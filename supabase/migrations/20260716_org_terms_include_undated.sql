-- org_terms() previously only surfaced a term if at least one of its programs
-- had a computable session date (first_session_date set). A term with real,
-- fully-configured program rows (curriculum, day, time, location) but no
-- confirmed first session date yet — the normal state for a future term
-- before the school calendar is set — silently vanished from every term
-- picker (Scheduled Programs, Schedule, Survey Responses) even though the
-- programs exist and are editable.
--
-- Fix: LEFT JOIN the derived dates instead of CROSS JOIN, so a term with
-- programs but no dates still surfaces a row (starts_on/ends_on = null,
-- status = 'undated'). Ranked last for is_default so an actual dated term
-- is still preferred as the default selection.
create or replace function public.org_terms(p_org uuid)
returns table(term text, starts_on date, ends_on date, status text, is_default boolean)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  with ranges as (
    select p.term,
           min(d) as starts_on,
           max(d) as ends_on
    from programs p
    left join lateral unnest(derive_program_session_dates(p.id)) as d on true
    where p.organization_id = p_org
      and p.term is not null
      and is_org_member(p_org)
    group by p.term
  ),
  classified as (
    select term, starts_on, ends_on,
      case
        when starts_on is null then 'undated'
        when current_date between starts_on and ends_on then 'in_progress'
        when starts_on > current_date then 'upcoming'
        else 'past'
      end as status,
      case
        when starts_on is null then 3
        when current_date between starts_on and ends_on then 0
        when starts_on > current_date then 1
        else 2
      end as bucket
    from ranges
  ),
  ranked as (
    select *,
      row_number() over (
        order by bucket asc,
          case when bucket = 2 then ends_on end desc,
          starts_on asc
      ) as rn
    from classified
  )
  select term, starts_on, ends_on, status, (rn = 1) as is_default
  from ranked
  order by starts_on asc nulls last;
$function$;
