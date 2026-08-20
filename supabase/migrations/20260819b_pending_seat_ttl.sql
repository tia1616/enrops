-- Stale `pending` registrations stop holding a seat after 24 hours.
--
-- WHY
-- A registration row is written at the payment step, BEFORE the family pays, so the
-- seat is held while they enter card details. Nothing ever releases it if they do not
-- finish. Verified against prod 2026-08-19: 23 pending rows across 10 open capped
-- classes, EVERY one older than 24h, oldest 75 days. Nine of them are the same child
-- (one parent restarted checkout nine times on 2026-06-05 and never paid), because
-- create-registration inserts students rather than upserting, so each retry writes a
-- fresh set.
--
-- Worst case on prod: Super Mario Game Makers at Happy Valley Library. cap 14,
-- 3 confirmed, 9 pending. It reads 12 of 14, so the new capacity gate would sell 2 of
-- the 11 genuinely empty seats and then turn every following family away from a room
-- with 11 empty chairs. The gate turns a cosmetic wrong number into lost revenue,
-- which is why this lands in the same pass as the gate rather than after it.
--
-- 13 prod cron jobs were enumerated; none expires a stale pending. There is no
-- automatic recovery today, and manual recovery is an admin editing rows one by one
-- with nothing surfacing which classes need it.
--
-- WHY A SHARED HELPER RATHER THAN A COPIED EXPRESSION
-- "Does this row hold a seat" now has several branches and TWO consumers that must
-- never disagree: program_seat_counts, which the gate enforces, and the
-- program_enrollment view, which the operator reads. Copying a multi-branch rule into
-- two places is how the screen and the gate end up telling different stories.
--
-- This helper is safe to share in a way program_seat_counts is not: it touches NO
-- tables, so it cannot leak a row and needs no SECURITY DEFINER. It is plain
-- arithmetic on its arguments, which is why anon may execute it (the view is
-- security_invoker=on, so anon evaluates it as itself).
--
-- THE 24 HOURS LIVES HERE, ONCE. Jessica chose 24h on 2026-08-19. It matches the
-- window the abandoned-registration automation already uses to decide a checkout is
-- dead (hours_after_pending, default 24, resolved in lifecycle-automations-cron), so
-- the platform says "this checkout is over" and "this seat is free" at the same moment
-- instead of holding two different opinions. If it ever needs to be per-org, thread it
-- in as the p_pending_ttl argument - do not add a second literal somewhere else.

-- BANK TRANSFER IS WHY THIS TAKES AN ACH ARGUMENT.
-- The Pay step offers "Bank transfer (ACH) - 1-3 business days - spot held meanwhile",
-- and an ACH registration sits `pending` for that whole settlement window. A flat 24h
-- rule would free that family's seat on day two and sell it to somebody else while the
-- page had promised it was held, and their money was on its way. ACH has NEVER been
-- used on prod (zero rows have ever carried an ach_payment_state), so this is not a
-- live defect - it is the first ACH family who would have found it.
-- `registrations_ach_payment_state_check` allows NULL | 'processing' | 'failed', and
-- _shared/achSettlement.ts confirms 'processing' = in flight, 'failed' = dead,
-- NULL = paid or never ACH. So only 'processing' overrides the age test.
create or replace function public.registration_holds_seat(
  p_status            text,
  p_registered_at     timestamptz,
  p_ach_payment_state text     default null,
  p_pending_ttl       interval default interval '24 hours'
)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    -- Paid and enrolled. Holds a seat, always.
    when p_status = 'confirmed' then true
    when p_status = 'pending' then
      case
        -- Bank transfer clearing. Holds the seat for as long as it takes, because we
        -- told the family it would.
        when p_ach_payment_state = 'processing' then true
        -- Otherwise a checkout in flight: holds its seat while the family is paying,
        -- and lets go once the attempt is dead. A NULL registered_at cannot be aged,
        -- so it keeps the seat - failing safe here means one unclearable row, failing
        -- unsafe means selling a chair that is taken.
        else p_registered_at is null or p_registered_at > now() - p_pending_ttl
      end
    -- cancelled / refunded / waitlist hold nothing. waitlist especially: the whole
    -- point of a waitlist row is that it is NOT occupying a place.
    else false
  end;
$$;

comment on function public.registration_holds_seat(text, timestamptz, text, interval) is
  'Single definition of whether one registration row occupies a seat. confirmed = yes; pending = yes while an ACH transfer is ''processing'', else only while younger than p_pending_ttl (default 24h, matching the abandoned-registration window); cancelled/refunded/waitlist = no. Touches no tables, so it is safe for anon to execute and needs no SECURITY DEFINER. Read by BOTH program_seat_counts (which the capacity gate enforces) and the program_enrollment view (which operators read) so the two cannot drift.';

grant execute on function public.registration_holds_seat(text, timestamptz, text, interval)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Both consumers now read the helper.
-- ---------------------------------------------------------------------------

create or replace function public.program_seat_counts(p_program_ids uuid[] default null)
returns table (
  program_id   uuid,
  max_capacity integer,
  seats_taken  bigint,
  is_full      boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id,
    p.max_capacity,
    count(r.id) filter (where registration_holds_seat(r.status, r.registered_at, r.ach_payment_state)),
    case
      when coalesce(p.max_capacity, 0) > 0
        then count(r.id) filter (where registration_holds_seat(r.status, r.registered_at, r.ach_payment_state)) >= p.max_capacity
      else false
    end
  from programs p
  left join registrations r on r.program_id = p.id
  where p_program_ids is null or p.id = any (p_program_ids)
  group by p.id, p.max_capacity;
$$;

-- Grants are NOT restated by CREATE OR REPLACE FUNCTION, so the existing ACL
-- (service_role only) carries over. Asserted after applying, not assumed.

-- program_enrollment: same rule, so the operator's "enrolled" and the gate's
-- "seats_taken" stay identical.
--
-- WITH (security_invoker = on) is spelled out because CREATE OR REPLACE VIEW SILENTLY
-- DROPS reloptions - that is how an earlier pass in this branch reverted the
-- 2026-06-06 hotfix that made this view invoker-rights in the first place (as a
-- DEFINER view it exposed every tenant's programs, locations and fill rates to anon).
-- Do not remove this clause, and assert reloptions after any change here.
--
-- NOT dropped and recreated: DROP + CREATE also re-applies Supabase's default
-- privileges, which hands anon and authenticated REFERENCES + TRIGGER that prod has
-- never had. CREATE OR REPLACE preserves the existing grants.
create or replace view public.program_enrollment
with (security_invoker = on)
as
 select p.id as program_id,
    p.curriculum,
    pl.name as program_location_name,
    pl.name as school_name,
    p.day_of_week,
    p.max_capacity,
    count(r.id) filter (where registration_holds_seat(r.status, r.registered_at, r.ach_payment_state)) as enrolled,
    p.max_capacity - count(r.id) filter (where registration_holds_seat(r.status, r.registered_at, r.ach_payment_state)) as spots_remaining
   from programs p
     join program_locations pl on p.program_location_id = pl.id
     left join registrations r on r.program_id = p.id
  group by p.id, p.curriculum, pl.name, p.day_of_week, p.max_capacity;

comment on view public.program_enrollment is
  'Public aggregate counts (max_capacity, enrolled, spots_remaining) for the parent-facing "spots available" UI and the admin schedule. enrolled counts rows where registration_holds_seat() is true - confirmed, plus pending that is either an ACH transfer in flight or younger than 24h - which is the SAME rule create-registration enforces. security_invoker = on, so RLS on programs/registrations applies to the caller and anon sees zeros by design (2026-06-06 hotfix). Returns NO PII.';
