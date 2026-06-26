-- Wire up fee pass-through (operator can pass the 1% platform fee to families).
--
-- Safety: default flips to FALSE so operators ABSORB the fee unless they
-- deliberately opt in via the Finances toggle. (Previously defaulted true,
-- which would have charged every new operator's families a fee by default.)
ALTER TABLE organizations ALTER COLUMN fee_pass_through SET DEFAULT false;

-- Snapshot the pass-through mode at first charge, alongside the rate/cap
-- snapshot. Installments 2 & 3 read this so the whole plan stays on the mode
-- in effect when the family first paid, even if the operator toggles later.
-- Nullable: legacy registrations have no snapshot and fall back to absorb.
ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS platform_fee_pass_through_at_charge boolean;

COMMENT ON COLUMN registrations.platform_fee_pass_through_at_charge IS
  'Whether the platform fee was passed through to the family at first charge. Snapshotted with platform_fee_rate_at_charge / _cap_cents_at_charge. NULL = legacy/absorb.';
