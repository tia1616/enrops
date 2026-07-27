-- Replace 20260727a's insert-time linking with sign-in-time claiming.
--
-- WHY 20260727a IS BEING WITHDRAWN
-- It linked parents.auth_id by matching an email address typed into the PUBLIC
-- guest-checkout form. Nobody has proven control of that address at that moment.
-- A parent typing sarah@ instead of sara@ would hand the real owner of sarah@
-- -- an instructor, an operator, a parent at any other tenant, since auth is
-- platform-wide -- portal access to a family's children, because
-- portal/Dashboard.jsx resolves the family purely by .eq('auth_id', user.id).
--
-- The pre-existing on_auth_user_created_link_parent trigger does NOT have this
-- problem and is deliberately left alone: it fires at ACCOUNT CREATION, which
-- happens via magic link or OAuth, so it already implies control of the address.
-- 20260727a extended email-matching to a moment where that implication does not
-- hold. That was the mistake.
--
-- WHAT REPLACES IT
-- claim_parent_record(), called by the portal when a signed-in user has no
-- parents row. Signing in REQUIRES receiving mail at the address, so the claim
-- rests on the same proof the account-creation trigger does. Note this holds
-- even though stripe-webhook creates users with email_confirm:true without
-- verifying: that flag lets them sign in, it does not sign them in -- a magic
-- link still has to be received.
--
-- The original bug is still fixed. Arielle's registration on reebok-hoops (prod,
-- 2026-07-26) links itself the moment she next opens the portal, with no
-- backfill, and so does every future family who already had an account.
--
-- The address comes from auth.users for the CALLER's own id -- never a parameter
-- -- so a caller cannot ask to be linked to somebody else's email.

DROP TRIGGER IF EXISTS link_parent_auth_on_insert ON public.parents;
DROP TRIGGER IF EXISTS link_parent_auth_on_email_change ON public.parents;
DROP FUNCTION IF EXISTS public.link_parent_auth_on_write();

CREATE OR REPLACE FUNCTION public.claim_parent_record()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_email     text;
  v_parent_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  -- Already linked: return it and touch nothing.
  SELECT id INTO v_parent_id FROM public.parents WHERE auth_id = v_uid LIMIT 1;
  IF v_parent_id IS NOT NULL THEN
    RETURN v_parent_id;
  END IF;

  SELECT lower(btrim(u.email)) INTO v_email FROM auth.users u WHERE u.id = v_uid;
  IF v_email IS NULL OR v_email = '' THEN
    RETURN NULL;
  END IF;

  -- Update exactly ONE row, chosen in a subquery. parents_email_key is unique on
  -- the RAW email, so two rows can differ only by case and both match a
  -- lower()-ed comparison; updating both would set the same auth_id twice and
  -- violate the UNIQUE idx_parents_auth, failing the whole call. Oldest first so
  -- repeat calls are deterministic.
  UPDATE public.parents p
     SET auth_id = v_uid
   WHERE p.id = (
     SELECT p2.id
       FROM public.parents p2
      WHERE lower(btrim(p2.email)) = v_email
        AND p2.auth_id IS NULL
      ORDER BY p2.created_at NULLS LAST, p2.id
      LIMIT 1
   )
  RETURNING p.id INTO v_parent_id;

  RETURN v_parent_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_parent_record() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_parent_record() FROM anon;
GRANT  EXECUTE ON FUNCTION public.claim_parent_record() TO authenticated;
