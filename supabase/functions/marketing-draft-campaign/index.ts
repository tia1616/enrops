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
// Opus 4.6 picked over Sonnet 4.6 for marketing copy quality. Jessica's
// feedback: Opus 4.7 "overthinks" the draft and produces colder copy. 4.6
// stays warm and punchy. Override per-deploy via MARKETING_DRAFT_MODEL.
const DRAFT_MODEL = Deno.env.get("MARKETING_DRAFT_MODEL") ?? "claude-opus-4-6";

// Multi-touchpoint schedules return ~6-9 emails worth of JSON. 8000 max_tokens
// fits comfortably; if Don wants more, future chunks can stream or paginate.
const MAX_TOKENS = 8000;
const CLAUDE_TIMEOUT_MS = 120_000;
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
  // Topics being promoted. Accept either a single string (legacy / quick send)
  // or a list of topics (multi-topic campaign — Don weaves them into one
  // schedule with topic-tagged touchpoints).
  what: string | string[];
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
  timezone: string | null;
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
  // `what` accepts string OR string[] (multi-topic). Normalize to string[].
  let topics: string[];
  if (typeof inputs.what === "string") {
    if (!inputs.what.trim()) {
      return { ok: false, error: "inputs.what cannot be empty", status: 400 };
    }
    topics = [inputs.what.trim()];
  } else if (Array.isArray(inputs.what)) {
    if (inputs.what.length === 0) {
      return { ok: false, error: "inputs.what must contain at least one topic", status: 400 };
    }
    if (inputs.what.some((t) => typeof t !== "string" || !t.trim())) {
      return { ok: false, error: "inputs.what must be non-empty strings", status: 400 };
    }
    topics = inputs.what.map((t) => (t as string).trim());
  } else {
    return { ok: false, error: "inputs.what must be a string or array of strings", status: 400 };
  }
  (inputs as { what: string[] }).what = topics;
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
        what: topics,
        who: who as unknown as WhoInput,
        duration: inputs.duration as string,
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

function buildSystemPrompt(
  org: OrgConfig,
  inputs: DraftInputs,
  segmentSummary: string,
  todayIso: string,
  orgTimezone: string,
): string {
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
  const tone = v.tone ?? "warm, positive, celebratory; no tech jargon";
  const avoid = v.do_not_use?.length ? `Avoid these phrases: ${v.do_not_use.join(", ")}.` : "";
  const favor = v.do_use?.length ? `Favor language like: ${v.do_use.join(", ")}.` : "";
  const notes = v.additional_notes ?? "";
  const closer = v.closer ? `End every email body with this exact line on its own paragraph: "${v.closer}"` : "";

  const topics = Array.isArray(inputs.what) ? inputs.what : [inputs.what];
  const topicLine = topics.length === 1
    ? `Campaign topic: "${topics[0]}"`
    : `Campaign topics (weave them across the schedule — each touchpoint covers one or more; tag each touchpoint with which topics it covers): ${topics.map((t) => `"${t}"`).join(", ")}`;

  const channelNote = inputs.channels.length > 1
    ? `Channels requested: ${inputs.channels.join(", ")}. v1 generates email touchpoints only; flyer + social are placeholders.`
    : "Channels: email only in v1.";

  const standingRules = [
    `STANDING RULES (apply to every touchpoint):`,
    `- Never use cancellation language with parents.`,
    `- One clear call to action per email. CTA links to the org's registration page (caller injects URL).`,
    `- Subject line under 60 characters; no all-caps, no clickbait, no emoji.`,
    `- Preheader (first ~80 chars of body) extends the subject, never repeats it.`,
    `- Personalize with {{first_name}} and {{school}} merge tokens where natural.`,
    `- If a touchpoint references an early-bird deadline or savings, mention the date plainly; caller injects pricing from programs.early_bird_price_cents.`,
    `- DEFAULT SEND TIMES (org timezone ${orgTimezone}): Tuesday/Thursday 10am for regular sends. Deadline-day reminders 7am. Welcome notes Monday 9am. NEVER Friday afternoons or weekends.`,
    `- THROTTLE: this org caps marketing at 1 email per parent per 10 days. Space consecutive emails at least 6 days apart.`,
    `- For any topic that has a known deadline (early-bird ends, registration closes), include BOTH a 48-hour-before AND a 24-hour-before reminder email.`,
    `- Pop-culture themes (Pokémon, Minecraft, LEGO, Mario) welcome when they fit.`,
    `- No promotional puffery. Lead with what kids do and make.`,
  ].join("\n");

  const cadenceGuidance = `CADENCE HEURISTICS by duration:
- "2 weeks": 2-3 emails. Kickoff + 1 mid + 1 final-call if a deadline lives in-window.
- "1 month": 4-6 emails. Kickoff, mid-window, plus 48h + 24h reminders for each deadline. Add a "thanks for registering" send if appropriate at the end.
- "2 months": 5-7 emails. Slower build with longer gaps between general sends; ALWAYS the 48h + 24h reminders near deadlines.
- "custom": pick a reasonable cadence with 6-10 day spacing.`;

  return [
    `You are Don, the marketing director for ${sender}. You plan multi-touchpoint email campaigns.`,
    ``,
    `Audience: ${audience}`,
    `Tone: ${tone}`,
    avoid,
    favor,
    notes,
    closer,
    ``,
    `Today is: ${todayIso} (org timezone: ${orgTimezone})`,
    topicLine,
    `Sending to: ${segmentSummary}`,
    `Campaign duration: "${inputs.duration}" — count from today.`,
    channelNote,
    ``,
    standingRules,
    ``,
    cadenceGuidance,
    ``,
    `OUTPUT FORMAT:`,
    `Return ONLY a single JSON object (no markdown fences). Schema:`,
    `{`,
    `  "schedule_summary": "<one short sentence describing the overall plan>",`,
    `  "touchpoints": [`,
    `    {`,
    `      "order_index": 0,`,
    `      "type": "email",`,
    `      "label": "<brief internal name: kickoff | mid-window | 48h-promo | 24h-promo | 48h-reg-close | 24h-reg-close | final-call | thanks>",`,
    `      "scheduled_at": "<ISO 8601 with timezone offset, e.g. 2026-05-21T10:00:00-07:00>",`,
    `      "subject": "<= 60 chars",`,
    `      "body_html": "<clean HTML, no <html>/<body> wrappers, no inline <style>>",`,
    `      "body_text": "<plain-text version>",`,
    `      "topics": ["<which input topics this touchpoint covers; subset of: ${topics.map((t) => `\\"${t}\\"`).join(", ")}>"]`,
    `    }`,
    `  ]`,
    `}`,
    ``,
    `IMPORTANT:`,
    `- Generate 2-7 touchpoints depending on duration (see cadence heuristics).`,
    `- order_index starts at 0 and is contiguous.`,
    `- scheduled_at must be in the future (after today) and respect default send times.`,
    `- Each touchpoint's "topics" array must be a non-empty subset of the input topics.`,
  ]
    .filter((line) => line !== undefined && line !== null && (typeof line !== "string" || line !== ""))
    .join("\n");
}

type Touchpoint = {
  order_index: number;
  type: "email" | "flyer" | "social";
  label: string;
  scheduled_at: string;
  subject?: string;
  body_html?: string;
  body_text?: string;
  topics: string[];
};

type Schedule = {
  schedule_summary: string;
  touchpoints: Touchpoint[];
};

async function callClaude(systemPrompt: string, topics: string[]): Promise<
  | { ok: true; schedule: Schedule; model: string }
  | { ok: false; error: string; status: number }
> {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const topicsLine = topics.length === 1
    ? `"${topics[0]}"`
    : topics.map((t) => `"${t}"`).join(" + ");
  const userMessage = `Plan the full campaign schedule now. Topic(s): ${topicsLine}. Generate every touchpoint with its scheduled_at, subject, body_html, body_text, and topics array. Return the JSON object only.`;

  const attempt = async (): Promise<{ raw: string }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
    try {
      const resp = await anthropic.messages.create(
        {
          model: DRAFT_MODEL,
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

  const tryParse = (raw: string): Schedule | null => {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    try {
      const parsed = JSON.parse(cleaned) as Partial<Schedule>;
      if (
        typeof parsed.schedule_summary === "string" &&
        Array.isArray(parsed.touchpoints) &&
        parsed.touchpoints.length > 0
      ) {
        // Validate each touchpoint has the minimum shape we need.
        const tps: Touchpoint[] = [];
        for (const tp of parsed.touchpoints) {
          if (typeof tp.order_index !== "number") return null;
          if (tp.type !== "email" && tp.type !== "flyer" && tp.type !== "social") return null;
          if (typeof tp.label !== "string") return null;
          if (typeof tp.scheduled_at !== "string") return null;
          if (!Array.isArray(tp.topics) || tp.topics.length === 0) return null;
          tps.push({
            order_index: tp.order_index,
            type: tp.type,
            label: tp.label,
            scheduled_at: tp.scheduled_at,
            subject: tp.subject,
            body_html: tp.body_html,
            body_text: tp.body_text,
            topics: tp.topics,
          });
        }
        return { schedule_summary: parsed.schedule_summary, touchpoints: tps };
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
  let schedule = tryParse(first.raw);
  if (!schedule) {
    try {
      const second = await attempt();
      schedule = tryParse(second.raw);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      if (err.toLowerCase().includes("abort")) return { ok: false, error: "draft_timeout", status: 504 };
      return { ok: false, error: `claude retry failed: ${err}`, status: 502 };
    }
  }
  if (!schedule) return { ok: false, error: "claude returned malformed schedule JSON after retry", status: 502 };
  return { ok: true, schedule, model: DRAFT_MODEL };
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
    .select("id, default_sender_name, default_sender_email, sending_domain, brand_voice, timezone")
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
  const orgTimezone = orgRow.timezone ?? "America/Los_Angeles";
  const todayIso = new Date().toISOString();
  const systemPrompt = buildSystemPrompt(orgRow, inputs, segment_summary, todayIso, orgTimezone);
  const topicsArr = Array.isArray(inputs.what) ? inputs.what : [inputs.what];
  const claudeResult = await callClaude(systemPrompt, topicsArr);
  if (!claudeResult.ok) return jsonError(claudeResult.error, claudeResult.status);
  const { schedule, model } = claudeResult;

  // First touchpoint = the "lead" email; its subject/body populate the parent
  // campaigns row so the existing campaigns list keeps working.
  const lead = schedule.touchpoints[0];

  // ---- Persist parent campaign row ----
  const { data: inserted, error: iErr } = await supabase
    .from("marketing_campaigns")
    .insert({
      organization_id,
      name: topicsArr.join(" + ").slice(0, 200),
      campaign_type: "custom",
      status: "draft",
      subject_template: lead?.subject ?? topicsArr.join(" + "),
      body_template: lead?.body_html ?? "",
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

  // ---- Persist touchpoint rows ----
  const touchpointRows = schedule.touchpoints.map((tp) => ({
    campaign_id: inserted.id,
    organization_id,
    type: tp.type,
    order_index: tp.order_index,
    scheduled_at: tp.scheduled_at,
    status: "queued",
    payload: {
      label: tp.label,
      subject: tp.subject ?? null,
      body_html: tp.body_html ?? null,
      body_text: tp.body_text ?? null,
    },
    topics: tp.topics,
  }));
  const { data: insertedTps, error: tpErr } = await supabase
    .from("marketing_campaign_touchpoints")
    .insert(touchpointRows)
    .select("id, order_index, type, scheduled_at, status, payload, topics");
  if (tpErr) {
    return jsonError(`failed to persist touchpoints: ${tpErr.message}`, 500);
  }

  return jsonOk({
    campaign_id: inserted.id,
    schedule: {
      summary: schedule.schedule_summary,
      touchpoints: (insertedTps ?? []).map((tp: { id: string; order_index: number; type: string; scheduled_at: string; status: string; payload: Record<string, unknown>; topics: string[] }) => ({
        id: tp.id,
        order_index: tp.order_index,
        type: tp.type,
        scheduled_at: tp.scheduled_at,
        status: tp.status,
        label: (tp.payload as { label?: string })?.label ?? null,
        subject: (tp.payload as { subject?: string })?.subject ?? null,
        body_html: (tp.payload as { body_html?: string })?.body_html ?? null,
        body_text: (tp.payload as { body_text?: string })?.body_text ?? null,
        topics: tp.topics,
      })),
    },
    sender: {
      name: orgRow.default_sender_name!,
      email: orgRow.default_sender_email!,
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
