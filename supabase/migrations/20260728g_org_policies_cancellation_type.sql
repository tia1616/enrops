-- Arielle's v4 section 6, item 1: "Checkout: show the operator's
-- cancellation/refund policy before payment is collected."
--
-- There was nowhere to put one. org_policies allowed privacy/terms plus five
-- PLATFORM-only types, so providers had to bury cancellation terms inside their
-- Terms of Service (J2S does exactly that) where a family reads them only if
-- they go looking, and never at the moment they are about to pay.
--
-- Additive: widens the CHECK, changes no rows, and nothing reads the new type
-- until the UI ships. Existing rows stay valid.

ALTER TABLE public.org_policies
  DROP CONSTRAINT IF EXISTS org_policies_policy_type_check;

ALTER TABLE public.org_policies
  ADD CONSTRAINT org_policies_policy_type_check
  CHECK (policy_type = ANY (ARRAY[
    'privacy'::text,
    'terms'::text,
    'cancellation'::text,
    'acceptable-use'::text,
    'cookies'::text,
    'data-retention'::text,
    'subprocessors'::text,
    'dpa'::text
  ]));

COMMENT ON CONSTRAINT org_policies_policy_type_check ON public.org_policies IS
  'privacy/terms/cancellation are PROVIDER documents with public routes at /{slug}/<type>. The rest are platform documents published under the enrops org. Never offer a type here without a public route - an operator would write a document no family could reach.';
