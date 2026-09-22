-- Re-measure what the money guard on public.organizations ACTUALLY DOES.
--
-- Run this against STAGING (mumfymlapolsfdnpewci), then paste the final JSON
-- into supabase/functions/_shared/tests/moneyGuard.snapshot.json and update
-- `newest_migration_at_probe_time` to the newest file in supabase/migrations/.
-- Then run the PARITY query at the bottom against BOTH databases.
--
-- WHY THIS EXISTS. Three versions of orgMoneyColumnsGuarded.test.ts parsed the
-- migration SQL with regexes and all three reported green while every money
-- column was unlocked - beaten by a comment, a nested IF, a string containing
-- "RAISE EXCEPTION", a DISABLE TRIGGER, a column name the pattern did not cover.
-- Text cannot answer "is this column protected". This can: it asks the database
-- by trying, as a real org admin, and records the answer.
--
-- SAFE TO RUN. It only ever touches ONE row - the QA fixture org below, never a
-- real tenant - undoes every change immediately from a backup taken first, and
-- ends by proving the row is byte-identical to that backup and that it left no
-- audit rows behind. Run it on STAGING. Do not point it at prod: prod has no
-- fixture org, and this writes.
--
-- TWO PROBES, and they must stay separate. (A) as a plain org ADMIN: does the
-- guard REFUSE the change (42501)? (B) as service_role, which the guard exempts:
-- does the change write a row to organization_money_audit? B cannot be folded
-- into A, because a refused write never reaches the audit trigger - so an
-- operator probe can say nothing about whether a LOCKED column is recorded.
--
-- TWO TRAPS ALREADY PAID FOR, do not reintroduce them:
--   1. The guard reads auth.role(), which is the JWT CLAIM, not the database
--      role. Resetting `role` alone leaves the claim saying 'authenticated' and
--      every later write is still refused. Both must be reset.
--   2. organization_money_audit.changed_at defaults to now(), which is
--      TRANSACTION start - not clock_timestamp(). Cleaning up with
--      `changed_at >= clock_timestamp()` matches nothing and leaves litter.
--      Delete by organization_id instead.

drop table if exists public._guard_probe;
drop table if exists public._probe_backup;
create table public._guard_probe(column_name text primary key, refuses text, audits text, detail text);
create table public._probe_backup as
  select * from public.organizations where id = 'b177a0ea-32c6-45c9-82ac-cbb7261c2dee';

do $probe$
declare
  v_org uuid := 'b177a0ea-32c6-45c9-82ac-cbb7261c2dee';  -- Cascade Enrichment Co. (QA fixture)
  v_uid uuid := '9d73c379-79ff-469a-a1c4-ba44da9205c5';  -- its org ADMIN, NOT a platform admin
  r record; v_expr text; v_before int; v_after int;
  v_ref text; v_aud text; v_detail text;
  svc text := json_build_object('role','service_role')::text;
begin
  for r in
    select column_name, data_type from information_schema.columns
     where table_schema='public' and table_name='organizations' and column_name <> 'id'
     order by column_name
  loop
    -- A value guaranteed DIFFERENT from the current one, so IS DISTINCT FROM
    -- fires, and LEGAL under the column's CHECK constraint. A column with no
    -- legal alternative is reported unprobeable, and the test fails if it is a
    -- money column - an untested column is not a protected column.
    v_expr := case r.column_name
      when 'stripe_account_status'  then 'case when stripe_account_status = ''active'' then ''onboarding'' else ''active'' end'
      when 'status'                 then 'case when status = ''active'' then ''suspended'' else ''active'' end'
      when 'venue_model'            then 'case when venue_model = ''own_venue'' then ''partner_venues'' else ''own_venue'' end'
      when 'venue_answer'           then 'case when venue_answer = ''both'' then ''own_space'' else ''both'' end'
      when 'program_cadence'        then 'case when program_cadence = ''one_off'' then ''both'' else ''one_off'' end'
      when 'stripe_business_type'   then 'case when stripe_business_type = ''company'' then ''individual'' else ''company'' end'
      when 'stripe_country'         then 'case when stripe_country = ''US'' then ''GB'' else ''US'' end'
      when 'stripe_charge_model'    then 'case when stripe_charge_model = ''direct'' then ''destination'' else ''direct'' end'
      when 'stripe_fee_payer'       then 'case when stripe_fee_payer = ''tenant'' then ''platform'' else ''tenant'' end'
      when 'instructor_pay_model'   then 'case when instructor_pay_model = ''enrops_platform'' then ''legacy_own_platform'' else ''enrops_platform'' end'
      when 'platform_plan'          then 'case when platform_plan = ''free'' then ''pilot'' else ''free'' end'
      when 'platform_fee_card_pct'  then 'case when coalesce(platform_fee_card_pct,0) <> 0.5 then 0.5 else 0.4 end'
      when 'platform_fee_ach_pct'   then 'case when coalesce(platform_fee_ach_pct,0) <> 0.5 then 0.5 else 0.4 end'
      when 'alert_email'            then 'case when coalesce(alert_email,'''') <> ''probe@example.test'' then ''probe@example.test'' else ''probe2@example.test'' end'
      when 'statement_descriptor_suffix' then 'case when coalesce(statement_descriptor_suffix,'''') <> ''ABC'' then ''ABC'' else ''ABD'' end'
      when 'default_age_min'        then 'case when coalesce(default_age_min,0) <> 5 then 5 else 6 end'
      when 'default_age_max'        then 'case when coalesce(default_age_max,0) <> 40 then 40 else 41 end'
      else case
        -- A small sentinel, not `+ 1`: incrementing overflowed platform_fee_cap_cents
        -- and reported it unprobeable, hiding whether it was locked at all.
        when r.data_type in ('integer','bigint','smallint','numeric','real','double precision')
          then format('case when coalesce(%I,0) <> 7 then 7 else 8 end', r.column_name)
        when r.data_type = 'boolean' then format('NOT coalesce(%I,false)', r.column_name)
        when r.data_type in ('text','character varying')
          then format('case when coalesce(%I,'''') <> ''zz'' then ''zz'' else ''yy'' end', r.column_name)
        when r.data_type = 'date' then format('coalesce(%I, current_date) + 1', r.column_name)
        when r.data_type like 'timestamp%' then format('coalesce(%I, now()) + interval ''1 day''', r.column_name)
        when r.data_type = 'jsonb' then format('coalesce(%I,''{}''::jsonb) || ''{"_probe":1}''::jsonb', r.column_name)
        else null end
      end;

    if v_expr is null then
      insert into public._guard_probe values (r.column_name,'unprobeable','unprobeable','no generator for '||r.data_type);
      continue;
    end if;
    v_detail := null;

    -- PROBE A: as a plain org admin. Does the guard REFUSE?
    begin
      perform set_config('request.jwt.claims', json_build_object('sub',v_uid::text,'role','authenticated')::text, true);
      perform set_config('role','authenticated', true);
      execute format('update public.organizations set %I = %s where id = $1', r.column_name, v_expr) using v_org;
      v_ref := 'allowed';
    exception
      when insufficient_privilege then v_ref := 'refused';
      when others then v_ref := 'unprobeable'; v_detail := SQLSTATE||' '||left(SQLERRM,45);
    end;

    -- Reset BOTH the claim and the role (trap 1), then undo.
    perform set_config('request.jwt.claims', svc, true);
    perform set_config('role','service_role', true);
    execute format('update public.organizations o set %I = b.%I from public._probe_backup b where o.id = $1',
                   r.column_name, r.column_name) using v_org;

    -- PROBE B: as service_role. Is the change AUDITED?
    select count(*) into v_before from public.organization_money_audit
      where organization_id=v_org and column_name=r.column_name;
    begin
      execute format('update public.organizations set %I = %s where id = $1', r.column_name, v_expr) using v_org;
      select count(*) into v_after from public.organization_money_audit
        where organization_id=v_org and column_name=r.column_name;
      v_aud := case when v_after > v_before then 'audited' else 'not_audited' end;
    exception when others then
      v_aud := 'unprobeable'; v_detail := coalesce(v_detail,'')||' audit:'||SQLSTATE;
    end;
    perform set_config('request.jwt.claims', svc, true);
    perform set_config('role','service_role', true);
    execute format('update public.organizations o set %I = b.%I from public._probe_backup b where o.id = $1',
                   r.column_name, r.column_name) using v_org;

    insert into public._guard_probe values (r.column_name, v_ref, v_aud, v_detail);
  end loop;

  -- By organization_id, NOT by changed_at (trap 2).
  delete from public.organization_money_audit where organization_id = v_org;
end
$probe$;

-- PROVE THE FIXTURE IS EXACTLY AS IT WAS. Both numbers must be 0.
select
  (select count(*) from (
     select * from public.organizations where id='b177a0ea-32c6-45c9-82ac-cbb7261c2dee'
     except select * from public._probe_backup) d) as rows_differing_from_backup,
  (select count(*) from public.organization_money_audit
     where organization_id='b177a0ea-32c6-45c9-82ac-cbb7261c2dee') as leftover_audit_rows;

-- THE SNAPSHOT. Paste this object into moneyGuard.snapshot.json.
select json_build_object(
  'refused',     (select json_agg(column_name order by column_name) from public._guard_probe where refuses='refused'),
  'audited',     (select json_agg(column_name order by column_name) from public._guard_probe where audits='audited'),
  'unprobeable', (select coalesce(json_agg(column_name order by column_name),'[]'::json) from public._guard_probe
                    where refuses='unprobeable' or audits='unprobeable'),
  'all_columns', (select json_agg(column_name order by column_name) from public._guard_probe),
  'guard_md5',   (select md5(prosrc) from pg_proc where proname='guard_organizations_locked_columns'),
  'audit_md5',   (select md5(prosrc) from pg_proc where proname='audit_organization_money'),
  'enabled_triggers_on_organizations',
                 (select count(*) from pg_trigger where tgrelid='public.organizations'::regclass
                    and not tgisinternal and tgenabled='O')
) as snapshot;

drop table if exists public._guard_probe;
drop table if exists public._probe_backup;

-- PARITY. Run this on BOTH databases; guard_md5, audit_md5, cols_md5 and
-- enabled_triggers must match, or behaviour measured on staging does not
-- describe prod. checks_md5 is reported for information: it already differs
-- (pre-existing drift on organizations, unrelated to the guard).
--
--   select
--     (select md5(prosrc) from pg_proc where proname='guard_organizations_locked_columns') as guard_md5,
--     (select md5(prosrc) from pg_proc where proname='audit_organization_money')          as audit_md5,
--     (select md5(string_agg(column_name,',' order by column_name)) from information_schema.columns
--        where table_schema='public' and table_name='organizations')                      as cols_md5,
--     (select count(*) from pg_trigger where tgrelid='public.organizations'::regclass
--        and not tgisinternal and tgenabled='O')                                          as enabled_triggers,
--     (select md5(string_agg(conname||pg_get_constraintdef(oid),',' order by conname)) from pg_constraint
--        where conrelid='public.organizations'::regclass and contype='c')                 as checks_md5;
