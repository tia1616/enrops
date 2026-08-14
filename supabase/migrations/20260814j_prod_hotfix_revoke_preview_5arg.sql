-- 20260814j_prod_hotfix_revoke_preview_5arg.sql
--
-- PROD HOTFIX, applied on Jessica's explicit go, 14 Aug.
--
-- 20260814i bounds and revokes preview_program_session_dates, but it targets the
-- SIX-argument form created by 20260814a. Production still runs the FIVE-argument
-- form and will until that whole set ships, so the anon exposure would have
-- stayed open on prod in the meantime. This closes it now, against the signature
-- that actually exists there.
--
-- PROD BEFORE (captured, so the change is provable and reversible):
--   preview_program_session_dates(uuid,uuid,text,date,integer)
--   acl  = =X/postgres | postgres=X | anon=X | authenticated=X | service_role=X
--   anon EXECUTE = true, SECURITY INVOKER (so RLS always gated the reads)
--
-- Only the anon vector is closed here. The p_count clamp arrives with 20260814i,
-- because adding it now means editing a function body that 20260814a is about to
-- replace anyway -- and with anon gone, the remaining caller is a known,
-- authenticated org member rather than the open internet.
--
-- GUARDED, so this file is safe in any order and in any environment. On a fresh
-- database 20260814a runs first (a < j), drops the 5-arg form and creates the
-- 6-arg one, at which point there is nothing here to revoke and this becomes a
-- no-op -- 20260814i does the real work there. Without the guard, REVOKE on a
-- missing function would abort the migration.
--
-- Sequencing note for the prod release: 20260814a DROPs this 5-arg function,
-- which discards the ACL this migration just fixed. 20260814i re-applies the
-- revoke to the new signature immediately after, so the end state is closed
-- either way. That is the same DROP-resets-the-ACL behaviour that caused the
-- original regression, handled deliberately this time rather than discovered.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.oid::regprocedure::text = 'preview_program_session_dates(uuid,uuid,text,date,integer)'
  ) THEN
    REVOKE EXECUTE ON FUNCTION public.preview_program_session_dates(uuid, uuid, text, date, integer) FROM public, anon;
    GRANT  EXECUTE ON FUNCTION public.preview_program_session_dates(uuid, uuid, text, date, integer) TO authenticated, service_role;
    RAISE NOTICE 'revoked anon EXECUTE on the 5-arg preview_program_session_dates';
  ELSE
    RAISE NOTICE 'no 5-arg preview_program_session_dates here; 20260814i covers the 6-arg form';
  END IF;
END $$;
