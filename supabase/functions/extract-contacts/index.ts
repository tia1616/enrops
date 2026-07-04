// extract-contacts
//
// The PDF/Word/scan-free half of the Family-Comms contact importer. A CSV/XLSX
// is parsed + column-mapped on the client (deterministic, no AI). A PDF/docx
// can't be, so this reads the doc and asks Claude to pull out the FAMILY
// CONTACTS (parent/guardian rows) in the SAME shape the client CSV path
// produces. It RETURNS those rows — it does NOT write them. The client drops
// them into the existing ContactsTab review screen, the operator confirms/edits,
// and the existing import-contacts fn upserts into marketing_recipients.
// One review + commit path for every upload type (CSV, XLSX, PDF).
//
// Mirrors extract-schedule-details exactly (auth gate, doc parsing, model call,
// stateless — no storage, no doc table, synchronous with a live client wait).
//
// Body: { organization_id, filename, file_base64 }  (base64 of the raw file)
// Returns: { rows: ContactRow[], count, model }
//
// Multi-tenant: org-admin gate (caller must be platform_admin OR owner/admin of
// organization_id). No org data is written here, so no service-role client — the
// model only sees the uploaded doc. No tenant strings anywhere.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Anthropic from "npm:@anthropic-ai/sdk@0.96.0";
import { detectExt, parseDocument } from "./parse.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SONNET_MODEL = Deno.env.get("SONNET_MODEL") ?? "claude-sonnet-4-6";

// ~8MB of base64 ≈ a ~6MB file — a large contact export. Bigger than that is
// almost certainly not a contact list.
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
  const comma = b64.indexOf(",");
  const clean = b64.startsWith("data:") && comma !== -1 ? b64.slice(comma + 1) : b64;
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const SYSTEM_PROMPT = [
  "You extract a list of FAMILY CONTACTS from a document exported by a children's",
  "enrichment / tutoring / activity provider (e.g. a parent roster, an enrolled-student",
  "list, a sign-up export). Each contact is a PARENT / GUARDIAN. Return ONLY a JSON",
  "array — no prose, no code fences.",
  "",
  "Each array element is one parent/guardian, with these keys (use null for anything",
  "the document doesn't state — NEVER invent values, especially emails):",
  '  email            (string)  the parent/guardian email — REQUIRED; skip any row with no email',
  '  parent_name      (string)  full name in natural "First Last" order',
  '  phone            (string)  digits as written, any format',
  '  child_first_name (string)  the enrolled child, if the row names one',
  '  child_last_name  (string)',
  '  school_name      (string)  the center / school / site the family is tied to',
  '  city             (string)',
  '  state            (string)  2-letter state code if present',
  '  zip              (string)',
  "",
  "Rules:",
  '- Names often appear as "Last, First" — REORDER them to "First Last" for parent_name.',
  '- A location like "GILBERT - LINDSAY & WARNER AZ" means school_name="Lindsay & Warner"',
  '  (or the center name as written), city="Gilbert", state="AZ". Split city/state when a',
  "  2-letter state is present; otherwise leave them null. Do not guess a state.",
  "- One object per DISTINCT parent. The same email may appear on several source lines",
  "  (different phone formats, duplicate rows) — emit it ONCE.",
  "- A row with a phone but no email is unusable — skip it.",
  "- Skip headers, totals, page numbers, and any non-contact text.",
  "- If you find no contacts with emails, return [].",
].join("\n");

function userPrompt(docText: string): string {
  return [
    "Here is the exported document. Extract the family contacts as the JSON array described.",
    "",
    "<document>",
    docText,
    "</document>",
  ].join("\n");
}

// Fields the client review screen (ContactsTab CONTACT_FIELDS) understands.
const CONTACT_KEYS = ["email", "parent_name", "phone", "child_first_name", "child_last_name", "school_name", "city", "state", "zip"] as const;
type ContactRow = Record<(typeof CONTACT_KEYS)[number], string | null>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class ContactExtractError extends Error {}

// Parse the model reply into clean contact rows. Tolerates code fences and
// surrounding prose by extracting the first top-level JSON array. Keeps only
// rows with a valid-looking email, de-dupes on lowercased email, whitelists
// keys, and coerces every field to a trimmed string or null.
function parseContactRows(reply: string): ContactRow[] {
  if (!reply || !reply.trim()) throw new ContactExtractError("empty model reply");
  let text = reply.trim();
  // Strip ```json ... ``` or ``` ... ``` fences if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new ContactExtractError("no JSON array in model reply");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ContactExtractError("model reply was not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new ContactExtractError("model reply was not a JSON array");

  const clean = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length ? t : null;
  };

  const seen = new Set<string>();
  const rows: ContactRow[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const src = item as Record<string, unknown>;
    const email = clean(src.email);
    if (!email || !EMAIL_RE.test(email)) continue; // email is required + must look real
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const row = {} as ContactRow;
    for (const k of CONTACT_KEYS) row[k] = clean(src[k]);
    row.email = email;
    rows.push(row);
  }
  return rows;
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

  // Org-admin gate — mirrors extract-schedule-details / import-contacts.
  if (!caller.isPlatformAdmin && !caller.adminOrgIds.has(organization_id)) {
    return jsonError("forbidden: caller has no admin access to this organization", 403);
  }

  const ext = detectExt(filename);
  if (!ext) return jsonError("Unsupported file type. Upload a PDF, Word doc, or spreadsheet.", 415);

  let docText: string;
  try {
    const bytes = base64ToBytes(file_base64);
    docText = await parseDocument(bytes, ext);
  } catch (e) {
    console.error("[extract-contacts] parse failed", e);
    return jsonError("We couldn't read that file. If it's a scanned PDF, try a spreadsheet instead.", 422);
  }
  if (!docText || docText.trim().length < 20) {
    return jsonError("We couldn't find any text in that file. If it's a scanned image, try a spreadsheet.", 422);
  }

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
    console.error("[extract-contacts] model call failed", e);
    return jsonError("The contact reader had a problem. Please try again in a moment.", 502);
  }

  try {
    const rows = parseContactRows(replyText);
    return jsonOk({ rows, count: rows.length, model: SONNET_MODEL });
  } catch (e) {
    if (e instanceof ContactExtractError) {
      return jsonError("We couldn't find any family contacts with emails in that file. Try a spreadsheet instead.", 422);
    }
    console.error("[extract-contacts] parse rows failed", e);
    return jsonError("We couldn't read the contacts from that file. Try a spreadsheet instead.", 422);
  }
});
