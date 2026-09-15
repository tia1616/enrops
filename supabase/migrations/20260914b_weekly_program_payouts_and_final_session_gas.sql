-- Payroll, two fixes that share one view.
--
-- 1. WEEKLY PROGRAM PAYOUTS WERE CAPPED AT ONE, FOREVER.
--    uq_instructor_payouts_no_concurrent_program was UNIQUE on
--    (instructor_id, program_id) WHERE status IN ('pending','succeeded').
--    That permits exactly ONE succeeded payout per instructor per class for
--    all time. Correct for a camp -- you pay once at the end of the week.
--    Wrong for after-school, which pays WEEKLY across an 8-week term: the
--    moment week 1 succeeded, every later week became unpayable and
--    pay-instructor returned 23505 -> "a payout is already in progress",
--    which was never true. Three instructor/class pairs and $180 were stuck
--    on prod when this was found (2026-09-14), growing by one class per
--    instructor per week.
--
--    The index is narrowed to status='pending'. That is the guard it was
--    actually built for -- the double-click race, where two concurrent
--    clicks both insert a pending row and the second must lose. It is NOT
--    the double-pay guard: pay-instructor only ever picks up pay lines with
--    instructor_payout_id IS NULL (index.ts), so a day that has been paid
--    cannot be paid again no matter what this index says. The once-ever rule
--    was doing nothing for safety and everything for breakage.
--
--    The CAMP index (uq_instructor_payouts_no_concurrent) is deliberately
--    left alone. A camp really is one payout per camp session, and camps are
--    not broken.
--
-- 2. THE GAS BONUS PAID ON THE FIRST WEEK INSTEAD OF THE LAST.
--    program_assignments.distance_bonus_cents is the gas/distance money an
--    operator attaches when assigning a class. pay-instructor paid it on the
--    first payout that carried any regular row, so on an 8-week term the gas
--    went out in week 1. It should ride the LAST class that instructor
--    teaches for that program (Jessica, 2026-09-14).
--
--    The view gains is_final_session so the decision lives in ONE place and
--    both readers -- pay-instructor (what actually moves) and Payroll.jsx
--    (what the card and the pay modal promise) -- read the same column. The
--    two have drifted before; a bonus the modal promised and the server
--    refused is exactly the failure this column exists to prevent.
--
--    Session dates come from derive_program_session_dates(), never a
--    recomputed weekday walk: it is the one place that knows about location
--    closures, district closures and early-release exceptions.
--
--    is_final_session COALESCEs to false, which is the fail-safe side. A
--    program whose dates cannot be derived pays no gas (recoverable -- the
--    operator sees it and fixes it) rather than paying gas early (money has
--    already left). Camp rows are TRUE unconditionally: a camp's single
--    payout IS its last, so camp behaviour is byte-identical to before.

-- ---------------------------------------------------------------------------
-- 1. Payout guard: one PENDING payout per instructor+program, not one ever.
-- ---------------------------------------------------------------------------
drop index if exists public.uq_instructor_payouts_no_concurrent_program;

create unique index uq_instructor_payouts_no_concurrent_program
  on public.instructor_payouts (instructor_id, program_id)
  where status = 'pending' and program_id is not null;

-- ---------------------------------------------------------------------------
-- 2. v_effective_pay_lines gains is_final_session (appended, so every
--    existing reader is untouched).
-- ---------------------------------------------------------------------------
create or replace view public.v_effective_pay_lines as
 SELECT c.id AS confirmation_id,
    c.organization_id,
    c.camp_session_id,
    c.program_id,
    c.session_date,
    c.session_type,
    c.confirmed_by,
    c.confirmed_at,
    c.pay_status,
    c.pay_amount_cents,
    c.pay_adjustment_cents,
    c.pay_adjustment_reason,
    c.instructor_payout_id,
    c.created_at AS confirmation_created_at,
    c.instructor_id AS original_instructor_id,
    COALESCE(sub.sub_instructor_id, c.instructor_id) AS effective_instructor_id,
    COALESCE(sub.sub_tier, i.contractor_tier) AS effective_tier,
        CASE
            WHEN sub.sub_instructor_id IS NOT NULL THEN 'sub'::text
            ELSE 'regular'::text
        END AS source,
        CASE
            WHEN sub.sub_instructor_id IS NULL THEN ca.distance_bonus_cents
            ELSE NULL::integer
        END AS distance_bonus_cents_if_regular,
    ca.id AS camp_assignment_id,
    ca.status AS camp_assignment_status,
    NULL::uuid AS program_assignment_id,
    NULL::text AS program_assignment_status,
    ca.distance_bonus_paid_at,
    ca.distance_bonus_payout_id,
    NULL::text AS program_status,
    -- A camp session pays once, at the end. Its only payout IS the final one,
    -- so this is unconditionally true and camp gas behaviour does not change.
    true AS is_final_session
   FROM session_delivery_confirmations c
     JOIN instructors i ON i.id = c.instructor_id
     LEFT JOIN camp_assignments ca ON ca.instructor_id = c.instructor_id AND ca.camp_session_id = c.camp_session_id
     LEFT JOIN assignment_substitutions sub ON sub.parent_assignment_id = ca.id AND sub.parent_assignment_type = 'camp'::text AND sub.date = c.session_date AND (sub.status = ANY (ARRAY['confirmed'::text, 'taught'::text]))
  WHERE c.camp_session_id IS NOT NULL
UNION ALL
 SELECT c.id AS confirmation_id,
    c.organization_id,
    c.camp_session_id,
    c.program_id,
    c.session_date,
    c.session_type,
    c.confirmed_by,
    c.confirmed_at,
    c.pay_status,
    c.pay_amount_cents,
    c.pay_adjustment_cents,
    c.pay_adjustment_reason,
    c.instructor_payout_id,
    c.created_at AS confirmation_created_at,
    c.instructor_id AS original_instructor_id,
    COALESCE(sub.sub_instructor_id, c.instructor_id) AS effective_instructor_id,
    COALESCE(sub.sub_tier, i.contractor_tier) AS effective_tier,
        CASE
            WHEN sub.sub_instructor_id IS NOT NULL THEN 'sub'::text
            ELSE 'regular'::text
        END AS source,
        CASE
            WHEN sub.sub_instructor_id IS NULL THEN pa.distance_bonus_cents
            ELSE NULL::integer
        END AS distance_bonus_cents_if_regular,
    NULL::uuid AS camp_assignment_id,
    NULL::text AS camp_assignment_status,
    pa.id AS program_assignment_id,
    pa.status AS program_assignment_status,
    pa.distance_bonus_paid_at,
    pa.distance_bonus_payout_id,
    p.status AS program_status,
    -- Is this the program's last scheduled session? >= rather than = so a
    -- session somehow sitting past the derived end still counts as final
    -- instead of silently stranding the gas forever. COALESCE false: if the
    -- dates cannot be derived we do not know, and not-paying is the
    -- recoverable half.
    COALESCE(
      c.session_date >= (
        SELECT max(d) FROM unnest(derive_program_session_dates(c.program_id)) AS d
      ),
      false
    ) AS is_final_session
   FROM session_delivery_confirmations c
     JOIN instructors i ON i.id = c.instructor_id
     LEFT JOIN program_assignments pa ON pa.instructor_id = c.instructor_id AND pa.program_id = c.program_id
     LEFT JOIN programs p ON p.id = c.program_id
     LEFT JOIN assignment_substitutions sub ON sub.parent_assignment_id = pa.id AND sub.parent_assignment_type = 'program'::text AND sub.date = c.session_date AND (sub.status = ANY (ARRAY['confirmed'::text, 'taught'::text]))
  WHERE c.program_id IS NOT NULL;

-- CREATE OR REPLACE VIEW silently CLEARS reloptions, which would drop
-- security_invoker and make this view read with the owner's rights -- i.e.
-- every org's pay lines to anyone holding SELECT. Re-set it, and the
-- verification block below reads pg_class back rather than trusting this line.
alter view public.v_effective_pay_lines set (security_invoker = on);

do $$
declare
  v_opts text[];
begin
  select c.reloptions into v_opts
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'v_effective_pay_lines';

  if v_opts is null or not ('security_invoker=on' = any(v_opts)) then
    raise exception
      'v_effective_pay_lines lost security_invoker (reloptions=%). Refusing to leave a cross-tenant read open.',
      v_opts;
  end if;
end $$;
