-- Chunk 3 (Comms reorg): turn saved_email_templates into a SHARED template shelf
-- that holds copy for all three Comms audiences, not just family/campaign email.
--
-- Today every row is campaign/family copy (the Templates tab + campaign
-- TouchpointCard both write here). We add an `audience` dimension so instructor
-- and partner copy can live in the same org-scoped, RLS-gated shelf, and the
-- in-context send buttons (Chunk 4: availability survey, assignment/patch offers,
-- roster->partner) can read their audience's templates from it.
--
-- Additive + inert: default 'families' backfills every existing row to exactly
-- what it already is, so campaign behavior is unchanged. RLS/grants unchanged
-- (the org-admin FOR ALL policy already gates every row regardless of audience).

alter table public.saved_email_templates
  add column if not exists audience text not null default 'families';

-- Constrain to the three Comms audiences. Named + guarded so re-running is safe.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.saved_email_templates'::regclass
      and conname = 'saved_email_templates_audience_check'
  ) then
    alter table public.saved_email_templates
      add constraint saved_email_templates_audience_check
      check (audience in ('families', 'instructors', 'partners'));
  end if;
end $$;

-- The shelf is browsed one audience at a time, most-recent first (mirrors the
-- existing org_idx the list query already relies on).
create index if not exists saved_email_templates_org_audience_idx
  on public.saved_email_templates (organization_id, audience, updated_at desc);
