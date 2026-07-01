-- Tenant mailing address for CAN-SPAM compliance. Every marketing email must
-- carry a physical postal address in its footer; this is the single freeform
-- text column that address is captured in (onboarding + Email sender settings)
-- and rendered from (marketing email footers). Additive + nullable — no
-- backfill, no NOT NULL, safe to run standalone on staging or prod.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS mailing_address text;

COMMENT ON COLUMN public.organizations.mailing_address IS
  'CAN-SPAM physical postal address for this org (e.g. "123 Main St, Portland, OR 97201"). Freeform single line/block. Rendered in the footer of marketing emails, under the unsubscribe link, only when present.';
