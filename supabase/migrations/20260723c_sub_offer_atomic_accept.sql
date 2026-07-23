-- Task B, chunk 1 (ADDITIVE foundation for first-come multi-offer subs).
-- See docs/handoffs/sub-availability-and-multi-offer.md (Task B).
--
-- This migration is deliberately additive and inert: it does NOT yet drop the
-- existing UNIQUE (parent_assignment_id, parent_assignment_type, date) that
-- keeps one row per slot, so multi-pending is not possible until chunk 2
-- swaps the constraint + updates the create edge fn (they are coupled - the
-- create fn upserts ON CONFLICT on that unique, so dropping it without the fn
-- change would 42P10 the live sub-assign path). What chunk 1 adds:
--
--   1. A PARTIAL UNIQUE INDEX enforcing at most ONE 'confirmed' sub per slot.
--      Harmless today (already <=1 row per slot); becomes the single-winner
--      guard once multiple pendings are legal. This is the DB-level invariant
--      that makes two simultaneous accepts safe.
--   2. accept_sub_offer(): the atomic accept. Confirms the caller's offer (the
--      partial index makes a 2nd concurrent confirm fail), auto-declines the
--      other pending offers for that slot, and returns the losers so the edge
--      fn can email them "already covered". Service-role only (the accept edge
--      fn authenticates the sub, then calls this); it also re-checks the sub.

-- 1) Single-winner guard -----------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS assignment_substitutions_one_confirmed_per_slot
  ON public.assignment_substitutions (parent_assignment_id, parent_assignment_type, date)
  WHERE status = 'confirmed';

-- 2) Atomic accept -----------------------------------------------------------
-- Returns jsonb: { outcome: 'won' | 'lost' | 'not_found' | 'forbidden'
--                            | 'already_responded', status?, losers? }
-- 'won'  -> caller confirmed; losers = [{sub_instructor_id,email,first_name,preferred_name}]
-- 'lost' -> someone else already won; caller's offer auto-declined as covered.
CREATE OR REPLACE FUNCTION public.accept_sub_offer(
  p_substitution_id  uuid,
  p_sub_instructor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row     assignment_substitutions%ROWTYPE;
  v_losers  jsonb;
BEGIN
  -- Lock the target offer so a double-submit of the same row serializes.
  SELECT * INTO v_row FROM assignment_substitutions
   WHERE id = p_substitution_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- Defense in depth: the edge fn already verified the caller is this sub.
  IF v_row.sub_instructor_id IS DISTINCT FROM p_sub_instructor_id THEN
    RETURN jsonb_build_object('outcome', 'forbidden');
  END IF;

  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('outcome', 'already_responded', 'status', v_row.status);
  END IF;

  -- Try to win the slot. The partial unique index rejects a 2nd concurrent
  -- winner: this UPDATE blocks on the in-flight winner's index entry, then
  -- raises unique_violation when that winner commits.
  BEGIN
    UPDATE assignment_substitutions
       SET status = 'confirmed', updated_at = now()
     WHERE id = p_substitution_id;
  EXCEPTION WHEN unique_violation THEN
    -- Lost the race. Mark this offer declined-as-covered (we hold its lock).
    UPDATE assignment_substitutions
       SET status = 'declined', declined_at = now(),
           decline_reason = 'covered_by_other', updated_at = now()
     WHERE id = p_substitution_id AND status = 'pending';
    RETURN jsonb_build_object('outcome', 'lost');
  END;

  -- Won: auto-decline the other pending offers for this exact slot and return
  -- them for the "already covered" email. SKIP LOCKED avoids deadlocking with a
  -- concurrent loser that is self-declining its own row (that loser handles
  -- itself and is simply not re-emailed).
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
$$;

-- Edge-fn-only: the accept edge fn (service role) authenticates the sub, then
-- calls this. Not exposed to authenticated/anon directly.
REVOKE ALL ON FUNCTION public.accept_sub_offer(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.accept_sub_offer(uuid, uuid) TO service_role;
