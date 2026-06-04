\set ON_ERROR_STOP on
begin;

-- 1) Clean slate: remove the earlier STEAMworks synthetic data + globals we will reload
truncate public.organizations cascade;
truncate public.parents cascade;
truncate public.partners cascade;
truncate public.available_fonts cascade;
truncate public.capability_definitions cascade;
truncate public.automation_templates cascade;
truncate public.legal_documents cascade;
truncate public.waivers cascade;
delete from auth.identities where user_id in (select id from auth.users where email like '%@staging.enrops.test');
delete from auth.users where email like '%@staging.enrops.test';

-- 2) Back up + drop FK constraints on the whitelist tables (needed to COPY self-refs + auth-refs)
create temp table _fkbak(tbl text, conname text, def text) on commit drop;
insert into _fkbak
select c.conrelid::regclass::text, c.conname, pg_get_constraintdef(c.oid)
from pg_constraint c
where c.contype='f' and c.connamespace='public'::regnamespace
  and c.conrelid::regclass::text = any(array[
    'organizations','org_branding','org_policies','enrollment_types','pricing_rules',
    'venue_regions','district_calendars','available_fonts','capability_definitions','capability_unlock_states',
    'automations','automation_templates','marketing_campaigns','marketing_campaign_touchpoints','promo_codes',
    'custom_reg_fields','program_fit_texts','partners','program_locations','curricula','curriculum_sessions',
    'curriculum_extracted_fields','curriculum_documents','programs','scheduling_cycles','camp_sessions',
    'legal_documents','waivers']);
do $$ declare r record; begin
  for r in select tbl, conname from _fkbak loop
    execute format('alter table public.%I drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

-- 3) Load the real catalog/config data (search_path must include public so
--    validation triggers like program_locations_partner_same_org resolve)
set search_path = public, extensions, pg_catalog;
\i .tmp/catalog_data.sql
reset search_path;

-- 4) Null dangling auth.users references
update public.curricula                 set created_by=null;
update public.curriculum_extracted_fields set human_approved_by=null;
update public.district_calendars        set created_by=null;
update public.marketing_campaigns       set approved_by=null;
update public.promo_codes               set created_by=null;

-- 5) Scrub org secrets/email + venue contact PII
update public.organizations set
  stripe_account_id            = case when stripe_account_id is not null then 'acct_staging_fake' else null end,
  stripe_last_account_event_id = null,
  apps_script_sync_secret      = null,
  alert_email                  = 'staging-alerts@staging.enrops.test',
  default_sender_email         = case when default_sender_email is not null then 'hello@staging.enrops.test' else null end,
  email                        = case when email is not null then 'hello@staging.enrops.test' else null end,
  phone                        = null,
  sending_domain               = null;
update public.program_locations set contact_name=null, contact_email=null, contact_phone=null;

-- 6) Re-add the FK constraints
do $$ declare r record; begin
  for r in select tbl, conname, def from _fkbak loop
    execute format('alter table public.%I add constraint %I %s', r.tbl, r.conname, r.def);
  end loop;
end $$;

commit;
