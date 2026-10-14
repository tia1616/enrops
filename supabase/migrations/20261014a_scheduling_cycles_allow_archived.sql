-- The admin Schedule page's "Archive cycle" button writes status='archived',
-- and every reader that hides a finished camp round (instructor portal,
-- admin overview, survey responses, the Schedule term picker) filters on
-- 'archived'. The CHECK never allowed it, so the button has failed with a
-- check violation since it shipped and no camp round could ever be archived:
-- on 2026-10-14 all 49 confirmed SU26 camps still sat on instructors'
-- current schedules, and one July offer still showed Accept.
--
-- Additive: every existing row still passes.
alter table public.scheduling_cycles drop constraint if exists scheduling_cycles_status_check;
alter table public.scheduling_cycles add constraint scheduling_cycles_status_check
  check (status = any (array['collecting'::text, 'scheduling'::text, 'published'::text, 'closed'::text, 'archived'::text]));
