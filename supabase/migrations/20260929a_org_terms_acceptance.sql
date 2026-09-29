-- Terms version tracking and acceptance, per organisation.
--
-- Money layer (17 Sept 2026) item 7: "Terms version tracking and re-accept at
-- login. Small, and needed before the new Terms publish, which is before ship
-- day." Section 12 sets the shape: "Acceptance tracked by version and date for
-- each organisation" and "Businesses on older Terms re-accept at next login".
--
-- WHY THIS IS THE NEXT ITEM AND NOT ITEM 4. Items 4 (bank transfer as a
-- discount) and 5 (the cover-the-fee toggle) are already built and live; item 6
-- has no live plan above four instalments to cap. Item 7 is the only remaining
-- item the doc places BEFORE ship day, because the new Terms cannot publish
-- without it.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO. It seeds no Terms version.
-- Arielle owns the 5a wording and the version number, and the doc still lists
-- that as open. With no version on record nothing is out of date, so no gate can
-- fire and no operator sees anything. The machinery lands inert and the content
-- switches it on later, which is the fail-safe half first: shipped early it does
-- nothing, whereas a gate shipped with a version and no acceptances would greet
-- every business at once.
--
-- AND THAT IS NOT HYPOTHETICAL. Operator signup has never captured Terms
-- acceptance - there is no "I agree" anywhere in it - so on 2026-09-29 the
-- acceptance count for all eleven live organisations is zero, J2S included. The
-- day a version is recorded, every one of them is on older Terms
-- simultaneously. That is the evidence behind gating narrowly rather than
-- locking anyone out.
--
-- WHAT THE UI ACTUALLY DOES, since an earlier version of this comment said
-- "warning everywhere" and that is NOT what was built. There is no warning
-- anywhere except the money page itself: no admin-shell banner, because a
-- disclosure that follows an operator across every screen until they answer it
-- was ruled out on 2026-07-30. Three writes are refused until the terms are
-- accepted - who pays the enrops service fee, the statement descriptor, and the
-- withdrawal admin fee - and the prompt to accept sits at the top of that same
-- page. Every number on it stays readable; nothing else in the product changes.

-- ── where the current version lives ────────────────────────────────────────
-- NOT a new table and NOT a constant in code. platform_settings is already the
-- single-source key/value config table that default_fee_config uses, and the
-- rule against a second spelling of one number applies to this one too. The row
-- is written when Arielle settles the wording:
--
--   insert into platform_settings (key, value) values
--     ('current_terms', '{"version":"5.0","effective_date":"2026-10-15"}'::jsonb);
--
-- Reading it back with no row is the inert state, handled in the function below.

-- ── the acceptance record ──────────────────────────────────────────────────
create table if not exists public.org_terms_acceptances (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  terms_version       text not null,
  accepted_at         timestamptz not null default now(),
  accepted_by_user_id uuid not null references auth.users(id),
  -- Captured AT THE TIME. A user can change their email later, and the record of
  -- who agreed to what must not move when they do.
  accepted_by_email   text,
  created_at          timestamptz not null default now(),
  -- Accepting the same version twice is one acceptance, so a double-click or a
  -- retry cannot mint a second row. A NEW version is a new row, which is the
  -- history the doc asks for.
  constraint org_terms_acceptances_once_per_version unique (organization_id, terms_version)
);

comment on table public.org_terms_acceptances is
  'Which Terms version each organisation accepted, and when. Append-only: an acceptance is evidence of what a business agreed to, so it is never updated or deleted, not even by the service role. Money layer item 7, section 12.';

create index if not exists org_terms_acceptances_org_accepted_idx
  on public.org_terms_acceptances (organization_id, accepted_at desc);

-- ── append-only, enforced where it cannot be bypassed ──────────────────────
-- RLS alone would not do it: the service role bypasses RLS entirely, and every
-- edge function here runs as service role. A trigger binds that path too, which
-- is the point - the record has to survive our own code being wrong.
create or replace function public.org_terms_acceptances_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'org_terms_acceptances is append-only: an acceptance records what a business agreed to and cannot be % (org %, version %)',
    lower(tg_op), coalesce(old.organization_id::text, '?'), coalesce(old.terms_version, '?')
    using errcode = 'TR001';
end;
$$;

comment on function public.org_terms_acceptances_append_only() is
  'Refuses UPDATE and DELETE on org_terms_acceptances, including from the service role. Raises TR001, a private errcode - never a P0xxx, which is plpgsql''s own class.';

drop trigger if exists org_terms_acceptances_no_update on public.org_terms_acceptances;
create trigger org_terms_acceptances_no_update
  before update on public.org_terms_acceptances
  for each row execute function public.org_terms_acceptances_append_only();

drop trigger if exists org_terms_acceptances_no_delete on public.org_terms_acceptances;
create trigger org_terms_acceptances_no_delete
  before delete on public.org_terms_acceptances
  for each row execute function public.org_terms_acceptances_append_only();

-- AND TRUNCATE, WHICH THE TWO ABOVE DO NOT COVER. They are FOR EACH ROW, and
-- TRUNCATE fires neither - so "append-only, not even for service_role" was false
-- for the one operation that removes every row at once. service_role held the
-- privilege and every edge function runs as service_role, so a cleanup script
-- walking tables would have destroyed the only record of what each business
-- agreed to, silently. Statement-level trigger AND the privilege revoked: the
-- trigger is the guarantee, the revoke makes the refusal happen a step earlier.
create or replace function public.org_terms_acceptances_no_truncate()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'org_terms_acceptances is append-only and cannot be truncated: it is the only record of what each business agreed to'
    using errcode = 'TR002';
end;
$$;

comment on function public.org_terms_acceptances_no_truncate() is
  'Refuses TRUNCATE on org_terms_acceptances, including from service_role. The row-level triggers cover UPDATE and DELETE; TRUNCATE fires neither, which is how an append-only table loses every row at once.';

drop trigger if exists org_terms_acceptances_no_truncate on public.org_terms_acceptances;
create trigger org_terms_acceptances_no_truncate
  before truncate on public.org_terms_acceptances
  for each statement execute function public.org_terms_acceptances_no_truncate();

revoke truncate on public.org_terms_acceptances from service_role;

-- ── who may read and write it ──────────────────────────────────────────────
alter table public.org_terms_acceptances enable row level security;

-- GRANTS FIRST, AND THEY ARE NOT OPTIONAL. Policies FILTER a privilege, they do
-- not confer one. Without the INSERT grant every Accept press failed 42501 -
-- permission denied for the TABLE - before RLS was ever consulted, and because a
-- policy existed it looked like an RLS refusal. 42501 means GRANT, an empty
-- result means RLS; that is the rule, and it is here because I read it the wrong
-- way round on the first pass and shipped an accept button that could not work.
--
-- anon is revoked rather than merely unpolicied. RLS was already blocking it, so
-- nothing leaked, but a privilege nobody can justify is how 2026-08-20 started.
--
-- UPDATE and DELETE are granted to NOBODY, deliberately: the table is
-- append-only, the triggers enforce it even for service_role, and withholding
-- the privilege makes the refusal happen a step earlier still.
grant insert, select on public.org_terms_acceptances to authenticated;
revoke all on public.org_terms_acceptances from anon;

-- ACCEPTING BINDS THE BUSINESS, so it is the owner's to do, not an admin's.
-- is_org_owner is the existing spelling of that rule; can_handle_money would be
-- wrong here because it also admits admins.
-- AND THE SIGNER MUST BE THE CALLER. An earlier version of this policy checked
-- only that the caller owns the organisation, so the caller could put ANY user
-- id in accepted_by_user_id - a co-owner's, or someone who never saw the terms.
-- In a table whose entire purpose is recording who agreed to what, a forgeable
-- signer is the one field that must not be. auth.uid() is the server's answer to
-- "who is asking" and cannot be supplied by the client.
drop policy if exists owners_accept_terms on public.org_terms_acceptances;
create policy owners_accept_terms on public.org_terms_acceptances
  for insert to authenticated
  with check (
    public.is_org_owner(organization_id)
    and accepted_by_user_id = auth.uid()
  );

-- Any member may READ, because the banner has to tell the truth to whoever is
-- looking, not only to the person who can clear it.
drop policy if exists members_see_own_org_terms on public.org_terms_acceptances;
create policy members_see_own_org_terms on public.org_terms_acceptances
  for select to authenticated
  using (public.is_org_member(organization_id) or public.is_platform_admin());

-- No UPDATE or DELETE policy exists, deliberately. The triggers above are the
-- guarantee; the missing policies are the belt.

-- ── what an organisation needs to know ─────────────────────────────────────
-- One function, so the banner, the money-surface gate and any server check all
-- read the same answer. Two spellings of "are they current" would drift.
create or replace function public.org_terms_status(p_org uuid)
returns table (
  current_version   text,
  accepted_version  text,
  accepted_at       timestamptz,
  needs_acceptance  boolean
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  -- ONE ROW ALWAYS, whether or not a version is published and whether or not
  -- this organisation has ever accepted anything. The scalar subquery yields
  -- NULL rather than no row, and the LATERAL join keeps that single row when an
  -- organisation has no acceptances - so a caller never has to tell "no answer"
  -- apart from "nothing owed".
  select
    ct.version                                     as current_version,
    latest.terms_version                           as accepted_version,
    latest.accepted_at                             as accepted_at,
    -- FAILS TOWARDS LEAVING PEOPLE ALONE, which is the safe direction here:
    -- with no version published there is nothing to be out of date with, so
    -- this is false and nobody is prompted. It becomes true only once a version
    -- exists AND this organisation has not accepted that exact version. The
    -- opposite default would greet every business with a demand to accept Terms
    -- that do not exist yet.
    (ct.version is not null
      and (latest.terms_version is null or latest.terms_version <> ct.version))
                                                   as needs_acceptance
  from (
    select (select value->>'version' from platform_settings where key = 'current_terms') as version
  ) ct
  left join lateral (
    select a.terms_version, a.accepted_at
    from org_terms_acceptances a
    where a.organization_id = p_org
    order by a.accepted_at desc
    limit 1
  ) latest on true
  -- THE CALLER CHECK, and it is not belt-and-braces. This is SECURITY DEFINER,
  -- so without it the GRANT is the only thing between a caller and any
  -- organisation's row - and a grant is exactly what went wrong on 2026-08-20,
  -- when `revoke from public` left anon's execute in place and parent emails
  -- leaked. Definer rights are used to read platform_settings, which is
  -- admin-only under RLS, and not as a way around membership.
  --
  -- Returns NO ROWS rather than a row of nulls: someone who may not ask should
  -- not learn whether the organisation exists or what it has accepted. The
  -- frontend reads "no row" as unknown and falls back to inert.
  where public.is_org_member(p_org) or public.is_platform_admin();
$$;

comment on function public.org_terms_status(uuid) is
  'The one answer to "is this organisation on the current Terms": the published version, what they last accepted, when, and whether they need to accept. needs_acceptance is false while no version is published, so the machinery is inert until Arielle sets one. Money layer item 7.';

-- BOTH REVOKES ARE LOAD-BEARING. `from public` does NOT remove anon's execute
-- on Supabase: anon is granted explicitly, not through PUBLIC, so the first line
-- alone leaves an unauthenticated caller able to run a SECURITY DEFINER
-- function. That is precisely the 2026-08-20 shape. Read proacl back after
-- applying this - the grant you did not verify is a claim, not a fix.
revoke all on function public.org_terms_status(uuid) from public;
revoke all on function public.org_terms_status(uuid) from anon;
grant execute on function public.org_terms_status(uuid) to authenticated;
