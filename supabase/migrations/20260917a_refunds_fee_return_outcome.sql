-- refunds.fee_return_outcome — record what happened when we tried to return
-- the enrops service fee, instead of leaving it to be inferred from a number.
--
-- Money layer (16 Sept 2026) section 6, blocker 1, fifth checkbox: "logs every
-- attempt, success or failure, somewhere we can both see."
--
-- THE PROBLEM THIS CLOSES. platform_fee_refunded_cents = 0 means two different
-- things and always has: nothing was owed, or we tried and could not. On
-- 8 September three fee returns failed on an empty platform balance and it
-- took a hand audit of production to find them. Counted on prod 17 Sept 2026:
-- 19 rows recorded a non-zero return, 4 recorded zero, and 1 never completed.
-- Three of the 19 had actually FAILED and were repaired by hand on 9 September;
-- nothing but free text in failure_reason says so.
--
-- ADDITIVE AND INERT. The column is nullable with no default and no backfill,
-- so every existing row keeps exactly the meaning it already had and no reader
-- changes behaviour. NULL means "no outcome was recorded" - true of every
-- refund before this ships - and is deliberately not a fourth state.
--
-- WHAT THIS DOES NOT TOUCH. platform_fee_refunded_cents keeps its current
-- meaning, including the one load-bearing use of it: stripe-webhook treats
-- IS NOT NULL as the completion marker when deciding whether a refund it is
-- being told about is already fully recorded. Changing that column's semantics
-- would break resume. This column sits beside it and answers a different
-- question.
--
-- GRANTS AND RLS: a new column inherits the table's, and refunds already has
-- row security on with org_money_manage_refunds and parents_see_own_refunds.
-- Nothing is granted here. Note for the record, not addressed by this
-- migration: parents_see_own_refunds already lets a parent SELECT their own
-- refund row including failure_reason, which carries internal margin wording.
-- That predates this change and is logged separately.

ALTER TABLE public.refunds
  ADD COLUMN IF NOT EXISTS fee_return_outcome text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.refunds'::regclass
      AND conname = 'refunds_fee_return_outcome_check'
  ) THEN
    ALTER TABLE public.refunds
      ADD CONSTRAINT refunds_fee_return_outcome_check
      CHECK (
        fee_return_outcome IS NULL
        OR fee_return_outcome IN ('returned', 'nothing_owed', 'failed')
      );
  END IF;
END $$;

COMMENT ON COLUMN public.refunds.fee_return_outcome IS
  'What happened when the enrops service fee was returned on this refund: '
  'returned (money went back), nothing_owed (the charge carried no enrops '
  'margin, e.g. a pre-29-June registration), failed (owed and did not come '
  'back - see failure_reason and margin_shortfall_alerts). NULL means no '
  'outcome was recorded, which is true of every refund before 2026-09-17 and '
  'of the one case the webhook cannot attribute. Written by BOTH refund paths '
  'via _shared/feeReturnOutcome.ts. Do not infer this from '
  'platform_fee_refunded_cents: a 0 there cannot tell nothing_owed from failed, '
  'which is the whole reason this column exists.';
