// import-class-schedule
//
// Bulk-load a tenant's weekly CLASS SCHEDULE into `class_schedule` from a
// spreadsheet they upload (parsed + column-mapped on the client). This is the
// membership-friendly "what's happening" backbone — NOT a registration funnel.
// It drives instructor scheduling + comms; there is no term / price / checkout.
//
// Auth + client pattern mirrors import-contacts exactly:
//   - verifyCaller(Authorization): JWT -> user client (SUPABASE_ANON_KEY) ->
//     checks platform_admins / org_members (owner|admin, accepted).
//   - Service-role client for the write. Safe here ONLY because we:
//       1. ORG-ADMIN gate — caller must be platform_admin OR owner/admin of the
//                           passed organization_id.
//       2. ORG-STAMP      — organization_id is forced onto every inserted row;
//                           we never read a per-row org from the payload.
//
// Body shape:
//   {
//     organization_id: uuid,
//     rows: Array<{ title, day_of_week, start_time?, end_time?, location_text?,
//                   instructor_name?, instructor_email?, age_min?, age_max?,
//                   capacity?, notes? }>,
//     source?: 'upload_csv' | 'upload_doc' | 'manual',   // default 'upload_csv'
//     mode?: 'replace' | 'append'                         // default 'replace'
//   }
//
// mode='replace' clears this org's prior UPLOAD-sourced rows before inserting, so
// re-uploading an updated schedule doesn't double it. Manually-added rows
// (source='manual') are preserved. mode='append' adds without clearing.
//
// Rows with no title or an unrecognizable day are skipped (reported back with a
// reason) — a few messy rows never fail the whole upload.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { normalizeScheduleRow, type IncomingScheduleRow } from "../_shared/scheduleNormalize.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// One upload is bounded. A weekly class schedule is tiny (tens of rows); this is
// just a sanity ceiling so a bad file can't push an enormous payload.
const MAX_ROWS = 2000;

// Sources this fn writes. Kept in sync with class_schedule.source CHECK.
const ALLOWED_SOURCES = new Set(["upload_csv", "upload_doc", "manual"]);
// Which sources a 'replace' clears — only upload-originated rows, never manual.
const UPLOAD_SOURCES = ["upload_csv", "upload_doc"];

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
  if (!body || typeof body !== "object") return jsonError("request body required", 400);
  const b = body as Record<string, unknown>;

  const organization_id = typeof b.organization_id === "string" ? b.organization_id.trim() : "";
  if (!organization_id) return jsonError("organization_id required", 400);
  if (!Array.isArray(b.rows)) return jsonError("rows array required", 400);

  const rawRows = b.rows as IncomingScheduleRow[];
  if (rawRows.length === 0) return jsonError("rows array is empty", 400);
  if (rawRows.length > MAX_ROWS) {
    return jsonError(
      `too many rows in one upload (${rawRows.length}). Split into batches of ${MAX_ROWS} or fewer.`,
      413,
    );
  }

  const rawSource = typeof b.source === "string" ? b.source.trim() : "";
  const source = ALLOWED_SOURCES.has(rawSource) ? rawSource : "upload_csv";
  const mode = b.mode === "append" ? "append" : "replace";

  // ---- Org-admin gate ----
  if (!caller.isPlatformAdmin && !caller.adminOrgIds.has(organization_id)) {
    return jsonError("forbidden: caller has no admin access to this organization", 403);
  }

  // ---- Normalize ----
  const clean: Record<string, unknown>[] = [];
  let skippedNoTitle = 0;
  let skippedBadDay = 0;
  for (const r of rawRows) {
    const res = normalizeScheduleRow(r);
    if (!res.ok) {
      if (res.reason === "missing_title") skippedNoTitle++;
      else skippedBadDay++;
      continue;
    }
    // ORG-STAMP: organization_id + source forced on every row, never from payload.
    clean.push({ ...res.row, organization_id, source });
  }

  if (clean.length === 0) {
    return jsonOk({
      inserted: 0,
      skipped: skippedNoTitle + skippedBadDay,
      skipped_no_title: skippedNoTitle,
      skipped_bad_day: skippedBadDay,
    });
  }

  // Service-role client for the write. Org-admin gate + forced organization_id
  // keep this scoped to the caller's org.
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ---- Insert FIRST ----
  // Insert the new rows before removing anything. If this fails in 'replace'
  // mode, the operator's existing schedule is left intact (no delete happened) —
  // rather than being wiped with no replacement (there is no cross-statement
  // transaction available on the client).
  const { data: inserted, error: insErr } = await supabase
    .from("class_schedule")
    .insert(clean)
    .select("id");
  if (insErr) return jsonError(`schedule import failed: ${insErr.message}`, 500);
  const newIds = (inserted ?? []).map((r: { id: string }) => r.id);

  // ---- Replace: now clear this org's prior UPLOAD rows, EXCLUDING the ones we
  // just inserted (never manual rows). Runs only after a successful insert. ----
  if (mode === "replace" && newIds.length > 0) {
    const { error: delErr } = await supabase
      .from("class_schedule")
      .delete()
      .eq("organization_id", organization_id)
      .in("source", UPLOAD_SOURCES)
      .not("id", "in", `(${newIds.join(",")})`);
    if (delErr) {
      // New rows are in; old ones lingered. Surface it but don't fail the import —
      // the operator got their schedule, just with stale extras to clean up.
      return jsonOk({
        inserted: newIds.length,
        skipped: skippedNoTitle + skippedBadDay,
        skipped_no_title: skippedNoTitle,
        skipped_bad_day: skippedBadDay,
        mode,
        warning: `new classes were added, but old ones could not be cleared: ${delErr.message}`,
      });
    }
  }

  return jsonOk({
    inserted: newIds.length,
    skipped: skippedNoTitle + skippedBadDay,
    skipped_no_title: skippedNoTitle,
    skipped_bad_day: skippedBadDay,
    mode,
  });
});
