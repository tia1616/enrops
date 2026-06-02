-- When a parent registers a kid through Enrops, their email should flow into
-- marketing_recipients automatically so:
--   1. They appear in audience-resolution for future campaigns
--   2. They can receive schedule-change / cancellation / instructor-swap
--      transactional emails (which today still go through marketing_recipients
--      because the transactional/promotional separation is future work).
--
-- Surfaced 2026-06-02 during J2S FA26 ship: 10 registered parents but only 7
-- in marketing_recipients. Cumulative gap across all J2S history: 27 parents.

-- Per-org opt-out. Default true (industry-standard CAN-SPAM-compliant behavior).
-- A tenant in a stricter jurisdiction (GDPR, double-opt-in policy) can flip
-- this to false and use their own subscription flow.
alter table organizations
  add column if not exists auto_subscribe_registrants boolean not null default true;

comment on column organizations.auto_subscribe_registrants is
  'When true (default), confirmed registrations auto-upsert into marketing_recipients via the auto_add_registrant_to_marketing_list() trigger. Every email has an unsubscribe link, so this is CAN-SPAM compliant. Set false for stricter-consent jurisdictions.';

-- Trigger function. Runs on registration confirmation. Joins parents (for
-- email + name) and students (for child name + school's program_location_id),
-- then upserts the marketing_recipients row. Honors the per-org opt-out.
-- Required source value is 'enrops_registration' per marketing_recipients_source_check.
create or replace function auto_add_registrant_to_marketing_list()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auto_enabled  boolean;
  v_parent_email  text;
  v_parent_name   text;
  v_child_first   text;
  v_child_last    text;
  v_school_name   text;
begin
  if (TG_OP = 'UPDATE') then
    if NEW.status is not distinct from OLD.status then return NEW; end if;
  end if;
  if NEW.status is null or NEW.status <> 'confirmed' then return NEW; end if;

  select auto_subscribe_registrants into v_auto_enabled
  from organizations where id = NEW.organization_id;
  if v_auto_enabled is not true then return NEW; end if;

  select p.email, nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')
    into v_parent_email, v_parent_name
  from parents p where p.id = NEW.parent_id;
  if v_parent_email is null then return NEW; end if;

  select s.first_name, s.last_name, pl.name
    into v_child_first, v_child_last, v_school_name
  from students s
  left join program_locations pl on pl.id = s.program_location_id
  where s.id = NEW.student_id;

  insert into marketing_recipients (
    organization_id, email, parent_name, child_first_name, child_last_name,
    school_name, source, segments
  )
  values (
    NEW.organization_id,
    lower(v_parent_email),
    v_parent_name,
    v_child_first,
    v_child_last,
    v_school_name,
    'enrops_registration',
    array['registrant']::text[]
  )
  on conflict do nothing;

  return NEW;
end;
$$;

comment on function auto_add_registrant_to_marketing_list() is
  'Upserts the registering parent into marketing_recipients on registration confirmation. Honors organizations.auto_subscribe_registrants. CAN-SPAM compliant via the always-on unsubscribe link in every send.';

drop trigger if exists trg_auto_add_registrant_to_marketing_list on registrations;
create trigger trg_auto_add_registrant_to_marketing_list
  after insert or update of status on registrations
  for each row
  execute function auto_add_registrant_to_marketing_list();

-- Backfill ran via execute_sql on 2026-06-02 (not in this migration to keep
-- DDL pure):
--   - 27 historical J2S parents added to marketing_recipients
--   - 3 of those resolved a school_name via their program's location; 24 are
--     historical registrations with no resolvable school link (old programs)
