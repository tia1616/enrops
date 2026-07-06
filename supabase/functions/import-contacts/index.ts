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
// tags, source, suppress_welcome, child_birthdate.

// Built-in Deno.serve (no external std import) — avoids a flaky deno.land/std
// fetch at bundle time; current Supabase standard.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { logPlatformEvent, FEATURE, ACTION, OUTCOME } from "../_shared/logPlatformEvent.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Staging safety (2026-07-06 incident): staging holds real emails imported for
// testing, but must NEVER actually email a real person. On staging we mask every
// imported address to a non-deliverable @example.com at write time, preserving
// tia1616+ test inboxes. Prod stores the real address. Detected by the staging
// project ref in the Supabase URL (infra guard, not tenant logic).
const IS_STAGING_SANDBOX = SUPABASE_URL.includes("mumfymlapolsfdnpewci");
function sandboxEmail(email: string): string {
  if (!IS_STAGING_SANDBOX) return email;
  if (email.startsWith("tia1616+") || email.endsWith("@example.com")) return email;
  const at = email.indexOf("@");
  if (at < 0) return email;
  return `${email.slice(0, at)}__${email.slice(at + 1).replace(/\./g, "_")}@example.com`;
}

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
  child_birthdate?: unknown;
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
  // Set false to welcome this contact via the welcome_contact automation; true
  // ("existing families" import choice) means skip the welcome. Batch-level flag.
  suppress_welcome: boolean;
  // Child DOB (YYYY-MM-DD) when the source doc carried one. Stored so the
  // birthday automation can fire off contacts once its resolver is extended to
  // read marketing_recipients (today it reads enrolled students only). Null when unknown.
  child_birthdate: string | null;
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

// Parse a birthdate string into a REAL ISO date (YYYY-MM-DD) for the date
// column. Accepts the extractor's normalized YYYY-MM-DD and common M/D/YYYY.
// Returns null for anything unrecognized OR out-of-range — never guess, and
// never emit an invalid date: a single bad DOB (e.g. "13/40/2015") must not
// fail the whole upsert batch (Postgres rejects out-of-range dates).
function parseDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  let y = "", mo = "", d = "";
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { y = m[1]; mo = m[2]; d = m[3]; }
  else {
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // assume US month/day/year
    if (m) { y = m[3]; mo = m[1]; d = m[2]; }
  }
  if (!m) return null;
  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  // Reject overflow (13th month, Feb 30, etc.): JS rolls these over, so a
  // round-trip mismatch means the input wasn't a real calendar date.
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) return null;
  return iso;
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

  // "Existing families" import choice → skip the welcome for every row in this
  // batch. Defaults to false (welcome new families) when the client omits it.
  const suppressWelcome = b.suppress_welcome === true;

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
    const rawEmail = (str(c.email) ?? "").toLowerCase();
    if (!rawEmail || !EMAIL_RE.test(rawEmail)) {
      invalid++;
      continue;
    }
    // Staging masks real addresses at import (see sandboxEmail); prod stores real.
    const email = sandboxEmail(rawEmail);
    const prior = byEmail.get(email);
    if (prior) skipped++;
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
      // Union tags across rows sharing an email (e.g. multi-child lines) so a
      // per-row tag isn't lost to last-wins dedup within the same upload.
      tags: [...new Set([...(prior?.tags ?? []), ...stringArray(c.tags)])],
      source,
      suppress_welcome: suppressWelcome,
      // Keep a birthdate once captured — a duplicate row without one must not
      // wipe it (mirrors the tags-union rule).
      child_birthdate: parseDate(c.child_birthdate) ?? prior?.child_birthdate ?? null,
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
  // Prior birthdate per existing row — preserve a captured DOB when a later
  // import for the same contact doesn't include one.
  const priorBirthdate = new Map<string, string | null>();
  // Prior welcome-suppression per existing row — a re-import must NOT flip a
  // family we already decided about (re-importing an existing "skip welcome"
  // list as "new" shouldn't retroactively welcome them). Mirrors tags/birthdate.
  const priorSuppress = new Map<string, boolean>();
  // Chunk the .in() lookup — a 5k-item IN list is unwieldy for one request.
  for (let i = 0; i < emails.length; i += 500) {
    const slice = emails.slice(i, i + 500);
    const { data: hits, error: selErr } = await supabase
      .from("marketing_recipients")
      .select("email, school_name, tags, child_birthdate, suppress_welcome")
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
        priorBirthdate.set(k, (h as { child_birthdate?: string | null }).child_birthdate ?? null);
        priorSuppress.set(k, (h as { suppress_welcome?: boolean }).suppress_welcome === true);
      }
    }
  }

  // Union each row's incoming tags with what the contact already had, so tags
  // accumulate across uploads and a tag-less re-import never wipes them.
  for (const row of rows) {
    const k = keyOf(row.email, row.school_name);
    const prior = priorTags.get(k) ?? [];
    row.tags = [...new Set([...prior, ...row.tags])];
    // Preserve an existing DOB if this import didn't bring one.
    if (!row.child_birthdate) row.child_birthdate = priorBirthdate.get(k) ?? null;
    // Preserve an existing contact's welcome decision — the batch flag only
    // applies to brand-new contacts, never re-flips one we already imported.
    if (existing.has(k)) row.suppress_welcome = priorSuppress.get(k) ?? row.suppress_welcome;
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

  await logPlatformEvent(supabase, {
    feature: FEATURE.CONTACTS, action: ACTION.CONTACTS_IMPORTED, outcome: OUTCOME.SUCCESS,
    organizationId: organization_id, actorUserId: caller.userId,
    metadata: { inserted, updated, skipped, invalid },
  });
  return jsonOk({ inserted, updated, skipped, invalid });
});
