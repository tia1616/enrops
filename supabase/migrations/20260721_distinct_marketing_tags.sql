-- distinct_marketing_tags(org) -> text[] of the distinct, non-blank tags in use
-- across an org's marketing_recipients.
--
-- Replaces a `.limit(2000)` client read (ContactsTab: the tag-filter dropdown
-- and the import tag autocomplete) that shipped every recipient's `tags` array
-- to the browser and deduped there. Past 2000 rows it silently dropped tags
-- (J2S has 2500+ contacts), so a tag only present on tail rows vanished from the
-- picker. This computes the distinct set server-side in one pass instead.
--
-- SECURITY INVOKER: runs as the caller, so the marketing_recipients RLS policy
-- (check_org_access(organization_id)) still gates rows to the caller's org. The
-- p_org filter is belt-and-suspenders + lets the planner use the org index; a
-- caller passing another org's id gets an empty array (RLS filters it out).
--
-- Returns tags RAW (no trim): the picker option is queried back verbatim against
-- the stored tags array, so trimming would make a ' VIP '-tagged contact
-- unmatchable by a 'VIP' option. Skips only null / empty-string, matching the
-- old client dedup's `if (t)` truthiness.
create or replace function public.distinct_marketing_tags(p_org uuid)
returns text[]
language sql
security invoker
stable
set search_path to 'public'
as $$
  select coalesce(array_agg(distinct tag order by tag), '{}')
  from marketing_recipients mr
  cross join lateral unnest(mr.tags) as tag
  where mr.organization_id = p_org
    and mr.tags is not null
    and tag is not null
    and tag <> '';
$$;

-- Least privilege: only signed-in users (and the service role) may call it;
-- never anon. Supabase's default privileges grant execute to anon directly (not
-- only via PUBLIC), so anon must be revoked explicitly too.
revoke all on function public.distinct_marketing_tags(uuid) from public;
revoke execute on function public.distinct_marketing_tags(uuid) from anon;
grant execute on function public.distinct_marketing_tags(uuid) to authenticated, service_role;
