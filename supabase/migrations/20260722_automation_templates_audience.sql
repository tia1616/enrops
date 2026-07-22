-- Comms reorg: make audience a FIRST-CLASS dimension on the automations catalog,
-- so the Automations tab can filter by Families / Instructors / Partners (the same
-- audience spine as Comms>Contacts and Comms>Templates), and the row chip reads
-- from data instead of a trigger_type special-case.
--
-- Additive + inert: default 'families' backfills every existing catalog row to
-- what it already is (all current automations are family/parent sends). We then
-- mark the one instructor automation. Does NOT change sending — the cron still
-- routes by trigger_type; audience is a UX/metadata dimension. Parity: both envs.

alter table public.automation_templates
  add column if not exists audience text not null default 'families';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.automation_templates'::regclass
      and conname = 'automation_templates_audience_check'
  ) then
    alter table public.automation_templates
      add constraint automation_templates_audience_check
      check (audience in ('families', 'instructors', 'partners'));
  end if;
end $$;

-- The one instructor-audience automation shipped so far. (partner_roster, when it
-- lands, inserts with audience='partners'.)
update public.automation_templates set audience = 'instructors'
  where key = 'instructor_birthday';
