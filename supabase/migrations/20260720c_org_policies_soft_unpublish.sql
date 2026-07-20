-- Soft-unpublish for org_policies.
--
-- Before this, "unpublish" DELETEd the row, destroying the operator's policy
-- text, while the confirm dialog promised "you can publish it again later".
-- This adds a `published` flag so unpublishing keeps the text as a hidden draft
-- and republishing is one click, not a full re-paste.
--
-- ADDITIVE + INERT: the column defaults to true, so every existing row (all of
-- which are currently published) is unchanged, and every reader that has not
-- yet learned to filter still sees exactly what it saw before. The public
-- readers (PolicyPage, fetchPublishedPolicyTypes) are updated in the same
-- release to filter published = true; the admin surface reads all rows and keys
-- the card state on the flag. No backfill needed.
--
-- RLS unchanged: soft-unpublish is an UPDATE (policy "Org members can update own
-- org policies" already exists and is proven), replacing the old DELETE. The
-- DELETE policy stays in place for the "delete draft entirely" path.

alter table public.org_policies
  add column if not exists published boolean not null default true;

-- effective_date is NOT NULL with no default, but the editor offers it as an
-- OPTIONAL field and savePolicy sends null when it's left blank -- so the first
-- operator who publishes without a date hits a 23502 not-null violation and the
-- save fails. Every reader already treats effective_date as optional
-- (`row.effective_date ? ... : ...`), so widening it to nullable matches the
-- real contract. Widening only; existing non-null values are untouched.
alter table public.org_policies
  alter column effective_date drop not null;

comment on column public.org_policies.published is
  'Whether this policy is live on the provider''s public pages. false = saved draft, text retained but hidden from families. Public readers must filter published = true; the admin editor reads all rows.';
