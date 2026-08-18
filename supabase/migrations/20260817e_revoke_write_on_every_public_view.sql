-- 20260817d REVOKED ON FOUR VIEWS BY NAME. That was the instance, not the class.
--
-- My own gauntlet caught it within minutes: enumerating EVERY relation where anon or
-- authenticated holds a write privilege turned up two more on staging I had never
-- looked at - program_enrollment and v_effective_pay_lines. The second is the PAYROLL
-- view. Naming views in a revoke list has the defect of every allowlist: correct the
-- day it is written, silently wrong for every view added after.
--
-- So this revokes across EVERY view in the public schema and stays correct as views
-- are added. Verified after applying: the same audit query that found the gap returns
-- empty, and anon still reads 98 sites and 14 districts on staging.
do $$
declare v record; n int := 0;
begin
  for v in
    select c.relname
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relkind = 'v'
  loop
    execute format(
      'revoke insert, update, delete, truncate on public.%I from anon, authenticated',
      v.relname);
    n := n + 1;
  end loop;
  raise notice 'revoked writes on % public views', n;
end $$;

-- THE DEFAULT PRIVILEGES, WHICH 20260817d ONLY HALF-FIXED - and which this file only
-- half-fixes too. Read this before assuming the hole is permanently shut.
--
-- `alter default privileges ... from anon` WITHOUT `for role` touches only the defaults
-- granted by the role running it. pg_default_acl showed two entries:
--   anon=rxtm/postgres          <- corrected by 20260817d (writes gone)
--   anon=arwdDxtm/supabase_admin  <- STILL FULL WRITES
-- Supabase's own tooling creates objects as supabase_admin, so a view created that way
-- still hands anon insert/update/delete/truncate.
--
-- MEASURED AFTER RUNNING THIS on staging 2026-08-17: the supabase_admin entry is
-- UNCHANGED - this role cannot alter another role's default privileges, and the
-- exception branch below is what actually fires. Kept anyway so the intent is in the
-- repo and it self-corrects if ever run with sufficient rights.
--
-- WHAT THAT MEANS PRACTICALLY: today's exposure is closed by the loop above, but a
-- NEWLY created public view can reopen it. Until the durable fix lands, re-run this
-- audit after adding any view:
--
--   select c.relname, string_agg(distinct g.privilege_type, ',')
--   from information_schema.role_table_grants g
--   join pg_class c on c.relname = g.table_name
--   join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
--   where g.table_schema = 'public' and g.grantee in ('anon','authenticated')
--     and g.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
--     and c.relkind = 'v'
--   group by c.relname;
--
-- THE DURABLE FIX, raised for Jessica rather than assumed: `alter table ... force row
-- level security` on the base tables would stop owner-run DML bypassing RLS at the
-- source, which is the real defect - the grants are only how it is reached. The other
-- candidate, security_invoker=true on the views, is NOT safe to flip blind: false is
-- exactly what the 14 Aug incident needed for signed-in parents to read districts at
-- all, so it cannot change without re-testing that path end to end.
do $$
begin
  execute 'alter default privileges for role supabase_admin in schema public '
       || 'revoke insert, update, delete, truncate on tables from anon';
  execute 'alter default privileges for role supabase_admin in schema public '
       || 'revoke insert, update, delete, truncate on tables from authenticated';
  raise notice 'supabase_admin default privileges tightened';
exception when others then
  raise notice 'COULD NOT alter supabase_admin default privileges: %. New views created by supabase_admin may still grant anon writes - run the audit query in this file after adding any view.', sqlerrm;
end $$;
