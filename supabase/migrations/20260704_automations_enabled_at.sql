-- Track when an automation was turned on, so contact-based automations
-- (welcome_contact) only reach contacts added AFTER enable — never the existing
-- back-catalog. Without this, importing families as "new" and then enabling the
-- Welcome automation could blast the whole recent import. Additive; applied to
-- staging via MCP 2026-07-04, prod at release.
alter table public.automations add column if not exists enabled_at timestamptz;

-- Backfill currently-enabled rows with a sensible enable time so the gate has a
-- baseline. (Only welcome_contact reads this; lifecycle automations ignore it.)
update public.automations set enabled_at = coalesce(enabled_at, created_at) where enabled = true;
