-- program_build_timings — how long it actually takes to stand up a program.
--
-- Exists because the onboarding step strip wants to say "your first program takes
-- about N minutes", and we refused to print a number we had never measured. This
-- is what turns that into a real figure instead of a guess.
--
-- It captures BOTH numbers the strip needs from one source: `was_first` splits
-- the first program (the long one, three steps) from every program after it (the
-- two-step one). Deriving both from the same table is deliberate - two figures
-- computed in two places is exactly how they end up disagreeing.
--
-- started_at comes from the client (when the builder mounted); completed_at is
-- server-side now(). The client could send a nonsense started_at, but these are
-- our own operators recording their own effort, with nothing to gain - and the
-- CHECK below rejects the one shape that would poison an average silently, a
-- start after the finish. Sessions where somebody left the tab open for an hour
-- are real data too, and get filtered when the median is computed rather than
-- being thrown away here.
--
-- Nothing reads this yet. That is the point: collect first, print the number once
-- there is enough of it to mean anything.

create table if not exists public.program_build_timings (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  program_id       uuid references public.programs(id) on delete set null,
  was_first        boolean not null,
  started_at       timestamptz not null,
  completed_at     timestamptz not null default now(),
  constraint program_build_timings_finish_after_start check (completed_at >= started_at)
);

create index if not exists program_build_timings_org_idx
  on public.program_build_timings (organization_id, completed_at desc);

alter table public.program_build_timings enable row level security;

-- Read: an operator can see their own org's rows; platform admin sees all, which
-- is what computing a cross-tenant median needs.
drop policy if exists program_build_timings_select on public.program_build_timings;
create policy program_build_timings_select
  on public.program_build_timings for select
  to authenticated
  using (public.is_org_member(organization_id) or public.is_platform_admin());

-- Write: only somebody who could have built the program in the first place, AND
-- the referenced program must belong to the same org.
--
-- That second half was missing at first and a security pass caught it. Checking
-- only can_edit_org(organization_id) validates the org column and says nothing
-- about program_id, so a member of org A could file a timing row against org A
-- referencing a program in org B. Program UUIDs are not secret - they are in
-- every public share link, /<slug>?program=<id> - so the id needed is trivially
-- obtainable. Nothing leaks (the attacker supplies the id they already have),
-- but it lets one tenant write a foreign reference into a table we intend to
-- compute cross-tenant medians from, which is the shape of finding iii: enforce
-- same-org on EVERY referenced row, not just the obvious one.
--
-- The EXISTS runs under the caller's own RLS, so it fails closed twice over: a
-- program they cannot see cannot satisfy it either.
--
-- INSERT is the only verb the client uses - there is no upsert here, so no
-- UPDATE policy is needed and none is granted.
drop policy if exists program_build_timings_insert on public.program_build_timings;
create policy program_build_timings_insert
  on public.program_build_timings for insert
  to authenticated
  with check (
    public.can_edit_org(organization_id)
    and (
      program_id is null
      or exists (
        select 1 from public.programs p
        where p.id = program_build_timings.program_id
          and p.organization_id = program_build_timings.organization_id
      )
    )
  );

grant select, insert on public.program_build_timings to authenticated;
