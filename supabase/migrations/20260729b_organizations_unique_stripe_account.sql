-- One Stripe account belongs to exactly one organization.
--
-- WHY. stripe-oauth-callback checks "is this account already on another org?"
-- and then, as a separate statement, writes it. Two callbacks for the same
-- Stripe account, for different orgs, can both pass the check and both write.
-- The window is small and the outcome is bad: refund scoping
-- (registrations.stripe_charge_account_id), payout attribution and 1099
-- reporting all assume a Stripe account has one owner. A check in application
-- code cannot make that true; a unique index can.
--
-- PARTIAL, because most orgs have no Stripe account and NULLs must stay
-- unrestricted. (Postgres would allow multiple NULLs in a plain UNIQUE anyway,
-- but being explicit documents the intent and keeps the index small.)
--
-- VERIFIED BEFORE CREATING: zero duplicate stripe_account_id values on staging
-- or prod on 2026-07-29, so this builds without a data fix.
--
-- SEAM - the other writer of this column. stripe-connect-onboard also sets
-- stripe_account_id: for an account it just minted (unique by construction), or
-- for an "orphan" it recovered by searching Stripe for metadata.enrops_org_id
-- matching THIS org, so it cannot legitimately find an account belonging to a
-- different org either. If it ever did, that would already be a data bug, and
-- this index turns it into a loud 23505 instead of a silent double-assignment.
-- That path returns persist_failed on a write error, which is the right
-- outcome.

CREATE UNIQUE INDEX IF NOT EXISTS organizations_stripe_account_id_unique
  ON public.organizations (stripe_account_id)
  WHERE stripe_account_id IS NOT NULL;

COMMENT ON INDEX public.organizations_stripe_account_id_unique IS
  'A Stripe connected account may belong to only one organization. Enforced in the database because the application-level check in stripe-oauth-callback is check-then-write and therefore racy.';
