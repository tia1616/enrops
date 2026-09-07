-- v_effective_pay_lines carries the class's own status, so Payroll reads the
-- SCHEDULE'S truth from one place instead of re-deriving it.
--
-- WHY. Cancelling an after-school class did not stop it generating pay. The
-- schedule screen has excluded cancelled and draft classes since 2026-08-31
-- (AfterschoolSchedule.jsx: `.not("status","in",'("cancelled","draft")')`), and
-- the instructor portal excludes them too. The pay side never learned: this view
-- is the single source Payroll reads, it already resolves the SUB correctly
-- (effective_instructor_id = COALESCE(sub.sub_instructor_id, c.instructor_id),
-- restricted to confirmed/taught substitutions), and the one thing about the
-- schedule it did not know was whether the class is still happening. It never
-- joined `programs`.
--
-- The first cut of this fix asked "is this class running" in five different
-- places (the seeder, three confirm endpoints, and the Payroll screen). That is
-- one rule in five spellings. This puts it in the source, so pay derives from
-- the schedule the way the schedule screen does.
--
-- LEFT JOIN, NOT INNER, ON PURPOSE. This view is security_invoker=on, so the
-- join runs with the CALLER's privileges and RLS. An inner join would make a
-- pay line VANISH for any caller who cannot see the program row - money
-- silently disappearing off Payroll is far worse than a phantom line, which is
-- at least visible and refusable. With a left join the column is simply NULL
-- when the program is unreadable or absent, and the reader treats NULL as
-- "don't know, keep showing it".
--
-- CAMPS ARE UNAFFECTED. A camp pay line has no program_id; its branch returns
-- NULL here. Camp cancellation is already carried by camp_assignment_status,
-- which this view has exposed since 20260529 and which Payroll already filters.
--
-- ADDITIVE AND INERT. A new trailing column, so the view's four readers
-- (Payroll.jsx, admin-confirm-session, pay-instructor, and the note in
-- AdminLayout.jsx) are unchanged until one of them selects it.
--
-- THE `with (security_invoker = on)` BELOW IS LOAD-BEARING, AND I LEARNED THAT
-- THE HARD WAY ON STAGING. I first ran this as a bare CREATE OR REPLACE VIEW,
-- assuming it preserved the view's options the way it preserves grants. IT DOES
-- NOT: omitting the WITH clause CLEARS reloptions, and reading pg_class back
-- showed reloptions = NULL, i.e. the view had silently become a
-- security-definer view over session_delivery_confirmations, instructors,
-- program_assignments and programs. `anon` holds SELECT on this view (checked),
-- so on prod that would have been every tenant's pay lines readable by anybody
-- with the anon key. Restored on staging with ALTER VIEW ... SET, then folded
-- into the statement here so the file itself can never reproduce the window.
-- Grants ARE preserved by CREATE OR REPLACE; read both back after applying.
-- Related: 20260606_security_invoker_leaky_views.sql, which is the migration
-- that put security_invoker on this view in the first place.

create or replace view public.v_effective_pay_lines
  with (security_invoker = on)
as
 select c.id as confirmation_id,
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
    c.created_at as confirmation_created_at,
    c.instructor_id as original_instructor_id,
    COALESCE(sub.sub_instructor_id, c.instructor_id) as effective_instructor_id,
    COALESCE(sub.sub_tier, i.contractor_tier) as effective_tier,
        CASE
            WHEN sub.sub_instructor_id IS NOT NULL THEN 'sub'::text
            ELSE 'regular'::text
        END as source,
        CASE
            WHEN sub.sub_instructor_id IS NULL THEN ca.distance_bonus_cents
            ELSE NULL::integer
        END as distance_bonus_cents_if_regular,
    ca.id as camp_assignment_id,
    ca.status as camp_assignment_status,
    NULL::uuid as program_assignment_id,
    NULL::text as program_assignment_status,
    ca.distance_bonus_paid_at,
    ca.distance_bonus_payout_id,
    NULL::text as program_status
   from session_delivery_confirmations c
     join instructors i on i.id = c.instructor_id
     left join camp_assignments ca on ca.instructor_id = c.instructor_id and ca.camp_session_id = c.camp_session_id
     left join assignment_substitutions sub on sub.parent_assignment_id = ca.id and sub.parent_assignment_type = 'camp'::text and sub.date = c.session_date and (sub.status = ANY (ARRAY['confirmed'::text, 'taught'::text]))
  where c.camp_session_id is not null
union all
 select c.id as confirmation_id,
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
    c.created_at as confirmation_created_at,
    c.instructor_id as original_instructor_id,
    COALESCE(sub.sub_instructor_id, c.instructor_id) as effective_instructor_id,
    COALESCE(sub.sub_tier, i.contractor_tier) as effective_tier,
        CASE
            WHEN sub.sub_instructor_id IS NOT NULL THEN 'sub'::text
            ELSE 'regular'::text
        END as source,
        CASE
            WHEN sub.sub_instructor_id IS NULL THEN pa.distance_bonus_cents
            ELSE NULL::integer
        END as distance_bonus_cents_if_regular,
    NULL::uuid as camp_assignment_id,
    NULL::text as camp_assignment_status,
    pa.id as program_assignment_id,
    pa.status as program_assignment_status,
    pa.distance_bonus_paid_at,
    pa.distance_bonus_payout_id,
    p.status as program_status
   from session_delivery_confirmations c
     join instructors i on i.id = c.instructor_id
     left join program_assignments pa on pa.instructor_id = c.instructor_id and pa.program_id = c.program_id
     left join programs p on p.id = c.program_id
     left join assignment_substitutions sub on sub.parent_assignment_id = pa.id and sub.parent_assignment_type = 'program'::text and sub.date = c.session_date and (sub.status = ANY (ARRAY['confirmed'::text, 'taught'::text]))
  where c.program_id is not null;
