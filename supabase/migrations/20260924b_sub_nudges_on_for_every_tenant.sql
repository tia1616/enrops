-- Turn the sub-offer nudge chaser ON, for every tenant.
--
-- Jessica, 2026-09-24: "if it's gauntleted and code-reviewed (if needed) make
-- it live for me and tenants." The gauntlet ran first and found ten defects
-- across two rounds - a roster leak through the dry-run response and a family
-- of failures that logged themselves as quiet days - all closed before this.
--
-- WHY THE DEFAULT FLIPS TOO, and not just the existing rows. A per-tenant
-- opt-in that defaults FALSE means every tenant onboarded from tomorrow
-- silently does not get this, and somebody has to remember to switch them on
-- one at a time. That is the opposite of building forward for new tenants.
-- Defaulting TRUE turns the column into what it should be: a kill switch, off
-- for a tenant only when somebody deliberately turns it off.
--
-- WHAT THIS ACTUALLY STARTS. The cron runs daily and chases a class-day nobody
-- has answered: instructors at T-8 and T-4, the provider at T-7 and T-3. It
-- only ever looks at offers whose email really left, it stops entirely the
-- moment somebody accepts, and a stage is claimed under a unique index before
-- any email goes, so a stage cannot send twice.
--
-- REVERSIBLE, per tenant or entirely:
--   update public.organizations set sub_nudges_enabled = false;            -- everybody
--   update public.organizations set sub_nudges_enabled = false where id = ...;  -- one

alter table public.organizations
  alter column sub_nudges_enabled set default true;

-- Existing tenants, including the ones with no instructors yet. Inert for any
-- tenant with no unanswered sub day; there is nothing for the cron to find.
update public.organizations
   set sub_nudges_enabled = true
 where sub_nudges_enabled is distinct from true;

comment on column public.organizations.sub_nudges_enabled is
  'When true, sub-offer-nudges-cron may email this org''s instructors and its '
  'alert_email about class-days nobody has answered. Defaults TRUE: this is a '
  'kill switch, not an opt-in, so a tenant onboarded tomorrow gets the chaser '
  'without anybody remembering to switch it on. Set false to silence one org.';
