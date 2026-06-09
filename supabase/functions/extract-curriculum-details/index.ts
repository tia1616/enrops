// extract-curriculum-details
//
// Two modes, picked by request body:
//
//   Production mode: { document_id, prompt_version? }
//     - Auth: org owner/admin OR platform_admin (the doc's organization_id
//       must be one the caller is admin/owner of, OR caller is platform_admin)
//     - Runs extraction in the background via EdgeRuntime.waitUntil(); returns
//       { ok: true, curriculum_id, document_id } immediately
//     - Status milestones write to curriculum_documents.extraction_status +
//       .status_message so the client can subscribe via Supabase Realtime
//     - On success: persists into curricula + curriculum_sessions +
//       curriculum_extracted_fields and sets curricula.status='extracted'
//     - On failure: marks the doc 'failed' with extraction_error
//     - Pre-flight: builds an <organization-context> block from the tenant's
//       existing programs / camp_sessions / published curricula so the model
//       can sanity-check ambiguous fields against the tenant's patterns.
//
//   Dev mode: { document_path, prompt_version? }
//     - Auth: platform_admin only
//     - SSE stream as before; no DB persistence; no org-context
//     - Used by /admin/dev/extraction-test for prompt iteration
//
// Both modes read from the `curriculum-documents` Storage bucket.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Anthropic from "npm:@anthropic-ai/sdk@0.96.0";
import { detectExt, parseDocument } from "./parse.ts";
import { DEFAULT_PROMPT_VERSION, PROMPT_VERSIONS, type PromptVersion } from "./prompts.ts";

// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const BUCKET = "curriculum-documents";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
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

function sseChunk(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Background work that survives the HTTP response closing. If EdgeRuntime is
// unavailable (local dev / older runtime), fall back to fire-and-forget with
// an error logger so we don't crash the request.
function scheduleBackground(work: Promise<unknown>) {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(work);
  } else {
    work.catch((e) => console.error("background task error:", e));
  }
}

// ---------------------------------------------------------------------------
// Auth
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

  // Platform admin?
  const { data: paRow } = await userClient
    .from("platform_admins")
    .select("auth_user_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  const isPlatformAdmin = !!paRow;

  // Orgs this user owns/admins
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
// Org-context preload
// ---------------------------------------------------------------------------
//
// Pulls distinct age-range / class-size / format patterns from the tenant's
// existing programs, camp_sessions, and already-published curricula. Used as
// a soft sanity-check in the v2 prompt (rule 14). Failing to build context is
// non-fatal — extraction proceeds without it.

async function buildOrgContext(
  admin: SupabaseClient,
  organizationId: string,
): Promise<string> {
  try {
    const [progsRes, campsRes, currsRes] = await Promise.all([
      admin
        .from("programs")
        .select("age_min, age_max, program_type")
        .eq("organization_id", organizationId),
      admin
        .from("camp_sessions")
        .select("ages_min, ages_max, session_type")
        .eq("organization_id", organizationId),
      admin
        .from("curricula")
        .select("age_range_min, age_range_max, class_size_min, class_size_max, format")
        .eq("organization_id", organizationId)
        .eq("status", "published"),
    ]);

    const ageRanges = new Set<string>();
    for (const r of (progsRes.data ?? []) as Array<{ age_min: number | null; age_max: number | null }>) {
      if (r.age_min != null && r.age_max != null) ageRanges.add(`${r.age_min}-${r.age_max}`);
    }
    for (const r of (campsRes.data ?? []) as Array<{ ages_min: number | null; ages_max: number | null }>) {
      if (r.ages_min != null && r.ages_max != null) ageRanges.add(`${r.ages_min}-${r.ages_max}`);
    }
    for (const r of (currsRes.data ?? []) as Array<{ age_range_min: number | null; age_range_max: number | null }>) {
      if (r.age_range_min != null && r.age_range_max != null) {
        ageRanges.add(`${r.age_range_min}-${r.age_range_max}`);
      }
    }

    const classSizes = new Set<string>();
    for (const r of (currsRes.data ?? []) as Array<{ class_size_min: number | null; class_size_max: number | null }>) {
      if (r.class_size_min != null || r.class_size_max != null) {
        const min = r.class_size_min ?? "?";
        const max = r.class_size_max ?? "?";
        classSizes.add(`${min}-${max}`);
      }
    }

    const formats = new Set<string>();
    for (const r of (progsRes.data ?? []) as Array<{ program_type: string | null }>) {
      if (r.program_type) formats.add(r.program_type);
    }
    for (const r of (campsRes.data ?? []) as Array<{ session_type: string | null }>) {
      if (r.session_type) formats.add(r.session_type);
    }
    for (const r of (currsRes.data ?? []) as Array<{ format: string | null }>) {
      if (r.format) formats.add(r.format);
    }

    if (ageRanges.size === 0 && classSizes.size === 0 && formats.size === 0) {
      return "";
    }

    const lines: string[] = ["<organization-context>"];
    lines.push("This organization's existing programs and camp sessions use these patterns:");
    if (ageRanges.size > 0) lines.push(`- Age ranges: ${[...ageRanges].join(", ")}`);
    if (classSizes.size > 0) lines.push(`- Class sizes: ${[...classSizes].join(", ")}`);
    if (formats.size > 0) lines.push(`- Formats: ${[...formats].join(", ")}`);
    lines.push("");
    lines.push("Use these as a soft sanity-check (per rule 14). Do not fabricate values to match.");
    lines.push("</organization-context>");
    return lines.join("\n");
  } catch (e) {
    console.warn("buildOrgContext failed (continuing without context):", e instanceof Error ? e.message : String(e));
    return "";
  }
}

// ---------------------------------------------------------------------------
// Production background extraction
// ---------------------------------------------------------------------------

type ExtractedShape = {
  name?: { value?: string; confidence?: number };
  short_description?: { value?: string; confidence?: number };
  age_range?: { value?: { min?: number; max?: number }; confidence?: number };
  session_count?: { value?: number; confidence?: number };
  format?: { value?: string; confidence?: number };
  session_types_supported?: { value?: string[]; confidence?: number };
  themes?: { value?: string[]; confidence?: number };
  narrative_arc?: { value?: string | null; confidence?: number };
  skills_overall?: { value?: string[]; confidence?: number };
  materials?: { value?: string[]; confidence?: number };
  class_size?: { value?: { min?: number | null; max?: number | null } | null; confidence?: number };
  prerequisites?: { value?: string | null; confidence?: number };
  mid_term_skills?: { value?: string[]; confidence?: number };
  final_recap_skills?: { value?: string[]; confidence?: number };
  final_showcase?: { value?: string | null; confidence?: number };
  sessions?: { value?: Array<Record<string, unknown>>; confidence?: number };
};

async function processExtractionInBackground(
  documentId: string,
  promptVersion: PromptVersion,
  preserveName: boolean = false,
): Promise<void> {
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  async function markStatus(
    status: "processing" | "complete" | "failed",
    message: string | null,
    extra: Record<string, unknown> = {},
  ) {
    const { error } = await admin
      .from("curriculum_documents")
      .update({ extraction_status: status, status_message: message, ...extra })
      .eq("id", documentId);
    if (error) console.error("markStatus failed:", error.message);
  }

  let curriculumId: string | null = null;
  let organizationId: string | null = null;

  try {
    const { data: doc, error: docErr } = await admin
      .from("curriculum_documents")
      .select("id, curriculum_id, organization_id, storage_path, source_type, original_filename, extracted_text")
      .eq("id", documentId)
      .single();
    if (docErr || !doc) throw new Error(`Document not found: ${docErr?.message ?? "no row"}`);
    curriculumId = doc.curriculum_id;
    organizationId = doc.organization_id;

    await markStatus("processing", "Extracting your curriculum...");

    // Source-type dispatch:
    //   - upload         → download from storage, parse based on file extension
    //   - drive_link + extracted_text → Google native doc already exported to text
    //     by fetch-drive-document; use that text directly
    //   - drive_link + storage_path   → raw PDF/Word mirrored into our bucket
    //     by fetch-drive-document; download + parse like an upload
    //   - else           → unsupported
    let documentText: string;
    if (doc.source_type === "upload" || (doc.source_type === "drive_link" && doc.storage_path)) {
      if (!doc.storage_path) throw new Error("Document is missing its storage path.");
      const filename = doc.original_filename ?? doc.storage_path;
      const ext = detectExt(filename);
      if (!ext) throw new Error("Unsupported file type. Use .pdf, .docx, .txt, .md, or .xlsx");
      const { data: fileData, error: dlErr } = await admin.storage
        .from(BUCKET)
        .download(doc.storage_path);
      if (dlErr || !fileData) throw new Error(`Could not download document: ${dlErr?.message ?? "no file"}`);
      const bytes = new Uint8Array(await fileData.arrayBuffer());

      // File-hash dedup: if the same org already extracted an identical file,
      // copy those results instead of re-calling Claude.
      const hashBuf = await crypto.subtle.digest("SHA-256", bytes);
      const fileHash = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
      await admin.from("curriculum_documents").update({ file_hash: fileHash }).eq("id", documentId);

      const { data: existingDoc } = await admin
        .from("curriculum_documents")
        .select("id, extraction_result, extracted_text, curriculum_id")
        .eq("organization_id", organizationId)
        .eq("file_hash", fileHash)
        .eq("extraction_status", "complete")
        .neq("id", documentId)
        .limit(1)
        .maybeSingle();

      if (existingDoc?.extraction_result && existingDoc.extracted_text) {
        await markStatus("complete", "Done! (matched a previously extracted copy)", {
          extraction_result: existingDoc.extraction_result,
          extracted_text: existingDoc.extracted_text,
          extraction_error: null,
        });
        return;
      }

      documentText = await parseDocument(bytes, ext);
    } else if (doc.source_type === "drive_link" && doc.extracted_text) {
      documentText = doc.extracted_text;
    } else {
      throw new Error("This document has no readable content. Re-import it from Drive or upload directly.");
    }

    if (!documentText || documentText.trim().length < 20) {
      throw new Error("We couldn't read any text from that document. If it's a scanned PDF, try re-exporting it.");
    }

    // Soft sanity-check context — non-fatal if it fails.
    const orgContext = organizationId ? await buildOrgContext(admin, organizationId) : "";

    const prompt = PROMPT_VERSIONS[promptVersion];
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    let buffer = "";
    const sentMilestones = new Set<string>();
    let lastUpdateAt = 0;

    async function maybeUpdate(message: string) {
      const now = Date.now();
      // Throttle DB writes so Realtime doesn't get spammed for every text delta.
      if (now - lastUpdateAt < 400) return;
      lastUpdateAt = now;
      await markStatus("processing", message);
    }

    const msgStream = anthropic.messages.stream({
      model: prompt.model,
      max_tokens: prompt.maxTokens,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.userTemplate(documentText, orgContext) }],
    });

    let firstChunk = true;
    const milestoneChecks: Array<{ key: string; msg: string }> = [
      { key: "short_description", msg: "Drafting a parent description..." },
      { key: "skills_overall", msg: "Listing the skills kids will practice..." },
      { key: "sessions", msg: "Writing recap templates for each session..." },
    ];

    for await (const event of msgStream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        if (firstChunk) {
          await markStatus("processing", "Pulling out the lesson structure...");
          lastUpdateAt = Date.now();
          firstChunk = false;
        }
        buffer += event.delta.text;
        for (const c of milestoneChecks) {
          if (!sentMilestones.has(c.key) && buffer.includes(`"${c.key}"`)) {
            sentMilestones.add(c.key);
            await maybeUpdate(c.msg);
          }
        }
      }
    }

    const cleaned = buffer.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    let extracted: ExtractedShape;
    try {
      extracted = JSON.parse(cleaned);
    } catch (e) {
      throw new Error(`The AI returned something we couldn't parse as JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!extracted || typeof extracted !== "object") {
      throw new Error("The AI returned a non-object response.");
    }
    if (typeof extracted.name?.value !== "string" || extracted.name.value.trim().length === 0) {
      throw new Error("The AI couldn't find a curriculum name in this document.");
    }
    if (!Array.isArray(extracted.sessions?.value) || extracted.sessions.value.length === 0) {
      throw new Error("The AI couldn't find any sessions in this document.");
    }

    // ---- Persist into curricula ----
    // Attach-mode extractions keep the operator's existing name (set during
    // curriculum creation / backfill). The doc's name is informational only.
    const curriculaUpdates: Record<string, unknown> = {
      ...(preserveName ? {} : { name: extracted.name.value.trim() }),
      short_description: extracted.short_description?.value ?? null,
      age_range_min: extracted.age_range?.value?.min ?? null,
      age_range_max: extracted.age_range?.value?.max ?? null,
      session_count: extracted.session_count?.value ?? extracted.sessions.value.length,
      format: extracted.format?.value ?? null,
      session_types_supported: extracted.session_types_supported?.value ?? [],
      themes: extracted.themes?.value ?? [],
      narrative_arc: extracted.narrative_arc?.value ?? null,
      skills_overall: extracted.skills_overall?.value ?? [],
      materials: extracted.materials?.value ?? [],
      class_size_min: extracted.class_size?.value?.min ?? null,
      class_size_max: extracted.class_size?.value?.max ?? null,
      prerequisites: extracted.prerequisites?.value ?? null,
      mid_term_skills: extracted.mid_term_skills?.value ?? [],
      final_recap_skills: extracted.final_recap_skills?.value ?? [],
      final_showcase: extracted.final_showcase?.value ?? null,
      status: "extracted",
      updated_at: new Date().toISOString(),
    };
    const { error: curUpdErr } = await admin
      .from("curricula")
      .update(curriculaUpdates)
      .eq("id", curriculumId);
    if (curUpdErr) throw new Error(`Couldn't save the extracted curriculum: ${curUpdErr.message}`);

    // ---- Replace curriculum_sessions ----
    // Delete-and-reinsert keeps the door open for re-extraction later (Chunk 3+).
    const { error: delSessErr } = await admin
      .from("curriculum_sessions")
      .delete()
      .eq("curriculum_id", curriculumId);
    if (delSessErr) throw new Error(`Couldn't clear existing sessions: ${delSessErr.message}`);

    const sessionRows = extracted.sessions.value.map((s, i) => ({
      curriculum_id: curriculumId,
      organization_id: organizationId,
      session_number: typeof s.session_number === "number" ? s.session_number : i + 1,
      title: typeof s.title === "string" ? s.title : null,
      description: typeof s.description === "string" ? s.description : null,
      skills_practiced: Array.isArray(s.skills_practiced) ? s.skills_practiced : [],
      materials_session: Array.isArray(s.materials_session) ? s.materials_session : [],
      recap_template: typeof s.recap_template === "string" ? s.recap_template : null,
      parent_engagement_question:
        typeof s.parent_engagement_question === "string" ? s.parent_engagement_question : null,
    }));
    const { error: sessInsErr } = await admin.from("curriculum_sessions").insert(sessionRows);
    if (sessInsErr) throw new Error(`Couldn't save the sessions: ${sessInsErr.message}`);

    // ---- Audit / per-field confidence ----
    const fieldNames: Array<keyof ExtractedShape> = [
      "name",
      "short_description",
      "age_range",
      "session_count",
      "format",
      "session_types_supported",
      "themes",
      "narrative_arc",
      "skills_overall",
      "materials",
      "class_size",
      "prerequisites",
      "mid_term_skills",
      "final_recap_skills",
      "final_showcase",
      "sessions",
    ];
    const fieldRows = fieldNames
      .filter((f) => extracted[f] !== undefined)
      .map((f) => ({
        curriculum_id: curriculumId,
        organization_id: organizationId,
        field_name: f as string,
        extracted_value: (extracted[f] as { value?: unknown })?.value ?? null,
        confidence:
          typeof (extracted[f] as { confidence?: number })?.confidence === "number"
            ? (extracted[f] as { confidence: number }).confidence
            : null,
        source_document_id: documentId,
      }));
    if (fieldRows.length > 0) {
      const { error: fldErr } = await admin
        .from("curriculum_extracted_fields")
        .upsert(fieldRows, { onConflict: "curriculum_id,field_name" });
      if (fldErr) throw new Error(`Couldn't save the audit fields: ${fldErr.message}`);
    }

    // ---- Final doc update: success ----
    await markStatus("complete", "Done!", {
      extraction_result: extracted,
      extracted_text: documentText,
      extraction_error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Extraction failed for doc ${documentId}:`, message);
    await markStatus("failed", null, { extraction_error: message });
  }
}

// ---------------------------------------------------------------------------
// Dev mode (SSE, no persistence) — used by /admin/dev/extraction-test
// ---------------------------------------------------------------------------

function handleDevExtract(documentPath: string, promptVersion: PromptVersion): Response {
  const ext = detectExt(documentPath);
  if (!ext) return jsonError("Unsupported file type. Use .pdf, .docx, .txt, .md, or .xlsx");

  const sseHeaders = {
    ...corsHeaders,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  };

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(sseChunk(event, data));
      (async () => {
        try {
          send("status", { message: "Extracting your curriculum..." });
          const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
            auth: { persistSession: false, autoRefreshToken: false },
          });
          const { data: fileData, error: dlErr } = await admin.storage
            .from(BUCKET)
            .download(documentPath);
          if (dlErr || !fileData) throw new Error(`Could not download document: ${dlErr?.message ?? "no file"}`);
          const bytes = new Uint8Array(await fileData.arrayBuffer());
          const documentText = await parseDocument(bytes, ext);
          if (!documentText || documentText.trim().length < 20) {
            throw new Error("Parsed document is empty or unreadable.");
          }

          const prompt = PROMPT_VERSIONS[promptVersion];
          const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

          let buffer = "";
          const sentMilestones = new Set<string>();
          const milestone = (key: string, message: string) => {
            if (!sentMilestones.has(key) && buffer.includes(`"${key}"`)) {
              sentMilestones.add(key);
              send("status", { message });
            }
          };

          // Dev mode has no document_id, so no org-context. Prompt's userTemplate
          // accepts an empty orgContext and skips the <organization-context> block.
          const msgStream = anthropic.messages.stream({
            model: prompt.model,
            max_tokens: prompt.maxTokens,
            system: prompt.system,
            messages: [{ role: "user", content: prompt.userTemplate(documentText, "") }],
          });

          let firstChunk = true;
          for await (const event of msgStream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              if (firstChunk) {
                send("status", { message: "Pulling out the lesson structure..." });
                firstChunk = false;
              }
              buffer += event.delta.text;
              milestone("short_description", "Drafting a parent description...");
              milestone("skills_overall", "Listing the skills kids will practice...");
              milestone("sessions", "Writing recap templates for each session...");
            }
          }

          const cleaned = buffer.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
          let extracted: unknown = null;
          let parseError: string | null = null;
          try {
            extracted = JSON.parse(cleaned);
          } catch (e) {
            parseError = e instanceof Error ? e.message : String(e);
          }

          send("status", { message: "Done!" });
          send("done", { extracted, raw: buffer, parse_error: parseError, prompt_version: promptVersion });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send("error", { message });
        } finally {
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, { headers: sseHeaders });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("Method not allowed", 405);

  const authResult = await verifyCaller(req.headers.get("Authorization"));
  if (!authResult.ok) return jsonError(authResult.reason, authResult.status);
  const { caller, userClient } = authResult;

  let body: { document_id?: string; document_path?: string; prompt_version?: string; preserve_name?: boolean };
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body");
  }

  const promptVersion = (body.prompt_version ?? DEFAULT_PROMPT_VERSION) as PromptVersion;
  if (!PROMPT_VERSIONS[promptVersion]) {
    return jsonError(`Unknown prompt_version: ${promptVersion}`);
  }

  // Production mode
  if (body.document_id) {
    const { data: doc, error: docErr } = await userClient
      .from("curriculum_documents")
      .select("id, organization_id, curriculum_id, storage_path, source_type")
      .eq("id", body.document_id)
      .maybeSingle();
    if (docErr) return jsonError(`Could not fetch document: ${docErr.message}`, 500);
    if (!doc) return jsonError("Document not found or you don't have access", 404);

    if (!caller.isPlatformAdmin && !caller.adminOrgIds.has(doc.organization_id)) {
      return jsonError("You need admin/owner access to this organization", 403);
    }

    scheduleBackground(processExtractionInBackground(body.document_id, promptVersion, body.preserve_name === true));
    return jsonOk({ ok: true, document_id: body.document_id, curriculum_id: doc.curriculum_id });
  }

  // Dev mode (SSE)
  if (body.document_path) {
    if (!caller.isPlatformAdmin) return jsonError("Dev mode is platform_admin only", 403);
    return handleDevExtract(body.document_path, promptVersion);
  }

  return jsonError("Provide either document_id (production) or document_path (dev)");
});
