// wufoo-sync — pull a tenant's Wufoo form entries into Enrops contacts.
//
// Flow: verify the caller is an owner/admin of the org (they own the Wufoo key)
// -> read the org's wufoo_connections row (secret api_key, service-role) -> fetch
// entries from the Wufoo v3 API (paginated, Basic auth) -> transform them via the
// shared, unit-tested wufooTransform (config-driven field mapping) -> feed them
// through the EXISTING hardened import-contacts path (dedup + tag-union + org-stamp)
// by forwarding the caller's auth, so there's one write path, not two.
//
// Auth mirrors import-contacts. Manual "Sync now" for MVP; a scheduled/webhook
// path (with a service-auth import path) comes later.
//
// NOTE: not yet live-verified against a real Wufoo account (pending a tenant's
// API key). The transform is unit-tested; the API interaction follows Wufoo v3
// docs (Basic auth with the API key as username; entries.json; pageStart/pageSize).

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { wufooEntriesToContacts, WufooFieldMapping } from "../_shared/wufooTransform.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Auth: mirrors import-contacts. Bearer JWT -> user client -> platform_admins /
// org_members(owner|admin, accepted). Returns whether the caller may act on org.
async function verifyOrgAdmin(
  authHeader: string | null,
  organizationId: string,
): Promise<{ ok: true } | { ok: false; reason: string; status: number }> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, reason: "Missing Authorization header", status: 401 };
  }
  const token = authHeader.slice("Bearer ".length);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userResp, error: userErr } = await userClient.auth.getUser(token);
  if (userErr || !userResp?.user) return { ok: false, reason: "Invalid session", status: 401 };
  const userId = userResp.user.id;

  const { data: paRow } = await userClient
    .from("platform_admins").select("auth_user_id").eq("auth_user_id", userId).maybeSingle();
  if (paRow) return { ok: true };

  const { data: memRow } = await userClient
    .from("org_members")
    .select("role, accepted_at")
    .eq("auth_user_id", userId)
    .eq("organization_id", organizationId)
    .in("role", ["owner", "admin"])
    .maybeSingle();
  if (memRow && (memRow as { accepted_at: string | null }).accepted_at) return { ok: true };

  return { ok: false, reason: "Not an owner/admin of this organization", status: 403 };
}

// Wufoo v3: Basic auth with the API key as the username and ANY password.
async function fetchWufooEntries(subdomain: string, apiKey: string, formHash: string): Promise<Record<string, unknown>[]> {
  const auth = "Basic " + btoa(`${apiKey}:enrops`);
  const PAGE = 100; // Wufoo max
  let pageStart = 0;
  const all: Record<string, unknown>[] = [];
  for (;;) {
    const url = `https://${encodeURIComponent(subdomain)}.wufoo.com/api/v3/forms/${encodeURIComponent(formHash)}/entries.json?pageStart=${pageStart}&pageSize=${PAGE}`;
    const resp = await fetch(url, { headers: { Authorization: auth, "User-Agent": "Enrops" } });
    if (resp.status === 401 || resp.status === 403) throw new Error("Wufoo rejected the API key or subdomain.");
    if (resp.status === 404) throw new Error("Wufoo form not found — check the form id.");
    if (resp.status === 429) throw new Error("Wufoo rate limit hit — try again in a few minutes.");
    if (!resp.ok) throw new Error(`Wufoo request failed (HTTP ${resp.status}).`);
    const data = await resp.json().catch(() => ({}));
    const entries = (data?.Entries ?? []) as Record<string, unknown>[];
    all.push(...entries);
    if (entries.length < PAGE) break;
    pageStart += PAGE;
    if (all.length > 20000) break; // sanity ceiling
  }
  return all;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const authHeader = req.headers.get("Authorization");
  let body: { organization_id?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  const organization_id = body?.organization_id;
  if (!organization_id || typeof organization_id !== "string") {
    return json({ error: "organization_id required" }, 400);
  }

  const gate = await verifyOrgAdmin(authHeader, organization_id);
  if (!gate.ok) return json({ error: gate.reason }, gate.status);

  // Service-role read of the connection (secret api_key) — only AFTER the admin gate.
  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: conn, error: connErr } = await admin
    .from("wufoo_connections")
    .select("subdomain, api_key, form_hash, field_mapping")
    .eq("organization_id", organization_id)
    .eq("is_active", true)
    .maybeSingle();
  if (connErr) return json({ error: `connection lookup failed: ${connErr.message}` }, 500);
  if (!conn) return json({ error: "No active Wufoo connection for this organization." }, 404);
  if (!conn.form_hash) return json({ error: "No Wufoo form selected yet." }, 400);
  if (!conn.field_mapping || !(conn.field_mapping as WufooFieldMapping).email) {
    return json({ error: "Wufoo field mapping is missing an email field." }, 400);
  }

  const stamp = (status: "ok" | "error", error: string | null) =>
    admin.from("wufoo_connections")
      .update({ last_synced_at: new Date().toISOString(), last_sync_status: status, last_sync_error: error })
      .eq("organization_id", organization_id);

  let entries: Record<string, unknown>[];
  try {
    entries = await fetchWufooEntries(conn.subdomain as string, conn.api_key as string, conn.form_hash as string);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await stamp("error", msg);
    return json({ error: msg }, 502);
  }

  const contacts = wufooEntriesToContacts(entries, conn.field_mapping as WufooFieldMapping);

  // Reuse the hardened import path. Forward the caller's auth so import-contacts
  // re-verifies the SAME admin — one audited write path, no duplicated merge logic.
  const importResp = await fetch(`${SUPABASE_URL}/functions/v1/import-contacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader!, apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ organization_id, contacts, source: "wufoo" }),
  });
  const importResult = await importResp.json().catch(() => ({}));
  if (!importResp.ok) {
    const msg = (importResult as { error?: string })?.error ?? "import failed";
    await stamp("error", msg);
    return json({ error: msg, wufoo_entries: entries.length }, 502);
  }

  await stamp("ok", null);
  return json({ wufoo_entries: entries.length, transformed: contacts.length, import: importResult });
});
