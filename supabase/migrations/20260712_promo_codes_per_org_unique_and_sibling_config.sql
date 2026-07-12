-- Promo codes & discounts, chunk 1 (schema foundation).
--
-- 1. The existing UNIQUE(code) is GLOBAL across all tenants. It blocks two tenants
--    from ever using the same code, and it masks the missing organization_id filter
--    at redemption (today a code resolves to exactly one row only because it's globally
--    unique). Replace it with per-org, case-insensitive uniqueness among ACTIVE codes.
-- 2. Add optional per-code minimum cart (nullable = no minimum).
-- 3. Make the sibling discount org-configurable, replacing the hardcoded
--    SIBLING_DISCOUNT_PCT=10 constant in src/lib/pricing.js.
--
-- Behavior preservation: the old constant applied 10% to EVERY org, so we backfill
-- 10 onto every EXISTING org (no live change). New orgs default to NULL (off) and
-- opt in. Applied to staging + prod in the same release pass (parity).

ALTER TABLE promo_codes DROP CONSTRAINT IF EXISTS promo_codes_code_key;

CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_org_code_active_uniq
  ON promo_codes (organization_id, upper(code))
  WHERE active;

ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS min_subtotal_cents integer;

-- One-use-per-family cap (nullable = unlimited per family). Enforced server-side
-- via a promo_redemptions ledger built in the server-hardening chunk.
ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS per_family_limit integer;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS sibling_discount_pct numeric;

-- Preserve current behavior: every existing org was effectively at 10%.
UPDATE organizations SET sibling_discount_pct = 10 WHERE sibling_discount_pct IS NULL;
