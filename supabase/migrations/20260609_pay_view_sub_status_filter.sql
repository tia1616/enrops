-- Fix: v_effective_pay_lines resolved a substitution as the effective payee
-- regardless of the sub's status, so a 'pending' or 'declined' sub still stole
-- the payout from the assigned instructor. Narrow both sub-joins (camp +
-- program) to status IN ('confirmed','taught') so only a sub who actually
-- accepted/taught is resolved as the payee. Proven on staging: a declined sub
-- over a taught day was being routed the pay.
--
-- IMPORTANT: re-set security_invoker=on. The June-6 security hotfix
-- (20260606_security_invoker_leaky_views) flipped this view to SECURITY INVOKER
-- to stop cross-tenant pay exposure to anon; CREATE OR REPLACE must carry it.
-- Only the two assignment_substitutions join predicates change vs the prior def.

create or replace view public.v_effective_pay_lines
with (security_invoker = on) as
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
    ca.distance_bonus_payout_id
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
    pa.distance_bonus_payout_id
   FROM session_delivery_confirmations c
     JOIN instructors i ON i.id = c.instructor_id
     LEFT JOIN program_assignments pa ON pa.instructor_id = c.instructor_id AND pa.program_id = c.program_id
     LEFT JOIN assignment_substitutions sub ON sub.parent_assignment_id = pa.id AND sub.parent_assignment_type = 'program'::text AND sub.date = c.session_date AND (sub.status = ANY (ARRAY['confirmed'::text, 'taught'::text]))
  WHERE c.program_id IS NOT NULL;
