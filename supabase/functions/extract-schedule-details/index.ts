// extract-schedule-details
//
// The PDF/Word half of the schedule uploader. A spreadsheet is parsed + column-
// mapped on the client (no AI); a PDF/docx can't be, so this reads the doc and
// asks Claude to pull out the weekly classes in the SAME row shape the
// spreadsheet path produces. It then RETURNS those rows — it does NOT write them.
// The client drops them into the same review screen, the operator confirms/edits,
// and the existing import-class-schedule fn normalizes + inserts. One review +
// commit path for both upload types.
//
// Stateless by design: no storage, no doc table, no background job. A schedule
// doc is small, so this runs synchronously and the client shows a live wait.
//
// Auth mirrors import-class-schedule: org-admin gate (caller must be
// platform_admin OR owner/admin of organization_id). No org data is written, so
// no service-role client is needed at all — the model only sees the uploaded doc.
//
// Body: { organization_id, filename, file_base64 }  (base64 of the raw file)
// Returns: { rows: IncomingScheduleRow[], count, model }

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Anthropic from "npm:@anthropic-ai/sdk@0.96.0";
import { detectExt, parseDocument } from "./parse.ts";
import { parseScheduleRows, ScheduleExtractError } from "../_shared/scheduleExtract.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SONNET_MODEL = Deno.env.get("SONNET_MODEL") ?? "claude-sonnet-4-6";

// Guard the request body — base64 of a doc. ~8MB of base64 ≈ a ~6MB file, which
// is a large schedule doc; anything bigger is almost certainly not a schedule.
const MAX_BASE64_LEN = 8_000_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonError(error: string, status = 400) {
  return new Response(JSON.stringify({ error }), {
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

function base64ToBytes(b64: string): Uint8Array {
  // Strip a possible data URL prefix (e.g. "data:application/pdf;base64,").
  const comma = b64.indexOf(",");
  const clean = b64.startsWith("data:") && comma !== -1 ? b64.slice(comma + 1) : b64;
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const SYSTEM_PROMPT = [
  "You extract a provider's WEEKLY CLASS SCHEDULE from a document (a studio/club/",
  "enrichment provider's schedule of recurring classes). Return ONLY a JSON array —",
  "no prose, no code fences.",
  "",
  "Each array element is one recurring class meeting, with these keys (use null for",
  "anything the document doesn't state — never invent values):",
  '  title            (string)  the class/program/session name',
  '  day_of_week      (string)  full weekday name, e.g. "Monday"',
  '  start_time       (string)  as written, e.g. "4:00 PM"',
  '  end_time         (string)',
  '  location_text    (string)  room / site / venue',
  '  instructor_name  (string)',
  '  instructor_email (string)',
  '  age_min          (number)  min age or grade if given',
  '  age_max          (number)',
  '  capacity         (number)  max students if given',
  '  notes            (string)  anything else useful',
  "",
  "Rules:",
  "- One object PER (class, day). If a class meets Mon + Wed, emit TWO objects.",
  "- Prefer the recurring WEEKLY pattern. If the doc is a dated monthly calendar,",
  "  collapse it to the weekly recurring classes (use each event's weekday) — do not",
  "  emit one row per calendar date.",
  "- Skip non-class content (prices, policies, holidays, headers).",
  "- If you find no classes, return [].",
].join("\n");

function userPrompt(docText: string): string {
  return [
    "Here is the schedule document. Extract the weekly classes as the JSON array described.",
    "",
    "<document>",
    docText,
    "</document>",
  ].join("\n");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("method not allowed", 405);

  const auth = await verifyCaller(req.headers.get("Authorization"));
  if (!auth.ok) return jsonError(auth.reason, auth.status);
  const { caller } = auth;

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
  const filename = typeof b.filename === "string" ? b.filename : "";
  if (!filename) return jsonError("filename required", 400);
  const file_base64 = typeof b.file_base64 === "string" ? b.file_base64 : "";
  if (!file_base64) return jsonError("file_base64 required", 400);
  if (file_base64.length > MAX_BASE64_LEN) {
    return jsonError("That file is too large. Try a smaller export or a spreadsheet.", 413);
  }

  // Org-admin gate — same as import-class-schedule.
  if (!caller.isPlatformAdmin && !caller.adminOrgIds.has(organization_id)) {
    return jsonError("forbidden: caller has no admin access to this organization", 403);
  }

  const ext = detectExt(filename);
  if (!ext) return jsonError("Unsupported file type. Upload a PDF, Word doc, or spreadsheet.", 415);

  // Decode + parse the document to text.
  let docText: string;
  try {
    const bytes = base64ToBytes(file_base64);
    docText = await parseDocument(bytes, ext);
  } catch (e) {
    console.error("[extract-schedule-details] parse failed", e);
    return jsonError("We couldn't read that file. If it's a scanned PDF, try a spreadsheet instead.", 422);
  }
  if (!docText || docText.trim().length < 20) {
    return jsonError("We couldn't find any text in that file. If it's a scanned image, try a spreadsheet.", 422);
  }

  // Ask Claude for the rows.
  let replyText = "";
  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt(docText) }],
    });
    for (const block of msg.content) {
      if (block.type === "text") replyText += block.text;
    }
  } catch (e) {
    console.error("[extract-schedule-details] model call failed", e);
    return jsonError("The schedule reader had a problem. Please try again in a moment.", 502);
  }

  try {
    const rows = parseScheduleRows(replyText);
    return jsonOk({ rows, count: rows.length, model: SONNET_MODEL });
  } catch (e) {
    if (e instanceof ScheduleExtractError) return jsonError(e.message, 422);
    console.error("[extract-schedule-details] parse rows failed", e);
    return jsonError("We couldn't read the schedule from that file. Try a spreadsheet instead.", 422);
  }
});
