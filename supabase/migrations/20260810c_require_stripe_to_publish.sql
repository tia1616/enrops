-- Stripe is required to publish a class that will take money through enrops.
--
-- Arielle raised it, Jessica decided it 2026-08-09: "it doesn't make any sense
-- to publish a program if they can't get paid for it." This REVERSES the earlier
-- "warn, don't block" behaviour on the program screens.
--
-- WHY A TRIGGER AND NOT A CHECK CONSTRAINT: the rule depends on
-- organizations.stripe_charges_enabled, which a CHECK on programs cannot see.
-- Same shape as guard_organizations_locked_columns.
--
-- WHY THE DATABASE AT ALL: the Comms gate shipped UI-only on the morning of
-- 2026-08-09 and code review found it bypassable from devtools within hours.
-- The screens (src/lib/publishGate.js) hold the same rule so the operator sees
-- the reason on the button; THIS is the enforcement. Change one, change both.
--
-- BLAST RADIUS ZERO, verified against both live databases 2026-08-10:
--   prod    - every program belongs to j2s (82 open / 9 draft) or
--             the-ukulele-project (19 open / 2 draft); both have Stripe on.
--   staging - seeded-branch-studio has 1 open paid class with Stripe OFF. It is
--             grandfathered by the transition rule below and stays live, which
--             is exactly the behaviour Jessica asked for.
-- No backfill. Nothing goes dark.
--
-- PROGRAMS ONLY. camp_sessions is a different table with no draft state, a
-- different status vocabulary (active | cancelled) and a nullable price_cents,
-- because camps never ran registration through enrops. Gating camps waits on
-- reworking them for enrops registration; it is NOT "the same change again".

create or replace function public.tg_programs_require_stripe_to_publish()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_uses_enrops boolean;
  v_charges_ok  boolean;
  v_found       boolean := false;
  v_new_gated   boolean;
  v_old_gated   boolean := false;
begin
  -- Same escape hatches as guard_organizations_locked_columns: backend jobs
  -- (service_role), Enrops platform admins, and direct SQL (auth.role() is NULL
  -- outside PostgREST). An operator's browser session is 'authenticated', so the
  -- devtools bypass this trigger exists to close stays closed.
  if auth.role() is null
     or auth.role() = 'service_role'
     or public.is_platform_admin() then
    return new;
  end if;

  -- programs.status is NULLABLE with DEFAULT 'open', so an INSERT that simply
  -- omits status PUBLISHES. Postgres applies the column default before a BEFORE
  -- trigger runs, so new.status already reads 'open' in that case; the coalesce
  -- covers an explicit NULL, which no screen writes and which nothing downstream
  -- treats as a real state.
  --
  -- "Will take money through enrops" is the actual rule, not "always Stripe".
  -- Three exemptions, each a real org or a real set of rows: the school collects
  -- (runs_own_registration), the class is free (price_cents = 0), or the org
  -- registers families elsewhere (checked below, on organizations).
  v_new_gated :=
        coalesce(new.status, 'open') = 'open'
    and new.runs_own_registration is not true
    and coalesce(new.price_cents, 0) > 0;

  if tg_op = 'UPDATE' then
    v_old_gated :=
          coalesce(old.status, 'open') = 'open'
      and old.runs_own_registration is not true
      and coalesce(old.price_cents, 0) > 0
      and old.organization_id is not distinct from new.organization_id;
  end if;

  -- Nothing to gate, or the row was ALREADY live and taking money. Jessica,
  -- 2026-08-09: when an org disconnects Stripe its live classes STAY LIVE with a
  -- loud warning -- they must never vanish from a family's view, and the
  -- operator must still be able to edit them. So only the transition INTO
  -- "open + paid + enrops-run" is gated. That also catches an open FREE class
  -- being given a price and an open PARTNER-RUN class being taken over in place,
  -- because both open a money path that had none.
  if not v_new_gated or v_old_gated then
    return new;
  end if;

  select o.uses_enrops_registration, o.stripe_charges_enabled, true
    into v_uses_enrops, v_charges_ok, v_found
    from public.organizations o
   where o.id = new.organization_id;

  -- Registers families somewhere else (shoreview-chess, mrs-richelle): there is
  -- no enrops checkout for a Stripe account to sit behind, so requiring one
  -- would be a prompt they could never clear.
  if v_found and v_uses_enrops is false then
    return new;
  end if;

  if v_found and v_charges_ok is true then
    return new;
  end if;

  -- Fails CLOSED when the org row is missing (organization_id NULL or dangling).
  -- RLS members_write_programs already requires can_edit_org(organization_id),
  -- so an operator cannot reach this branch; it is here so that if they ever
  -- can, the answer is "no".
  raise exception 'Connect Stripe before you publish a paid class. Families can''t pay you until Stripe is connected - open Payments to connect, then publish. Saving as a draft always works.'
    using errcode = 'ENRPS';
end;
$$;

comment on function public.tg_programs_require_stripe_to_publish() is
  'Blocks publishing a program that would take money through enrops while the org has no Stripe. Mirrors src/lib/publishGate.js - change both together.';

-- BEFORE UPDATE with no OF-column list on purpose: price_cents and
-- runs_own_registration can each open a money path without status changing, and
-- an "OF status" trigger would sail straight past both.
drop trigger if exists trg_programs_require_stripe_ins on public.programs;
create trigger trg_programs_require_stripe_ins
  before insert on public.programs
  for each row execute function public.tg_programs_require_stripe_to_publish();

drop trigger if exists trg_programs_require_stripe_upd on public.programs;
create trigger trg_programs_require_stripe_upd
  before update on public.programs
  for each row execute function public.tg_programs_require_stripe_to_publish();
