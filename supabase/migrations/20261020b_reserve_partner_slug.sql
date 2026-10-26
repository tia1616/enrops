-- /partner is now the neutral partner home (spec v3 H1), a static route that
-- outranks /:slug. A provider whose slug was "partner" would have a public page
-- nobody could reach, so the word joins the reserved slugs in both places that
-- hand out slugs: provision_operator_org (signup) and rename_org_slug.
-- No organization uses "partner" or "partners" on either database (checked
-- 2026-10-20). Each function is redefined from its LIVE text with only the
-- array literal changed, so nothing else in it can drift.

do $$
declare
  fn text;
  def text;
  patched text;
begin
  foreach fn in array array['provision_operator_org', 'rename_org_slug'] loop
    select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = fn;
    if def is null then
      raise exception 'function % not found', fn;
    end if;
    if position('''partner''' in def) > 0 then
      continue; -- already reserved
    end if;
    patched := replace(def, '''pricing''];', '''pricing'',''partner'',''partners''];');
    if patched = def then
      raise exception 'reserved-slug list not found in %', fn;
    end if;
    execute patched;
  end loop;
end $$;
