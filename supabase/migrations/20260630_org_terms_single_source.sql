-- Single source of truth for an org's afterschool terms + which one is "current".
-- Replaces hardcoded TERM_OPTIONS / "FA26" defaults across admin term-scoped views.
-- Term date range is derived from the canonical derive_program_session_dates()
-- (never hand-rolled date math). "Default" term = in-progress (today within range);
-- else the next term starting; else the most-recent past term. Chronological order
-- for dropdowns. Multi-tenant: returns rows only to a member of p_org.
--
-- Applied to staging (mumfymlapolsfdnpewci) + prod (iuasfpztkmrtagivlhtj) via MCP
-- on 2026-06-30; this file is the repo record for parity.
create or replace function public.org_terms(p_org uuid)
returns table(term text, starts_on date, ends_on date, status text, is_default boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  with ranges as (
    select p.term,
           min(d) as starts_on,
           max(d) as ends_on
    from programs p
    cross join lateral unnest(derive_program_session_dates(p.id)) as d
    where p.organization_id = p_org
      and p.term is not null
      and is_org_member(p_org)
    group by p.term
  ),
  classified as (
    select term, starts_on, ends_on,
      case
        when current_date between starts_on and ends_on then 'in_progress'
        when starts_on > current_date then 'upcoming'
        else 'past'
      end as status,
      case
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
  order by starts_on asc;
$$;

revoke all on function public.org_terms(uuid) from public, anon;
grant execute on function public.org_terms(uuid) to authenticated;
