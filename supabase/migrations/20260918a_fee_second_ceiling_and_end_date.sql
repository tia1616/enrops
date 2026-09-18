-- The bank ceiling, and an end date for a negotiated rate.
--
-- Money layer (17 Sept 2026) section 4:
--   "$1.99 minimum, $14.99 card maximum, $9.99 bank maximum, applied to the
--    line, not the cart."
--   "Per-organisation setting with an end date, not a hardcoded exception.
--    Jeff needs it now; Custom will need it later."
--
-- ADDITIVE AND INERT, ALL OF IT. Two nullable columns and one settings row.
-- Every column defaults to NULL, and NULL means "carry on exactly as before":
-- no bank ceiling of its own, and no expiry. No org's fee changes by a cent
-- when this is applied, and none changes until somebody deliberately writes a
-- value. The doc's own effective date is SHIP DAY, not the day the schema
-- lands, so the schema landing early is the point.
--
-- WHY A SECOND COLUMN RATHER THAN RENAMING THE FIRST. platform_fee_cap_cents is
-- read by create-checkout, process-installments, org-fee-config and the browser.
-- Renaming it to platform_fee_card_cap_cents would be correct and would also be
-- a flag day across all four. The pair reads the way the rate pair already does
-- (platform_fee_card_pct / platform_fee_ach_pct) once you know the rule: the
-- unqualified column is the default and the card ceiling; the ach one overrides
-- it for bank. That rule lives in _shared/feeConfig.ts, in one place.
--
-- WHY NO SECOND FLOOR. The doc names one minimum, $1.99, with no per-rail
-- split. A column nobody can point at a sentence in the spec is a column
-- somebody will fill in wrongly later.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS platform_fee_ach_cap_cents integer;

COMMENT ON COLUMN public.organizations.platform_fee_ach_cap_cents IS
  'Maximum enrops service fee per registration LINE when the family pays by '
  'bank. NULL means no bank-specific ceiling: fall back to '
  'platform_fee_cap_cents, which is the card and default ceiling. Money layer '
  'section 4 sets these at $14.99 card and $9.99 bank. Per LINE, never per '
  'cart - see _shared/cartFee.ts. Resolved by _shared/feeConfig.ts; do not read '
  'this column directly.';

-- The end date for a negotiated rate.
--
-- NAMED "override_until" ON PURPOSE. An earlier draft called it
-- platform_fee_ends_on, which reads as "the fee stops" - the opposite of what
-- it does. What ends is the ORG'S OWN terms; after this date the organisation
-- falls back to the platform default pricing in platform_settings.
--
-- Jeff is the reason it exists: 1% through 31 December 2030, agreed, and the
-- doc is explicit that it must be a setting with an end date and never a
-- hardcoded exception. Nobody's date is set by this migration - that is an
-- operator decision, made deliberately, not a side effect of a schema change.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS platform_fee_override_until date;

COMMENT ON COLUMN public.organizations.platform_fee_override_until IS
  'Last date on which this organisation''s OWN platform_fee_* columns apply. '
  'After it, the organisation falls back to platform_settings.default_fee_config. '
  'NULL means the org''s own terms never expire, which is every org today. '
  'Inclusive: the terms still apply ON this date. Set for negotiated rates only '
  '(Jeff: 1% through 2030-12-31). Resolved by _shared/feeConfig.ts.';

-- The platform's own default pricing, in the database rather than in code.
--
-- Nothing reads this until an organisation's override_until has PASSED, which
-- is never today because every org's is NULL. It is seeded now so that the
-- resolver has a real source from the first line of code that asks for it, and
-- so the numbers live in one place that Jessica and Arielle can change without
-- a deploy.
--
-- These are the money layer's section 4 numbers. They are NOT yet what any org
-- charges - the ship-day flip is a separate, deliberate act.
INSERT INTO public.platform_settings (key, value)
VALUES (
  'default_fee_config',
  jsonb_build_object(
    'card_pct',      0.03,
    'ach_pct',       0.02,
    'floor_cents',   199,
    'card_cap_cents', 1499,
    'ach_cap_cents',  999,
    'note', 'Money layer 2026-09-17 section 4. Applied PER REGISTRATION LINE, never per cart. Read only when an organisation platform_fee_override_until has passed.'
  )
)
ON CONFLICT (key) DO NOTHING;
