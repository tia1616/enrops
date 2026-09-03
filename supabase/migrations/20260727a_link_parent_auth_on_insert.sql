-- Parent portal access: link a parents row to an EXISTING auth user at write time.
--
-- WHY THIS EXISTS
-- on_auth_user_created_link_parent fires AFTER INSERT ON auth.users, so the link
-- is only ever made when the AUTH USER is the new side. The reverse case -- the
-- auth account already exists and the parents row is created afterwards -- was
-- never covered, so parents.auth_id stayed NULL forever and portal/Dashboard.jsx
-- (which resolves the family with .eq('auth_id', user.id)) rendered the empty
-- "check your email" state to a family that had just paid.
--
-- CONFIRMED ON PROD 2026-07-26: a paid, confirmed registration created a parents
-- row for an email whose auth user dates to 2026-05-22. auth_id NULL, portal
-- empty, and the family signed in 15 minutes later to nothing. This is the case
-- that GROWS with adoption -- a returning family registering with a second
-- operator, an operator registering their own child, anyone previously invited
-- to a roster -- because the failing condition IS "already has an enrops
-- account".
--
-- WHY A TRIGGER AND NOT A FIX IN create-registration
-- parents.auth_id has four writers: create-registration (leaves it null by
-- design), invite-parents (already carries this exact repair by hand, see its
-- "Self-heal" block), the auth.users trigger, and manual admin edits.
-- stripe-webhook never got the repair. Closing it in the write path covers every
-- caller, present and future, instead of asking each one to remember.
--
-- WHY BEFORE INSERT
-- No second write, no recursion, and RLS WITH CHECK is still evaluated against
-- the final row: an authenticated caller inserting somebody else's email gets
-- auth_id filled with that other user's id and then fails parents_create_self
-- (auth_id = auth.uid()). That is the fail-closed direction.
--
-- SAFETY -- THE NOT EXISTS GUARD IS LOAD-BEARING
-- idx_parents_auth is UNIQUE on auth_id, so claiming an id that another parents
-- row already holds would abort the INSERT -- i.e. break a family's registration
-- mid-checkout. The guard makes the worst case "left NULL, exactly as today"
-- rather than a failed write. Both environments verified clean 2026-07-27 (zero
-- case-variant parent emails, zero mixed-case emails in parents or auth.users),
-- so the guard is defence against future data, not a live collision.

CREATE OR REPLACE FUNCTION public.link_parent_auth_on_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid;
BEGIN
  IF NEW.auth_id IS NOT NULL OR NEW.email IS NULL OR btrim(NEW.email) = '' THEN
    RETURN NEW;
  END IF;

  SELECT u.id INTO v_uid
  FROM auth.users u
  WHERE lower(u.email) = lower(btrim(NEW.email))
  LIMIT 1;

  IF v_uid IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.parents p WHERE p.auth_id = v_uid) THEN
    NEW.auth_id := v_uid;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.link_parent_auth_on_write() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.link_parent_auth_on_write() FROM anon;
REVOKE EXECUTE ON FUNCTION public.link_parent_auth_on_write() FROM authenticated;

DROP TRIGGER IF EXISTS link_parent_auth_on_insert ON public.parents;
CREATE TRIGGER link_parent_auth_on_insert
  BEFORE INSERT ON public.parents
  FOR EACH ROW EXECUTE FUNCTION public.link_parent_auth_on_write();

-- An email correction on an unlinked row is the other way a parents row can come
-- to match an existing account. Scoped with WHEN so an ordinary parent edit
-- (name, phone, comms prefs) never enters the function at all.
DROP TRIGGER IF EXISTS link_parent_auth_on_email_change ON public.parents;
CREATE TRIGGER link_parent_auth_on_email_change
  BEFORE UPDATE OF email ON public.parents
  FOR EACH ROW
  WHEN (NEW.auth_id IS NULL AND NEW.email IS DISTINCT FROM OLD.email)
  EXECUTE FUNCTION public.link_parent_auth_on_write();
