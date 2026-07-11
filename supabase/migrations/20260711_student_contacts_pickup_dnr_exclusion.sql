-- Customizable Registration — pickup / do-not-release mutual exclusion.
-- Spec: docs/specs/customizable-registration.md
--
-- Invariant (Jessica, 2026-07-11): "the same person can't be on the do not
-- release list and the approved pickup list — that should be impossible."
--
-- This is the UPSTREAM data guarantee the Attendance + Dismissal Log picker
-- relies on: the dismissal picker sources ONLY from authorized_pickup, so a
-- do_not_release person must NEVER also be an authorized_pickup for the same
-- student. We enforce it at the one place every write path funnels through —
-- the student_contacts table itself — via an AFTER INSERT/UPDATE row trigger
-- (see the timing note below for why AFTER, not BEFORE).
--
-- Why a trigger (not a guard inside replace_student_contacts): the live
-- registration form writes student_contacts DIRECTLY from create-registration
-- (service-role, bypassing the RPC). A trigger covers create-registration, the
-- replace_student_contacts RPC (admin editor + parent portal), and any future
-- importer with a single rule. It is SECURITY DEFINER so its internal lookup
-- always sees ALL of the student's opposite-role rows regardless of the
-- caller's RLS (it only SELECTs + RAISEs; it never writes).
--
-- Why an AFTER (constraint) trigger, NOT a BEFORE trigger: create-registration
-- inserts a child's authorized_pickup AND do_not_release rows in ONE INSERT
-- statement. A BEFORE ROW trigger's lookup does NOT see the other rows of the
-- SAME command (they share the command-id, so cmin == curcid → invisible under
-- MVCC), so it would miss a name entered into both lists on the same submit —
-- exactly the case we must block. An AFTER ROW constraint trigger fires at
-- statement end when all of the command's rows are visible, so it catches
-- same-statement conflicts. A RAISE here still aborts the whole INSERT, and
-- create-registration writes contacts BEFORE create-checkout, so a rejection
-- means no charge. The RPC path (separate DELETE then INSERT statements) is
-- caught under either timing.
--
-- Matching is case-insensitive on the trimmed first name AND trimmed last name
-- (free-text names). A row with an empty first+last is ignored (nothing to
-- match on). Only the authorized_pickup <-> do_not_release pair is mutually
-- exclusive; guardian / emergency are unaffected.
--
-- Additive + replay-safe. Applied to staging (mumfymlapolsfdnpewci) first,
-- then prod (iuasfpztkmrtagivlhtj) in the SAME pass (parity). Existing rows are
-- untouched (the trigger only fires on new writes); a separate check below
-- confirms neither env already holds an overlapping pair before this ships.

CREATE OR REPLACE FUNCTION public.student_contacts_no_pickup_dnr_overlap()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  opposite   text;
  norm_first text;
  norm_last  text;
BEGIN
  -- Only the pickup <-> do_not_release pair is mutually exclusive.
  IF NEW.role NOT IN ('authorized_pickup','do_not_release') THEN
    RETURN NEW;
  END IF;

  opposite := CASE NEW.role
                WHEN 'authorized_pickup' THEN 'do_not_release'
                ELSE 'authorized_pickup'
              END;

  norm_first := lower(btrim(coalesce(NEW.first_name, '')));
  norm_last  := lower(btrim(coalesce(NEW.last_name,  '')));

  -- Nothing to match on (defensive; write paths filter out empty names).
  IF norm_first = '' AND norm_last = '' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.student_contacts sc
     WHERE sc.student_id = NEW.student_id
       AND sc.role = opposite
       AND sc.id <> NEW.id
       AND lower(btrim(coalesce(sc.first_name, ''))) = norm_first
       AND lower(btrim(coalesce(sc.last_name,  ''))) = norm_last
  ) THEN
    RAISE EXCEPTION
      'Contact "% %" cannot be on both the approved pickup list and the do-not-release list for the same student.',
      btrim(coalesce(NEW.first_name, '')), btrim(coalesce(NEW.last_name, ''))
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.student_contacts_no_pickup_dnr_overlap() IS
  'Enforces the pickup/do-not-release mutual-exclusion invariant on student_contacts: a normalized (lower+trim first & last) name present as authorized_pickup for a student cannot also be do_not_release, and vice versa. SECURITY DEFINER so the lookup sees all opposite-role rows regardless of caller RLS. Read-only + RAISE, never writes.';

-- Trigger functions are invoked by the trigger regardless of EXECUTE grants, so
-- nobody needs direct EXECUTE. Supabase auto-grants EXECUTE to anon/authenticated
-- on new functions; revoke it so this SECURITY DEFINER function is never a public
-- doorway (matches the Chunk 0 posture; also clears the security advisor warning).
REVOKE EXECUTE ON FUNCTION public.student_contacts_no_pickup_dnr_overlap() FROM public, anon, authenticated;

-- Replay-safe: Postgres has no CREATE TRIGGER IF NOT EXISTS. AFTER ROW (via a
-- CONSTRAINT TRIGGER) so same-statement inserts are visible to the lookup — see
-- the header note on MVCC command-id visibility.
DROP TRIGGER IF EXISTS student_contacts_no_pickup_dnr_overlap_trg ON public.student_contacts;
CREATE CONSTRAINT TRIGGER student_contacts_no_pickup_dnr_overlap_trg
  AFTER INSERT OR UPDATE ON public.student_contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.student_contacts_no_pickup_dnr_overlap();

-- Pre-ship safety check (informational — does not fail the migration):
-- surfaces any student that ALREADY has the same normalized name in both roles,
-- so it can be reconciled before/at ship. Expected: 0 rows on both envs.
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT p.student_id
      FROM public.student_contacts p
      JOIN public.student_contacts d
        ON d.student_id = p.student_id
       AND d.role = 'do_not_release'
       AND lower(btrim(coalesce(d.first_name,''))) = lower(btrim(coalesce(p.first_name,'')))
       AND lower(btrim(coalesce(d.last_name,'')))  = lower(btrim(coalesce(p.last_name,'')))
     WHERE p.role = 'authorized_pickup'
       AND (lower(btrim(coalesce(p.first_name,''))) <> '' OR lower(btrim(coalesce(p.last_name,''))) <> '')
     GROUP BY p.student_id
  ) x;
  IF n > 0 THEN
    RAISE WARNING 'student_contacts: % student(s) already have a name in BOTH authorized_pickup and do_not_release — reconcile these existing rows (trigger only guards new writes).', n;
  END IF;
END $$;
