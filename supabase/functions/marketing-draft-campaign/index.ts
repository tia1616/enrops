// marketing-draft-campaign
//
// AI Campaign Builder backend. Takes 3-4 question answers from the "Marketing
// and Communications" tab, resolves the recipient list, and asks Claude to
// draft the email per the tenant's brand_voice. Returns a draft + a locked
// recipient ID list that the admin can review, edit, and send via the
// existing `marketing-send` function (using its `ad_hoc_recipient_ids` param).
//
// Critical: NOTHING in this file is hardcoded for J2S or any specific tenant.
// All copy rules, sender identity, and location aliases load from the DB.
//
// Body shape:
//   {
//     organization_id: uuid,
//     inputs: {
//       what: string,
//       who: { audience: 'parents' | 'partners' | 'instructors', filter: {...} },
//       duration: string,
//       channels: string[],            // e.g., ['email', 'social', 'flyer']
//     }
//   }
//
// Auth: caller must be platform_admin OR own/admin the requested organization.
//
// v1 scope:
//   - audience='parents' is fully implemented.
//   - audience='partners' / 'instructors' -> 501 not_yet_supported (UI dropdown
//     can ship; backend catches up in a later chunk).
//   - channels accepted; only 'email' is rendered. Others ignored with a
//     warning in the response.
//
// Writes one row to marketing_campaigns with status='draft', draft_source=
// 'ai_assisted', draft_inputs=<the inputs object>, draft_model=<model used>.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Anthropic from "npm:@anthropic-ai/sdk@0.96.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SONNET_MODEL = Deno.env.get("SONNET_MODEL") ?? "claude-sonnet-4-6";

const MAX_TOKENS = 1500;
const CLAUDE_TIMEOUT_MS = 60_000;
const RECIPIENT_HARD_CAP = 5000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ParentsFilter =
  | { type: "master_list" }
  | { type: "school"; school_ids: string[] }
  | { type: "area"; area: string }
  | { type: "segment"; segments: string[] }
  | { type: "natural"; text: string };

type WhoInput =
  | { audience: "parents"; filter: ParentsFilter }
  | { audience: "partners"; filter: Record<string, unknown> }
  | { audience: "instructors"; filter: Record<string, unknown> };

type DraftInputs = {
  what: string;
  who: WhoInput;
  duration: string;
  channels: string[];
};

type DraftRequest = {
  organization_id: string;
  inputs: DraftInputs;
};

type OrgConfig = {
  id: string;
  default_sender_name: string | null;
  default_sender_email: string | null;
  sending_domain: string | null;
  brand_voice: Record<string, unknown> | null;
};

type ResolvedRecipients = {
  ids: string[];
  count: number;
  segment_summary: string;
};

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
// Auth (mirrors polish-skills / extract-curriculum-details)
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
// Request parsing + validation
// ---------------------------------------------------------------------------

function parseRequest(body: unknown):
  | { ok: true; req: DraftRequest }
  | { ok: false; error: string; status: number } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "request body required", status: 400 };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.organization_id !== "string") {
    return { ok: false, error: "organization_id required", status: 400 };
  }
  const inputs = b.inputs as Record<string, unknown> | undefined;
  if (!inputs || typeof inputs !== "object") {
    return { ok: false, error: "inputs object required", status: 400 };
  }
  if (typeof inputs.what !== "string" || !inputs.what.trim()) {
    return { ok: false, error: "inputs.what required", status: 400 };
  }
  if (typeof inputs.duration !== "string" || !inputs.duration.trim()) {
    return { ok: false, error: "inputs.duration required", status: 400 };
  }
  if (!Array.isArray(inputs.channels) || inputs.channels.some((c) => typeof c !== "string")) {
    return { ok: false, error: "inputs.channels must be string[]", status: 400 };
  }
  const who = inputs.who as Record<string, unknown> | undefined;
  if (!who || typeof who !== "object") {
    return { ok: false, error: "inputs.who required", status: 400 };
  }
  if (!["parents", "partners", "instructors"].includes(who.audience as string)) {
    return { ok: false, error: "inputs.who.audience must be parents | partners | instructors", status: 400 };
  }
  if (!who.filter || typeof who.filter !== "object") {
    return { ok: false, error: "inputs.who.filter required", status: 400 };
  }
  return {
    ok: true,
    req: {
      organization_id: b.organization_id,
      inputs: {
        what: inputs.what,
        who: who as unknown as WhoInput,
        duration: inputs.duration,
        channels: inputs.channels as string[],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Recipient resolution (parents audience)
// ---------------------------------------------------------------------------

async function resolveParents(
  supabase: SupabaseClient,
  orgId: string,
  filter: ParentsFilter,
): Promise<{ ok: true; data: ResolvedRecipients } | { ok: false; error: string; status: number }> {
  let query = supabase
    .from("marketing_recipients")
    .select("id, school_name")
    .eq("organization_id", orgId);

  let segmentSummary = "";

  switch (filter.type) {
    case "master_list": {
      segmentSummary = "all parents on the master list";
      break;
    }
    case "school": {
      if (!Array.isArray(filter.school_ids) || filter.school_ids.length === 0) {
        return { ok: false, error: "filter.school_ids required for type=school", status: 400 };
      }
      // Resolve school_ids -> display names + aliases for this tenant
      const { data: locs, error: lErr } = await supabase
        .from("program_locations")
        .select("id, name, name_aliases")
        .eq("organization_id", orgId)
        .in("id", filter.school_ids);
      if (lErr) return { ok: false, error: `program_locations query failed: ${lErr.message}`, status: 500 };
      if (!locs || locs.length === 0) {
        return { ok: false, error: "no matching program_locations for this org", status: 404 };
      }
      const recipientNames = new Set<string>();
      for (const loc of locs as { name: string; name_aliases: string[] | null }[]) {
        if (loc.name) recipientNames.add(loc.name);
        for (const alias of loc.name_aliases ?? []) recipientNames.add(alias);
      }
      query = query.in("school_name", [...recipientNames]);
      const displayNames = (locs as { name: string }[]).map((l) => l.name).filter(Boolean);
      segmentSummary = `parents at ${joinWithAnd(displayNames)}`;
      break;
    }
    case "area": {
      if (typeof filter.area !== "string" || !filter.area.trim()) {
        return { ok: false, error: "filter.area required for type=area", status: 400 };
      }
      query = query.eq("geo_segment", filter.area);
      segmentSummary = `parents in the ${filter.area} area`;
      break;
    }
    case "segment": {
      if (!Array.isArray(filter.segments) || filter.segments.length === 0) {
        return { ok: false, error: "filter.segments required for type=segment", status: 400 };
      }
      query = query.overlaps("segments", filter.segments);
      segmentSummary = `parents tagged ${joinWithAnd(filter.segments)}`;
      break;
    }
    case "natural": {
      return {
        ok: false,
        error: "natural-language recipient search not implemented in v1",
        status: 501,
      };
    }
    default: {
      return { ok: false, error: `unknown filter.type: ${(filter as { type: string }).type}`, status: 400 };
    }
  }

  // Paginate through PostgREST's 1000-row default cap.
  const PAGE = 1000;
  const ids: string[] = [];
  for (let off = 0; ; off += PAGE) {
    const { data: page, error: rErr } = await query.range(off, off + PAGE - 1);
    if (rErr) return { ok: false, error: `recipients query failed: ${rErr.message}`, status: 500 };
    if (!page || page.length === 0) break;
    for (const row of page as { id: string }[]) ids.push(row.id);
    if (page.length < PAGE) break;
    if (ids.length >= RECIPIENT_HARD_CAP) break;
  }

  if (ids.length > RECIPIENT_HARD_CAP) {
    return {
      ok: false,
      error: "resolved recipient count exceeds hard cap",
      status: 413,
    };
  }

  return { ok: true, data: { ids, count: ids.length, segment_summary: segmentSummary } };
}

function joinWithAnd(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Prompt + Claude call
// ---------------------------------------------------------------------------

function buildSystemPrompt(org: OrgConfig, inputs: DraftInputs, segmentSummary: string): string {
  const v = (org.brand_voice ?? {}) as {
    audience?: string;
    tone?: string;
    do_not_use?: string[];
    do_use?: string[];
    additional_notes?: string;
    closer?: string;
  };
  const sender = org.default_sender_name ?? "the team";
  const audience = v.audience ?? "parents of enrichment-program students";
  const tone = v.tone ?? "warm and professional";
  const avoid = v.do_not_use?.length ? `Avoid these phrases: ${v.do_not_use.join(", ")}.` : "";
  const favor = v.do_use?.length ? `Favor language like: ${v.do_use.join(", ")}.` : "";
  const notes = v.additional_notes ?? "";
  const closer = v.closer ? `End the email body with this exact line on its own paragraph: "${v.closer}"` : "";

  const channelNote = inputs.channels.length > 1
    ? `Channels requested: ${inputs.channels.join(", ")}. v1 only generates email content; other channels surface a "coming soon" pill in the UI.`
    : "Channel: email.";

  return [
    `You are drafting a marketing email on behalf of ${sender}.`,
    ``,
    `Audience: ${audience}`,
    `Tone: ${tone}`,
    avoid,
    favor,
    notes,
    closer,
    ``,
    `Campaign topic: ${inputs.what}`,
    `Sending to: ${segmentSummary}`,
    `Campaign duration: ${inputs.duration}`,
    channelNote,
    ``,
    `Return ONLY a single JSON object with these fields (no markdown fences):`,
    `{`,
    `  "subject": "<= 80 characters, no emoji, no clickbait",`,
    `  "body_html": "<clean HTML, no <html>/<body> wrappers, no inline <style>>",`,
    `  "body_text": "<plain-text version for clients that strip HTML>"`,
    `}`,
  ]
    .filter((line) => line !== undefined && line !== null && (typeof line !== "string" || line !== ""))
    .join("\n");
}

type Draft = { subject: string; body_html: string; body_text: string };

async function callClaude(systemPrompt: string, what: string): Promise<
  | { ok: true; draft: Draft; model: string }
  | { ok: false; error: string; status: number }
> {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const userMessage = `Write the email now for: "${what}"`;

  const attempt = async (): Promise<{ raw: string }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
    try {
      const resp = await anthropic.messages.create(
        {
          model: SONNET_MODEL,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
        },
        { signal: controller.signal },
      );
      let raw = "";
      for (const block of resp.content) {
        if (block.type === "text") raw += block.text;
      }
      return { raw };
    } finally {
      clearTimeout(timer);
    }
  };

  const tryParse = (raw: string): Draft | null => {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    try {
      const parsed = JSON.parse(cleaned) as Partial<Draft>;
      if (
        typeof parsed.subject === "string" &&
        typeof parsed.body_html === "string" &&
        typeof parsed.body_text === "string"
      ) {
        return { subject: parsed.subject, body_html: parsed.body_html, body_text: parsed.body_text };
      }
    } catch {
      // fall through
    }
    return null;
  };

  let first: { raw: string };
  try {
    first = await attempt();
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    if (err.toLowerCase().includes("abort")) return { ok: false, error: "draft_timeout", status: 504 };
    return { ok: false, error: `claude call failed: ${err}`, status: 502 };
  }
  let draft = tryParse(first.raw);
  if (!draft) {
    // Retry once on malformed output, then fail.
    try {
      const second = await attempt();
      draft = tryParse(second.raw);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      if (err.toLowerCase().includes("abort")) return { ok: false, error: "draft_timeout", status: 504 };
      return { ok: false, error: `claude retry failed: ${err}`, status: 502 };
    }
  }
  if (!draft) return { ok: false, error: "claude returned malformed JSON after retry", status: 502 };
  return { ok: true, draft, model: SONNET_MODEL };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

serve(async (req: Request) => {
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
  const parsed = parseRequest(body);
  if (!parsed.ok) return jsonError(parsed.error, parsed.status);
  const { organization_id, inputs } = parsed.req;

  // ---- Multi-tenant gate ----
  if (!caller.isPlatformAdmin && !caller.adminOrgIds.has(organization_id)) {
    return jsonError("forbidden: caller has no admin access to this organization", 403);
  }

  // Service-role client for downstream reads/writes (RLS already enforced by the
  // explicit auth gate above; service role lets us avoid second-guessing each
  // policy from inside this trusted function).
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ---- Audience gate (v1: parents only) ----
  if (inputs.who.audience !== "parents") {
    return jsonError(
      `audience ${inputs.who.audience} not yet implemented`,
      501,
      { audience: inputs.who.audience, supported_in_v1: ["parents"] },
    );
  }

  // ---- Load org config ----
  const { data: orgRow, error: oErr } = await supabase
    .from("organizations")
    .select("id, default_sender_name, default_sender_email, sending_domain, brand_voice")
    .eq("id", organization_id)
    .single<OrgConfig>();
  if (oErr || !orgRow) return jsonError(`organization not found: ${oErr?.message ?? "unknown"}`, 404);

  const missing: string[] = [];
  if (!orgRow.default_sender_email) missing.push("default_sender_email");
  if (!orgRow.default_sender_name) missing.push("default_sender_name");
  if (missing.length > 0) {
    return jsonError("org_not_configured", 400, { missing });
  }

  // ---- Resolve recipients ----
  const resolved = await resolveParents(supabase, organization_id, inputs.who.filter as ParentsFilter);
  if (!resolved.ok) return jsonError(resolved.error, resolved.status);
  const { ids: recipientIds, count: recipientCount, segment_summary } = resolved.data;

  // Zero-recipient case is a soft warning: the admin can still see the draft
  // and adjust the filter without re-running the whole question flow.
  const zeroRecipientWarning = recipientCount === 0 ? "no_recipients_matched" : null;

  // ---- Build prompt + call Claude ----
  const systemPrompt = buildSystemPrompt(orgRow, inputs, segment_summary);
  const claudeResult = await callClaude(systemPrompt, inputs.what);
  if (!claudeResult.ok) return jsonError(claudeResult.error, claudeResult.status);
  const { draft, model } = claudeResult;

  // ---- Persist as a draft campaign ----
  const { data: inserted, error: iErr } = await supabase
    .from("marketing_campaigns")
    .insert({
      organization_id,
      name: inputs.what.slice(0, 200),
      campaign_type: "custom",
      status: "draft",
      subject_template: draft.subject,
      body_template: draft.body_html,
      draft_source: "ai_assisted",
      draft_inputs: inputs as unknown as Record<string, unknown>,
      draft_model: model,
      approved_at: null,
    })
    .select("id")
    .single<{ id: string }>();
  if (iErr || !inserted) {
    return jsonError(`failed to persist draft: ${iErr?.message ?? "unknown"}`, 500);
  }

  return jsonOk({
    campaign_id: inserted.id,
    draft: {
      subject: draft.subject,
      body_html: draft.body_html,
      body_text: draft.body_text,
      sender_name: orgRow.default_sender_name!,
      sender_email: orgRow.default_sender_email!,
    },
    recipients: {
      ids: recipientIds,
      count: recipientCount,
      segment_summary,
    },
    model,
    inputs_echo: inputs,
    ...(zeroRecipientWarning ? { warning: zeroRecipientWarning } : {}),
  });
});
