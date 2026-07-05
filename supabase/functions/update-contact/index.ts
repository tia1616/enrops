// update-contact — edit a single marketing_recipients row (fields + tags) from
// the Contacts list. The table grants withhold UPDATE from `authenticated`
// (all writes go through vetted service-role edge fns), so contact edits route
// here rather than a direct client update. Org-admin gated; the update is
// double-scoped (id AND organization_id) so a caller can only touch their org.
//
// Body: { organization_id, id, email, parent_name, phone, child_first_name,
//         child_last_name, child_birthdate, school_name, city, state, zip, tags }
// Returns: { ok: true, contact } or { error }.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonError(error: string, status = 400) {
  return new Response(JSON.stringify({ error }), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function jsonOk(data: Record<string, unknown>) {
  return new Response(JSON.stringify(data), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

type Caller = { userId: string; isPlatformAdmin: boolean; adminOrgIds: Set<string> };

async function verifyCaller(
  authHeader: string | null,
): Promise<{ ok: true; caller: Caller } | { ok: false; reason: string; status: number }> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return { ok: false, reason: "Missing Authorization header", status: 401 };
  const token = authHeader.slice("Bearer ".length);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userResp, error: userErr } = await userClient.auth.getUser(token);
  if (userErr || !userResp?.user) return { ok: false, reason: "Invalid session", status: 401 };
  const userId = userResp.user.id;
  const { data: paRow } = await userClient.from("platform_admins").select("auth_user_id").eq("auth_user_id", userId).maybeSingle();
  const { data: orgRows } = await userClient.from("org_members").select("organization_id, role, accepted_at").eq("auth_user_id", userId).in("role", ["owner", "admin"]);
  const adminOrgIds = new Set((orgRows ?? []).filter((r: { accepted_at: string | null }) => r.accepted_at).map((r: { organization_id: string }) => r.organization_id));
  return { ok: true, caller: { userId, isPlatformAdmin: !!paRow, adminOrgIds } };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((t) => (t === null || t === undefined ? "" : String(t).trim())).filter((t) => t !== "");
}
// Store a real ISO date or null — never let a bad DOB reject the update.
function parseDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let y = "", mo = "", d = "";
  if (m) { y = m[1]; mo = m[2]; d = m[3]; }
  else { m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (m) { y = m[3]; mo = m[1]; d = m[2]; } }
  if (!m) return null;
  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("method not allowed", 405);

  const auth = await verifyCaller(req.headers.get("Authorization"));
  if (!auth.ok) return jsonError(auth.reason, auth.status);
  const { caller } = auth;

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON body", 400); }
  if (!body || typeof body !== "object") return jsonError("request body required", 400);
  const b = body as Record<string, unknown>;

  const organization_id = typeof b.organization_id === "string" ? b.organization_id.trim() : "";
  const id = typeof b.id === "string" ? b.id.trim() : "";
  if (!organization_id) return jsonError("organization_id required", 400);
  if (!id) return jsonError("contact id required", 400);

  if (!caller.isPlatformAdmin && !caller.adminOrgIds.has(organization_id)) {
    return jsonError("forbidden: caller has no admin access to this organization", 403);
  }

  const email = (str(b.email) ?? "").toLowerCase();
  if (!EMAIL_RE.test(email)) return jsonError("A valid email is required.", 400);

  const patch = {
    email,
    parent_name: str(b.parent_name),
    phone: str(b.phone),
    child_first_name: str(b.child_first_name),
    child_last_name: str(b.child_last_name),
    child_birthdate: parseDate(b.child_birthdate),
    // school_name is part of the unique key — coalesce to "" (matches importer).
    school_name: str(b.school_name) ?? "",
    city: str(b.city),
    state: str(b.state),
    zip: str(b.zip),
    tags: stringArray(b.tags),
    updated_at: new Date().toISOString(),
  };

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase
    .from("marketing_recipients")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organization_id) // double-scope: caller's org only
    .select("id, email, parent_name, tags")
    .maybeSingle();

  if (error) {
    const dup = (error as { code?: string }).code === "23505";
    return jsonError(dup ? "Another contact already has this email and school." : `Couldn't save: ${error.message}`, dup ? 409 : 500);
  }
  if (!data) return jsonError("Contact not found for this organization.", 404);
  return jsonOk({ ok: true, contact: data });
});
