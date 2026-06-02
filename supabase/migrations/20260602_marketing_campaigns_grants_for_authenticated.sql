-- marketing_campaigns was created without GRANTs for the `authenticated`
-- role, so every browser-initiated SELECT/UPDATE on it failed with
-- "permission denied for table marketing_campaigns" before RLS could even
-- run. This was the real cause of the 403s we kept attributing to RLS
-- transients during the FA26 build; the function-based RLS policy never
-- got a chance to evaluate because GRANT is the first gate.
--
-- Granting SELECT + UPDATE so org admins can approve their campaigns from
-- the UI. INSERT stays service-role-only (drafts are created by the
-- marketing-draft-campaign edge function under service-role). DELETE is
-- not exposed to the UI either.
--
-- RLS already in place: the `org_read_campaigns` policy via
-- check_org_access(organization_id) gates rows to the caller's org.
grant select, update on public.marketing_campaigns to authenticated;

-- Same fix for marketing_sends — the UI will need to read send results
-- when we ship the "send results" surface (status of approved campaigns).
-- Today the cron writes via service-role; the UI reads from this table
-- through the recipient list and post-send dashboards. Grant SELECT now
-- to avoid the same trap.
grant select on public.marketing_sends to authenticated;
