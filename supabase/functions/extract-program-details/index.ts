// extract-program-details
// Reads a curriculum document from the `program-documents` Storage bucket,
// parses it to plain text, and asks Claude to extract structured program data
// per the versioned prompt in prompts.ts.
//
// Response is Server-Sent Events. Event types:
//   - status: { message } — human-readable progress
//   - done:   { extracted, raw } — final structured JSON + raw model output
//   - error:  { message } — fatal error, stream then closes
//
// Auth: caller must be a row in platform_admins (checked with caller's JWT
// before any work begins). Service-role client is used downstream so we can
// read Storage without per-user grants.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Anthropic from "npm:@anthropic-ai/sdk@0.96.0";
import { detectExt, parseDocument } from "./parse.ts";
import { PROMPT_VERSIONS, type PromptVersion } from "./prompts.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const sseHeaders = {
  ...corsHeaders,
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
};

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sseChunk(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function verifyPlatformAdmin(authHeader: string | null): Promise<{ ok: true; userId: string } | { ok: false; reason: string; status: number }> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, reason: "Missing Authorization header", status: 401 };
  }
  const token = authHeader.slice("Bearer ".length);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userResp, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userResp?.user) {
    return { ok: false, reason: "Invalid session", status: 401 };
  }
  const { data: adminRow } = await userClient
    .from("platform_admins")
    .select("auth_user_id")
    .eq("auth_user_id", userResp.user.id)
    .maybeSingle();
  if (!adminRow) {
    return { ok: false, reason: "Platform admin only", status: 403 };
  }
  return { ok: true, userId: userResp.user.id };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("Method not allowed", 405);

  // 1. Auth gate
  const auth = await verifyPlatformAdmin(req.headers.get("Authorization"));
  if (!auth.ok) return jsonError(auth.reason, auth.status);

  // 2. Parse + validate payload
  let body: { document_path?: string; prompt_version?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body");
  }
  const documentPath = body.document_path;
  const promptVersion = (body.prompt_version ?? "v1") as PromptVersion;
  if (!documentPath || typeof documentPath !== "string") {
    return jsonError("document_path is required");
  }
  if (!PROMPT_VERSIONS[promptVersion]) {
    return jsonError(`Unknown prompt_version: ${promptVersion}`);
  }
  const ext = detectExt(documentPath);
  if (!ext) {
    return jsonError("Unsupported file type. Use .pdf, .docx, .txt, .md, or .xlsx");
  }

  // 3. Stream
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(sseChunk(event, data));
      (async () => {
        try {
          send("status", { message: "Reading your curriculum..." });

          const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
            auth: { persistSession: false, autoRefreshToken: false },
          });
          const { data: fileData, error: dlErr } = await admin.storage
            .from("program-documents")
            .download(documentPath);
          if (dlErr || !fileData) {
            throw new Error(`Could not download document: ${dlErr?.message ?? "no file"}`);
          }
          const bytes = new Uint8Array(await fileData.arrayBuffer());
          const documentText = await parseDocument(bytes, ext);
          if (!documentText || documentText.trim().length < 20) {
            throw new Error("Parsed document is empty or unreadable.");
          }

          const prompt = PROMPT_VERSIONS[promptVersion];
          const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

          // Stream the model output. Emit reactive status messages when specific
          // JSON keys first appear in the buffered output — this is "real
          // progress, not faked" because the message is tied to what the model
          // has actually started writing.
          let buffer = "";
          const sentMilestones = new Set<string>();
          const milestone = (key: string, message: string) => {
            if (!sentMilestones.has(key) && buffer.includes(`"${key}"`)) {
              sentMilestones.add(key);
              send("status", { message });
            }
          };

          const msgStream = anthropic.messages.stream({
            model: prompt.model,
            max_tokens: prompt.maxTokens,
            system: prompt.system,
            messages: [{ role: "user", content: prompt.userTemplate(documentText) }],
          });

          let firstChunk = true;
          for await (const event of msgStream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              if (firstChunk) {
                send("status", { message: "Pulling out the lesson structure..." });
                firstChunk = false;
              }
              buffer += event.delta.text;
              milestone("short_description", "Writing a parent-friendly description...");
              milestone("skills", "Finding the skills kids will practice...");
              milestone("sessions", "Listing out each session...");
            }
          }

          // Parse final JSON. Model is instructed not to wrap in fences but defend anyway.
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
});
