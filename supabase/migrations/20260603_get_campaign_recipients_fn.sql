-- get_campaign_recipients(campaign_id) — single-call recipient loader for
-- marketing-touchpoint-send. Replaces client-side chunking of recipient_ids
-- through PostgREST URL IN-clauses (the previous pattern hit Cloudflare's
-- HTTP/2 stream limit at 500 UUIDs and required manual chunking for 1000+).
--
-- Multi-tenant safety: joins through marketing_campaigns so the recipient
-- rows returned are ONLY those whose organization_id matches the campaign's
-- organization_id AND whose id is in the campaign's approved_recipient_ids.
-- A caller (including a compromised admin) can trigger a send for any
-- campaign but cannot influence which recipients are loaded — that's set
-- at approval time, not at send time.
--
-- SECURITY DEFINER so service-role + anon callers both work; the function
-- body enforces the join itself.
--
-- Applied via Supabase MCP on 2026-06-03. This file mirrors that write for
-- source control.
CREATE OR REPLACE FUNCTION public.get_campaign_recipients(p_campaign_id uuid)
RETURNS TABLE (
  id uuid,
  email text,
  parent_name text,
  child_first_name text,
  child_last_name text,
  school_name text,
  city text,
  zip text,
  geo_segment text,
  segments text[]
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    mr.id,
    mr.email,
    mr.parent_name,
    mr.child_first_name,
    mr.child_last_name,
    mr.school_name,
    mr.city,
    mr.zip,
    mr.geo_segment,
    mr.segments
  FROM marketing_campaigns mc
  JOIN marketing_recipients mr
    ON mr.organization_id = mc.organization_id
   AND mr.id = ANY(mc.approved_recipient_ids)
  WHERE mc.id = p_campaign_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_campaign_recipients(uuid) TO service_role;
