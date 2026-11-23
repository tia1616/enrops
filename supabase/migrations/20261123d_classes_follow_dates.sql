-- 20261123d: a self-serve provider's classes are filed by their own dates.
--
-- The bug (Jessica 2026-11-20, "that's a big mistake"): every business was
-- created with active_registration_term = 'FA26' (a hardcoded column default),
-- and the quick class builder filed EVERY class under that open term. So a class
-- starting in January was saved as Fall 2026 and shown to families as Fall.
-- On prod 11/20 Branching Minds had two January classes filed under FA26.
--
-- The fix, for providers who never think in seasons:
--   1. classes_follow_dates (config, never a tenant check). TRUE for own_venue
--      orgs (every self-serve signup is own_venue). FALSE for partner_venues orgs,
--      which run on school-year seasons and switch them by hand on Programs
--      (J2S, Ukulele, and the other school-partner orgs, on both environments).
--   2. term_for_date(): the season a date falls in. Same rule as the app's
--      campTermForDate (Dec -> next year's WI, Jan-Feb WI, Mar-May SP, Jun-Aug SU,
--      Sep-Nov FA). The class builder files a class under the season of its first
--      meeting day for these orgs.
--   3. New orgs start on TODAY's season, not a hardcoded 'FA26'.
--   4. A nightly job moves a date-following org's open season forward to today's.
--      Forward only: it never moves a season back, and never touches an org that
--      manages its own seasons.
-- The app then sells a date-following org's classes from its open season and the
-- three after it (src/lib/classSeasons.js), so a January class is on sale in
-- November without anyone switching anything.

alter table public.organizations
  add column if not exists classes_follow_dates boolean not null default true;

comment on column public.organizations.classes_follow_dates is
  'TRUE: classes are filed under the season of their first date and sold from the open season plus the next three; '
  'the open season advances nightly. FALSE: the org switches its open season by hand (school-year providers).';

-- Backfill by setup type (config), on whatever environment this runs.
update public.organizations
   set classes_follow_dates = (venue_model = 'own_venue')
 where classes_follow_dates is distinct from (venue_model = 'own_venue');

create or replace function public.term_for_date(d date)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when d is null then null
    when extract(month from d) = 12 then 'WI' || lpad(((extract(year from d)::int + 1) % 100)::text, 2, '0')
    when extract(month from d) <= 2  then 'WI' || lpad((extract(year from d)::int % 100)::text, 2, '0')
    when extract(month from d) <= 5  then 'SP' || lpad((extract(year from d)::int % 100)::text, 2, '0')
    when extract(month from d) <= 8  then 'SU' || lpad((extract(year from d)::int % 100)::text, 2, '0')
    else                                  'FA' || lpad((extract(year from d)::int % 100)::text, 2, '0')
  end
$$;

-- Season order: WI27 < SP27 < SU27 < FA27 < WI28. NULL for a non-season code.
create or replace function public.term_ordinal(t text)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when t ~ '^(WI|SP|SU|FA)[0-9]{2}$' then
      (substring(t from 3 for 2)::int) * 4
      + case substring(t from 1 for 2) when 'WI' then 0 when 'SP' then 1 when 'SU' then 2 else 3 end
    else null
  end
$$;

grant execute on function public.term_for_date(date) to anon, authenticated, service_role;
grant execute on function public.term_ordinal(text) to anon, authenticated, service_role;

-- New orgs start on today's season (Pacific; the nightly job corrects for the
-- org's own timezone on a season-boundary day).
alter table public.organizations
  alter column active_registration_term
  set default public.term_for_date((now() at time zone 'America/Los_Angeles')::date);

create or replace function public.advance_date_following_terms()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  update public.organizations o
     set active_registration_term = public.term_for_date((now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date)
   where o.classes_follow_dates
     and (
       public.term_ordinal(o.active_registration_term) is null
       or public.term_ordinal(o.active_registration_term)
          < public.term_ordinal(public.term_for_date((now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date))
     );
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.advance_date_following_terms() is
  'Nightly (pg_cron advance-date-following-terms, 08:10 UTC). Moves each classes_follow_dates org''s open season '
  'FORWARD to the season of its local today. Never backwards; never an org that switches seasons by hand.';

revoke all on function public.advance_date_following_terms() from public, anon, authenticated;
grant execute on function public.advance_date_following_terms() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'advance-date-following-terms') then
    perform cron.unschedule('advance-date-following-terms');
  end if;
  perform cron.schedule('advance-date-following-terms', '10 8 * * *',
    $job$ select public.advance_date_following_terms() $job$);
end;
$$;

-- Bring every date-following org to today's season now.
select public.advance_date_following_terms();
