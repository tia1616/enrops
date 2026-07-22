-- Comms reorg: an automation can reach MORE THAN ONE audience. no_school_day
-- already emails BOTH families (editable parent copy) and the assigned instructor
-- (fixed instructor copy), so it must appear under Families AND Instructors — a
-- single `audience` value couldn't express that, which wrongly hid it from the
-- Instructors filter.
--
-- Add `audiences text[]` (the membership set the Automations filter reads),
-- backfilled from the singular `audience`, and mark no_school_day dual. Keep the
-- singular `audience` column (harmless primary/home) so the currently-deployed
-- frontend keeps working until the new build ships. Additive + inert; parity.

alter table public.automation_templates
  add column if not exists audiences text[] not null default array['families']::text[];

-- Backfill every row's membership from its current single audience.
update public.automation_templates set audiences = array[audience];

-- no_school_day reaches families + instructors.
update public.automation_templates
  set audiences = array['families', 'instructors']
  where key = 'no_school_day';

-- Constrain the array to the known audiences + require at least one.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.automation_templates'::regclass
      and conname = 'automation_templates_audiences_check'
  ) then
    alter table public.automation_templates
      add constraint automation_templates_audiences_check
      check (audiences <@ array['families','instructors','partners']::text[]
             and array_length(audiences, 1) >= 1);
  end if;
end $$;
