-- THE SECURITY HALF, ON ITS OWN, SO IT CAN GO TO PRODUCTION AHEAD OF THE
-- FEATURE. Jessica's call, 2026-09-24: close the holes now, ship the substitute
-- work when she is ready.
--
-- Two things a signed-in instructor can do to their own substitution row today
-- that they must not be able to do. Both go through PostgREST directly, not
-- through any screen, and both are invisible to every edge function.
--
-- 1. SETTLE IT. RLS policy assignment_substitutions_sub_self_update_status has
--    no predicate on the status being written, and the column trigger
--    explicitly permits `status`. So PATCH status=confirmed takes a paid
--    class-day with no coordination email to the regular instructor and no
--    admin notice. Survivable while one person could hold a row per day; the
--    multi-offer work takes that to twelve.
--
-- 2. SILENCE IT. `cover_still_needed` decides whether a released cover raises
--    the coverage alarm, and it was NOT in the trigger's whitelist - I added the
--    column in 20260923h and did not add it to the guard. PATCH it to false and
--    the day stops being reported as needing anybody. Proven on staging before
--    writing this: the write was ALLOWED. That is the alarm going quiet on a day
--    with no teacher, which is the single thing this whole build exists to
--    prevent, reachable by the one person with an interest in it being quiet.
--
-- WHY THIS IS SAFE TO LAND ON PROD ALONE, verified not assumed:
--   * The columns are additive and nothing on prod writes them.
--   * origin/main's frontend NEVER writes assignment_substitutions - checked
--     every reference with a window, not a single-line grep.
--   * origin/main's edge functions never call accept_sub_offer, so revoking it
--     from authenticated cannot break a deployed path.
--   * Every edge function uses the service-role client, where auth.uid() is
--     NULL, so the trigger's whole restricted branch is unreachable for them.
--     That is why tightening it costs the product nothing.
--
-- The columns are added HERE only so the trigger body is identical on both
-- databases. A prod-only variant of this function would be two spellings of one
-- rule, which is how the two sides drift.

alter table public.assignment_substitutions
  add column if not exists cancelled_at       timestamptz,
  add column if not exists cancelled_by       uuid,
  add column if not exists cancel_reason      text,
  add column if not exists cover_still_needed boolean;

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
     -- Added 2026-09-24. Whether a released day still needs somebody is an
     -- OPERATOR's answer, recorded by cancel-sub-cover. The sub it was taken
     -- from is the last person who should be able to write it.
     NEW.cover_still_needed     IS DISTINCT FROM OLD.cover_still_needed     OR
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

-- accept_sub_offer is SECURITY INVOKER and was granted to authenticated, which
-- its own migration (20260723c) says it must not be: "Edge-fn-only. Not exposed
-- to authenticated/anon directly." The trigger above now refuses the write it
-- would make; the grant should state the same contract.
revoke execute on function public.accept_sub_offer(uuid, uuid) from public;
revoke execute on function public.accept_sub_offer(uuid, uuid) from anon;
revoke execute on function public.accept_sub_offer(uuid, uuid) from authenticated;
