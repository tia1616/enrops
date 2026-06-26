-- ACH / bank-transfer support: marker for delayed (async-settling) payments.
--
-- Card payments settle instantly; ACH takes 3-5 business days. Per the product
-- decision, we hold the seat optimistically (status='confirmed') and the
-- registration stays payment_status='unpaid' until the bank transfer clears,
-- then flips to 'paid'. This column distinguishes an ACH-in-flight 'unpaid'
-- from an ordinary unpaid/invoice registration, and drives the family
-- "payment processing" note + the operator follow-up alert on a bounce.
--
-- Additive + nullable: existing rows get NULL (correct — they are card/invoice,
-- not pending ACH). The payment_status CHECK is left untouched (still only
-- unpaid/paid/refunded/partial), so no roster/revenue reader needs to change.
ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS ach_payment_state text
    CHECK (ach_payment_state IS NULL OR ach_payment_state IN ('processing', 'failed'));

COMMENT ON COLUMN registrations.ach_payment_state IS
  'ACH/bank-transfer settlement state for delayed payments: processing | failed | NULL. NULL = card, invoice, or already settled. payment_status stays unpaid until the ACH clears (then paid).';
