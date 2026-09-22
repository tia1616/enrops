-- Credits, code-review fixes. Both tables are still EMPTY on staging and prod,
-- so these are free to make now and expensive to make later.
--
-- ---------------------------------------------------------------------------
-- 1. A LEDGER MUST NOT LOSE ROWS WHEN A PARENT ROW IS TIDIED UP
-- ---------------------------------------------------------------------------
-- 20260922b says, of the 'void' status: "kept, never deleted, because a ledger
-- that loses rows is not a ledger" - and then attached the credit to `parents`
-- with ON DELETE CASCADE, which deletes it, and takes its entire movement
-- history with it through the movements' own cascade.
--
-- That is not hypothetical here: duplicate parent rows get merged, and the
-- merge deletes the loser. Under CASCADE, a family's outstanding credit
-- silently disappears with no trace that money was ever owed.
--
-- RESTRICT instead: a parent who is owed money cannot be deleted until somebody
-- decides what happens to the money. That is a deliberate obstacle, and it is
-- the cheap side of the trade - the alternative is discovering the loss when a
-- family asks where their credit went.
--
-- The ORGANISATION cascade is left alone on purpose. Deleting an organisation
-- is a full teardown of that tenant, and a credit owed by a business that no
-- longer exists has nowhere to live.
alter table public.family_credits
  drop constraint if exists family_credits_parent_id_fkey;

alter table public.family_credits
  add constraint family_credits_parent_id_fkey
  foreign key (parent_id) references public.parents(id) on delete restrict;

-- ---------------------------------------------------------------------------
-- 2. THE IDEMPOTENCY KEY IS PER-ORGANISATION, NOT GLOBAL
-- ---------------------------------------------------------------------------
-- 20260922c made the key unique across the whole table, which quietly turned it
-- into a shared namespace between tenants. Any caller keying off something
-- org-local - 'withdraw:2026-09-22:1' is the obvious shape - would collide with
-- another business's key, and the SECOND organisation's legitimate credit would
-- be rejected with 23505. One tenant silently denying another is exactly the
-- class of bug this platform's multi-tenant rules exist to prevent.
--
-- Scoped to (organization_id, idempotency_key), the guarantee that matters is
-- unchanged: the same caller cannot issue the same credit twice, which is what
-- protects against the double-delivered Stripe webhook and the double-clicked
-- button. NULLs are still not deduplicated, deliberately.
drop index if exists uq_family_credits_idempotency;

create unique index if not exists uq_family_credits_org_idempotency
  on public.family_credits (organization_id, idempotency_key)
  where idempotency_key is not null;

comment on column public.family_credits.idempotency_key is
  'Caller-supplied key, unique WITHIN an organisation when present; NULLs are not deduplicated. Guards against the double-delivery of the two live Stripe webhook endpoints, and against a double-clicked operator action. Scoped per-org so one tenant cannot block another by choosing the same key.';
