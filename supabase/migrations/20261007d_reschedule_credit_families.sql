-- Reschedule a session, part 4: credit families for a day with no make-up.
--
-- Jessica, 2026-10-07: the PROVIDER chooses, per skipped day, "credit families"
-- or "no credit" (some providers' sign-up policy allows one unrefunded skip),
-- and the credit is applied to each family automatically. Amount = what that
-- family paid for the class (registrations.amount_cents: after discounts,
-- before the enrops service fee and Stripe's processing fee) / session count,
-- capped at what they have actually paid so far (families mid-installment).
-- Putting the day back removes every credit nobody has touched; a credit with
-- any movement at all stays with the family and is reported.
--
-- WHERE THE MONEY IS WRITTEN: issue_family_credit, the existing guarded writer
-- (registration lock, paid-refunded-credited ceiling re-checked inside the
-- lock). NOT refund-registration's issue_credit path: that is "credit INSTEAD
-- of a refund" for a family who is LEAVING, and after writing the credit it
-- always stops the family's remaining installments and cancels the
-- registration. Reusing it here would have withdrawn every family from a class
-- because one day moved.
--
-- "PAID" IS READ FROM THE DATABASE, AND THAT IS THE SAFE DIRECTION. The
-- per-registration figure handed to issue_family_credit is the class price the
-- family has actually paid so far, before fees: the sum of PAID installments
-- when they have a plan, else amount_cents when the registration is paid. It
-- never includes the enrops service fee or Stripe's fee, so it is at or below
-- the real charged total - the ceiling can only be LOWER than the one
-- refund-registration would compute from Stripe, never higher. A family who
-- has paid nothing yet is owed nothing.
--
-- Each credit's idempotency key is 'skip:<skip id>:<registration id>', which
-- makes the write safe to repeat and is how the undo finds them.


-- ------------------------------------------- credit the paying families --
-- Internal: called only by skip_program_session, inside its transaction, so a
-- day is never taken off with half its families credited. Not granted to
-- anybody; it trusts the caller's authorization check.
create or replace function public.credit_families_for_skip(p_skip_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
DECLARE
  v_skip    program_session_skips%ROWTYPE;
  v_count   int;
  v_reg     record;
  v_paid    int;
  v_share   int;
  v_avail   int;
  v_amt     int;
  v_out     record;
  v_done    jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_total   int := 0;
BEGIN
  SELECT * INTO v_skip FROM program_session_skips WHERE id = p_skip_id;
  IF NOT FOUND OR NOT v_skip.credit_families OR v_skip.makeup THEN
    RETURN jsonb_build_object('credited', '[]'::jsonb, 'skipped', '[]'::jsonb, 'total_cents', 0);
  END IF;

  SELECT p.session_count INTO v_count FROM programs p WHERE p.id = v_skip.program_id;
  IF COALESCE(v_count, 0) <= 0 THEN
    RAISE EXCEPTION 'this class has no session count, so a per-session credit can''t be worked out';
  END IF;

  FOR v_reg IN
    SELECT r.id, r.parent_id, r.amount_cents, r.payment_status,
           (SELECT count(*) FROM installments i WHERE i.registration_id = r.id) AS n_inst,
           COALESCE((SELECT sum(i.amount_cents) FROM installments i
                      WHERE i.registration_id = r.id AND i.status = 'paid'), 0) AS inst_paid,
           nullif(trim(coalesce(pa.first_name, '') || ' ' || coalesce(pa.last_name, '')), '') AS parent_name
      FROM registrations r
      LEFT JOIN parents pa ON pa.id = r.parent_id
     WHERE r.program_id = v_skip.program_id
       AND r.organization_id = v_skip.organization_id
       AND r.status = 'confirmed'
       AND r.cancelled_at IS NULL
       AND COALESCE(r.amount_cents, 0) > 0
     ORDER BY r.id
  LOOP
    IF v_reg.parent_id IS NULL THEN
      v_skipped := v_skipped || jsonb_build_object('registration_id', v_reg.id, 'name', v_reg.parent_name, 'why', 'no family on file');
      CONTINUE;
    END IF;

    v_paid := CASE
      WHEN v_reg.n_inst > 0 THEN v_reg.inst_paid
      WHEN v_reg.payment_status IN ('paid', 'partial') THEN v_reg.amount_cents
      ELSE 0
    END;
    v_share := round(v_reg.amount_cents::numeric / v_count)::int;
    v_avail := registration_available_cents(v_reg.id, v_paid);
    v_amt := LEAST(v_share, v_avail);

    IF v_amt <= 0 THEN
      v_skipped := v_skipped || jsonb_build_object('registration_id', v_reg.id, 'name', v_reg.parent_name,
                     'why', CASE WHEN v_paid <= 0 THEN 'nothing paid yet' ELSE 'nothing left to credit' END);
      CONTINUE;
    END IF;

    SELECT * INTO v_out FROM issue_family_credit(
      v_skip.organization_id, v_reg.parent_id, v_reg.id, v_amt, 'business_cancelled',
      'No class on ' || to_char(v_skip.session_date, 'FMMonth FMDD') || ' (rescheduled)',
      'skip:' || p_skip_id::text || ':' || v_reg.id::text,
      v_paid);

    v_total := v_total + v_out.amount_cents;
    v_done := v_done || jsonb_build_object('registration_id', v_reg.id, 'name', v_reg.parent_name,
                'amount_cents', v_out.amount_cents, 'capped', v_amt < v_share);
  END LOOP;

  RETURN jsonb_build_object('credited', v_done, 'skipped', v_skipped, 'total_cents', v_total);
END;
$$;

revoke all on function public.credit_families_for_skip(uuid) from public, anon, authenticated;
grant execute on function public.credit_families_for_skip(uuid) to service_role;

-- -------------------------------------------- the choice, recorded --
-- Same body as 20261007c plus p_credit_families. Dropped and recreated rather
-- than overloaded: a 3-argument and a 4-argument version with a default would
-- make every named call ambiguous.
drop function if exists public.skip_program_session(uuid, date, boolean);

create or replace function public.skip_program_session(
  p_program_id uuid, p_date date, p_makeup boolean, p_credit_families boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
DECLARE
  v_org        uuid;
  v_class_days text[];
  v_skip_id    uuid;
  v_voided     uuid[] := '{}';
  v_blocking   int;
  v_covers     jsonb;
  v_dates      date[];
  v_mode       text;
  v_credits    jsonb := null;
BEGIN
  IF p_program_id IS NULL OR p_date IS NULL OR p_makeup IS NULL THEN
    RAISE EXCEPTION 'program, date and make-up choice are all required';
  END IF;
  -- With a make-up nothing was lost, so there is nothing to credit.
  IF p_makeup AND COALESCE(p_credit_families, false) THEN
    RAISE EXCEPTION 'families are only credited when there is no make-up';
  END IF;

  SELECT p.organization_id, p.class_days, p.schedule_mode INTO v_org, v_class_days, v_mode
    FROM programs p WHERE p.id = p_program_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'program not found';
  END IF;
  IF NOT (can_admin_org(v_org) OR is_platform_admin()) THEN
    RAISE EXCEPTION 'not authorized to change this program''s schedule';
  END IF;
  IF v_class_days IS NOT NULL AND array_length(v_class_days, 1) > 0 THEN
    RAISE EXCEPTION 'camp days cannot be rescheduled one at a time';
  END IF;

  -- One schedule change per class at a time: two operators taking two days off
  -- at once would each check the schedule before the other's row existed.
  PERFORM pg_advisory_xact_lock(hashtext('program_schedule:' || p_program_id::text));

  v_dates := derive_program_session_dates(p_program_id);
  IF NOT (p_date = ANY (v_dates)) THEN
    RAISE EXCEPTION 'that date is not a class day for this class';
  END IF;

  -- A class sold by DATE RANGE told families its end date; a make-up week
  -- would meet after it, and nothing that reads end_date (emails, roster,
  -- range drift check) would know.
  IF p_makeup AND v_mode = 'range' THEN
    RAISE EXCEPTION 'this class runs between fixed dates, so a make-up can''t be added at the end - skip the day without one';
  END IF;

  -- Skipping the LAST class without a make-up moves the "final session" back a
  -- week. The instructor's distance bonus rides the final session's pay line;
  -- if that earlier line is already paid the bonus can never be paid.
  IF NOT p_makeup AND p_date = (SELECT max(d) FROM unnest(v_dates) d) THEN
    RAISE EXCEPTION 'that''s the last class, so it can only be rescheduled with a make-up';
  END IF;

  -- Lock this day's pay lines BEFORE judging them, so an instructor confirming
  -- the day at the same moment either lands first (and blocks this) or waits
  -- and finds it withheld.
  PERFORM 1 FROM session_delivery_confirmations c
    WHERE c.program_id = p_program_id AND c.session_date = p_date
    FOR UPDATE;

  -- A day somebody said they taught, or that has moved money, is not a
  -- schedule change any more. An unconfirmed placeholder an admin already
  -- WITHHELD by hand does not block: nothing was taught or paid, and it is
  -- left exactly as the admin set it (the UPDATE below only takes 'pending').
  SELECT count(*) INTO v_blocking
    FROM session_delivery_confirmations c
   WHERE c.program_id = p_program_id
     AND c.session_date = p_date
     AND (c.confirmed_by <> 'pending'
          OR c.instructor_payout_id IS NOT NULL
          OR c.pay_status IN ('approved', 'adjusted', 'paid'));
  IF v_blocking > 0 THEN
    RAISE EXCEPTION 'that class was already marked taught or paid, so it can''t be rescheduled - correct it in payroll instead';
  END IF;

  WITH v AS (
    UPDATE session_delivery_confirmations c
       SET pay_status = 'withheld',
           pay_adjustment_reason = 'No class (rescheduled)',
           updated_at = now()
     WHERE c.program_id = p_program_id
       AND c.session_date = p_date
       AND c.confirmed_by = 'pending'
       AND c.pay_status = 'pending'
       AND c.instructor_payout_id IS NULL
     RETURNING c.id
  )
  SELECT COALESCE(array_agg(id), '{}') INTO v_voided FROM v;

  INSERT INTO program_session_skips
    (organization_id, program_id, session_date, makeup, credit_families, voided_confirmation_ids, created_by)
  VALUES (v_org, p_program_id, p_date, p_makeup, COALESCE(p_credit_families, false), v_voided, auth.uid())
  RETURNING id INTO v_skip_id;

  -- In the same transaction: the day and its credits succeed or fail together.
  IF COALESCE(p_credit_families, false) THEN
    v_credits := credit_families_for_skip(v_skip_id);
  END IF;

  -- Unanswered sub offers for this day close NOW, not at tonight's sweep:
  -- the stale 9/29 offer is what started this feature. Same function the
  -- nightly job runs (one spelling of "close an offer whose day is not
  -- held"), confined to this class so one admin's click does not walk every
  -- org's schedule.
  PERFORM close_sub_offers_on_days_not_held(p_program_id);

  -- Anyone who ACCEPTED a sub day on this date. The pop-up releases them
  -- through cancel-sub-cover so they are told; the schedule change alone
  -- must not silently drop a person who said yes.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'substitution_id', s.id,
           'sub_instructor_id', s.sub_instructor_id,
           'name', nullif(trim(coalesce(nullif(i.preferred_name, ''), i.first_name, '') || ' ' || coalesce(i.last_name, '')), '')
         )), '[]'::jsonb)
    INTO v_covers
    FROM assignment_substitutions s
    JOIN program_assignments pa ON pa.id = s.parent_assignment_id AND s.parent_assignment_type = 'program'
    LEFT JOIN instructors i ON i.id = s.sub_instructor_id
   WHERE pa.program_id = p_program_id
     AND s.date = p_date
     AND s.status = 'confirmed';

  v_dates := derive_program_session_dates(p_program_id);

  RETURN jsonb_build_object(
    'skip_id', v_skip_id,
    'date', p_date,
    'makeup', p_makeup,
    'credit_families', COALESCE(p_credit_families, false),
    'credits', v_credits,
    'last_date', (SELECT max(d) FROM unnest(v_dates) d),
    'sessions_left_in_schedule', COALESCE(array_length(v_dates, 1), 0),
    'voided_pay_lines', COALESCE(array_length(v_voided, 1), 0),
    'confirmed_covers', v_covers
  );
END;
$$;

revoke all on function public.skip_program_session(uuid, date, boolean, boolean) from public, anon;
grant execute on function public.skip_program_session(uuid, date, boolean, boolean) to authenticated, service_role;

-- --------------------------------------------- put back, credits too --
-- Same body as 20261007c, plus: every credit this skip issued that nobody has
-- touched is voided, under the same per-family lock apply_family_credit,
-- capture_family_credit_hold and restore_family_credit_for_registration take,
-- so a checkout spending it at that instant either lands first (and the credit
-- is kept) or waits. "Untouched" = no movement of any kind, including an
-- expired hold: the strictest reading, so a credit is never pulled from under
-- a family who has started to use it. Voiding gives the ceiling back (the
-- paid-refunded-credited sum excludes void credits).
create or replace function public.restore_program_session(p_skip_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
DECLARE
  v_row     program_session_skips%ROWTYPE;
  v_dates   date[];
  v_credit  record;
  v_voided  int := 0;
  v_kept    jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_row FROM program_session_skips WHERE id = p_skip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that rescheduled day was not found';
  END IF;
  IF NOT (can_admin_org(v_row.organization_id) OR is_platform_admin()) THEN
    RAISE EXCEPTION 'not authorized to change this program''s schedule';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('program_schedule:' || v_row.program_id::text));

  -- Re-read under the lock: two undos at once must not both proceed.
  SELECT * INTO v_row FROM program_session_skips WHERE id = p_skip_id FOR UPDATE;
  IF v_row.restored_at IS NOT NULL THEN
    RAISE EXCEPTION 'that day is already back on the schedule';
  END IF;
  -- Putting a day back after it has passed would rewrite history: a class
  -- that did not meet would reappear as held, and with a make-up the extra
  -- week (possibly already taught and paid) would vanish from the schedule.
  -- The make-up always falls after the skipped day, so this one guard covers
  -- both.
  -- The ORG's today, not the database's: current_date is UTC, which is already
  -- tomorrow by late afternoon in the Pacific, and would refuse today's class.
  IF v_row.session_date < (now() AT TIME ZONE COALESCE(
       (SELECT o.timezone FROM organizations o WHERE o.id = v_row.organization_id),
       'America/Los_Angeles'))::date THEN
    RAISE EXCEPTION 'that day has already passed, so it can''t be put back on the schedule';
  END IF;

  UPDATE program_session_skips
     SET restored_at = now(), restored_by = auth.uid()
   WHERE id = p_skip_id;

  v_dates := derive_program_session_dates(v_row.program_id);

  -- Only the placeholders THIS skip withheld, and only while they still carry
  -- its reason: an admin who has since decided something else about that line
  -- keeps their decision. And only if the day really is back: if a closure
  -- now covers it, the line stays "no class" (the pay-line guard would refuse
  -- the flip anyway, and failing the whole undo over it would be worse).
  IF v_row.session_date = ANY (v_dates) THEN
    UPDATE session_delivery_confirmations c
       SET pay_status = 'pending',
           pay_adjustment_reason = NULL,
           updated_at = now()
     WHERE c.id = ANY (v_row.voided_confirmation_ids)
       AND c.pay_status = 'withheld'
       AND c.pay_adjustment_reason = 'No class (rescheduled)'
       AND c.instructor_payout_id IS NULL;
  END IF;

  -- The credits this skip issued (their keys carry its id).
  FOR v_credit IN
    SELECT fc.id, fc.parent_id, fc.amount_cents
      FROM family_credits fc
     WHERE fc.organization_id = v_row.organization_id
       AND fc.idempotency_key LIKE 'skip:' || p_skip_id::text || ':%'
       AND fc.status = 'active'
     ORDER BY fc.parent_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext('family_credit_balance:' || v_row.organization_id::text || ':' || v_credit.parent_id::text));
    IF NOT EXISTS (SELECT 1 FROM family_credit_movements m WHERE m.credit_id = v_credit.id) THEN
      UPDATE family_credits
         SET status = 'void', updated_at = now(),
             note = COALESCE(note || ' | ', '') || 'Voided: the day was put back on the schedule'
       WHERE id = v_credit.id AND status = 'active';
      v_voided := v_voided + 1;
    ELSE
      v_kept := v_kept || jsonb_build_object(
        'credit_id', v_credit.id,
        'parent_id', v_credit.parent_id,
        'name', (SELECT nullif(trim(coalesce(pa.first_name, '') || ' ' || coalesce(pa.last_name, '')), '')
                   FROM parents pa WHERE pa.id = v_credit.parent_id),
        'amount_cents', v_credit.amount_cents);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'date', v_row.session_date,
    'makeup', v_row.makeup,
    'last_date', (SELECT max(d) FROM unnest(v_dates) d),
    'back_on_schedule', v_row.session_date = ANY (v_dates),
    'credits_voided', v_voided,
    'credits_kept', v_kept
  );
END;
$$;

revoke all on function public.restore_program_session(uuid) from public, anon;
grant execute on function public.restore_program_session(uuid) to authenticated, service_role;
