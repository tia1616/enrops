-- A camp does not have to be LEGO, coding or robotics.
--
-- camp_sessions.curriculum_category was NOT NULL with a CHECK allowing exactly
-- 'lego', 'coding' and 'robotics'. That is Journey to STEAM's vocabulary written
-- into the schema as a requirement for every tenant, so Riverbend Arts Academy -
-- or a ukulele school, or a chess club - literally cannot store a camp. It only
-- went unnoticed because J2S was the only org with camps and every one of theirs
-- is one of those three.
--
-- The category exists to match instructors to subjects they prefer
-- (instructor_curriculum_preferences keys on it). An org that does not run that
-- matching has no use for it, so it becomes optional rather than gaining a
-- meaningless fourth value.
--
-- The existing CHECK is left exactly as it is: a CHECK passes when its expression
-- is NULL, so dropping NOT NULL is the whole change. Adding 'other' to the list
-- instead would have put a J2S-shaped answer in every other tenant's data.
--
-- Checked every reader first. The only place a SESSION's category is read is the
-- schedule board's "marked X as not preferred" warning, which fires only when a
-- preference row matches the pair (instructor_id, category) - and no row can
-- match a NULL category, so the warning simply never fires. The other references
-- read instructor preferences, not sessions.

alter table public.camp_sessions
  alter column curriculum_category drop not null;

comment on column public.camp_sessions.curriculum_category is
  'Optional subject tag, used only to match instructors against the subjects they prefer. NULL for orgs that do not run instructor matching. Constrained to lego/coding/robotics when set - that list is J2S vocabulary, so prefer NULL over forcing a camp into it.';
