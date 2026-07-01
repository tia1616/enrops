// marketing-delete-draft
//
// Permanently delete a DRAFT marketing campaign (and its touchpoints) for an
// org admin. Drafts ONLY — a campaign that has been approved/scheduled/sent
// (approved_at IS NOT NULL) can never be deleted through this path.
//
// Auth + client pattern mirrors marketing-draft-campaign exactly:
//   - verifyCaller(Authorization): JWT -> user client (SUPABASE_ANON_KEY) ->
//     checks platform_admins / org_members (owner|admin, accepted).
//   - Service-role client for the actual reads/writes. Service role is safe
//     here ONLY because we do three explicit guards ourselves before any
//     delete runs:
//       1. ORG-ADMIN gate    — caller must be platform_admin OR owner/admin of
//                              the passed organization_id.
//       2. ORG-OWNERSHIP gate — the campaign row's organization_id MUST equal
//                              the passed organization_id (blocks deleting
//                              another tenant's campaign by id).
//       3. DRAFT-ONLY gate    — campaign.approved_at MUST be null (blocks
//                              deleting a live/scheduled/sent campaign).
//   These are the same guards the other admin functions rely on. The delete
//   statements re-apply the org + approved_at filters (defense in depth) so
//   even a logic slip above can't delete a non-draft or cross-org row.
//
// Body shape:
//   { organization_id: uuid, campaign_id: uuid }
//
// marketing_campaigns columns: id, organization_id, name, status, approved_at.
// marketing_campaign_touchpoints has campaign_id + organization_id FKs.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonError(error: string, status = 400, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function jsonOk(data: Record<string, unknown>) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Auth (mirrors marketing-draft-campaign)
// ---------------------------------------------------------------------------

type Caller = { userId: string; isPlatformAdmin: boolean; adminOrgIds: Set<string> };

async function verifyCaller(
  authHeader: string | null,
): Promise<
  | { ok: true; caller: Caller; userClient: SupabaseClient }
  | { ok: false; reason: string; status: number }
> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, reason: "Missing Authorization header", status: 401 };
  }
  const token = authHeader.slice("Bearer ".length);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userResp, error: userErr } = await userClient.auth.getUser(token);
  if (userErr || !userResp?.user) {
    return { ok: false, reason: "Invalid session", status: 401 };
  }
  const userId = userResp.user.id;

  const { data: paRow } = await userClient
    .from("platform_admins")
    .select("auth_user_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  const isPlatformAdmin = !!paRow;

  const { data: orgRows } = await userClient
    .from("org_members")
    .select("organization_id, role, accepted_at")
    .eq("auth_user_id", userId)
    .in("role", ["owner", "admin"]);
  const adminOrgIds = new Set(
    (orgRows ?? [])
      .filter((r: { accepted_at: string | null }) => r.accepted_at)
      .map((r: { organization_id: string }) => r.organization_id),
  );

  return { ok: true, caller: { userId, isPlatformAdmin, adminOrgIds }, userClient };
}

// ---------------------------------------------------------------------------
// Request parsing + validation
// ---------------------------------------------------------------------------

type DeleteRequest = { organization_id: string; campaign_id: string };

function parseRequest(body: unknown):
  | { ok: true; req: DeleteRequest }
  | { ok: false; error: string; status: number } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "request body required", status: 400 };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.organization_id !== "string" || !b.organization_id.trim()) {
    return { ok: false, error: "organization_id required", status: 400 };
  }
  if (typeof b.campaign_id !== "string" || !b.campaign_id.trim()) {
    return { ok: false, error: "campaign_id required", status: 400 };
  }
  return {
    ok: true,
    req: { organization_id: b.organization_id.trim(), campaign_id: b.campaign_id.trim() },
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("method not allowed", 405);

  // ---- Auth ----
  const auth = await verifyCaller(req.headers.get("Authorization"));
  if (!auth.ok) return jsonError(auth.reason, auth.status);
  const { caller } = auth;

  // ---- Parse request ----
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }
  const parsed = parseRequest(body);
  if (!parsed.ok) return jsonError(parsed.error, parsed.status);
  const { organization_id, campaign_id } = parsed.req;

  // ---- Guard 1: org-admin gate ----
  // Caller must be a platform admin OR an accepted owner/admin of this org.
  if (!caller.isPlatformAdmin && !caller.adminOrgIds.has(organization_id)) {
    return jsonError("forbidden: caller has no admin access to this organization", 403);
  }

  // Service-role client for downstream reads/writes. RLS is already enforced by
  // the explicit auth gate above + the org-ownership and draft-only guards
  // below; service role lets us avoid second-guessing each policy from inside
  // this trusted function.
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ---- Fetch the campaign (by id only) so we can verify ownership + draft state ----
  const { data: campaign, error: fetchErr } = await supabase
    .from("marketing_campaigns")
    .select("id, organization_id, name, status, approved_at")
    .eq("id", campaign_id)
    .maybeSingle();
  if (fetchErr) {
    return jsonError(`campaign lookup failed: ${fetchErr.message}`, 500);
  }
  if (!campaign) {
    return jsonError("campaign not found", 404);
  }

  // ---- Guard 2: org-ownership gate ----
  // The campaign must belong to the org the caller passed. This blocks a caller
  // (even a legit admin of org A) from deleting a campaign that belongs to org B
  // by guessing/knowing its id.
  if (campaign.organization_id !== organization_id) {
    return jsonError("campaign does not belong to this organization", 403);
  }

  // ---- Guard 3: draft-only gate ----
  // approved_at set means the campaign has been approved/scheduled/sent — never
  // deletable through this path.
  if (campaign.approved_at !== null && campaign.approved_at !== undefined) {
    return jsonError("only draft campaigns can be deleted", 409);
  }

  // ---- Delete touchpoints first (FK children), scoped to both id + org ----
  const { error: tpErr } = await supabase
    .from("marketing_campaign_touchpoints")
    .delete()
    .eq("campaign_id", campaign_id)
    .eq("organization_id", organization_id);
  if (tpErr) {
    return jsonError(`failed to delete campaign touchpoints: ${tpErr.message}`, 500);
  }

  // ---- Delete the campaign row. Re-apply org + draft guards (defense in depth):
  // the approved_at IS NULL filter guarantees that even a race that flips a
  // draft to approved between the fetch and here cannot delete a live campaign. ----
  const { data: deletedRows, error: delErr } = await supabase
    .from("marketing_campaigns")
    .delete()
    .eq("id", campaign_id)
    .eq("organization_id", organization_id)
    .is("approved_at", null)
    .select("id");
  if (delErr) {
    return jsonError(`failed to delete campaign: ${delErr.message}`, 500);
  }
  if (!deletedRows || deletedRows.length === 0) {
    // The guarded delete matched nothing — the campaign was approved/scheduled
    // (or moved orgs) between the fetch and the delete. Treat as conflict.
    return jsonError("only draft campaigns can be deleted", 409);
  }

  return jsonOk({ deleted: true, campaign_id });
});
