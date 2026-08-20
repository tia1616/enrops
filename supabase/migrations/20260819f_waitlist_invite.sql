-- Chunk 2 foundation: an offered place is HELD while the family decides.
--
-- Decisions (Jessica, 2026-08-19): auto-invite the top of the list with a hold window.
--
-- WHY THIS IS THE FIRST THING BUILT, NOT THE EMAIL
-- The moment a seat opens and we offer it to the family at position 1, that seat must
-- stop being sellable. Otherwise the catalog still shows the class as open, somebody
-- registers and pays, and the invited family clicks a link to a class that is full again
-- - having been told in writing it was theirs. That is a worse experience than never
-- having a waitlist. So the HOLD comes before the sending.
--
-- NO NEW TABLE. The waitlist row already exists and is already the thing being offered;
-- an invites table would need its own RLS, its own grants, and would let a row exist
-- whose registration had been cancelled underneath it. Three columns on the row itself
-- cannot drift from it.

alter table public.registrations
  add column if not exists waitlist_invited_at      timestamptz,
  add column if not exists waitlist_invite_expires_at timestamptz,
  -- Single use, and unguessable. Looked up on its own, so it carries a unique index.
  add column if not exists waitlist_invite_token    text;

comment on column public.registrations.waitlist_invited_at is
  'When this waitlisted family was offered the open place. NULL = never offered.';
comment on column public.registrations.waitlist_invite_expires_at is
  'When that offer lapses. While in the future the row HOLDS A SEAT (see registration_holds_seat) so the place cannot be sold from under them.';
comment on column public.registrations.waitlist_invite_token is
  'Single-use secret in the invite link. Unique. Cleared when the offer is accepted or lapses so a stale link cannot be replayed.';

-- Partial: only invited rows carry a token, and NULLs must not collide.
create unique index if not exists uniq_registrations_waitlist_invite_token
  on public.registrations (waitlist_invite_token)
  where waitlist_invite_token is not null;

-- Finding the expiring ones is a cron's whole job, so give it an index rather than a
-- sequential scan over every registration the platform has.
create index if not exists idx_registrations_live_invites
  on public.registrations (waitlist_invite_expires_at)
  where status = 'waitlist' and waitlist_invite_expires_at is not null;

-- ---------------------------------------------------------------------------
-- The seat rule now has a fourth branch, and it takes the ROW.
--
-- Previous signature was (status, registered_at, ach_payment_state, ttl) and adding two
-- more scalars would mean another drop-and-recreate dance next time. Passing the whole
-- registrations row means the rule can consider any column it needs without the callers
-- changing again. It also reads better at the call site: registration_holds_seat(r).
--
-- Under a LEFT JOIN r can be entirely NULL. That is safe here because every caller wraps
-- this in `count(r.id) filter (...)`, and count(r.id) ignores NULL ids regardless of what
-- the filter says.
-- ---------------------------------------------------------------------------

-- Break the view's dependency on the old signature before dropping it.
create or replace view public.program_enrollment
with (security_invoker = on)
as
 select p.id as program_id, p.curriculum, pl.name as program_location_name,
    pl.name as school_name, p.day_of_week, p.max_capacity,
    count(r.id) filter (where r.status = any (array['confirmed'::text,'pending'::text])) as enrolled,
    p.max_capacity - count(r.id) filter (where r.status = any (array['confirmed'::text,'pending'::text])) as spots_remaining
   from programs p
     join program_locations pl on p.program_location_id = pl.id
     left join registrations r on r.program_id = p.id
  group by p.id, p.curriculum, pl.name, p.day_of_week, p.max_capacity;

drop function if exists public.registration_holds_seat(text, timestamptz, text, interval);

create or replace function public.registration_holds_seat(
  r             public.registrations,
  p_pending_ttl interval default interval '24 hours'
)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    -- Paid and enrolled.
    when r.status = 'confirmed' then true

    when r.status = 'pending' then
      case
        -- Bank transfer clearing. The Pay step promises 1-3 business days and the seat
        -- held meanwhile, so it is held for as long as it takes.
        when r.ach_payment_state = 'processing' then true
        -- Otherwise a checkout in flight: holds while alive, releases when dead. A NULL
        -- registered_at cannot be aged so it keeps the seat (fail safe: one unclearable
        -- row beats selling an occupied chair).
        else r.registered_at is null or r.registered_at > now() - p_pending_ttl
      end

    -- A WAITLISTED FAMILY WHO HAS BEEN OFFERED THE PLACE HOLDS IT until the offer lapses.
    -- This is the whole point of the migration: between "we emailed you the link" and
    -- "the link expired", the place is theirs and nobody else can buy it. An expired or
    -- never-sent offer holds nothing - a waitlist row is otherwise just an expression of
    -- interest.
    when r.status = 'waitlist' then
      r.waitlist_invite_expires_at is not null
      and r.waitlist_invite_expires_at > now()

    -- cancelled / refunded hold nothing.
    else false
  end;
$$;

comment on function public.registration_holds_seat(public.registrations, interval) is
  'Single definition of whether one registration row occupies a seat. confirmed = yes. pending = yes while an ACH transfer is processing, else while younger than p_pending_ttl (default 24h, matching the abandoned-registration window). waitlist = yes ONLY while it has an unexpired invite, because an offered place must not be sellable while the family decides. cancelled/refunded = no. Touches no tables, so anon may execute it and it needs no SECURITY DEFINER. Read by BOTH program_seat_counts (which the capacity gate enforces) and the program_enrollment view (which operators read) so the two cannot drift.';

grant execute on function public.registration_holds_seat(public.registrations, interval)
  to anon, authenticated, service_role;

-- Both consumers, repointed at the row-taking rule.
create or replace function public.program_seat_counts(p_program_ids uuid[] default null)
returns table (program_id uuid, max_capacity integer, seats_taken bigint, is_full boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id,
    p.max_capacity,
    count(r.id) filter (where registration_holds_seat(r)),
    case
      when coalesce(p.max_capacity, 0) > 0
        then count(r.id) filter (where registration_holds_seat(r)) >= p.max_capacity
      else false
    end
  from programs p
  left join registrations r on r.program_id = p.id
  where p_program_ids is null or p.id = any (p_program_ids)
  group by p.id, p.max_capacity;
$$;

create or replace view public.program_enrollment
with (security_invoker = on)
as
 select p.id as program_id, p.curriculum, pl.name as program_location_name,
    pl.name as school_name, p.day_of_week, p.max_capacity,
    count(r.id) filter (where registration_holds_seat(r)) as enrolled,
    p.max_capacity - count(r.id) filter (where registration_holds_seat(r)) as spots_remaining
   from programs p
     join program_locations pl on p.program_location_id = pl.id
     left join registrations r on r.program_id = p.id
  group by p.id, p.curriculum, pl.name, p.day_of_week, p.max_capacity;

comment on view public.program_enrollment is
  'Public aggregate counts (max_capacity, enrolled, spots_remaining) for the parent-facing "spots available" UI and the admin schedule. enrolled counts rows where registration_holds_seat() is true - confirmed, pending that is live, and waitlisted families holding an unexpired invite - which is the SAME rule create-registration enforces. security_invoker = on, so RLS applies to the caller and anon sees zeros by design (2026-06-06 hotfix). Returns NO PII.';
