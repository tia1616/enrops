// import-contacts
//
// Bulk-load a new tenant's email list into `marketing_recipients` so they can
// send their first campaign (a brand-new org has 0 rows and literally cannot
// build an audience until contacts exist). Campaigns' Q2 audience reads from
// this table.
//
// Auth + client pattern mirrors marketing-delete-draft exactly:
//   - verifyCaller(Authorization): JWT -> user client (SUPABASE_ANON_KEY) ->
//     checks platform_admins / org_members (owner|admin, accepted).
//   - Service-role client for the actual reads/writes. Service role is safe
//     here ONLY because we gate on the caller's admin access to the passed
//     organization_id and stamp that same organization_id onto every row —
//     the function can never touch another org's data:
//       1. ORG-ADMIN gate — caller must be platform_admin OR owner/admin of
//                           the passed organization_id.
//       2. ORG-STAMP      — organization_id is forced onto every inserted row;
//                           we never read a per-row org from the payload.
//
// Body shape:
//   {
//     organization_id: uuid,
//     contacts: Array<{
//       email, parent_name?, phone?, child_first_name?, child_last_name?,
//       school_name?, city?, state?, zip?, tags?: string[]
//     }>,
//     source?: string   // defaults to "csv_import"
//   }
//
// Dedupe strategy: `marketing_recipients` has a UNIQUE index on
// (organization_id, email, school_name, source), so we upsert on that exact
// conflict target — a re-upload of the same list updates in place instead of
// erroring or duplicating.
//
// marketing_recipients columns touched: organization_id, email, parent_name,
// phone, child_first_name, child_last_name, school_name, city, state, zip,
// tags, source.

// Built-in Deno.serve (no external std import) — avoids a flaky deno.land/std
// fetch at bundle time; current Supabase standard.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Hard cap on a single upload. Keeps one request bounded; big lists should be
// split. The unique index means re-running is safe (idempotent), so chunking
// on the client is fine.
const MAX_ROWS = 5000;

// Conflict target must match the UNIQUE index exactly:
//   marketing_recipients_organization_id_email_school_name_sour_key
//   ON (organization_id, email, school_name, source)
const CONFLICT_TARGET = "organization_id,email,school_name,source";

// Basic email shape check — cheap gate to drop obvious junk before a write.
// Not RFC-perfect on purpose; the point is to skip rows with no usable address.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
// Auth (mirrors marketing-delete-draft)
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
// Request parsing + normalization
// ---------------------------------------------------------------------------

type IncomingContact = {
  email?: unknown;
  parent_name?: unknown;
  phone?: unknown;
  child_first_name?: unknown;
  child_last_name?: unknown;
  school_name?: unknown;
  city?: unknown;
  state?: unknown;
  zip?: unknown;
  tags?: unknown;
};

// Row shape written to marketing_recipients. school_name is coalesced to "" so
// the composite unique key (which includes school_name) is stable — NULLs are
// distinct in a unique index, which would let the same email re-insert forever.
type RecipientRow = {
  organization_id: string;
  email: string;
  parent_name: string | null;
  phone: string | null;
  child_first_name: string | null;
  child_last_name: string | null;
  school_name: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  tags: string[];
  source: string;
};

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((t) => (t === null || t === undefined ? "" : String(t).trim()))
    .filter((t) => t !== "");
}

Deno.serve(async (req: Request) => {
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
  if (!body || typeof body !== "object") {
    return jsonError("request body required", 400);
  }
  const b = body as Record<string, unknown>;

  const organization_id = typeof b.organization_id === "string" ? b.organization_id.trim() : "";
  if (!organization_id) {
    return jsonError("organization_id required", 400);
  }
  if (!Array.isArray(b.contacts)) {
    return jsonError("contacts array required", 400);
  }
  const rawContacts = b.contacts as IncomingContact[];
  if (rawContacts.length === 0) {
    return jsonError("contacts array is empty", 400);
  }
  if (rawContacts.length > MAX_ROWS) {
    return jsonError(
      `too many contacts in one upload (${rawContacts.length}). Split into batches of ${MAX_ROWS} or fewer.`,
      413,
    );
  }

  // marketing_recipients.source has a CHECK constraint — anything outside this
  // set (including the old 'csv_import' default) is rejected by Postgres. Coerce
  // an unknown/absent source to 'manual' so an upload can never 500 on it.
  const ALLOWED_SOURCES = new Set(["manual", "am_afterschool", "squarespace_summer", "enrops_registration"]);
  const rawSource = typeof b.source === "string" ? b.source.trim() : "";
  const source = ALLOWED_SOURCES.has(rawSource) ? rawSource : "manual";

  // ---- Guard: org-admin gate ----
  // Caller must be a platform admin OR an accepted owner/admin of this org.
  if (!caller.isPlatformAdmin && !caller.adminOrgIds.has(organization_id)) {
    return jsonError("forbidden: caller has no admin access to this organization", 403);
  }

  // ---- Normalize + dedupe within the batch ----
  // - trim + lowercase email; drop rows whose email is missing/invalid
  // - dedupe by lowercased email (last wins) so a single upsert can't hit the
  //   "cannot affect row a second time" error from duplicate conflict keys.
  let invalid = 0;
  // In-batch duplicate emails are silently collapsed (last-wins) below. Count
  // how many valid rows get dropped that way so `skipped` is honest.
  let skipped = 0;
  const byEmail = new Map<string, RecipientRow>();
  for (const c of rawContacts) {
    const email = (str(c.email) ?? "").toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      invalid++;
      continue;
    }
    if (byEmail.has(email)) skipped++;
    byEmail.set(email, {
      organization_id,
      email,
      parent_name: str(c.parent_name),
      phone: str(c.phone),
      child_first_name: str(c.child_first_name),
      child_last_name: str(c.child_last_name),
      // school_name is part of the unique key — coalesce null to "" so repeat
      // uploads collapse onto the same row instead of inserting duplicates.
      school_name: str(c.school_name) ?? "",
      city: str(c.city),
      state: str(c.state),
      zip: str(c.zip),
      tags: stringArray(c.tags),
      source,
    });
  }

  const rows = Array.from(byEmail.values());
  if (rows.length === 0) {
    return jsonOk({ inserted: 0, updated: 0, skipped, invalid });
  }

  // Service-role client for the write. The org-admin gate above + the forced
  // organization_id on every row keep this scoped to the caller's org.
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ---- Split into net-new vs existing so we can report inserted vs updated ----
  // The upsert itself is one round-trip; this SELECT is only for accurate
  // counts (upsert alone can't tell you which rows already existed).
  // Key the existing-check on the FULL conflict target — (org, email,
  // school_name, source) — not email alone, so a row that shares an email but
  // differs in school_name counts as new, not "updated". school_name is
  // coalesced to "" on the rows we write, so compare against that same value.
  const keyOf = (email: string, schoolName: string | null) =>
    `${email}|${schoolName ?? ""}`;
  const emails = rows.map((r) => r.email);
  const existing = new Set<string>();
  // Prior tags per existing row, so a re-import ADDS tags instead of replacing
  // them (the Mailchimp model — import only ever adds; removal happens in the
  // tag manager). Keyed on the same (email|school_name) as `existing`.
  const priorTags = new Map<string, string[]>();
  // Chunk the .in() lookup — a 5k-item IN list is unwieldy for one request.
  for (let i = 0; i < emails.length; i += 500) {
    const slice = emails.slice(i, i + 500);
    const { data: hits, error: selErr } = await supabase
      .from("marketing_recipients")
      .select("email, school_name, tags")
      .eq("organization_id", organization_id)
      .eq("source", source)
      .in("email", slice);
    if (selErr) {
      return jsonError(`contact lookup failed: ${selErr.message}`, 500);
    }
    for (const h of hits ?? []) {
      if (h?.email) {
        const k = keyOf(String(h.email).toLowerCase(), h.school_name);
        existing.add(k);
        priorTags.set(k, stringArray(h.tags));
      }
    }
  }

  // Union each row's incoming tags with what the contact already had, so tags
  // accumulate across uploads and a tag-less re-import never wipes them.
  for (const row of rows) {
    const prior = priorTags.get(keyOf(row.email, row.school_name)) ?? [];
    row.tags = [...new Set([...prior, ...row.tags])];
  }

  // ---- Upsert on the real unique key (update-or-insert) ----
  const { error: upErr } = await supabase
    .from("marketing_recipients")
    .upsert(rows, { onConflict: CONFLICT_TARGET, ignoreDuplicates: false });
  if (upErr) {
    return jsonError(`contact import failed: ${upErr.message}`, 500);
  }

  // `existing` holds the full conflict-target key (org, source, email,
  // school_name) of rows already in the table, so this "updated" count is exact
  // even when an email appears under more than one school_name.
  const updated = rows.filter((r) => existing.has(keyOf(r.email, r.school_name))).length;
  const inserted = rows.length - updated;

  return jsonOk({ inserted, updated, skipped, invalid });
});
