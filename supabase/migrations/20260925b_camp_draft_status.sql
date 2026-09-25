-- A camp can be a draft, the same way a class can.
--
-- programs.status has been draft / open / closed / cancelled for as long as the
-- builders have existed, and "Save as draft" is how an operator sets a class up
-- before the price or the dates are settled. camp_sessions.status allowed only
-- active / cancelled, so the camp branch of the builder wrote 'active' whichever
-- button was pressed: Save as draft PUBLISHED a camp families could register for.
--
-- Rather than invent a camp-shaped answer - hiding the button, or a second flag -
-- camps get the state programs already have. 'draft' is additive; every existing
-- row stays 'active'.
--
-- WHO READS camp_sessions.status, checked before adding the value:
--   ALLOW-LIST, already correct - a draft is excluded for free:
--     Schedule.jsx and SchedulePrint.jsx (.eq 'active') - the board and the
--       printable schedule
--     AdminOverview.jsx (.eq 'active') - open-hire counts
--   DENY-LIST, fixed in the same commit because 'not cancelled' silently
--   admits a new value:
--     marketing-v2 Q1_What (.neq 'cancelled') - would have offered a draft camp
--       as something to advertise
--     marketing-v2 periodDetection (no status filter at all) - would have
--       counted drafts as camps in flight
--   DELIBERATELY UNCHANGED:
--     Rosters.jsx lists every camp and guards the row by status. The programs
--       half of that same screen lists drafts too, so a draft camp appearing
--       there is the sibling's behaviour, not a gap.
--
-- This is the deny-list trap the repo has been bitten by before: adding a value
-- to an enum is only safe once every 'is not X' reader has been read.

alter table public.camp_sessions
  drop constraint if exists camp_sessions_status_check;

alter table public.camp_sessions
  add constraint camp_sessions_status_check
  check (status = any (array['active'::text, 'draft'::text, 'cancelled'::text]));

comment on column public.camp_sessions.status is
  'active = running and sellable, draft = set up but private, cancelled = not running. Mirrors programs.status, minus "closed" which camps have no equivalent of. Readers that mean "sellable" must test = active, never <> cancelled.';
