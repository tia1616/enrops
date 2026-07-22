-- Comms reorg: group the Automations list by LIFECYCLE STAGE so a long audience
-- list (12 family automations today) reads as a few labelled sections instead of
-- one flat pile — the standard CRM "flows by stage" pattern, in operator words.
--
-- Stage is first-class data (like audience), so the frontend groups from truth
-- instead of a hardcoded key->stage map that would drift as automations are added.
-- Additive + inert: default 'during', then each row is set explicitly. Does not
-- change sending. Parity: both envs.

alter table public.automation_templates
  add column if not exists lifecycle_stage text not null default 'during';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.automation_templates'::regclass
      and conname = 'automation_templates_lifecycle_stage_check'
  ) then
    alter table public.automation_templates
      add constraint automation_templates_lifecycle_stage_check
      check (lifecycle_stage in ('getting_started', 'during', 'wrapping_up', 'anytime'));
  end if;
end $$;

-- Explicit assignment per catalog key (the default 'during' only backstops a
-- future row someone forgets to place).
update public.automation_templates set lifecycle_stage = 'getting_started'
  where key in ('welcome_contact', 'welcome_camp', 'welcome_afterschool', 'thank_you', 'abandoned_registration');
update public.automation_templates set lifecycle_stage = 'during'
  where key in ('check_in', 'no_school_day', 'mid_recap', 'survey_nudge');
update public.automation_templates set lifecycle_stage = 'wrapping_up'
  where key in ('final_recap', 'review_request');
update public.automation_templates set lifecycle_stage = 'anytime'
  where key in ('birthday', 'instructor_birthday');
