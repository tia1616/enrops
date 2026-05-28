-- 20260527_organizations_stripe_business_type_country.sql
--
-- Per-tenant Stripe Express account creation params. These were hardcoded
-- in stripe-connect-onboard's first version (business_type='company',
-- country='US'). That broke multi-tenant from the start — every operator's
-- Express account would be filed as a US company regardless of their
-- actual structure. Captured per-tenant in the Finances tab before they
-- click Connect Stripe.
--
-- Both columns are UNLOCKED — org owner/admin sets them via the UI. They
-- are NOT in the locked-columns trigger because they're operator config,
-- not Enrops pricing.
--
-- stripe_business_type: null = let Stripe ask in the form. Otherwise pre-fills.
-- stripe_country: required by Stripe at account creation. Default 'US' so
-- existing flows don't break, but the UI should explicitly capture it.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS stripe_business_type TEXT
    CHECK (stripe_business_type IS NULL
           OR stripe_business_type IN ('company', 'individual', 'non_profit', 'government_entity')),
  ADD COLUMN IF NOT EXISTS stripe_country TEXT NOT NULL DEFAULT 'US'
    CHECK (char_length(stripe_country) = 2 AND stripe_country = upper(stripe_country));

COMMENT ON COLUMN organizations.stripe_business_type IS 'Stripe Express account business_type. NULL = let Stripe ask the operator in the hosted form. Captured pre-Connect in Finances tab.';
COMMENT ON COLUMN organizations.stripe_country IS 'ISO 3166-1 alpha-2 country code (uppercase). Required by Stripe at Express account create. Default US for backwards compat; UI should capture explicitly for new tenants.';
