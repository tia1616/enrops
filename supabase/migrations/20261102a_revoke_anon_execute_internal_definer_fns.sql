-- Revoke anon (and PUBLIC) EXECUTE on SECURITY DEFINER functions that were never meant to be
-- callable through /rest/v1/rpc by a visitor with only the public key.
-- Trigger functions (10, incl. audit_organization_money): EXECUTE is checked at CREATE TRIGGER,
-- not at fire time, so nothing breaks.
-- add_program_no_school_date is an admin-only RPC: its one caller is the signed-in admin calendar.
-- authenticated + service_role keep their explicit grants.
revoke execute on function public.link_parent_to_auth_user() from public, anon;
revoke execute on function public.sync_student_name_to_contact() from public, anon;
revoke execute on function public.tg_founder_first_camp() from public, anon;
revoke execute on function public.tg_founder_first_payment() from public, anon;
revoke execute on function public.tg_founder_first_program() from public, anon;
revoke execute on function public.tg_founder_new_account() from public, anon;
revoke execute on function public.tg_operator_welcome_on_onboarded() from public, anon;
revoke execute on function public.tg_owner_sets_alert_email() from public, anon;
revoke execute on function public.tg_programs_require_stripe_to_publish() from public, anon;
revoke execute on function public.add_program_no_school_date(uuid, date, text, text) from public, anon;
revoke execute on function public.audit_organization_money() from public, anon;

-- Post-condition: fail the migration loudly if any of the 11 is still callable by anon/PUBLIC,
-- or if authenticated/service_role lost access.
do $$
declare r record;
begin
  for r in
    select p.oid, p.oid::regprocedure::text as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'link_parent_to_auth_user','sync_student_name_to_contact','tg_founder_first_camp',
      'tg_founder_first_payment','tg_founder_first_program','tg_founder_new_account',
      'tg_operator_welcome_on_onboarded','tg_owner_sets_alert_email',
      'tg_programs_require_stripe_to_publish','add_program_no_school_date','audit_organization_money')
  loop
    if has_function_privilege('anon', r.oid, 'EXECUTE') then
      raise exception 'anon can still execute %', r.sig;
    end if;
    if not has_function_privilege('authenticated', r.oid, 'EXECUTE')
       or not has_function_privilege('service_role', r.oid, 'EXECUTE') then
      raise exception 'authenticated/service_role lost execute on %', r.sig;
    end if;
  end loop;
end $$;
