-- Credits, chunk 2: show what the business OWES, next to what it collected.
--
-- Money layer section 6: "A credit is money owed, not revenue. It shows on the
-- money dashboard and is not zeroed."
--
-- BOTH HALVES OF THAT SENTENCE MATTER. A credited registration collected real
-- cash and the business still holds it, so the collected figure is correct and
-- is deliberately left alone - nothing here subtracts credits from revenue.
-- What was missing is the other side: the obligation that cash now carries.
-- Until this, the ledger was written by the cancellation path and read by
-- nothing, so an operator's money screen showed a business doing better than it
-- was, with no hint that some of that money is spoken for.
--
-- IT IS A BALANCE, NOT A FLOW, AND THAT IS WHY IT IGNORES THE PERIOD. Every
-- other figure this function returns is scoped to the selected term or date
-- range, because they are all things that HAPPENED in that window. "What do I
-- owe families" is a position as of right now: a credit issued last term and
-- still unspent is still owed today, and would vanish from a period-filtered
-- total the moment the operator switched to "last 30 days" - which is exactly
-- when a liability must not disappear. The screen labels it as a running total
-- so the inconsistency is stated rather than discovered.
--
-- 'active' IS THE WHOLE PREDICATE, and it is equivalent to the claim, not
-- merely correlated with it: 'spent' is no longer owed, 'refunded' was paid
-- back in cash, and 'void' was withdrawn as issued in error. Only 'active' is
-- money a family can still come and ask for.
--
-- DROP THEN CREATE, because CREATE OR REPLACE cannot change a function's
-- RETURNS TABLE. The grants go with it, so they are restored explicitly below
-- and read back - `authenticated` and `service_role` only, exactly as before.
-- Production carries an ALTER DEFAULT PRIVILEGES rule that hands EXECUTE on new
-- functions to anon, and this function is money-gated, so silently gaining anon
-- would matter.

drop function if exists public.get_revenue_summary(uuid, timestamptz, timestamptz, text);

create function public.get_revenue_summary(
  p_org  uuid,
  p_from timestamptz default null,
  p_to   timestamptz default null,
  p_term text default null
)
returns table(
  collected_cents          bigint,
  refunded_cents           bigint,
  expected_soon_cents      bigint,
  paid_count               bigint,
  external_count           bigint,
  has_enrops_payments      boolean,
  credit_outstanding_cents bigint
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
BEGIN
  IF NOT can_handle_money(p_org) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH term_prog AS (
    SELECT id FROM programs WHERE organization_id = p_org AND (p_term IS NULL OR term = p_term)
  ),
  pif AS (
    SELECT r.id, r.amount_cents, r.parent_id
    FROM registrations r
    WHERE r.organization_id = p_org
      AND r.payment_method = 'stripe'
      AND r.payment_status IN ('paid','partial','refunded')
      AND (p_from IS NULL OR r.registered_at >= p_from)
      AND (p_to   IS NULL OR r.registered_at <  p_to)
      AND (p_term IS NULL OR r.program_id IN (SELECT id FROM term_prog))
  ),
  inst_paid AS (
    SELECT i.amount_cents, r.parent_id
    FROM installments i JOIN registrations r ON r.id = i.registration_id
    WHERE i.organization_id = p_org AND i.status = 'paid'
      AND (p_from IS NULL OR i.paid_at >= p_from)
      AND (p_to   IS NULL OR i.paid_at <  p_to)
      AND (p_term IS NULL OR r.program_id IN (SELECT id FROM term_prog))
  ),
  ref AS (
    SELECT rf.amount_cents
    FROM refunds rf
    WHERE rf.organization_id = p_org AND rf.status = 'succeeded'
      AND (p_from IS NULL OR rf.succeeded_at >= p_from)
      AND (p_to   IS NULL OR rf.succeeded_at <  p_to)
      AND (p_term IS NULL OR rf.registration_id IN
            (SELECT r.id FROM registrations r WHERE r.program_id IN (SELECT id FROM term_prog)))
  ),
  inst_pending AS (
    SELECT i.amount_cents
    FROM installments i
    WHERE i.organization_id = p_org AND i.status = 'pending'
      AND (p_term IS NULL OR i.registration_id IN
            (SELECT r.id FROM registrations r WHERE r.program_id IN (SELECT id FROM term_prog)))
  ),
  ext AS (
    SELECT r.id
    FROM registrations r
    WHERE r.organization_id = p_org AND r.payment_method IS NULL
      AND (p_from IS NULL OR r.registered_at >= p_from)
      AND (p_to   IS NULL OR r.registered_at <  p_to)
      AND (p_term IS NULL OR r.program_id IN (SELECT id FROM term_prog))
  ),
  paid_families AS (
    SELECT parent_id FROM pif       WHERE parent_id IS NOT NULL
    UNION
    SELECT parent_id FROM inst_paid WHERE parent_id IS NOT NULL
  )
  SELECT
    (COALESCE((SELECT SUM(amount_cents) FROM pif),0)
      + COALESCE((SELECT SUM(amount_cents) FROM inst_paid),0)
      - COALESCE((SELECT SUM(amount_cents) FROM ref),0))::bigint,
    COALESCE((SELECT SUM(amount_cents) FROM ref),0)::bigint,
    COALESCE((SELECT SUM(amount_cents) FROM inst_pending),0)::bigint,
    (SELECT COUNT(*) FROM paid_families)::bigint,
    (SELECT COUNT(*) FROM ext)::bigint,
    EXISTS (SELECT 1 FROM registrations r
            WHERE r.organization_id = p_org AND r.payment_method = 'stripe'
              AND r.payment_status IN ('paid','partial','refunded')),
    -- Deliberately NOT filtered by p_from/p_to/p_term. See the header.
    COALESCE((SELECT SUM(fc.amount_cents) FROM family_credits fc
              WHERE fc.organization_id = p_org AND fc.status = 'active'),0)::bigint;
END
$function$;

revoke all     on function public.get_revenue_summary(uuid, timestamptz, timestamptz, text) from public;
revoke execute on function public.get_revenue_summary(uuid, timestamptz, timestamptz, text) from anon;
grant  execute on function public.get_revenue_summary(uuid, timestamptz, timestamptz, text) to authenticated;
grant  execute on function public.get_revenue_summary(uuid, timestamptz, timestamptz, text) to service_role;
