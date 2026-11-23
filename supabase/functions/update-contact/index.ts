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

// Same words as the roster's edit form (src/lib/parentEmailTaken.js) - one
// situation, one sentence, wherever an operator meets it. The address is
// src/lib/helpEmail.js's HELP_EMAIL (edge fns cannot import from src/).
const TAKEN_BY_ANOTHER_FAMILY =
  "Nothing was changed: that email is already on a different record in enrops (often the same family, registered twice). Send us a note with Share feedback or email hello@enrops.com, and we'll combine the two records.";

// Case-insensitive EXACT match. `ilike` treats `_` and `%` as wildcards, and
// `_` is common in email addresses: unescaped, "mrs_j@x.com" would match
// "mrs.j@x.com" and move the wrong family.
function exactILike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

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

  // ── A CORRECTED EMAIL GOES TO THE FAMILY'S RECORD, NOT JUST THE LIST ──────
  // A contact row is the mailing-list copy. The roster, the parent portal and
  // every registration email read `parents.email`. Before this, an operator who
  // fixed a mistyped address here fixed the list only, and the roster kept the
  // wrong one (Jen Israel, 11/23).
  //
  // So when the email changes and that old address belongs to a family who is
  // a customer of THIS org (parent_org_relationships), the parent record moves
  // too. `parents` is one row per person across every business, so that is a
  // correction to the person; trg_sync_parent_email_to_contact then carries it
  // to their contact rows at every org they belong to - this one included.
  //
  // ORDER: both conflicts are checked BEFORE anything is written, then the
  // parent first, then the contact. If the parent write fails, nothing has
  // changed. A family whose old address is only on this list (an import, no
  // registration) has no parent row to move, and the edit stays list-only.
  const { data: current, error: curErr } = await supabase
    .from("marketing_recipients")
    .select("email, school_name")
    .eq("id", id)
    .eq("organization_id", organization_id)
    .maybeSingle();
  if (curErr) return jsonError(`Couldn't save: ${curErr.message}`, 500);
  if (!current) return jsonError("Contact not found for this organization.", 404);

  const oldEmail = String(current.email ?? "").trim().toLowerCase();
  let parentToMove: string | null = null;
  if (oldEmail && oldEmail !== email) {
    const { data: oldParent, error: opErr } = await supabase
      .from("parents")
      .select("id, parent_org_relationships!inner(organization_id)")
      .ilike("email", exactILike(oldEmail))
      .eq("parent_org_relationships.organization_id", organization_id)
      .maybeSingle();
    if (opErr) return jsonError(`Couldn't save: ${opErr.message}`, 500);

    if (oldParent) {
      const { data: taken, error: tkErr } = await supabase
        .from("parents")
        .select("id")
        .ilike("email", exactILike(email))
        .neq("id", oldParent.id)
        .limit(1);
      if (tkErr) return jsonError(`Couldn't save: ${tkErr.message}`, 500);
      if (taken && taken.length) return jsonError(TAKEN_BY_ANOTHER_FAMILY, 409);

      // The contact's own unique key (org, email, school). Checked here, not
      // left to the update below, because by then the parent has moved.
      const { data: dupContact, error: dcErr } = await supabase
        .from("marketing_recipients")
        .select("id")
        .eq("organization_id", organization_id)
        .ilike("email", exactILike(email))
        .eq("school_name", patch.school_name)
        .neq("id", id)
        .limit(1);
      if (dcErr) return jsonError(`Couldn't save: ${dcErr.message}`, 500);
      if (dupContact && dupContact.length) return jsonError("Another contact already has this email and school.", 409);

      parentToMove = oldParent.id as string;
    }
  }

  if (parentToMove) {
    const { data: moved, error: pErr } = await supabase
      .from("parents")
      .update({ email })
      .eq("id", parentToMove)
      .select("id");
    if (pErr) {
      // Lost a race to another family taking the address between the check and here.
      if ((pErr as { code?: string }).code === "23505") return jsonError(TAKEN_BY_ANOTHER_FAMILY, 409);
      return jsonError(`Couldn't save: ${pErr.message}`, 500);
    }
    if (!moved || !moved.length) return jsonError("Couldn't update this family's record. Nothing was changed.", 500);
  }

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
