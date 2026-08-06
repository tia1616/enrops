-- 20260806b_fee_pass_through_review_fixes.sql
--
-- Follow-up to 20260806a, fixing what a max-effort review found. Three things:
--   1. the guard's exception message named the wrong set of columns;
--   2. fee_pass_through is now operator-writable with NO record of who changed it;
--   3. the "families mid-payment-plan" warning counted the wrong rows, twice over.
--
-- Also restores `set search_path` on the guard - see the note on that below.

-- ── 1. the exception message ──────────────────────────────────────────────────
--
-- 20260806a narrowed 20260801c's "platform fee columns" to "platform fee RATE
-- columns" while still gating platform_fee_cap_cents and platform_fee_floor_cents,
-- neither of which is a rate. Anyone who tripped the floor or cap lock read a
-- message that did not name their column. Verified safe to reword: a repo-wide
-- grep found nothing outside .sql asserting on any variant of this string.
--
-- `set search_path` IS restored here, reversing 20260806a's decision to leave it
-- off. The reasoning has changed: 20260801c dropped the pin that
-- prod_baseline_2026-06-04 and 20260703 both carried, and I confirmed by reading
-- pg_get_functiondef on BOTH live databases that neither currently has it. So
-- this is a restoration of the original definition, not a new behaviour riding
-- along - and a SECURITY DEFINER trigger guarding money columns resolving names
-- against the caller's search_path is not something to defer a third time.
create or replace function public.guard_organizations_locked_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
BEGIN
  IF auth.role() IS NULL
     OR auth.role() = 'service_role'
     OR public.is_platform_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.stripe_account_id        IS DISTINCT FROM OLD.stripe_account_id
  OR NEW.platform_fee_card_pct    IS DISTINCT FROM OLD.platform_fee_card_pct
  OR NEW.platform_fee_ach_pct     IS DISTINCT FROM OLD.platform_fee_ach_pct
  OR NEW.platform_fee_cap_cents   IS DISTINCT FROM OLD.platform_fee_cap_cents
  OR NEW.platform_fee_floor_cents IS DISTINCT FROM OLD.platform_fee_floor_cents
  OR NEW.stripe_fee_payer         IS DISTINCT FROM OLD.stripe_fee_payer
  OR NEW.instructor_pay_enabled   IS DISTINCT FROM OLD.instructor_pay_enabled
  OR NEW.instructor_pay_model     IS DISTINCT FROM OLD.instructor_pay_model THEN
    RAISE EXCEPTION 'stripe_account_id, the platform fee rate, floor and cap columns, stripe_fee_payer, instructor_pay_enabled, and instructor_pay_model can only be changed by Enrops platform admins.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.sending_domain IS DISTINCT FROM OLD.sending_domain THEN
    RAISE EXCEPTION 'sending_domain records a Resend-verified sending domain and can only be set by Enrops once verification passes. Ask Enrops to set up a custom sending domain; until then your email sends from your own address on the shared Enrops domain.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- ── 2. an audit trail for the columns that decide what a card is charged ──────
--
-- Until 20260806a, fee_pass_through could only be changed by the two rows in
-- platform_admins, so the value was effectively stable and attributable. Now any
-- owner/admin can flip it, it is read LIVE at every charge (process-installments
-- re-selects it each run), and nothing snapshots it: checkout_schedules and
-- installments.amount_cents hold base amounts only. There is no audit table for
-- organizations anywhere in the migration history, so "the page said no fee but I
-- was charged on payment 2" was unanswerable. This makes it answerable.
--
-- Records the money-relevant columns, not just fee_pass_through: the others are
-- platform-admin-only, and knowing when Enrops itself changed a tenant's rate is
-- exactly as useful when reconciling a dispute.
create table if not exists public.organization_money_audit (
  id              bigserial primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  column_name     text not null,
  old_value       text,
  new_value       text,
  changed_by      uuid,
  changed_by_email text,
  changed_at      timestamptz not null default now()
);

create index if not exists organization_money_audit_org_time_idx
  on public.organization_money_audit (organization_id, changed_at desc);

comment on table public.organization_money_audit is
  'Append-only record of changes to the organizations columns that determine what a family is charged or what an operator is paid. Written only by trg_audit_organization_money; never written through the API.';

alter table public.organization_money_audit enable row level security;

-- Readable by the org''s own admins (they are the ones answering a family''s
-- question) and by platform admins. Deliberately NO insert/update/delete policy:
-- the only writer is the SECURITY DEFINER trigger below, so the table is
-- append-only from every other direction, including a compromised operator token.
drop policy if exists money_audit_read_own_org on public.organization_money_audit;
create policy money_audit_read_own_org
  on public.organization_money_audit
  for select
  using (public.can_admin_org(organization_id) or public.is_platform_admin());

-- New public tables need explicit GRANTs on top of RLS.
grant select on public.organization_money_audit to authenticated;
grant all    on public.organization_money_audit to service_role;
grant usage, select on sequence public.organization_money_audit_id_seq to service_role;

create or replace function public.audit_organization_money()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
DECLARE
  v_uid   uuid := auth.uid();
  v_email text := nullif(btrim(coalesce(auth.jwt() ->> 'email', '')), '');
BEGIN
  -- One row per changed column, so a dispute reads as a list of facts rather
  -- than a diff someone has to interpret.
  IF NEW.fee_pass_through IS DISTINCT FROM OLD.fee_pass_through THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'fee_pass_through', OLD.fee_pass_through::text, NEW.fee_pass_through::text, v_uid, v_email);
  END IF;

  IF NEW.platform_fee_card_pct IS DISTINCT FROM OLD.platform_fee_card_pct THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'platform_fee_card_pct', OLD.platform_fee_card_pct::text, NEW.platform_fee_card_pct::text, v_uid, v_email);
  END IF;

  IF NEW.platform_fee_ach_pct IS DISTINCT FROM OLD.platform_fee_ach_pct THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'platform_fee_ach_pct', OLD.platform_fee_ach_pct::text, NEW.platform_fee_ach_pct::text, v_uid, v_email);
  END IF;

  IF NEW.platform_fee_floor_cents IS DISTINCT FROM OLD.platform_fee_floor_cents THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'platform_fee_floor_cents', OLD.platform_fee_floor_cents::text, NEW.platform_fee_floor_cents::text, v_uid, v_email);
  END IF;

  IF NEW.platform_fee_cap_cents IS DISTINCT FROM OLD.platform_fee_cap_cents THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'platform_fee_cap_cents', OLD.platform_fee_cap_cents::text, NEW.platform_fee_cap_cents::text, v_uid, v_email);
  END IF;

  IF NEW.stripe_fee_payer IS DISTINCT FROM OLD.stripe_fee_payer THEN
    INSERT INTO public.organization_money_audit
      (organization_id, column_name, old_value, new_value, changed_by, changed_by_email)
    VALUES (NEW.id, 'stripe_fee_payer', OLD.stripe_fee_payer, NEW.stripe_fee_payer, v_uid, v_email);
  END IF;

  RETURN NEW;
END;
$$;

-- AFTER, not BEFORE: only record changes that actually committed past the guard
-- and past RLS. A BEFORE trigger would log attempts the guard then rejected.
drop trigger if exists trg_audit_organization_money on public.organizations;
create trigger trg_audit_organization_money
  after update on public.organizations
  for each row
  execute function public.audit_organization_money();

-- ── 3. the "families mid-payment-plan" count ─────────────────────────────────
--
-- The frontend counted this with a PostgREST query that was wrong three ways, all
-- of which this RPC fixes by construction:
--
--   a. DISTINCT registration_id counts REGISTRATIONS, not families. A parent who
--      enrolled two children is two registrations sharing one Stripe Customer
--      (process-installments treats them as one charge group). Measured on prod:
--      pending installments span 30 registrations but only 18 parents, so the
--      warning overstated J2S by 12 families. Counting parent_id fixes it.
--
--   b. It used a deny-list of terminal statuses, which counts 'failed' and
--      'paused_card_failed'. process-installments charges ONLY status='pending'
--      (its own alert says paused rows "will not be retried automatically" and
--      need a manual flip back), so those families' remaining payments are NOT
--      repriced and the warning's claim was false for them. This matches the
--      charger's predicate exactly instead of approximating it.
--
--   c. It counted the returned ROWS, and PostgREST caps a result set at 1000 -
--      the exact bug stripe-oauth-disconnect documents as proven on staging
--      2026-07-30. count(distinct ...) in SQL has no such ceiling.
--
-- It also joins through registrations rather than filtering
-- installments.organization_id, which is NULLABLE: a row with a null org would
-- have been invisible to the old query while the service-role cron still charged it.
--
-- coalesce on parent_id: registrations.parent_id is nullable (0 nulls on both
-- envs today, but nullable). count(distinct) skips NULLs, so a parentless
-- registration would vanish from the count entirely; falling back to the
-- registration id counts it as its own family, which errs toward warning.
create or replace function public.org_pending_plan_families(p_org uuid)
returns integer
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select count(distinct coalesce(r.parent_id::text, 'reg:' || r.id::text))::int
  from installments i
  join registrations r on r.id = i.registration_id
  where r.organization_id = p_org
    and i.status = 'pending'
    and (public.can_admin_org(p_org) or public.is_platform_admin());
$$;

comment on function public.org_pending_plan_families(uuid) is
  'Number of distinct FAMILIES with at least one still-chargeable (status=pending) installment. Mirrors process-installments'' own selection predicate. Returns 0 for a caller who is not an admin of the org.';

-- SECURITY DEFINER, so lock it down explicitly: Supabase ships an ALTER DEFAULT
-- PRIVILEGES that grants EXECUTE on new functions to anon, and this one reads
-- other people''s payment plans. The body is authorization-gated regardless, but
-- an anon-callable SECURITY DEFINER function over installments should not exist.
revoke all on function public.org_pending_plan_families(uuid) from public;
revoke all on function public.org_pending_plan_families(uuid) from anon;
grant execute on function public.org_pending_plan_families(uuid) to authenticated;
grant execute on function public.org_pending_plan_families(uuid) to service_role;
