-- Chunk 2 review fixes. Five things on one table, applied together because they
-- are one story: a class-day can be taken back, and only the people who should
-- be able to settle one can.
--
-- 1. A COVER CAN BE RELEASED. Dropping the old one-row-per-class-day upsert
--    removed the only way to take a day back from a confirmed sub - the modal
--    used to say "Swap to X" and overwrite the row. Nothing replaced it, so a
--    confirmed sub who then fell ill froze the class-day: the picker refused
--    ("cancel their cover first") and no surface in the product could cancel
--    anything. 'cancelled' is that missing state.
--
-- 2. THE ALARM HAS TO SEE A RELEASED DAY. A day whose only rows are cancelled
--    fell outside get_sub_coverage's HAVING entirely and was drawn as nothing:
--    nobody coming, nobody asked, nobody refused, no alarm. The same silence
--    the lead_out work existed to end.
--
-- 3. NOBODY IS "ASKED" UNTIL THE EMAIL LEAVES. offers_out counted pending rows,
--    and a row is written before its email is sent. A Resend failure therefore
--    left a row that read as a live offer everywhere - "Offered, waiting" in
--    the modal, offers_out >= 1 on the board, and state 'awaiting', which is
--    the calm state - for somebody who had never heard of the day.
--
-- 4. A SUB MAY DECLINE, NOT DECIDE. RLS policy
--    assignment_substitutions_sub_self_update_status has no predicate on the
--    status being written, and the column trigger explicitly permits status, so
--    a signed-in instructor could PATCH their own row to 'confirmed' and take a
--    paid class-day without the edge function: no coordination email to the
--    regular instructor, no admin notice. Survivable when one person held a row
--    per day. This build takes that to twelve.
--
-- 5. THE RACE SENTINEL MUST NOT BE FORGEABLE. decline_reason is free text the
--    instructor writes, and 'covered_by_other' in that same column is how six
--    readers decide somebody did NOT really refuse. Typing it as your reason
--    erased your own refusal from the coverage alarm. This closes in the
--    trigger rather than in the edge function, because the policy above let the
--    row be PATCHed directly and validating one function would leave that open.

-- ---------------------------------------------------------------- 1. state --
alter table public.assignment_substitutions
  drop constraint if exists assignment_substitutions_status_check;
alter table public.assignment_substitutions
  add constraint assignment_substitutions_status_check
  check (status = any (array['pending','confirmed','declined','taught','missed','cancelled']));

-- Who took the day back, and why. A release moves money - the pay line for a
-- cancelled row drops out of v_effective_pay_lines, which filters to
-- confirmed|taught - so it gets a real audit trail, not a bare status flip.
alter table public.assignment_substitutions
  add column if not exists cancelled_at  timestamptz,
  add column if not exists cancelled_by  uuid,
  add column if not exists cancel_reason text;

comment on column public.assignment_substitutions.cancelled_at is
  'When an admin released this cover or withdrew this offer. Set with status=cancelled.';

-- Both partial unique indexes key off status and 'cancelled' falls out of both
-- by construction: out of one_settled_per_slot, so the day can be offered
-- again, and out of one_live_offer_per_person, so the same person can be
-- re-asked. Nothing to change there, but it is why this status works.

-- ------------------------------------------------- 4 + 5. what a sub may do --
create or replace function public.restrict_assignment_substitution_sub_updates()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_caller_is_sub BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM instructors i
    WHERE i.id = OLD.sub_instructor_id
      AND i.auth_user_id = auth.uid()
  ) INTO v_caller_is_sub;

  -- Service role (every edge function that writes this table) has no
  -- auth.uid(), so none of the real write paths reach anything below.
  IF NOT v_caller_is_sub THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_assignment_id   IS DISTINCT FROM OLD.parent_assignment_id   OR
     NEW.parent_assignment_type IS DISTINCT FROM OLD.parent_assignment_type OR
     NEW.sub_instructor_id      IS DISTINCT FROM OLD.sub_instructor_id      OR
     NEW.date                   IS DISTINCT FROM OLD.date                   OR
     NEW.sub_tier               IS DISTINCT FROM OLD.sub_tier               OR
     NEW.assigned_at            IS DISTINCT FROM OLD.assigned_at            OR
     NEW.assigned_by            IS DISTINCT FROM OLD.assigned_by            OR
     NEW.notes                  IS DISTINCT FROM OLD.notes                  OR
     NEW.organization_id        IS DISTINCT FROM OLD.organization_id        OR
     NEW.email_sent_at          IS DISTINCT FROM OLD.email_sent_at          OR
     NEW.cancelled_at           IS DISTINCT FROM OLD.cancelled_at           OR
     NEW.cancelled_by           IS DISTINCT FROM OLD.cancelled_by           OR
     NEW.cancel_reason          IS DISTINCT FROM OLD.cancel_reason          OR
     NEW.created_at             IS DISTINCT FROM OLD.created_at             THEN
    RAISE EXCEPTION 'sub_instructor may only update status, decline_reason, declined_at, email_viewed_at, updated_at'
      USING ERRCODE = '42501';
  END IF;

  -- Accepting decides who teaches a paid class, and it belongs to
  -- accept_sub_offer, which arbitrates the race, closes the losing offers and
  -- fires the 3-way coordination email. Declining is the sub's own to make.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'pending' AND NEW.status = 'declined') THEN
    RAISE EXCEPTION 'sub_instructor may only decline a pending offer'
      USING ERRCODE = '42501';
  END IF;

  -- 'covered_by_other' records that somebody LOST a race, not that they
  -- refused, and accept_sub_offer is its only legitimate writer. The column the
  -- sub controls may not carry it.
  IF NEW.decline_reason IS DISTINCT FROM OLD.decline_reason
     AND lower(btrim(coalesce(NEW.decline_reason, ''))) = 'covered_by_other' THEN
    RAISE EXCEPTION 'covered_by_other is reserved and cannot be set as a decline reason'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

-- --------------------------------------- one spelling of "when does it run" --
-- Programs store 12-hour text ("3:30 PM"); camps store a real time. The
-- double-booking guard below needs both, so the answer lives in one function
-- instead of being re-typed. NULL means the window is not knowable (a malformed
-- start_time, a missing parent); callers must read NULL as "do not know", never
-- as "no conflict".
create or replace function public.sub_slot_window(p_parent_type text, p_parent_assignment_id uuid)
returns table(ts time, te time)
language sql
stable
set search_path to 'public'
as $function$
  select cs.start_time, cs.end_time
    from camp_assignments ca
    join camp_sessions cs on cs.id = ca.camp_session_id
   where p_parent_type = 'camp' and ca.id = p_parent_assignment_id
  union all
  select
    case when pr.start_time ~* '^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$'
         then to_timestamp(pr.start_time, 'HH12:MI AM')::time end,
    case when pr.end_time ~* '^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$'
         then to_timestamp(pr.end_time, 'HH12:MI AM')::time end
    from program_assignments pa
    join programs pr on pr.id = pa.program_id
   where p_parent_type = 'program' and pa.id = p_parent_assignment_id;
$function$;

-- No client calls this; accept_sub_offer does, as service role. It takes a bare
-- assignment id and answers with that class's times, with no org predicate of
-- its own, so leaving it callable would let a signed-in member of one tenant
-- read another tenant's schedule an id at a time. Owner and service_role only.
revoke execute on function public.sub_slot_window(text, uuid) from public;
revoke execute on function public.sub_slot_window(text, uuid) from anon;
revoke execute on function public.sub_slot_window(text, uuid) from authenticated;

-- ------------------------------------------ accept_sub_offer: one refusal --
-- Unchanged: the FOR UPDATE lock, the unique_violation race resolution, the
-- sibling close-out, the losers payload.
--
-- Added: a sub cannot accept a class overlapping one they are ALREADY settled
-- on that day. Nothing checked this. sub_availability_on_date counts only
-- confirmed|taught as busy, so two live offers left the same person looking
-- free in both pickers, and accepting both left one room empty.
--
-- Deliberately PROVABLE overlap only - both windows known and actually
-- overlapping. sub_availability_on_date treats an unknown window as a conflict,
-- which is right for greying out a name in a picker and wrong here, where it
-- would refuse a real acceptance nobody can talk the database out of and leave
-- the day uncovered anyway.
create or replace function public.accept_sub_offer(p_substitution_id uuid, p_sub_instructor_id uuid)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
DECLARE
  v_row     assignment_substitutions%ROWTYPE;
  v_losers  jsonb;
  v_ts      time;
  v_te      time;
BEGIN
  SELECT * INTO v_row FROM assignment_substitutions
   WHERE id = p_substitution_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_row.sub_instructor_id IS DISTINCT FROM p_sub_instructor_id THEN
    RETURN jsonb_build_object('outcome', 'forbidden');
  END IF;

  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('outcome', 'already_responded', 'status', v_row.status);
  END IF;

  SELECT w.ts, w.te INTO v_ts, v_te
    FROM sub_slot_window(v_row.parent_assignment_type, v_row.parent_assignment_id) w;

  IF v_ts IS NOT NULL AND v_te IS NOT NULL AND EXISTS (
    SELECT 1
      FROM assignment_substitutions s
      CROSS JOIN LATERAL sub_slot_window(s.parent_assignment_type, s.parent_assignment_id) w
     WHERE s.sub_instructor_id = p_sub_instructor_id
       AND s.date              = v_row.date
       AND s.status IN ('confirmed', 'taught')
       AND s.id <> p_substitution_id
       AND w.ts IS NOT NULL AND w.te IS NOT NULL
       AND v_ts < w.te AND w.ts < v_te
  ) THEN
    RETURN jsonb_build_object('outcome', 'time_conflict');
  END IF;

  BEGIN
    UPDATE assignment_substitutions
       SET status = 'confirmed', updated_at = now()
     WHERE id = p_substitution_id;
  EXCEPTION WHEN unique_violation THEN
    UPDATE assignment_substitutions
       SET status = 'declined', declined_at = now(),
           decline_reason = 'covered_by_other', updated_at = now()
     WHERE id = p_substitution_id AND status = 'pending';
    RETURN jsonb_build_object('outcome', 'lost');
  END;

  WITH sib AS (
    SELECT s.id
      FROM assignment_substitutions s
     WHERE s.parent_assignment_id   = v_row.parent_assignment_id
       AND s.parent_assignment_type = v_row.parent_assignment_type
       AND s.date                   = v_row.date
       AND s.status = 'pending'
       AND s.id <> p_substitution_id
     FOR UPDATE SKIP LOCKED
  ),
  upd AS (
    UPDATE assignment_substitutions s
       SET status = 'declined', declined_at = now(),
           decline_reason = 'covered_by_other', updated_at = now()
      FROM sib
     WHERE s.id = sib.id
     RETURNING s.sub_instructor_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'sub_instructor_id', i.id,
           'email',             i.email,
           'first_name',        i.first_name,
           'preferred_name',    i.preferred_name
         )), '[]'::jsonb)
    INTO v_losers
    FROM upd JOIN instructors i ON i.id = upd.sub_instructor_id;

  RETURN jsonb_build_object('outcome', 'won', 'losers', v_losers);
END;
$function$;

-- accept_sub_offer is SECURITY INVOKER and was granted to authenticated, which
-- its own migration (20260723c) says it must not be: "Edge-fn-only. Not exposed
-- to authenticated/anon directly." The trigger above now refuses the write it
-- would make; the grant should state the same contract.
revoke execute on function public.accept_sub_offer(uuid, uuid) from public;
revoke execute on function public.accept_sub_offer(uuid, uuid) from anon;
revoke execute on function public.accept_sub_offer(uuid, uuid) from authenticated;
