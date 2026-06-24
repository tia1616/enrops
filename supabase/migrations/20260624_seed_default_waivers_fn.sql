-- seed_default_waivers(p_org_id): copy the platform default waivers into a tenant.
--
-- Platform default waiver templates live as rows under the Enrops org
-- (slug='enrops'), with the operator name tokenized as {{org}}. This function
-- (admin-gated, SECURITY DEFINER) copies those active templates into the target
-- org, substituting the org's real name for {{org}}. SECURITY DEFINER so it can
-- read the platform templates + insert across the per-org RLS boundary.
--
-- DATA NOTE (per environment): the Enrops-org template rows are derived from
-- J2S's two waivers (Program Fit Acknowledgment + Waiver and Agreement) with
-- 'Journey to STEAM[ LLC]' -> '{{org}}' and J2S contact info -> placeholders.
-- Seed them once per environment (staging done 2026-06-24; prod when promoted)
-- so this function has templates to copy.

create or replace function public.seed_default_waivers(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_platform uuid;
  v_name text;
  v_count int := 0;
begin
  if not public.can_admin_org(p_org_id) then
    raise exception 'forbidden';
  end if;
  select name into v_name from organizations where id = p_org_id;
  select id into v_platform from organizations where slug = 'enrops';
  if v_platform is null then return 0; end if;
  insert into public.waivers (organization_id, name, content, required, active)
  select p_org_id, w.name,
         replace(w.content, '{{org}}', coalesce(nullif(btrim(v_name), ''), 'our program')),
         w.required, true
  from public.waivers w
  where w.organization_id = v_platform and w.active = true;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.seed_default_waivers(uuid) from public, anon;
grant execute on function public.seed_default_waivers(uuid) to authenticated;
