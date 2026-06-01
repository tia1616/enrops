// fetch-drive-document
//
// Pulls a Google Drive file into a curriculum_documents row using the
// org's stored OAuth tokens. Refreshes access tokens automatically.
//
// Auth: caller must be admin/owner of the target organization. Drive API
// calls use the org's connected Google tokens (NOT the caller's session) —
// any admin can trigger an import using the connection that an org-mate set up.
//
// Request: POST {
//   curriculum_id: string,
//   organization_id: string,
//   drive_url: string,        // accepts Drive doc/file URLs OR direct fileId
//   doc_type?: string,        // 'instructor_guide' | 'materials_list' | 'student_materials' | 'other' (default: instructor_guide)
// }
//
// Response: 200 { ok: true, document_id, original_filename, mime_type }
//          4xx { error: string, code?: 'not_connected' | 'no_access' | 'unsupported_type' | 'token_refresh_failed' }
//
// Flow:
//   1. Verify caller is admin of the org
//   2. Extract fileId from URL (or accept fileId directly)
//   3. Load active Google token row for the org (most-recently-updated)
//   4. If access_token expired (or < 60s left), refresh via Google
//   5. GET file metadata: mimeType, name
//   6. Branch on mimeType:
//      - Google native (doc/slides/sheet) → export as text/plain → store as extracted_text
//      - PDF / Word → fetch raw bytes → upload to our storage bucket → store as storage_path
//      - else → 400 unsupported_type
//   7. Insert curriculum_documents row (source_type='drive_link', drive_url, plus
//      extracted_text OR storage_path depending on type)
//   8. Return document_id — caller then POSTs that to extract-curriculum-details

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_OAUTH_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
const GOOGLE_OAUTH_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!;

const BUCKET = "curriculum-documents";
const ALLOWED_DOC_TYPES = new Set(["instructor_guide", "materials_list", "student_materials", "other"]);

const GOOGLE_NATIVE_EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};

// Raw-download mimetypes that our existing parse.ts can handle when we mirror
// them into Storage. Keep this in lockstep with extract-curriculum-details/parse.ts.
const RAW_DOWNLOAD_MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
  "text/markdown": "md",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonError(message: string, status = 400, code?: string) {
  return new Response(JSON.stringify({ error: message, ...(code ? { code } : {}) }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function jsonOk(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Drive URL patterns to extract fileId:
//   https://docs.google.com/document/d/{id}/...
//   https://docs.google.com/spreadsheets/d/{id}/...
//   https://docs.google.com/presentation/d/{id}/...
//   https://drive.google.com/file/d/{id}/...
//   https://drive.google.com/open?id={id}
//   {id}  (already-extracted bare id)
function extractFileId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const dPath = /\/d\/([a-zA-Z0-9_-]+)/.exec(trimmed);
  if (dPath) return dPath[1];
  const openId = /[?&]id=([a-zA-Z0-9_-]+)/.exec(trimmed);
  if (openId) return openId[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return null;
}

async function verifyAdmin(
  authHeader: string | null,
  organizationId: string,
): Promise<
  | { ok: true; userId: string; userClient: SupabaseClient }
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
  if (userErr || !userResp?.user) return { ok: false, reason: "Invalid session", status: 401 };
  const userId = userResp.user.id;
  const { data: row } = await userClient
    .from("org_members")
    .select("role, accepted_at")
    .eq("auth_user_id", userId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!row || !row.accepted_at) return { ok: false, reason: "Not a member of that organization", status: 403 };
  if (!["owner", "admin"].includes(row.role)) {
    return { ok: false, reason: "Only org owners or admins can import from Drive", status: 403 };
  }
  return { ok: true, userId, userClient };
}

type TokenRow = {
  id: string;
  user_id: string;
  access_token_secret_id: string;
  refresh_token_secret_id: string;
  token_expires_at: string;
};

async function loadAccessToken(admin: SupabaseClient, organizationId: string): Promise<string> {
  const { data, error } = await admin
    .from("organization_google_tokens")
    .select("id, user_id, access_token_secret_id, refresh_token_secret_id, token_expires_at")
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Token lookup failed: ${error.message}`);
  if (!data) {
    const err = new Error(
      "Google Drive isn't connected for this organization. Go to Settings → Connections and connect Google Drive first.",
    ) as Error & { code?: string };
    err.code = "not_connected";
    throw err;
  }
  const row = data as TokenRow;

  const expiresAt = new Date(row.token_expires_at).getTime();
  const needsRefresh = expiresAt < Date.now() + 60_000;
  if (!needsRefresh) {
    const { data: accessText, error: rErr } = await admin.rpc("vault_read_secret_text", {
      p_secret_id: row.access_token_secret_id,
    });
    if (rErr || !accessText) throw new Error(`Could not read access token: ${rErr?.message ?? "empty"}`);
    return accessText as string;
  }

  // Refresh path.
  const { data: refreshText, error: refErr } = await admin.rpc("vault_read_secret_text", {
    p_secret_id: row.refresh_token_secret_id,
  });
  if (refErr || !refreshText) throw new Error(`Could not read refresh token: ${refErr?.message ?? "empty"}`);

  const body = new URLSearchParams({
    refresh_token: refreshText as string,
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await resp.json();
  if (!resp.ok) {
    const err = new Error(
      `Google refused to refresh the token (${json.error ?? resp.statusText}). The user may need to reconnect.`,
    ) as Error & { code?: string };
    err.code = "token_refresh_failed";
    throw err;
  }
  const newAccess = json.access_token as string;
  const newExpiresIn = json.expires_in as number;
  await admin.rpc("vault_update_secret_text", {
    p_secret_id: row.access_token_secret_id,
    p_secret_text: newAccess,
  });
  await admin
    .from("organization_google_tokens")
    .update({
      token_expires_at: new Date(Date.now() + (newExpiresIn - 60) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  return newAccess;
}

// supportsAllDrives=true is required to reach files inside Google Shared
// Drives (formerly Team Drives). Without it the API only resolves files in
// the user's personal My Drive. Docs say it's safe to always include — has
// no effect on My Drive items.
async function fetchFileMetadata(fileId: string, accessToken: string) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size&supportsAllDrives=true`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (resp.status === 404 || resp.status === 403) {
    const err = new Error(
      "We couldn't access that document. Make sure it's in a Drive the connected Google account can open.",
    ) as Error & { code?: string };
    err.code = "no_access";
    throw err;
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Drive metadata failed (${resp.status}): ${t}`);
  }
  return (await resp.json()) as { id: string; name: string; mimeType: string; size?: string };
}

async function exportAsText(fileId: string, accessToken: string, exportMime: string): Promise<string> {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}&supportsAllDrives=true`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Drive export failed (${resp.status}): ${t}`);
  }
  return await resp.text();
}

async function downloadRawBytes(fileId: string, accessToken: string): Promise<Uint8Array> {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Drive download failed (${resp.status}): ${t}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("Method not allowed", 405);

  let body: { curriculum_id?: string; organization_id?: string; drive_url?: string; doc_type?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body");
  }
  const curriculumId = body.curriculum_id?.trim();
  const organizationId = body.organization_id?.trim();
  const driveUrl = body.drive_url?.trim();
  const docType = (body.doc_type?.trim() || "instructor_guide");
  if (!curriculumId) return jsonError("Missing 'curriculum_id'");
  if (!organizationId) return jsonError("Missing 'organization_id'");
  if (!driveUrl) return jsonError("Missing 'drive_url'");
  if (!ALLOWED_DOC_TYPES.has(docType)) return jsonError(`Invalid doc_type: ${docType}`);

  const fileId = extractFileId(driveUrl);
  if (!fileId) return jsonError("That doesn't look like a Google Drive URL. Paste the link from the address bar of the doc.");

  const authCheck = await verifyAdmin(req.headers.get("Authorization"), organizationId);
  if (!authCheck.ok) return jsonError(authCheck.reason, authCheck.status);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Confirm the curriculum belongs to this org (cheap guard against caller
  // pointing at someone else's curriculum_id).
  const { data: curr, error: currErr } = await admin
    .from("curricula")
    .select("id, organization_id")
    .eq("id", curriculumId)
    .maybeSingle();
  if (currErr || !curr) return jsonError("Curriculum not found", 404);
  if (curr.organization_id !== organizationId) return jsonError("Curriculum belongs to a different organization", 403);

  // 1. Get a valid access token (refresh if needed)
  let accessToken: string;
  try {
    accessToken = await loadAccessToken(admin, organizationId);
  } catch (e) {
    const err = e as Error & { code?: string };
    return jsonError(err.message, err.code === "not_connected" ? 409 : 500, err.code);
  }

  // 2. File metadata
  let meta: { id: string; name: string; mimeType: string; size?: string };
  try {
    meta = await fetchFileMetadata(fileId, accessToken);
  } catch (e) {
    const err = e as Error & { code?: string };
    return jsonError(err.message, err.code === "no_access" ? 404 : 500, err.code);
  }

  // 3. Branch on mime type
  const exportMime = GOOGLE_NATIVE_EXPORTS[meta.mimeType];
  const rawExt = RAW_DOWNLOAD_MIME_EXT[meta.mimeType];

  let extractedText: string | null = null;
  let storagePath: string | null = null;
  let storedMime: string = meta.mimeType;

  try {
    if (exportMime) {
      extractedText = await exportAsText(fileId, accessToken, exportMime);
      if (!extractedText || extractedText.trim().length < 20) {
        return jsonError("That document appears to be empty or unreadable.");
      }
    } else if (rawExt) {
      const bytes = await downloadRawBytes(fileId, accessToken);
      const docId = crypto.randomUUID();
      const safeName = meta.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${organizationId}/${curriculumId}/${docId}-${safeName}.${rawExt}`;
      const { error: upErr } = await admin.storage.from(BUCKET).upload(path, bytes, {
        contentType: meta.mimeType,
        upsert: false,
      });
      if (upErr) throw new Error(`Couldn't mirror Drive file into storage: ${upErr.message}`);
      storagePath = path;
    } else {
      return jsonError(
        `We can't import "${meta.mimeType}" files from Drive yet. Convert to Google Doc, PDF, or .docx, or upload directly.`,
        400,
        "unsupported_type",
      );
    }
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : String(e), 500);
  }

  // 4. Insert curriculum_documents row
  const { data: docRow, error: insErr } = await admin
    .from("curriculum_documents")
    .insert({
      curriculum_id: curriculumId,
      organization_id: organizationId,
      doc_type: docType,
      source_type: "drive_link",
      drive_url: driveUrl,
      storage_path: storagePath,
      original_filename: meta.name,
      mime_type: storedMime,
      extracted_text: extractedText,
      extraction_status: "pending",
    })
    .select("id")
    .single();
  if (insErr || !docRow) {
    // Roll back the storage mirror if it was created.
    if (storagePath) {
      await admin.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    }
    return jsonError(`Could not save document record: ${insErr?.message ?? "no row"}`, 500);
  }

  return jsonOk({
    ok: true,
    document_id: docRow.id,
    original_filename: meta.name,
    mime_type: storedMime,
  });
});
