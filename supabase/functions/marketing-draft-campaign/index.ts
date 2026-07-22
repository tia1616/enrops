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
// ENNIE PROMPT — human-readable docs (keep in sync with buildSystemPrompt):
//   - docs/agents/ennie/system-prompt.md         (cross-platform persona)
//   - docs/agents/ennie/marketing-draft-rules.md (this function's rules)
// When changing the prompt here, update the .md files. Future refactor:
// have buildSystemPrompt read from those files at deploy time so there's
// one source of truth.
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

// Use the built-in Deno.serve (no external std import) — avoids a flaky
// deno.land/std fetch at bundle time and is the current Supabase standard.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Anthropic from "npm:@anthropic-ai/sdk@0.96.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
// Sonnet 4.6 — switched from Opus 4.6 for cost (June 2026 review). ~5x
// cheaper, acceptable quality for parent-facing email copy. Revert via
// MARKETING_DRAFT_MODEL env var if copy quality drops.
const DRAFT_MODEL = Deno.env.get("MARKETING_DRAFT_MODEL") ?? "claude-sonnet-4-6";

// Multi-touchpoint schedules return ~6-9 emails worth of JSON. 16000 max_tokens
// fits a 7-email series with html+text without truncation; if Ennie wants more,
// future chunks can stream or paginate.
// 10k fits ~7 HTML-only emails comfortably. The model no longer writes the
// plain-text copy (we derive it from the HTML), which roughly halves output
// and generation time. Timeout is short enough that one attempt + one retry
// still fits under the platform's wall-clock limit — fail fast, not hang.
const MAX_TOKENS = 10000;
const CLAUDE_TIMEOUT_MS = 55_000;
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
  // Area filter went multi-select 2026-06-02. `area: string` is still accepted
  // for backward-compat with in-flight drafts; resolveParents normalizes it
  // into `areas: string[]`.
  | { type: "area"; areas?: string[]; area?: string }
  | { type: "tag"; tags: string[] }
  | { type: "natural"; text: string };

type WhoInput =
  | { audience: "parents"; filter: ParentsFilter }
  | { audience: "partners"; filter: Record<string, unknown> }
  | { audience: "instructors"; filter: Record<string, unknown> };

// Structured `what` shape from the new Q1 catalog picker. Provider picks
// concrete program/camp rows from their catalog → we load the real rows
// here and inject them as grounded facts into Ennie's prompt. This replaces
// the fuzzy-string curriculum match for the structured path. mode='other'
// falls through to topic strings + fuzzy match for partner notes / general
// recap content that isn't tied to a scheduled row.
type StructuredWhat = {
  mode: "programs" | "camps" | "other";
  program_ids?: string[];
  camp_session_ids?: string[];
  topics?: string[];
  // Q1 intent identifier when the operator clicked an intent card (Family
  // Comms intent-first redesign 2026-06-02). Drives the INTENT-DRIVEN
  // TONE/CADENCE block in buildSystemPrompt. null/undefined when the
  // operator used the manual catalog picker — prompt falls back to the
  // duration-based cadence heuristics.
  intent_key?: string | null;
};

type PromoSettings = {
  early_bird?: boolean;        // lead with early-bird savings
  vip_option?: boolean;        // mention STEAM VIP full-year add-on
  multi_camp_discount?: boolean; // reference multi-camp bundle (e.g. BUILD10)
  code?: string | null;        // optional promo_codes.code
};

type DraftInputs = {
  // Topics being promoted. Accepts:
  //   string                                        — legacy / quick send
  //   string[]                                      — multi-topic campaign
  //   { mode, program_ids?, camp_session_ids?, topics? } — structured catalog picks
  what: string | string[] | StructuredWhat;
  who: WhoInput;
  duration: string;
  channels: string[];
  promo?: PromoSettings;
  // Free-text context from the operator for this specific campaign. Overrides
  // Ennie's defaults when in conflict. Used for things the system can't infer
  // from the catalog (e.g. tenant-level VIP offers, partner events, copy preferences).
  operator_notes?: string;
  // Per-campaign registration URL override. When set, {{register_url}} resolves
  // to this URL at send time instead of the org default. For campaigns where
  // registration isn't on the operator's default enrops.com page (Squarespace,
  // external form, partner site).
  registration_url_override?: string;
  // One-off send time. Required when what.mode='other'. Values:
  //   'now' -> resolve to current time + small delay (cron picks up next tick)
  //   'tomorrow_morning' -> next day 10am org timezone
  //   ISO-like 'YYYY-MM-DDTHH:MM:SS' -> interpreted as local time, resolved
  //     to UTC with org timezone offset
  send_at?: string;
};

type DraftRequest = {
  organization_id: string;
  inputs: DraftInputs;
};

type VipOffering = {
  enabled: boolean;
  label?: string;
  price_cents?: number;
  description?: string;
  excluded_location_ids?: string[];
};

type OrgConfig = {
  id: string;
  default_sender_name: string | null;
  default_sender_email: string | null;
  sending_domain: string | null;
  brand_voice: Record<string, unknown> | null;
  timezone: string | null;
  vip_offering: VipOffering | null;
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
  | { ok: true; req: DraftRequest; derivedTopics: string[]; structuredWhat: StructuredWhat | null }
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
  // `what` accepts:
  //   string                              — legacy single topic
  //   string[]                            — legacy multi-topic
  //   { mode, program_ids|camp_session_ids|topics } — structured catalog picks
  //
  // We normalize the structured shape into `topics: string[]` for prompt /
  // response purposes (Ennie still works in terms of "topics"), AND preserve
  // the structured what on the request so loadGroundedFacts can use the IDs
  // to query the real rows server-side.
  let topics: string[];
  let structuredWhat: StructuredWhat | null = null;

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
  } else if (inputs.what && typeof inputs.what === "object") {
    const w = inputs.what as Record<string, unknown>;
    const mode = w.mode;
    if (mode !== "programs" && mode !== "camps" && mode !== "other") {
      return { ok: false, error: "inputs.what.mode must be programs | camps | other", status: 400 };
    }
    // intent_key is optional — present when the operator clicked a Q1 intent
    // card. Validated here so the prompt can trust it; unknown keys are
    // dropped silently (forward-compat: future intents added in the registry
    // won't 400 older edge function versions).
    const KNOWN_INTENTS = new Set([
      "registration_opened", "last_call", "fill_remaining_seats", "low_enrollment_push",
      "other_schedule_change", "other_photo_gallery", "other_partner_event", "other_free_form",
    ]);
    const intentKeyRaw = typeof w.intent_key === "string" ? w.intent_key.trim() : null;
    const intent_key = intentKeyRaw && KNOWN_INTENTS.has(intentKeyRaw) ? intentKeyRaw : null;

    if (mode === "programs") {
      const ids = Array.isArray(w.program_ids) ? (w.program_ids as unknown[]).filter((x) => typeof x === "string") as string[] : [];
      if (ids.length === 0) {
        return { ok: false, error: "inputs.what.program_ids must contain at least one id", status: 400 };
      }
      structuredWhat = { mode: "programs", program_ids: ids, intent_key };
    } else if (mode === "camps") {
      const ids = Array.isArray(w.camp_session_ids) ? (w.camp_session_ids as unknown[]).filter((x) => typeof x === "string") as string[] : [];
      if (ids.length === 0) {
        return { ok: false, error: "inputs.what.camp_session_ids must contain at least one id", status: 400 };
      }
      structuredWhat = { mode: "camps", camp_session_ids: ids, intent_key };
    } else {
      const ts = Array.isArray(w.topics) ? (w.topics as unknown[]).filter((x) => typeof x === "string" && (x as string).trim()).map((x) => (x as string).trim()) : [];
      if (ts.length === 0) {
        return { ok: false, error: "inputs.what.topics must contain at least one topic", status: 400 };
      }
      structuredWhat = { mode: "other", topics: ts, intent_key };
    }
    // Topics get filled in by loadGroundedFacts for programs/camps modes;
    // for 'other' we already have them. Placeholder for prompt-builder until
    // grounded facts resolve.
    topics = structuredWhat.topics ?? [];
  } else {
    return { ok: false, error: "inputs.what must be a string, array of strings, or structured object", status: 400 };
  }

  // Validate timing. Branches by mode:
  //   - mode='other' (one-off send) requires inputs.send_at
  //   - mode='programs'/'camps' (multi-touchpoint campaign) requires inputs.duration
  //   - legacy callers (no structured what) still require duration
  const isOneOff = structuredWhat?.mode === "other";
  let send_at: string | undefined;
  if (isOneOff) {
    if (typeof inputs.send_at !== "string" || !inputs.send_at.trim()) {
      return { ok: false, error: "inputs.send_at required for one-off (mode='other') campaigns", status: 400 };
    }
    send_at = inputs.send_at.trim();
  } else {
    if (typeof inputs.duration !== "string" || !inputs.duration.trim()) {
      return { ok: false, error: "inputs.duration required", status: 400 };
    }
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
  // Strip the internal `auto_derived` flag the client sets on auto-resolved
  // filters — it's not part of the server contract.
  const filter = who.filter as Record<string, unknown>;
  if (filter.auto_derived !== undefined) delete filter.auto_derived;

  // Validate operator_notes if present
  let operator_notes: string | undefined;
  if (inputs.operator_notes !== undefined && inputs.operator_notes !== null) {
    if (typeof inputs.operator_notes !== "string") {
      return { ok: false, error: "inputs.operator_notes must be a string", status: 400 };
    }
    const trimmed = inputs.operator_notes.trim().slice(0, 500);
    if (trimmed.length > 0) operator_notes = trimmed;
  }

  // Validate registration_url_override if present. Light validation: must look
  // URL-shaped. If they typed bare 'example.com', prepend https://.
  let registration_url_override: string | undefined;
  if (inputs.registration_url_override !== undefined && inputs.registration_url_override !== null) {
    if (typeof inputs.registration_url_override !== "string") {
      return { ok: false, error: "inputs.registration_url_override must be a string", status: 400 };
    }
    let raw = inputs.registration_url_override.trim().slice(0, 300);
    if (raw.length > 0) {
      if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
      try { new URL(raw); } catch {
        return { ok: false, error: "inputs.registration_url_override doesn't look like a valid URL", status: 400 };
      }
      registration_url_override = raw;
    }
  }

  // Validate promo if present
  let promo: PromoSettings | undefined;
  if (inputs.promo !== undefined && inputs.promo !== null) {
    if (typeof inputs.promo !== "object") {
      return { ok: false, error: "inputs.promo must be an object", status: 400 };
    }
    const p = inputs.promo as Record<string, unknown>;
    promo = {
      early_bird: Boolean(p.early_bird),
      vip_option: Boolean(p.vip_option),
      multi_camp_discount: Boolean(p.multi_camp_discount),
      code: typeof p.code === "string" && p.code.trim() ? p.code.trim() : null,
    };
  }

  return {
    ok: true,
    req: {
      organization_id: b.organization_id,
      inputs: {
        what: structuredWhat ?? topics,
        who: who as unknown as WhoInput,
        duration: (inputs.duration as string) || "",
        channels: inputs.channels as string[],
        promo,
        operator_notes,
        registration_url_override,
        send_at,
      },
    },
    derivedTopics: topics,
    structuredWhat,
  };
}

// ---------------------------------------------------------------------------
// Recipient resolution (parents audience)
// ---------------------------------------------------------------------------

// Expands a canonical school name to common short-form variants. Drives the
// auto-derive logic in resolveParents' school case so parents tagged
// "Johnson" in marketing_recipients still match a picked "Johnson Elementary"
// program_location.
//
// Pattern: strip common school-type suffixes. Operator-provided aliases ALWAYS
// take precedence; this is purely additive. Variants are only USED when they
// are unique org-wide (collision check in the caller) so two schools sharing
// a short form don't both claim a parent.
//
// Added 2026-06-02 after the FA26 send missed 147 parents at "Alameda" /
// "Cannady" because their marketing_recipients.school_name didn't exactly
// match program_locations.name ("Alameda Elementary", "Beatrice Morrow
// Cannady"). Generic across tenants — Johnson Elementary, Lincoln Middle
// School, etc. all derive the right short forms.
const SCHOOL_SUFFIX_PATTERNS: RegExp[] = [
  / Elementary School$/i,
  / Elementary$/i,
  / Middle School$/i,
  / Middle$/i,
  / High School$/i,
  / Charter School$/i,
  / Charter$/i,
  / Magnet School$/i,
  / Magnet$/i,
  / Academy$/i,
  / School$/i,
];
function expandSchoolNameVariants(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const variants = new Set<string>([trimmed]);
  for (const re of SCHOOL_SUFFIX_PATTERNS) {
    const stripped = trimmed.replace(re, "").trim();
    if (stripped && stripped !== trimmed) variants.add(stripped);
  }
  return [...variants];
}

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
      // Build the org-wide variant count so we only auto-derive short forms
      // that are UNIQUE org-wide. Without this guard, "Johnson Elementary"
      // and "Johnson Academy" would both auto-derive "Johnson" and a parent
      // tagged "Johnson" would be wrongly attributed to both schools.
      const { data: allLocs } = await supabase
        .from("program_locations")
        .select("name, name_aliases")
        .eq("organization_id", orgId);
      const orgWideVariantCount = new Map<string, number>();
      for (const l of (allLocs ?? []) as { name: string; name_aliases: string[] | null }[]) {
        const seenInThisLoc = new Set<string>();
        for (const n of [l.name, ...(l.name_aliases ?? [])]) {
          if (!n) continue;
          for (const v of expandSchoolNameVariants(n)) seenInThisLoc.add(v.toLowerCase());
        }
        for (const v of seenInThisLoc) orgWideVariantCount.set(v, (orgWideVariantCount.get(v) ?? 0) + 1);
      }
      // Build the picked-side variant set. Always include the operator's
      // explicit canonical + alias strings (those are the operator's intent
      // — never gate them). Additionally include any AUTO-derived variant
      // that is UNIQUE org-wide.
      const recipientNames = new Set<string>();
      for (const loc of locs as { name: string; name_aliases: string[] | null }[]) {
        const explicit = new Set<string>();
        if (loc.name) explicit.add(loc.name);
        for (const alias of loc.name_aliases ?? []) explicit.add(alias);
        for (const e of explicit) recipientNames.add(e);
        // Now auto-derive — only add variants unique org-wide.
        for (const e of explicit) {
          for (const v of expandSchoolNameVariants(e)) {
            if (explicit.has(v)) continue; // already added
            const count = orgWideVariantCount.get(v.toLowerCase()) ?? 0;
            if (count <= 1) recipientNames.add(v);
          }
        }
      }
      query = query.in("school_name", [...recipientNames]);
      const displayNames = (locs as { name: string }[]).map((l) => l.name).filter(Boolean);
      segmentSummary = `parents at ${joinWithAnd(displayNames)}`;
      break;
    }
    case "area": {
      // Multi-select 2026-06-02. Accept `areas: string[]` (new) OR `area: string`
      // (legacy single-area drafts).
      const areasRaw = Array.isArray(filter.areas)
        ? filter.areas.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
        : (typeof filter.area === "string" && filter.area.trim() ? [filter.area.trim()] : []);
      const areas = [...new Set(areasRaw.map((a) => a.trim()))];
      if (areas.length === 0) {
        return { ok: false, error: "filter.areas required for type=area", status: 400 };
      }
      query = query.in("geo_segment", areas);
      segmentSummary = areas.length === 1
        ? `parents in the ${areas[0]} area`
        : `parents across ${areas.length} areas (${joinWithAnd(areas)})`;
      break;
    }
    case "tag": {
      if (!Array.isArray(filter.tags) || filter.tags.length === 0) {
        return { ok: false, error: "filter.tags required for type=tag", status: 400 };
      }
      // Operator-applied labels (e.g. membership tier), set at contact import.
      // Targeting lives on `tags`; the `segments` column is reserved for system
      // markers (_internal_admin), so it is deliberately NOT used here.
      query = query.overlaps("tags", filter.tags);
      segmentSummary = `parents tagged ${joinWithAnd(filter.tags)}`;
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
// Curriculum grounding — match input topics against this org's curricula and
// inject the matched curriculum's facts into Ennie's prompt so she writes from
// real data instead of making things up.
// ---------------------------------------------------------------------------

type CurriculumRow = {
  id: string;
  name: string;
  short_description: string | null;
  age_range_min: number | null;
  age_range_max: number | null;
  session_count: number | null;
  format: string | null;
  themes: string[] | null;
  skills_overall: string[] | null;
  mid_term_skills: string[] | null;
  final_showcase: string | null;
};

type CurriculumMatch = {
  topic: string;
  match: CurriculumRow | null;
  score: number;
};

const CURRICULUM_MATCH_THRESHOLD = 0.4;
// Stop-words filtered before token matching. Generic enrichment-program words
// would otherwise inflate the overlap on every curriculum.
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "with", "by", "is",
  "camp", "class", "course", "program", "session", "edition", "kids", "kid",
  "after", "school", "afterschool",
]);

function tokenize(s: string): string[] {
  return s.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

async function loadCurricula(
  supabase: SupabaseClient,
  orgId: string,
): Promise<CurriculumRow[]> {
  const { data, error } = await supabase
    .from("curricula")
    .select("id, name, short_description, age_range_min, age_range_max, session_count, format, themes, skills_overall, mid_term_skills, final_showcase")
    .eq("organization_id", orgId)
    .limit(500);
  if (error) {
    console.error("curricula load failed:", error.message);
    return [];
  }
  return (data ?? []) as CurriculumRow[];
}

function scoreCurriculum(topic: string, c: CurriculumRow): number {
  const tTokens = new Set(tokenize(topic));
  if (tTokens.size === 0) return 0;

  const nameTokens = new Set(tokenize(c.name));
  const themeTokens = new Set<string>();
  for (const theme of c.themes ?? []) for (const tok of tokenize(theme)) themeTokens.add(tok);
  const descTokens = new Set(tokenize(c.short_description ?? ""));

  let nameMatch = 0;
  for (const tok of tTokens) if (nameTokens.has(tok)) nameMatch++;
  // Jaccard on names — denominator is union, so two single-word matches don't
  // dominate just because the curriculum name happens to be short.
  const denom = new Set([...tTokens, ...nameTokens]).size || 1;
  const nameScore = nameMatch / denom;

  let themeMatch = 0;
  for (const tok of tTokens) if (themeTokens.has(tok)) themeMatch++;
  const themeScore = themeMatch / tTokens.size;

  let descMatch = 0;
  for (const tok of tTokens) if (descTokens.has(tok)) descMatch++;
  const descScore = descMatch / tTokens.size;

  return nameScore + themeScore * 0.5 + descScore * 0.2;
}

function matchCurriculaToTopics(
  topics: string[],
  curricula: CurriculumRow[],
): CurriculumMatch[] {
  return topics.map((topic) => {
    if (curricula.length === 0) return { topic, match: null, score: 0 };
    let best: CurriculumRow | null = null;
    let bestScore = 0;
    for (const c of curricula) {
      const s = scoreCurriculum(topic, c);
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    return {
      topic,
      match: bestScore >= CURRICULUM_MATCH_THRESHOLD ? best : null,
      score: bestScore,
    };
  });
}

// ---------------------------------------------------------------------------
// Grounded facts (structured catalog picks)
// ---------------------------------------------------------------------------

// Rich curriculum detail loaded from the curricula table when the
// program/camp_session row has curriculum_id set. Lets Ennie write from
// the operator's uploaded skill list + final showcase instead of guessing.
type CurriculumDetail = {
  short_description: string | null;
  themes: string[] | null;
  skills_overall: string[] | null;
  final_showcase: string | null;
  format: string | null;
  age_range_min: number | null;
  age_range_max: number | null;
};

type ProgramFact = {
  id: string;
  curriculum: string;
  school_name: string;
  term: string;
  day_of_week: string;
  first_session_date: string | null;
  session_count: number | null;
  price_cents: number;
  early_bird_price_cents: number | null;
  early_bird_deadline: string | null;
  vip_price_cents: number | null;
  age_min: number | null;
  age_max: number | null;
  short_description: string | null;
  curriculum_detail: CurriculumDetail | null; // null when program isn't linked to a curriculum row
};

type CampFact = {
  id: string;
  curriculum_name: string;
  location_name: string;
  starts_on: string;
  ends_on: string;
  start_time: string;
  end_time: string;
  ages_min: number | null;
  ages_max: number | null;
  session_type: string;
  current_enrollment: number;
  week_num: number;
  curriculum_detail: CurriculumDetail | null;
};

type GroundedFacts = {
  programs: ProgramFact[];
  camps: CampFact[];
  topics: string[];
};

async function loadGroundedFacts(
  supabase: SupabaseClient,
  orgId: string,
  structured: StructuredWhat | null,
  fallbackTopics: string[],
): Promise<GroundedFacts> {
  if (!structured || structured.mode === "other") {
    return { programs: [], camps: [], topics: structured?.topics ?? fallbackTopics };
  }
  if (structured.mode === "programs" && (structured.program_ids?.length ?? 0) > 0) {
    const { data, error } = await supabase
      .from("programs")
      .select("id, term, curriculum, curriculum_id, day_of_week, first_session_date, session_count, price_cents, early_bird_price_cents, early_bird_deadline, vip_price_cents, age_min, age_max, short_description, program_locations(name)")
      .eq("organization_id", orgId)
      .neq("status", "cancelled")
      .in("id", structured.program_ids ?? []);
    if (error) {
      console.error("loadGroundedFacts programs error:", error.message);
      return { programs: [], camps: [], topics: fallbackTopics };
    }
    const rows = data ?? [];
    const curriculumDetails = await loadCurriculumDetails(
      supabase,
      orgId,
      rows.map((r: Record<string, unknown>) => r.curriculum_id as string | null).filter(Boolean) as string[],
    );
    const programs: ProgramFact[] = rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      curriculum: r.curriculum as string,
      school_name: ((r.program_locations as { name?: string } | null)?.name) ?? "(unknown school)",
      term: r.term as string,
      day_of_week: r.day_of_week as string,
      first_session_date: (r.first_session_date as string | null) ?? null,
      session_count: (r.session_count as number | null) ?? null,
      price_cents: r.price_cents as number,
      early_bird_price_cents: (r.early_bird_price_cents as number | null) ?? null,
      early_bird_deadline: (r.early_bird_deadline as string | null) ?? null,
      vip_price_cents: (r.vip_price_cents as number | null) ?? null,
      age_min: (r.age_min as number | null) ?? null,
      age_max: (r.age_max as number | null) ?? null,
      short_description: (r.short_description as string | null) ?? null,
      curriculum_detail: r.curriculum_id ? curriculumDetails.get(r.curriculum_id as string) ?? null : null,
    }));
    const topics = [...new Set(programs.map((p) => p.curriculum).filter(Boolean))];
    return { programs, camps: [], topics };
  }
  if (structured.mode === "camps" && (structured.camp_session_ids?.length ?? 0) > 0) {
    const { data, error } = await supabase
      .from("camp_sessions")
      .select("id, week_num, session_type, location_name, curriculum_name, curriculum_id, starts_on, ends_on, start_time, end_time, ages_min, ages_max, current_enrollment")
      .eq("organization_id", orgId)
      // Cancelled camps must not ground the AI copy — they're excluded from the
      // rendered email (marketing-touchpoint-send), so grounding on them would
      // write copy about camps that never appear.
      .neq("status", "cancelled")
      .in("id", structured.camp_session_ids ?? []);
    if (error) {
      console.error("loadGroundedFacts camps error:", error.message);
      return { programs: [], camps: [], topics: fallbackTopics };
    }
    const rows = data ?? [];
    const curriculumDetails = await loadCurriculumDetails(
      supabase,
      orgId,
      rows.map((r: Record<string, unknown>) => r.curriculum_id as string | null).filter(Boolean) as string[],
    );
    const camps: CampFact[] = rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      curriculum_name: r.curriculum_name as string,
      location_name: r.location_name as string,
      starts_on: r.starts_on as string,
      ends_on: r.ends_on as string,
      start_time: r.start_time as string,
      end_time: r.end_time as string,
      ages_min: (r.ages_min as number | null) ?? null,
      ages_max: (r.ages_max as number | null) ?? null,
      session_type: r.session_type as string,
      current_enrollment: (r.current_enrollment as number) ?? 0,
      week_num: r.week_num as number,
      curriculum_detail: r.curriculum_id ? curriculumDetails.get(r.curriculum_id as string) ?? null : null,
    }));
    const topics = [...new Set(camps.map((c) => c.curriculum_name).filter(Boolean))];
    return { programs: [], camps, topics };
  }
  return { programs: [], camps: [], topics: fallbackTopics };
}

// Bulk-load curriculum rows by id. Returns a map curriculum_id -> CurriculumDetail.
// Tolerates partial misses (an unlinked program just has null detail).
async function loadCurriculumDetails(
  supabase: SupabaseClient,
  orgId: string,
  ids: string[],
): Promise<Map<string, CurriculumDetail>> {
  const out = new Map<string, CurriculumDetail>();
  const uniqIds = [...new Set(ids)];
  if (uniqIds.length === 0) return out;
  const { data, error } = await supabase
    .from("curricula")
    .select("id, short_description, themes, skills_overall, final_showcase, format, age_range_min, age_range_max")
    .eq("organization_id", orgId)
    .in("id", uniqIds);
  if (error) {
    console.error("loadCurriculumDetails error:", error.message);
    return out;
  }
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    out.set(r.id as string, {
      short_description: (r.short_description as string | null) ?? null,
      themes: (r.themes as string[] | null) ?? null,
      skills_overall: (r.skills_overall as string[] | null) ?? null,
      final_showcase: (r.final_showcase as string | null) ?? null,
      format: (r.format as string | null) ?? null,
      age_range_min: (r.age_range_min as number | null) ?? null,
      age_range_max: (r.age_range_max as number | null) ?? null,
    });
  }
  return out;
}

// Append the uploaded curriculum's rich details to a program/camp's facts
// block. Operator put real effort into describing what kids actually do +
// what they learn — Ennie should weave from that, not invent activities.
function appendCurriculumDetail(parts: string[], d: CurriculumDetail) {
  if (d.short_description) parts.push(`- Curriculum description: ${d.short_description}`);
  if (d.themes && d.themes.length > 0) parts.push(`- Themes: ${d.themes.join(", ")}`);
  if (d.skills_overall && d.skills_overall.length > 0) {
    parts.push(`- Skills students develop:`);
    for (const s of d.skills_overall) parts.push(`    • ${s}`);
  }
  if (d.final_showcase) parts.push(`- Final showcase: ${d.final_showcase}`);
}

function formatGroundedFactsForPrompt(facts: GroundedFacts, promo: PromoSettings | undefined): string {
  if (facts.programs.length === 0 && facts.camps.length === 0) return "";

  // Group programs by curriculum so Ennie sees "5 schools running Toy Designers"
  // as one structured fact instead of 5 near-duplicate blocks.
  const programsByCurriculum = new Map<string, ProgramFact[]>();
  for (const p of facts.programs) {
    if (!programsByCurriculum.has(p.curriculum)) programsByCurriculum.set(p.curriculum, []);
    programsByCurriculum.get(p.curriculum)!.push(p);
  }

  const blocks: string[] = [];

  for (const [curriculum, rows] of programsByCurriculum) {
    const schoolList = [...new Set(rows.map((r) => r.school_name))];
    const r0 = rows[0];
    const parts = [`PROGRAM: "${curriculum}"`];
    parts.push(schoolList.length === 1
      ? `- Running at: ${schoolList[0]}`
      : `- Running at ${schoolList.length} schools: ${schoolList.join(", ")}`);
    if (r0.day_of_week) parts.push(`- Day of week: ${r0.day_of_week}`);
    if (r0.first_session_date) parts.push(`- First session: ${r0.first_session_date}`);
    if (r0.session_count) parts.push(`- Total sessions: ${r0.session_count}`);
    if (r0.age_min != null && r0.age_max != null) parts.push(`- Ages: ${r0.age_min}-${r0.age_max}`);
    parts.push(`- Regular price: $${(r0.price_cents / 100).toFixed(0)}`);
    if (r0.early_bird_price_cents && r0.early_bird_deadline) {
      const savings = (r0.price_cents - r0.early_bird_price_cents) / 100;
      parts.push(`- Early bird price: $${(r0.early_bird_price_cents / 100).toFixed(0)} (save $${savings.toFixed(0)}) - ends ${r0.early_bird_deadline}`);
    }
    if (r0.vip_price_cents) parts.push(`- VIP full-year price: $${(r0.vip_price_cents / 100).toFixed(0)}`);
    if (r0.short_description) parts.push(`- Short description (program row): ${r0.short_description}`);
    // Rich curriculum data — the operator's uploaded skill list + showcase.
    // This is the ground truth Ennie should draw from for "what kids actually do."
    if (r0.curriculum_detail) appendCurriculumDetail(parts, r0.curriculum_detail);
    blocks.push(parts.join("\n"));
  }

  const campsByCurriculum = new Map<string, CampFact[]>();
  for (const c of facts.camps) {
    if (!campsByCurriculum.has(c.curriculum_name)) campsByCurriculum.set(c.curriculum_name, []);
    campsByCurriculum.get(c.curriculum_name)!.push(c);
  }
  for (const [curriculum, rows] of campsByCurriculum) {
    const locations = [...new Set(rows.map((r) => r.location_name))];
    const sorted = [...rows].sort((a, b) => a.starts_on.localeCompare(b.starts_on));
    const dateRange = sorted.length > 1
      ? `${sorted[0].starts_on} to ${sorted[sorted.length - 1].ends_on}`
      : `${sorted[0].starts_on} to ${sorted[0].ends_on}`;
    const r0 = sorted[0];
    const parts = [`CAMP: "${curriculum}"`];
    parts.push(`- Locations: ${locations.join(", ")}`);
    parts.push(`- Dates: ${dateRange}`);
    parts.push(`- Daily hours: ${r0.start_time} to ${r0.end_time}`);
    if (r0.ages_min != null && r0.ages_max != null) parts.push(`- Ages: ${r0.ages_min}-${r0.ages_max}`);
    if (r0.session_type) parts.push(`- Type: ${r0.session_type}`);
    if (r0.curriculum_detail) appendCurriculumDetail(parts, r0.curriculum_detail);
    blocks.push(parts.join("\n"));
  }

  let result = `KNOWN PROGRAM DETAILS (factual ground-truth from the provider's actual scheduled catalog. Draw your specifics ONLY from these facts. Do not invent activities, skills, ages, session counts, prices, or dates beyond what is listed. Use approved merge tokens for per-recipient values like {{school}}, {{first_name}}; use these structured facts for content):\n\n${blocks.join("\n\n")}`;

  // Auto-detect active early-bird across picked programs even if promo wasn't
  // explicitly set — every FA26-style campaign benefits from leading with it.
  const hasActiveEarlyBird = facts.programs.some((p) => p.early_bird_price_cents && p.early_bird_deadline);
  const promoLines: string[] = [];
  if (promo?.early_bird || (hasActiveEarlyBird && promo?.early_bird !== false)) {
    promoLines.push(`- Lead with early-bird savings. Reference the deadline ({{early_bird_deadline}}) and savings amount ({{savings}}). Include 48h-before AND 24h-before reminder touchpoints.`);
  }
  if (promo?.vip_option) {
    // Tells Ennie to surface the VIP add-on via the {{vip_block}} token. The
    // detailed VIP rules + label/price/description come from
    // org.vip_offering (rendered in buildSystemPrompt). Per-school exclusion
    // (e.g. Cascadia doesn't offer it) happens at send time via the
    // {{vip_block}} resolver — Ennie doesn't need to worry about it here.
    promoLines.push(`- VIP/annual-pass upsell: place {{vip_block}} in at least one touchpoint (typically the kickoff and/or the 24h reminder). Do not write VIP language inline.`);
  }
  if (promo?.multi_camp_discount) {
    promoLines.push(`- Multi-camp bundle discount: reference {{promo_code}} (10% off when registering for 2+ camps). Mention in the kickoff and at least one mid-window touchpoint.`);
  }
  if (promo?.code) {
    promoLines.push(`- Custom promo code: reference {{promo_code}} = "${promo.code}". Explain the discount in plain language.`);
  }
  if (promoLines.length > 0) {
    result += `\n\nPROMO GUIDANCE:\n${promoLines.join("\n")}`;
  }

  return result;
}

function formatCurriculaForPrompt(matches: CurriculumMatch[]): string {
  const matchedBlocks: string[] = [];
  for (const m of matches) {
    if (!m.match) continue;
    const c = m.match;
    const parts = [`Topic "${m.topic}" matches curriculum "${c.name}":`];
    if (c.short_description) parts.push(`- Description: ${c.short_description}`);
    if (c.age_range_min != null && c.age_range_max != null) {
      parts.push(`- Age range: ${c.age_range_min}–${c.age_range_max}`);
    }
    if (c.session_count != null) parts.push(`- Session count: ${c.session_count}`);
    if (c.format) parts.push(`- Format: ${c.format}`);
    if (c.themes?.length) parts.push(`- Themes: ${c.themes.join(", ")}`);
    if (c.skills_overall?.length) {
      parts.push(`- Skills covered:`);
      for (const s of c.skills_overall) parts.push(`    • ${s}`);
    }
    if (c.final_showcase) parts.push(`- Final showcase: ${c.final_showcase}`);
    matchedBlocks.push(parts.join("\n"));
  }

  const unmatched = matches.filter((m) => !m.match).map((m) => m.topic);

  const sections: string[] = [];
  if (matchedBlocks.length > 0) {
    sections.push(
      `KNOWN PROGRAM DETAILS (factual ground-truth from the provider's curricula — draw your specifics ONLY from these. Do not invent activities, skills, ages, or session counts beyond what is listed here):\n\n${matchedBlocks.join("\n\n")}`,
    );
  }
  if (unmatched.length > 0) {
    sections.push(
      `NO CURRICULUM MATCH for these topics: ${unmatched.map((t) => `"${t}"`).join(", ")}. Write generically for these (no invented activities or outcomes), and list each one in notes_to_operator so the operator knows to either rename the topic to match an existing curriculum or upload one.`,
    );
  }
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Prompt + Claude call
// ---------------------------------------------------------------------------

// Approved merge tokens — must match docs/marketing-merge-tokens.md exactly.
// The mechanical-check pass rejects drafts that use a {{token}} not in this set.
const APPROVED_TOKENS = new Set([
  // per-recipient
  "first_name", "parent_name", "child_first_name", "child_last_name",
  "school", "city", "zip", "geo_segment", "unsubscribe_url",
  // per-org
  "org_name", "sender_name", "sender_email", "register_url", "register_button", "reply_to",
  "logo_url", "closer", "phone", "website",
  // per-program (computed from this recipient's school's programs)
  "savings", "early_bird_price", "regular_price", "early_bird_deadline",
  "first_session_date", "session_count", "day_of_week", "curriculum", "vip_price",
  // per-area camps (resolves to an HTML <ul> with each camp's name, venue, dates
  // in THIS recipient's area). The camps-mode equivalent of the per-school
  // program tokens for afterschool. Empty for afterschool campaigns.
  "camp_details",
  // per-campaign
  "topic", "topics_list", "promo_code", "promo_amount",
  // VIP/annual-pass block — resolves per recipient at send time. Empty when
  // the recipient's school is in org.vip_offering.excluded_location_ids or
  // when the org has no VIP offering enabled. Otherwise an HTML paragraph
  // built from the org's label/price_cents/description.
  "vip_block",
]);

// Extracts inputs.what.intent_key (set by the Q1 intent-first cards as of
// 2026-06-02). Returns null when the operator used the legacy/manual path —
// the INTENT-DRIVEN block emits a fall-back stanza in that case so Ennie
// still knows to defer to the duration-based cadence below.
function readIntentKey(inputs: DraftInputs): string | null {
  const w = inputs.what;
  if (!w || typeof w !== "object" || Array.isArray(w)) return null;
  const k = (w as StructuredWhat).intent_key;
  return typeof k === "string" && k.length > 0 ? k : null;
}

// INTENT-DRIVEN TONE/CADENCE — added 2026-06-02 with the Family Comms Q1
// intent-first redesign. The operator's intent click maps to a specific
// tone register + cadence shape. These rules OVERRIDE the duration-based
// cadence heuristics below when in conflict.
//
// Keys must stay in sync with src/pages/admin/marketing-v2/lib/intents.js
// AND the KNOWN_INTENTS set in parseRequest above.
function buildIntentBlock(inputs: DraftInputs): string {
  const key = readIntentKey(inputs);

  const header = `INTENT-DRIVEN TONE/CADENCE
The operator picked one of these intents from the Q1 intent-first surface (or used the manual catalog picker, intent_key=null). Apply the matching tone + cadence below.

THESE RULES OVERRIDE THE SCHEDULE-PLANNING BLOCK BELOW — including:
- the duration-based cadence heuristics
- the DEADLINE PROXIMITY rule (the one that collapses to "2 emails total" when a deadline falls in the first 7 days of the window)
- the "CAMPAIGN ENDS AT THE DEADLINE" rule

The operator picked the intent on purpose. If they wanted a deadline push, they would have clicked "last_call". When fill_remaining_seats or registration_opened is the intent and an early-bird deadline happens to be in the window, you DO NOT collapse the schedule around the deadline. You space the emails across the FULL chosen duration (see each intent's CADENCE rule). Mention the deadline naturally in one or two of the emails if it's real, but never let it hijack the cadence the operator chose.

Current intent: ${key ?? "(none — operator used manual picker; defer to duration heuristics below)"}`;

  // Per-intent guidance. Always include all of them so Ennie has the full
  // reference, but mark the active one explicitly so attention lands there.
  const sections: Record<string, string> = {
    registration_opened: `intent_key="registration_opened"  (fall registration just opened, term starts 4-13 weeks out)
  TONE: warm announcement, building anticipation. "Here's what your kid will be up to this year" energy. Sketch what they'll do; let parents imagine the year. Lead with possibility, not urgency. Subject line names the program / season — NOT the deadline.
  CADENCE: 3 emails across the FULL chosen duration. Space them roughly evenly (e.g. 1-month duration → emails at week 1, week 2-3, week 4). Email 1 (kickoff): announce, paint the picture. Email 2 (mid): highlight skills/showcase using curriculum_detail. Email 3 (close): soft register-now reminder. If promo.early_bird is true, mention {{early_bird_deadline}} naturally in 1-2 emails, but DO NOT collapse the schedule around the deadline — even if the EB deadline is only days away, hold the 3-email cadence across the full duration. The operator picked this intent (not last_call) — respect the long-view.`,
    last_call: `intent_key="last_call"  (a deadline is 7-14 days away — this campaign IS the deadline push)
  TONE: urgent, short, deadline-driven, but still warm. Lead with the deadline ("Last 5 days for early-bird" / "Class starts Tuesday"). Strip the exposition — parents reading this need to act, not learn about the program for the first time. Subject line owns the deadline.
  CADENCE: 2-3 emails total, clustered against the deadline. Email 1: kickoff that leads with the deadline. Email 2 (if 5+ days): 48h-before reminder. Email 3: 24h-before reminder. NEVER add mid-window topical content — the campaign window IS the deadline push.`,
    fill_remaining_seats: `intent_key="fill_remaining_seats"  (term starts 21+ days out, programs have room but aren't full)
  TONE: encouraging, not desperate. Lean on what makes the program worth joining (curriculum showcase, skills, the experience). Do NOT invent scarcity ("only 3 spots!") — only mention real numbers if the operator put them in operator_notes. "Still a few seats" is fine if the catalog facts show partial fill; otherwise just promote the program warmly. Subject line is about the program, NOT the deadline.
  CADENCE: 2-3 emails spaced ACROSS the operator's chosen duration. Roughly even spacing (e.g. 2-month duration → emails at week 1, week 4-5, week 8). DO NOT cluster against any early-bird deadline that happens to be in the window — the operator chose the long-view "fill seats" intent, not the deadline push (that's last_call). You may mention {{early_bird_deadline}} naturally in ONE email if it's real and well-timed, but the schedule itself is driven by the chosen duration, not the deadline. No 48h/24h deadline reminder emails.`,
    low_enrollment_push: `intent_key="low_enrollment_push"  (specific programs are below their minimum class size, start within 6 weeks)
  TONE: warm, intimate-class framing — "smaller group means more attention, more hands-on time per kid." Honest, not desperate. NEVER tell parents "we'll cancel if we don't fill" — that's an internal operator concern; the parent-facing framing is the intimacy of a small class.
  CADENCE: 2 emails spaced ACROSS the chosen duration. Kickoff with the small-class angle and what makes this program special. Final email near start. If start is within 7 days, just 1 email — and consider a "share with a friend whose kid might love this" closing line. Do NOT cluster against an early-bird deadline even if one is in the window — operator picked the small-class push, not the deadline push.`,
    other_schedule_change: `intent_key="other_schedule_change"  (one-off note: class moved, time shifted, cancelled session)
  TONE: factual, clear, calm. Lead with what changed. Tell parents what to do (or what NOT to do). No fluff, no marketing copy. Zero exclamation points unless the change is positive (e.g. "new date works for more families"). Remember the never-cancel rule — phrase as "isn't running this term" or "we've moved that to next week," not "cancelled."
  CADENCE: Single touchpoint — see ONE-OFF SEND MODE block above.`,
    other_photo_gallery: `intent_key="other_photo_gallery"  (one-off note: share photos / ad-hoc recap)
  TONE: celebratory, warm. "Look what your kid did this week." Reference the program by name; DON'T describe specific photos (you can't see them). Direct parents to the gallery via {{register_url}} (which the operator filled in with the gallery URL). One image's worth of words, not a recap essay.
  CADENCE: Single touchpoint.`,
    other_partner_event: `intent_key="other_partner_event"  (one-off note: cross-promote a partner's event)
  TONE: friendly invitation. Brief. Acknowledge it's a partner ("our friends at X are running…"). Don't over-pitch — parents trust your judgment, not a sales pitch. Set expectations honestly: this isn't a {{org_name}} program, it's a heads-up — use the {{org_name}} token, don't write the org name literally.
  CADENCE: Single touchpoint.`,
    other_free_form: `intent_key="other_free_form"  (operator typed their own topic in the free-form picker)
  TONE: take cues from the topic string + operator_notes. Lean warm if intent is unclear. Don't invent specifics that aren't grounded in the topic / notes.
  CADENCE: Single touchpoint.`,
  };

  const lines: string[] = [header, ""];
  for (const [k, body] of Object.entries(sections)) {
    const marker = k === key ? "▶ ACTIVE INTENT — apply this section's tone + cadence" : "";
    lines.push(marker ? `${marker}\n${body}` : body);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function buildSystemPrompt(
  org: OrgConfig,
  inputs: DraftInputs,
  segmentSummary: string,
  todayIso: string,
  orgTimezone: string,
  programDetailsBlock: string, // pre-rendered KNOWN PROGRAM DETAILS section — grounded facts OR fuzzy curriculum matches
  topicsForPrompt: string[],   // explicit topics list (derived from grounded facts when present, else from legacy what)
  cadenceSlots: CadenceSlot[], // server-computed fixed send schedule (empty for one-off sends); when non-empty the model writes to these exact slots and does NOT choose timing
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
  const audience = v.audience ?? "parents of K-5 kids enrolled or interested in enrichment programs";
  const tone = v.tone ?? "warm, positive, smart, casual — like a thoughtful friend";
  const avoid = v.do_not_use?.length ? `\nThis provider has asked you to AVOID these phrases (their explicit corrections beat your defaults): ${v.do_not_use.join(", ")}` : "";
  const favor = v.do_use?.length ? `\nThis provider reaches for these phrases — favor them when natural: ${v.do_use.join(", ")}` : "";
  const notes = v.additional_notes ? `\nProvider notes: ${v.additional_notes}` : "";

  const topics = topicsForPrompt;
  const topicLine = topics.length === 1
    ? `Campaign topic: "${topics[0]}"`
    : `Campaign topics (weave them across the schedule — each touchpoint covers one or more; tag each touchpoint with which topics it covers): ${topics.map((t) => `"${t}"`).join(", ")}`;

  const channelNote = inputs.channels.length > 1
    ? `Channels requested: ${inputs.channels.join(", ")}. v1 generates email touchpoints only; flyer + social are placeholders.`
    : "Channels: email only in v1.";

  const tokenList = `Approved merge tokens (use these for ALL specifics):
- Per-recipient: {{first_name}}, {{parent_name}}, {{child_first_name}}, {{child_last_name}}, {{school}}, {{city}}, {{zip}}, {{geo_segment}}, {{unsubscribe_url}}
- Per-org: {{org_name}}, {{sender_name}}, {{sender_email}}, {{register_url}}, {{register_button}} (branded registration button — see CTA rule), {{reply_to}}, {{logo_url}}, {{closer}}, {{phone}}, {{website}}
- Per-program (pulled per recipient's school): {{savings}}, {{early_bird_price}}, {{regular_price}}, {{early_bird_deadline}}, {{first_session_date}}, {{session_count}}, {{day_of_week}}, {{curriculum}}, {{vip_price}}
- Per-area camp list (pulled per recipient's area, camps mode only): {{camp_details}} — an HTML <ul> with each camp's name, venue, and date range in this recipient's area. Use this when the operator wants parents to see specific venues + dates per camp (almost always — it's what helps them pick a camp to register for).
- VIP / annual-pass block (whole paragraph, per-recipient suppression): {{vip_block}} — see "VIP / ANNUAL-PASS BLOCK" rules below
- Per-campaign: {{topic}}, {{topics_list}}, {{promo_code}}, {{promo_amount}}

If a {{token}} you'd want doesn't appear in this list, do NOT invent one. Write around it generically.`;

  const personaBlock = `You are Ennie, the helper that runs across Enrops — a platform that helps after-school enrichment providers run their programs. You have two jobs across the platform: talking with operators inside the app, and writing on their behalf to parents, instructors, and partners. Right now you're doing the writing job: drafting emails on behalf of ${sender} to parents of K-5 kids.

WHO YOU ARE
You're warm, positive, smart, and conversational — with real personality. You believe enrichment programs make kids' lives better, and that belief is the floor under everything you write. You're not a marketer and you're not a cheerleader, but you're not flat either.

Right now you're in your parent-writing register. The warmth dial is turned up. Parents make signup decisions emotionally for their kids, so lean into that — excitement, possibility, the joy of seeing a kid light up about something new, the buzz of coming home full of stories. Talk like someone who has watched it happen and wants the parent to see it too. A parent email that's all facts won't move a parent; vibe and emotion do real work here.

What you do not do: manufacture fear, FOMO, or anxiety about kids "falling behind." Mild urgency around real deadlines is fine ("early-bird ends Friday") — manufactured scarcity ("only 3 spots left!") is not.

You speak plain English. No tech jargon, no industry jargon, no marketer-speak (avoid "leverage", "elevate", "unlock", "drive engagement", "supercharge", "next-level", "game-changing", "activate your"). If you wouldn't say it to a friend over coffee, don't write it in an email.

Emojis are part of your voice, not decoration. Reach for them when they fit — one or two in a subject line, a sprinkle in the body. They give the email warmth before the parent has read a word. Never decorative rows of them.

WHO YOU'RE WRITING TO
Audience: ${audience}.
Tone: ${tone}.${avoid}${favor}${notes}

THE HARD RULE: USE TOKENS FOR SPECIFICS AND GROUND-TRUTH FOR EVERYTHING ELSE
You MUST use the approved merge tokens for anything specific. You MUST NOT invent specifics.

- Never write a dollar amount inline. Use {{early_bird_price}}, {{regular_price}}, {{savings}}, or {{promo_amount}}.
- Never write a specific date, day of week, or session count. Use {{early_bird_deadline}} or {{first_session_date}}, or write around it ("registration is open now", "before the deadline").
- Never write a parent's name, child's name, or school name. Use {{first_name}}, {{child_first_name}}, {{school}}.
- Never invent a promo code. Only reference {{promo_code}} if the operator's topics explicitly mention one.
- Never invent a curriculum name, instructor name, location detail, or program beyond what the operator typed.
- Never cite statistics ("200 families joined last year", "92% of kids improved"). Don't fabricate social proof.
- When KNOWN PROGRAM DETAILS are provided below, draw your specifics ONLY from those facts. Don't add activities, skills, ages, or session counts that aren't listed there. If a topic has no curriculum match, write generically (no invented bullets) and name the topic in notes_to_operator so the operator knows you didn't have facts to work from.

If you need a specific fact and there's no token, write generically ("our upcoming session", "more details on the registration page"). Generic copy is always better than invented copy.

CAMPS MODE — PER-AREA PERSONALIZATION (HARD RULE when the picks are camps)
Camps work just like afterschool, but the per-recipient unit is AREA, not school. Each parent sees the camps happening in THEIR area ({{geo_segment}}). The renderer matches the camps' location district to the recipient's geo_segment.

Tokens that work for camps (same names as afterschool, different source):
- {{camp_details}}  — PREFERRED. An HTML <ul> with each camp's name, venue, and date range in THIS recipient's area. Use this whenever the body needs to show parents what camps are happening + where + when. Example output for a Hillsboro parent: "<ul><li><strong>LEGO Superheroes</strong> at Hillsboro Tyson Rec Center (Jul 6–10)</li><li><strong>Next Level Robotics: Busy Cities</strong> at Hillsboro Tyson Rec Center (Jul 13–17)</li></ul>". Wrap in any context you want — e.g. "Here's what's coming to {{geo_segment}}: {{camp_details}}".
- {{curriculum}}  — joined list of camp names without venues/dates (use when you want an inline name reference, not a full breakdown).
- {{first_session_date}}  — earliest start date among the camps in THIS recipient's area.
- {{geo_segment}}  — the recipient's city/area (e.g. "Hillsboro").
- Per-recipient names: {{first_name}}, {{parent_name}}, {{child_first_name}}, {{child_last_name}}.
- Per-org / per-campaign: {{org_name}}, {{sender_name}}, {{register_url}}, {{unsubscribe_url}}, {{vip_block}} (if applicable), {{topic}}, {{topics_list}}.

Tokens that DO NOT work for camps (leave empty — emitting them gives broken copy):
- {{school}}  — camp parents have kids at many schools; the camp is a destination, not their school. Use {{geo_segment}} ("camps in {{geo_segment}}", "this summer in {{geo_segment}}") instead.
- {{day_of_week}}, {{session_count}}, {{regular_price}}, {{early_bird_price}}, {{early_bird_deadline}}, {{savings}}, {{vip_price}}  — camps don't share these structurally with the afterschool program model. Write any price/dates inline FROM KNOWN PROGRAM DETAILS if you need them — but most camp copy doesn't.

NEVER say "your school", "their school", or "your kid's school" in camps copy.

GOOD examples for camps:
- "Here's what's coming up in {{geo_segment}}:\n{{camp_details}}\nPick a week that works on {{register_url}}." (preferred — full details visible)
- "Summer camps in {{geo_segment}} are here:\n{{camp_details}}"
- Use {{curriculum}} alone only for an inline name mention: "{{curriculum}} are happening near you this summer — full lineup below.\n{{camp_details}}"
- Subject lines: "Summer camps in {{geo_segment}} — small groups, big fun" or "{{curriculum}} in {{geo_segment}}" — names + city work here; details belong in body.

EACH PARENT SEES THEIR OWN SCHOOL'S PROGRAM — NOT THE FULL LIST (afterschool mode only)
When the campaign spans many schools that each run their own program, the BODY of each touchpoint refers to "their program" in the SINGULAR, using {{curriculum}}, {{first_session_date}}, {{day_of_week}}, {{savings}}, {{early_bird_price}}, {{early_bird_deadline}}. The send pipeline fills those tokens with the program running at THIS recipient's school. DO NOT enumerate the full list of curricula in the body. A parent at Stoller should read about Toy Designers at Stoller — not also about Robotics at Bonny Slope and Minecraft at Beverly Cleary. That makes the email feel like a mass blast; we want it to feel like it's about their kid.

USE THE UPLOADED CURRICULUM DATA — DON'T INVENT ACTIVITIES
When a PROGRAM or CAMP block in KNOWN PROGRAM DETAILS includes any of:
- "Curriculum description: ..." (richer than the row's short_description),
- "Themes: ...",
- "Skills students develop:" (a bulleted list),
- "Final showcase: ...",
…that's the operator's uploaded curriculum file — the ground truth for what kids actually do and what they walk away with. Draw your specifics from those bullets and that showcase paragraph. Reference one or two skills naturally ("they learn loops and debugging" not "they learn coding"). Mention the showcase as a real moment ("they finish with a Playtest Arcade where classmates rotate through and play each other's games"). If a parent reads "they learn computational thinking and break problems into smaller steps," they trust you. If they read "kids design, code, and build," they don't.
Do NOT invent skills, activities, or outcomes that aren't in the curriculum data. If a program block lacks these details (no curriculum_id linked), write generically (no invented bullets) and flag in notes_to_operator that "X of Y picked programs are missing curriculum details — uploading them would let Ennie write more specifically."

USE THE PARENT'S AREA WHEN THE CAMPAIGN IS AREA-FILTERED
When the 'Sending to:' line in this prompt names ANY area(s) (e.g. "parents in Hillsboro" OR "parents across 3 areas (Hillsboro, Beaverton, Cornelius)"), every individual recipient lives in ONE of those areas. The body MUST use {{geo_segment}} to talk about "their area," never enumerate the full area list:
- Each parent sees ONE area name — their own — via the {{geo_segment}} token. Resolved per-recipient at send time.
- BAD (multi-area campaigns): "Camps coming to Hillsboro, Beaverton, and Cornelius this summer" — a Hillsboro parent doesn't care about Beaverton, and listing all three makes the email feel like a mass blast.
- GOOD: "Camps coming to {{geo_segment}} this summer", "Your kid doesn't have to leave {{geo_segment}} for great enrichment", "Local to {{geo_segment}}".
- Do NOT write any area name literally — always use {{geo_segment}}. If the operator changes the area filter later, the copy still works without a redraft.
- Subject lines may use {{geo_segment}} but don't have to ("Camps near you" works subject-line-wide).

WHEN CURRICULA SPAN MULTIPLE THEMES — STAY UNIVERSAL (HARD RULE)
Look at the picked programs in KNOWN PROGRAM DETAILS. If they span multiple themes (e.g. coding, robotics, LEGO, game design, art, science), the BODY must use UNIVERSAL language that fits any of them.

BANNED in the body as standalone verbs/adjectives (cross-theme campaigns): "code", "coding", "build", "building", "design", "designing", "robotics", "engineer", "engineering", "LEGO", "Minecraft", "Pokémon", "Mario", "art", "art-making". These words may ONLY appear via the {{curriculum}} token (which IS the program name) — never as part of body prose, never in a list like "kids design, kids code, kids build", never as adjectives like "hands-on building" or "creative coding."

This rule WINS over brand_voice.do_use entries when curricula span themes. If the operator's brand_voice.do_use favors a banned phrase (e.g. "kids code"), that preference was set when the catalog was narrower — IGNORE it for this campaign. Don't include those phrases in cross-theme bodies even if the operator favorited them, because they'll read wrong for the parents at schools running non-coding programs. Note this in notes_to_operator: "Your brand voice favors 'kids code / kids build' — I skipped those for this campaign because your picked curricula span [N] themes and those phrases would read wrong for parents at non-coding programs. Update your voice rules in Settings to drop those for cross-theme campaigns."

UNIVERSAL replacements (use these instead):
- Instead of "kids code" / "kids build" / "kids design" → "kids create", "kids make", "kids tinker", "kids explore", "kids discover"
- Instead of "hands-on building" / "hands-on coding" → "hands-on projects", "hands-on time with real tools", "hands-on challenges"
- Instead of "they design, code, build" → "they tackle real projects", "they make something they're proud of", "they solve creative challenges"

BAD examples (these are violations — do NOT write):
- "Your student gets {{session_count}} sessions of hands-on building, coding, and creating…"
- "Each week kids design, kids code, kids build…"
- "They'll work with real tools, tackle creative challenges, and come home with stories" — this one is FINE because there are no theme-specific verbs.

GOOD examples:
- "Every week your student dives into {{curriculum}} — hands-on projects, real tools, and the kind of 'I made that' moments they're talking about at dinner."
- "Your student gets {{session_count}} sessions of creative challenges and real-tool projects."

If all picked curricula share a single clear theme (e.g. all 8 are robotics), you may use that theme word freely. Verify by looking at the curricula list in KNOWN PROGRAM DETAILS — if the names cover multiple themes, stay universal.
- BODY: treat as if it's about one program — theirs. Use {{curriculum}} where you'd name a program. Use {{school}} where you'd name a school. Never reach for "across our 24 schools" or "all 8 programs" or similar.
- SUBJECT: can be campaign-wide and not name a specific curriculum ("Fall programs are here", "Early bird ends Friday"). Doesn't need to use {{curriculum}} but can.
- NOTES_TO_OPERATOR: this is where you list "you picked 8 curricula across 24 schools, here's the breakdown" if useful — that's operator-facing, not parent-facing. The body must not echo that breakdown.

NOTES_TO_OPERATOR — HARD LIMITS (this is operator-facing; they don't have time to read a wall)
- MAX 2 sentences. Empty string is encouraged when there's nothing genuinely surprising.
- DO NOT recap what the operator just picked. They know which programs and schools they chose. Never list them back ("the segment includes Forest Park, Art Rutkin, ..."). Never say "X runs Y" — they configured the catalog.
- DO NOT fabricate merge-token concerns. The audience resolver and grounding already verified the data. {{school}} renders from each recipient's row.
- DO NOT offer interactions you can't follow up on. There is no chat back to you mid-draft. Phrases like "let me know if you want X" or "tell me if you'd prefer Y" go nowhere. If the operator wants something different, they re-draft with operator_notes.
- DO use notes_to_operator for: a deadline being closer than the picked duration; a topic with no curriculum match (mode='other'); a genuine assumption you made that the operator might want to challenge.

MULTI-PROGRAM SCHOOLS — TRUST THE TOKEN SYSTEM, DON'T FLAG
When a school in the audience runs multiple programs in this campaign (e.g. Beatrice Morrow Cannady runs both LEGO Brickopolis Architects and Robotics Builders), a parent at that school gets ONE email that mentions BOTH of their school's programs. The token system joins {{curriculum}} naturally as a list ("LEGO Brickopolis Architects and Robotics Builders") and the body still reads cleanly. Do NOT raise this as a decision for the operator. Do NOT propose "school-specific sends" or "splitting it out." Write the body once, normally, and let the per-recipient token resolution handle it.

CURRICULUM TOKEN FORMATTING — DO NOT BOLD
Do NOT wrap {{curriculum}} in <strong>...</strong> or other emphasis tags. Reason: when a recipient is at a multi-program school (Cannady today, others tomorrow), {{curriculum}} resolves to "Class A and Class B" — wrapping the whole thing in bold makes the "and" bold too, which reads like a single program name to parents. Plain {{curriculum}} reads correctly in both single- and multi-program cases. The curriculum names are already long proper nouns; they don't need typographic emphasis to land.

OPERATOR_NOTES INPUT
If the operator typed something into OPERATOR NOTES FOR THIS CAMPAIGN, those are their explicit instructions — treat as ground truth and weave them in. You don't need to ask follow-up questions about them; they wrote what they meant.

PURCHASABLE ADD-ONS ARE ON THE REGISTRATION PAGE
When you mention an add-on or promo, assume it's selectable at checkout on the registration page — that's the default for any enrichment provider unless the operator explicitly says otherwise.
- DO: "Look for the [offering name] option when you register…", "Add it at registration for the listed price…"
- DO NOT: "Ask about our X" / "Inquire about" / "Contact us for details on" / "Reach out to learn more about" — these imply a separate sales process. Operators don't run sales calls. The registration page IS the buying surface.
- If the add-on isn't actually selectable inline (operator said so in operator_notes), use the directed language they specified.

VIP / ANNUAL-PASS BLOCK
${org.vip_offering?.enabled
  ? `This provider offers an annual pass labeled "${org.vip_offering.label ?? "VIP"}"${org.vip_offering.price_cents ? ` at $${(org.vip_offering.price_cents / 100).toFixed(0)}/year` : ""}. Description (provider's words): "${org.vip_offering.description ?? ""}".
- Do NOT inline the VIP description yourself. Place the {{vip_block}} merge token where you want the VIP paragraph to appear. The send-time resolver expands it into the provider's pre-written paragraph for recipients whose school offers it, and renders it EMPTY for recipients at schools where VIP isn't offered (so the same email body works for everyone). Place {{vip_block}} on its own line in the body_html (e.g. <p>{{vip_block}}</p> — but the resolver also handles bare placement gracefully).
- Only place {{vip_block}} ONCE per touchpoint, not in subject lines. A natural spot is just before the register CTA in the kickoff and the 24h-reminder.
- Do NOT write your own VIP language ("Want the full year?" / "Lock it in" / "Add the annual pass" / etc.) anywhere in the body — the resolver handles voice + price + suppression as one block. If you write VIP prose inline, parents at excluded schools will see a CTA they can't act on.`
  : `This provider has NO active annual-pass / VIP offering. Do NOT invent one. Do NOT use {{vip_block}}. Do NOT mention an annual pass, year-long bundle, multi-term pre-purchase, or any equivalent.`
}

THINGS YOU SHOULD NEVER CLAIM
- That a program is "selling fast" or "almost full" (unless the operator said so).
- That it's "award-winning," "accredited," or "the most popular" anything.
- That a child will achieve a specific outcome ("your child will master Python"). Describe what they'll do, not what they'll become.
- That this program is better than another provider's.
- Never use cancellation language with parents. If a program isn't running, say "isn't running this term" or "we've moved that to next session."
- That kids use "real tools" / "hands-on tools" / specific materials (clay, wood, soldering, etc.) UNLESS the curriculum_detail or short_description for THIS curriculum names them. Many curricula are software-based (Minecraft, Block Coding, etc.) — claiming "real tools" there is wrong.
- That "every session wraps with a finished project" or "every week they take home something they made" or "every camp wraps with a showcase where your kid gets to walk you through what they made". Curricula vary: some are session-wrapped, many are multi-week builds where the deliverable is the FINAL showcase, not per-session, and SOME HAVE NO SHOWCASE AT ALL. For CAMPS specifically: do NOT generalize "every camp" or "all our camps" — when the campaign spans multiple camps from different curricula (which is the common case for multi-area camp sends), the camps differ in format. Only claim a showcase / final project / demo day when the relevant curriculum_detail explicitly names one, and even then phrase it as "your kid's camp wraps with…" (singular, scoped to their camp). Default safer phrasing: "they'll come home with stories" / "by the end they'll have something to show" / "they'll be able to walk you through what they built".
- Specifics about pickup/dropoff, snacks, materials brought by kids, holiday closures, instructor names, photos, past success stories — none of these are in the grounded facts unless the operator put them in operator_notes. Don't invent them.

GROUNDED LANGUAGE TEST (apply before writing each sentence)
Before any concrete claim about what kids do, make, use, or take home: can you point to the exact line in KNOWN PROGRAM DETAILS / curriculum_detail / operator_notes / brand_voice that backs it up? If no, stay aspirational ("the kind of project kids talk about at dinner", "creative challenges that have them buzzing") instead of specific ("they'll solder LEDs and take a finished circuit home"). Aspirational is honest; specifics-without-data is invention.

TENANT ISOLATION
You never reference any other provider's data, copy, instructors, parents, or numbers when working for ${sender}. No "most providers do X" comparisons. ${sender} is the only tenant you're thinking about right now.

VOICE DETAILS
- NEVER use em dashes (—) or en dashes (–). They read as AI-written and are an instant tell. Use a comma, a period, a colon, or a plain hyphen (-) instead. For ranges write "9am-3pm" with a plain hyphen.
- One exclamation point per email max; zero in subject lines unless one really earns it.
- Address the parent, not the kid. "Your student" not "you."
- Subject line under 60 characters; no all-caps; no clickbait.
- Preheader (first ~80 chars of body) extends the subject, never repeats it.
- Match length to purpose: a kickoff can be substantial — paint the picture. A 24-hour reminder is three or four sentences, but still warm, not curt.
- Leave the parent feeling something positive after reading: curiosity, anticipation, that "this sounds like my kid" hum. Don't just inform — connect.
- SIGN-OFF: end the body content with a sign-off line using ONLY {{sender_name}} on its own paragraph (e.g. "- {{sender_name}}" with a plain hyphen, or just {{sender_name}} on its own line — never an em dash). Do NOT append {{org_name}} after the sender — tenants frequently set their sender_name as "First Last @ Org" so the org is already conveyed; appending it again duplicates the provider name in the closer. Skip the comma + org_name.
- End every email body with the closer line on its own paragraph AFTER the sign-off: "${v.closer ?? "(no closer set)"}" — only if a closer is set, otherwise omit.

${tokenList}

${buildIntentBlock(inputs)}

SCHEDULE-PLANNING RULES (you plan a multi-touchpoint sequence, not a single send)
- DEFAULT SEND TIMES (org timezone ${orgTimezone}): Tuesday/Thursday 10am for regular sends. Deadline-day reminders at 7am. Welcome notes Monday 9am. NEVER Friday afternoons or weekends.
- THROTTLE: this org caps at 1 email per parent per 10 days. Space consecutive emails at least 6 days apart (deadline reminders are exempt — see below).

- DEADLINE PROXIMITY (this rule beats the duration-based cadence below):
  - If a deadline falls within the FIRST 7 DAYS of the campaign window, the campaign IS the deadline push. Plan **2 emails total**: an announce/kickoff that leads with the deadline, and a final reminder 24 hours before the deadline. Skip "mid-window" and "final-call" touchpoints — there is no room, and you would burn the list with content the operator did not ask for.
  - If a deadline falls 8–14 DAYS into the window, plan 3 emails: announce, then a 48-hours-before reminder, then a 24-hours-before reminder. Still no mid-window topical sends.
  - If a deadline is 14+ DAYS out, use the full duration-based cadence below AND include both 48h and 24h reminders before the deadline.

- CAMPAIGN ENDS AT THE DEADLINE: when the user-requested duration extends past the deadline, the campaign still ENDS at the deadline reminder. Do not plan post-deadline topical sends — the operator picked the deadline-driven campaign, not a general-content month. If they want post-deadline thank-you / recap sends, they will run a separate campaign for that.

PER-TENANT NOTES
If the tenant has refined your voice over time (their "Ennie's notes" file), those corrections beat your defaults. None supplied yet for this draft.`;

  // Multi-touchpoint timing is now SERVER-COMPUTED (computeCadenceSlots). When
  // we have a fixed schedule, hand the model the exact slots and forbid it from
  // choosing scheduled_at. Fall back to the old prose heuristics only if the
  // server produced no slots (defensive — shouldn't happen for a valid campaign).
  const useFixedCadence = !inputs.send_at && cadenceSlots.length > 0;
  const cadenceGuidance = useFixedCadence
    ? formatCadenceForPrompt(cadenceSlots)
    : `CADENCE HEURISTICS by duration:
- "2 weeks": 2-3 emails. Kickoff + 1 mid + 1 final-call if a deadline lives in-window.
- "1 month": 4-6 emails. Kickoff, mid-window, plus 48h + 24h reminders for each deadline. Add a "thanks for registering" send if appropriate at the end.
- "2 months": 5-7 emails. Slower build with longer gaps between general sends; ALWAYS the 48h + 24h reminders near deadlines.
- "custom": pick a reasonable cadence with 6-10 day spacing.`;

  const curriculumBlock = programDetailsBlock;

  // Operator notes — free-text context the operator typed in Q4. Treated as
  // ground truth and overrides Ennie's defaults when in conflict. Empty when
  // the operator left the textarea blank.
  const operatorNotesBlock = inputs.operator_notes
    ? `OPERATOR NOTES FOR THIS CAMPAIGN (these override your defaults when in conflict — treat as ground truth for this draft):\n${inputs.operator_notes}`
    : "";

  // Per-campaign link override. The operator field is labeled "Link to
  // include" (generic — could be registration, photo gallery, rebook tool,
  // makeup form, updated schedule, etc.). Ennie uses context (topic +
  // operator_notes) to decide what to CALL the link in the copy.
  // The token is named {{register_url}} for legacy reasons but Ennie treats
  // it as the campaign's CTA destination, whatever that is.
  const registrationUrlBlock = inputs.registration_url_override
    ? `LINK TO INCLUDE IN THIS CAMPAIGN: ${inputs.registration_url_override}
{{register_url}} resolves to this URL at send time. Write {{register_url}} where you want the link — do not paste the URL inline.
This URL is NOT always a registration page. Use context to decide what to call it:
- A registration page (Squarespace, Enrops, partner): "Register here", "Grab your spot", "Sign up"
- A photo gallery: "See the photos", "View this week's photos"
- A rebook / makeup form: "Reschedule", "Book a makeup class"
- An updated schedule PDF or page: "See the new schedule"
- A feedback / survey form: "Share your thoughts", "Quick survey"
Look at the campaign topic, operator_notes, and what's happening (cancellation? recap? new program?) to pick the right framing. When in doubt, "More info" works for any link type.`
    : "";

  // The registration CTA renders as a branded button via {{register_button}}.
  const ctaButtonBlock = `REGISTRATION CTA BUTTON:
For the main "register" / "sign up" call-to-action, put {{register_button}} on its OWN line where the button should go (usually near the end, right after the pitch). It renders as a branded "Register now" button — do NOT write your own button label and do NOT paste the raw URL as visible text.
{{register_url}} points at the same destination as a plain text link — use it ONLY when the link is NOT a registration page (e.g. a photo gallery, survey, or updated schedule in a recap), and then write real link text, never the bare URL. For a normal "go register" campaign, use {{register_button}}.`;

  // One-off mode (mode='other' with send_at) -> 1 touchpoint at exact time.
  // Multi-touchpoint mode (programs/camps with duration) -> Ennie spaces the cadence.
  const isOneOff = !!inputs.send_at;
  const oneOffBlock = isOneOff
    ? `ONE-OFF SEND MODE (overrides cadence rules below):
This is a SINGLE-EMAIL send, not a multi-touchpoint campaign. The operator wants ONE touchpoint at a specific moment.
- Produce EXACTLY 1 touchpoint in the output. No kickoff/mid/reminder cadence.
- Set scheduled_at to: ${resolveSendAtForPrompt(inputs.send_at!, orgTimezone)}
- The body should be a single direct note. Use the operator's typed topic + operator_notes as the source. Common cases: weather cancellation, schedule change, recap / thank-you, holiday greeting.
- Subject line should be clear and action-oriented for urgent sends ("Class cancelled tomorrow — Tuesday Sept 9") and warm for relational sends ("Thanks for an amazing fall, families").
- Do NOT generate 48h/24h reminders. Do NOT enumerate program details unless the operator wrote them in notes. Do NOT add a kickoff/final-call structure.
- Do NOT mention curricula or specific programs unless the operator wrote that in operator_notes. A "thank-you" or "Special announcement" with no other input means you write generically and warmly — but DO flag it.

THIN INPUT — TELL THE OPERATOR
If the operator's topic + operator_notes give you very little to work with (e.g. just "thank you" with no details), do NOT pad the body with invented specifics. Write a short warm generic note AND put this in notes_to_operator:
  "Not much to go on — a generic [thank-you / announcement / etc.] is what I wrote. For a stronger message, add details in the operator_notes field (a specific moment to celebrate, what's exciting about the news, etc.) and re-draft."
This is more useful to the operator than guessing or apologizing for the lack of specifics in the body.`
    : "";

  return [
    personaBlock,
    ``,
    `Today is: ${todayIso} (org timezone: ${orgTimezone})`,
    topicLine,
    `Sending to: ${segmentSummary}`,
    isOneOff ? `One-off send time: ${inputs.send_at}` : `Campaign duration: "${inputs.duration}" — count from today.`,
    channelNote,
    ``,
    curriculumBlock,
    operatorNotesBlock ? `\n${operatorNotesBlock}` : ``,
    registrationUrlBlock ? `\n${registrationUrlBlock}` : ``,
    `\n${ctaButtonBlock}`,
    oneOffBlock ? `\n${oneOffBlock}` : ``,
    ``,
    isOneOff ? `` : cadenceGuidance,
    ``,
    `OUTPUT FORMAT:`,
    `Return ONLY a single JSON object (no markdown fences). Schema:`,
    `{`,
    `  "schedule_summary": "<one short sentence describing the overall plan>",`,
    `  "notes_to_operator": "<optional: anything ambiguous, missing, or that the operator should know. Empty string if nothing to flag.>",`,
    `  "touchpoints": [`,
    `    {`,
    `      "order_index": 0,`,
    `      "type": "email",`,
    `      "label": "<kickoff | mid-window | 48h-promo | 24h-promo | 48h-reg-close | 24h-reg-close | final-call | thanks>",`,
    `      "scheduled_at": "<ISO 8601 with timezone offset, e.g. 2026-05-21T10:00:00-07:00>",`,
    `      "subject": "<= 60 chars, uses tokens for any specifics>",`,
    `      "body_html": "<clean HTML, no wrappers, uses {{first_name}} and {{school}} merge tokens>",`,
    `      "topics": ["<which input topics this touchpoint covers; subset of: ${topics.map((t) => `\\"${t}\\"`).join(", ")}>"]`,
    `    }`,
    `  ]`,
    `}`,
    ``,
    `IMPORTANT:`,
    useFixedCadence
      ? `- Produce EXACTLY ${cadenceSlots.length} touchpoints — one for each slot in the FIXED SEND SCHEDULE above, in the same order. order_index 0 = the first slot, and so on, contiguous.`
      : `- Generate 2-7 touchpoints depending on duration (see cadence heuristics).`,
    `- order_index starts at 0 and is contiguous.`,
    `- Do NOT include a body_text field. Write only body_html; the system generates the plain-text version from your HTML.`,
    useFixedCadence
      ? `- The SERVER sets the timing. Do NOT choose scheduled_at yourself — echo the slot's date if you like, but it will be overwritten with the exact send time from the FIXED SEND SCHEDULE.`
      : `- scheduled_at must be in the future (after today) and respect default send times.`,
    useFixedCadence
      ? `- Match each touchpoint's tone to its slot purpose: a "kickoff" is fuller and paints the picture; a 24h reminder is three or four sentences, urgent but warm; a 48h reminder sits in between. Keep the JSON schema (subject, body_html, topics) otherwise identical for every slot.`
      : undefined,
    `- Each touchpoint's "topics" array must be a non-empty subset of the input topics.`,
    `- If a topic is ambiguous or you're unsure about something, put it in notes_to_operator — DON'T guess in the copy.`,
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

// ---------------------------------------------------------------------------
// Mechanical validation — see docs/agents/ennie/mechanical-checks.md
// ---------------------------------------------------------------------------

const KNOWN_ACRONYMS = new Set([
  "STEAM", "STEM", "LEGO", "PT", "PST", "PDT", "EST", "EDT", "AM", "PM",
  "USA", "FAQ", "CEO", "VIP", "AI", "TV", "PC", "NPR", "K", "FA", "WI", "SP", "SU",
]);

const BANNED_CLAIM_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bmost popular\b/i, label: "most popular" },
  { pattern: /\baward[-\s]?winning\b/i, label: "award-winning" },
  { pattern: /\bbest in\b/i, label: "best in" },
  { pattern: /\btop[-\s]?rated\b/i, label: "top-rated" },
  { pattern: /\bvoted #?1\b/i, label: "voted #1" },
  { pattern: /\bselling fast\b/i, label: "selling fast" },
  { pattern: /\bgoing fast\b/i, label: "going fast" },
  { pattern: /\balmost full\b/i, label: "almost full" },
  { pattern: /\bfilling up\b/i, label: "filling up" },
  { pattern: /\bback by popular demand\b/i, label: "back by popular demand" },
];

// Marketer-speak — flag for review. Ennie's voice doc forbids these explicitly.
// Soft (not hard) because the operator can override with a real reason.
const MARKETER_SPEAK_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bleverage\b/i, label: "leverage" },
  { pattern: /\belevate\b/i, label: "elevate" },
  { pattern: /\bunlock(?:ing)? (?:your|their)\b/i, label: "unlock your/their" },
  { pattern: /\bdrive engagement\b/i, label: "drive engagement" },
  { pattern: /\bsupercharge\b/i, label: "supercharge" },
  { pattern: /\bnext[-\s]level\b/i, label: "next-level" },
  { pattern: /\bgame[-\s]changing\b/i, label: "game-changing" },
  { pattern: /\bactivate your\b/i, label: "activate your" },
  { pattern: /\bsynergy\b/i, label: "synergy" },
];

// Outcome promises about a specific child — soft flag. "Your child will master X"
// is the canonical bad version; describe what kids do, not what they become.
const OUTCOME_PROMISE_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\byour (?:child|student|kid|kiddo) will (?:become|master|be able to|learn to)\b/i, label: "outcome promise (your child will become/master/be able to)" },
  { pattern: /\bguaranteed to\b/i, label: "guaranteed to" },
];

// Hard reject: cancel-style language in parent-facing subject lines. Parents
// hear "isn't running this term" / "schedule update" / "moved that to next
// session" — never "cancelled." Operator + partner channels are exempt; this
// only fires for audience='parents' (the only Mode B audience in v1).
const PARENT_SUBJECT_CANCEL_PATTERN = /\bcancel(?:l?ed)?\b/i;

// (Instructor subject cancel/removed/terminated rule deferred — will fire
// once audience='instructors' is wired through Ennie's drafting path.)

// Deterministic backstop: strip em/en dashes from generated copy. They're an
// AI tell, so the prompt forbids them — but a regex guarantees zero slip-through
// without burning a regeneration. Covers the literal chars and the HTML entity
// forms Claude sometimes emits in body_html. Spaced dash -> spaced hyphen
// (" - "), unspaced (ranges like "9am–3pm") -> plain hyphen.
function stripAiDashes(text: string | undefined): string | undefined {
  if (text == null) return text;
  return text
    // HTML entity forms first, normalized to the literal char.
    .replace(/&mdash;|&#8212;|&#x2014;|&ndash;|&#8211;|&#x2013;/gi, "—")
    // Spaced em/en dash -> spaced hyphen; unspaced -> plain hyphen.
    .replace(/\s*[—–]\s*/g, (m) => (/\s/.test(m) ? " - " : "-"));
}

const MONTH_DATE_PATTERN = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?\b/i;
const NUMERIC_DATE_PATTERN = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/;

// Resolves the operator's chosen send_at value to a concrete ISO timestamp
// for the prompt + the touchpoint's scheduled_at. Three input shapes:
//   'now' -> current time + 5 minutes (cron picks up next tick)
//   'tomorrow_morning' -> tomorrow 10am org timezone (approximated to PDT)
//   'YYYY-MM-DDTHH:MM:SS' -> local time at the org's timezone, converted to UTC
function resolveSendAtIso(sendAt: string, _orgTimezone: string): string {
  const now = Date.now();
  if (sendAt === "now") {
    return new Date(now + 5 * 60_000).toISOString();
  }
  if (sendAt === "tomorrow_morning") {
    // Approximation: 17:00 UTC = 10am PDT (= 9am PST). Good enough for Pacific
    // orgs; refine with proper timezone math when we onboard non-Pacific tenants.
    const d = new Date(now + 24 * 60 * 60_000);
    d.setUTCHours(17, 0, 0, 0);
    return d.toISOString();
  }
  // Custom: 'YYYY-MM-DDTHH:MM:SS' from a date+time input. The browser
  // submitted local-time without timezone. Assume Pacific for now (matches
  // resolveSendAtIso's tomorrow_morning assumption).
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(sendAt)) {
    // Treat the operator's wall-clock time as Pacific (PDT, UTC-7) so a "3pm"
    // pick sends at 3pm Pacific — NOT 3pm UTC (which was 7h early). Refine to a
    // real per-tenant timezone when we onboard non-Pacific orgs.
    return new Date(sendAt + "-07:00").toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  // Already-ISO-ish: pass through
  return sendAt;
}

// Same resolution but formatted for the prompt: a human-readable line + ISO.
function resolveSendAtForPrompt(sendAt: string, orgTimezone: string): string {
  const iso = resolveSendAtIso(sendAt, orgTimezone);
  return `${iso}  (operator chose: ${sendAt === "now" ? "Send right away" : sendAt === "tomorrow_morning" ? "Tomorrow morning" : sendAt})`;
}

// ---------------------------------------------------------------------------
// Server-computed cadence
//
// The MODEL used to pick its own scheduled_at values from prose cadence
// heuristics — brittle, and it routinely mis-spaced sends or ignored deadlines.
// Instead we compute the send schedule deterministically here from the grounded
// facts (early-bird deadlines + first-session/camp-start dates) and hand the
// model a FIXED list of slots to write copy for. The model no longer chooses
// timing; the handler overwrites every scheduled_at from these slots.
//
// Send-time convention matches resolveSendAtIso: 17:00 UTC = 10am Pacific.
// ---------------------------------------------------------------------------

type CadenceSlot = {
  order_index: number;
  label: string;
  scheduled_at: string;
  reason: string;
};

// Parse a date-only string ("YYYY-MM-DD") into ms at 17:00 UTC (the send hour).
// Returns null for empty / unparseable values.
function dateOnlyToSendMs(d: string | null | undefined): number | null {
  if (!d || typeof d !== "string") return null;
  const m = d.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 17, 0, 0, 0);
  return Number.isFinite(ms) ? ms : null;
}

// Parse the END date out of a "custom: YYYY-MM-DD to YYYY-MM-DD" duration.
function parseCustomDuration(duration: string): { start: number | null; end: number | null } {
  const m = duration.match(/custom:\s*(\d{4}-\d{2}-\d{2})\s*to\s*(\d{4}-\d{2}-\d{2})/i);
  if (!m) return { start: null, end: null };
  return { start: dateOnlyToSendMs(m[1]), end: dateOnlyToSendMs(m[2]) };
}

// Compute the deterministic send schedule for a multi-touchpoint campaign.
// Returns [] for one-off sends (caller passes []). See module comment above.
function computeCadenceSlots(inputs: DraftInputs, facts: GroundedFacts, nowMs: number): CadenceSlot[] {
  const SEND_UTC_HOUR = 17;
  const DAY_MS = 86_400_000;
  const atSend = (dateMs: number): string => {
    const d = new Date(dateMs);
    d.setUTCHours(SEND_UTC_HOUR, 0, 0, 0);
    return d.toISOString();
  };

  // ---- Kickoff: today if before today's 17:00 UTC, else tomorrow. ----
  const todayStart = new Date(nowMs);
  todayStart.setUTCHours(0, 0, 0, 0);
  const todaySend = new Date(todayStart.getTime());
  todaySend.setUTCHours(SEND_UTC_HOUR, 0, 0, 0);
  let kickoffMs = nowMs >= todaySend.getTime()
    ? todayStart.getTime() + DAY_MS // tomorrow at 17:00 (atSend applied at return)
    : todayStart.getTime();
  kickoffMs = new Date(atSend(kickoffMs)).getTime();

  const duration = inputs.duration ?? "";
  const custom = parseCustomDuration(duration);

  // Custom start floors the kickoff (never before the operator's start date).
  if (custom.start != null && custom.start > kickoffMs) {
    kickoffMs = custom.start;
  }

  // ---- Window end. ----
  let endMs: number;
  if (duration === "2 weeks") endMs = kickoffMs + 14 * DAY_MS;
  else if (duration === "1 month") endMs = kickoffMs + 30 * DAY_MS;
  else if (duration === "2 months") endMs = kickoffMs + 60 * DAY_MS;
  else if (custom.end != null) endMs = custom.end;
  else endMs = kickoffMs + 30 * DAY_MS; // safe default for unrecognized durations

  // ---- Deadlines from grounded facts. ----
  // A deadline can only anchor a REMINDER if it's far enough out to actually
  // send a "48h before" email — at least ~2 days. A program that starts
  // tomorrow can't be reminded about, so it must NOT anchor OR collapse the
  // campaign. Pick the earliest remindable, in-window deadline of each kind.
  const REMINDABLE_FLOOR = kickoffMs + 2 * DAY_MS;
  let earlyBirdMs: number | null = null;
  for (const p of facts.programs) {
    if (p.early_bird_price_cents == null) continue;
    const d = dateOnlyToSendMs(p.early_bird_deadline);
    if (d == null) continue;
    if (d >= REMINDABLE_FLOOR && d <= endMs && (earlyBirdMs == null || d < earlyBirdMs)) earlyBirdMs = d;
  }
  // startDateMs = earliest remindable start (drives 48h/24h "last chance"
  // reminders). latestStartMs = last start overall, used only to stop the drip
  // once everything has started — never to collapse to a single early outlier.
  let startDateMs: number | null = null;
  let latestStartMs: number | null = null;
  const considerStart = (d: number | null) => {
    if (d == null) return;
    if (d >= REMINDABLE_FLOOR && d <= endMs && (startDateMs == null || d < startDateMs)) startDateMs = d;
    if (d > kickoffMs && (latestStartMs == null || d > latestStartMs)) latestStartMs = d;
  };
  for (const p of facts.programs) considerStart(dateOnlyToSendMs(p.first_session_date));
  for (const c of facts.camps) considerStart(dateOnlyToSendMs(c.starts_on));

  // Stop promoting once the LAST offering has started (don't drip into empty
  // space) — but never past the operator's chosen duration, and NEVER collapse
  // to the earliest start. A 2-month push over programs that start across
  // months keeps its full window even if one program happens to start tomorrow.
  if (latestStartMs != null && latestStartMs > kickoffMs && latestStartMs < endMs) {
    endMs = latestStartMs;
  }

  type Draft = { label: string; ms: number; reason: string; kind: "kickoff" | "reminder" | "build" };
  const slots: Draft[] = [];

  // ---- Always: kickoff. ----
  slots.push({ label: "kickoff", ms: kickoffMs, reason: "Kickoff — announce the campaign and set the hook.", kind: "kickoff" });

  const deadlineCandidates = [earlyBirdMs, startDateMs].filter((x): x is number => x != null);
  const earliestDeadline = deadlineCandidates.length > 0 ? Math.min(...deadlineCandidates) : null;

  // ---- Deadline-proximity collapse: SHORT campaigns only. ----
  // If the operator chose a short window (~2 weeks) and the earliest deadline is
  // within a week, a full drip is pointless — collapse to announce + a final
  // reminder. We do NOT collapse a 1-2 month campaign just because one deadline
  // is near; long campaigns keep their weekly cadence.
  const shortWindow = endMs - kickoffMs <= 16 * DAY_MS;
  if (shortWindow && earliestDeadline != null && earliestDeadline <= kickoffMs + 7 * DAY_MS) {
    const before48 = earliestDeadline - 2 * DAY_MS;
    const before24 = earliestDeadline - 1 * DAY_MS;
    if (before48 > kickoffMs) {
      slots.push({ label: "final-reminder-48h", ms: before48, reason: "48 hours before the deadline", kind: "reminder" });
    }
    if (before24 > kickoffMs) {
      slots.push({ label: "final-reminder-24h", ms: before24, reason: "24 hours before the deadline — final reminder", kind: "reminder" });
    }
    return finalizeSlots(slots, nowMs, kickoffMs, atSend);
  }

  // ---- Otherwise: per-deadline 48h/24h reminders. ----
  const addReminderPair = (
    deadlineMs: number | null,
    label48: string,
    reason48: string,
    label24: string,
    reason24: string,
  ) => {
    if (deadlineMs == null) return;
    if (deadlineMs <= kickoffMs || deadlineMs > endMs) return;
    const before48 = deadlineMs - 2 * DAY_MS;
    const before24 = deadlineMs - 1 * DAY_MS;
    if (before48 > kickoffMs) slots.push({ label: label48, ms: before48, reason: reason48, kind: "reminder" });
    if (before24 > kickoffMs) slots.push({ label: label24, ms: before24, reason: reason24, kind: "reminder" });
  };
  addReminderPair(
    earlyBirdMs,
    "early-bird-48h", "48 hours before early-bird pricing ends",
    "early-bird-24h", "24 hours before early-bird pricing ends — last chance to save",
  );
  addReminderPair(
    startDateMs,
    "last-call-48h", "48 hours before registration closes / classes start",
    "last-call-24h", "24 hours before registration closes — final call",
  );

  const anyReminderAdded = slots.some((s) => s.kind === "reminder");

  // ---- Weekly builds: kickoff+7d, +14d, ... while inside the window. ----
  for (let t = kickoffMs + 7 * DAY_MS; t < endMs; t += 7 * DAY_MS) {
    // Skip if within 2 days of an existing reminder or within 3 days of an existing build.
    const nearReminder = slots.some((s) => s.kind === "reminder" && Math.abs(s.ms - t) <= 2 * DAY_MS);
    if (nearReminder) continue;
    const nearBuild = slots.some((s) => s.kind === "build" && Math.abs(s.ms - t) <= 3 * DAY_MS);
    if (nearBuild) continue;
    slots.push({ label: "weekly-build", ms: t, reason: "Weekly touchpoint to keep families engaged", kind: "build" });
  }

  // ---- If no deadline reminders exist, promote the last build to a final-call. ----
  if (!anyReminderAdded) {
    const builds = slots.filter((s) => s.kind === "build");
    if (builds.length > 0) {
      const last = builds.reduce((a, b) => (b.ms > a.ms ? b : a));
      last.label = "final-call";
      last.reason = "Last call before the campaign window closes.";
    }
  }

  return finalizeSlots(slots, nowMs, kickoffMs, atSend);
}

// Sort, dedupe, cap at 7, guarantee future timing, and assign order_index.
// Shared tail of computeCadenceSlots (both the collapse path and the full path).
function finalizeSlots(
  raw: Array<{ label: string; ms: number; reason: string; kind: "kickoff" | "reminder" | "build" }>,
  nowMs: number,
  kickoffMs: number,
  atSend: (dateMs: number) => string,
): CadenceSlot[] {
  const DAY_MS = 86_400_000;
  const HALF_DAY_MS = 12 * 60 * 60_000;

  // Sort ascending by time.
  let slots = [...raw].sort((a, b) => a.ms - b.ms);

  // Dedupe any within 12h of each other: keep the earlier; prefer reminders over builds.
  const deduped: typeof slots = [];
  for (const s of slots) {
    const clash = deduped.find((d) => Math.abs(d.ms - s.ms) < HALF_DAY_MS);
    if (!clash) {
      deduped.push(s);
      continue;
    }
    // A kickoff/reminder always wins over a build; otherwise keep the earlier (already in `deduped`).
    const rank = (k: string) => (k === "kickoff" ? 2 : k === "reminder" ? 1 : 0);
    if (rank(s.kind) > rank(clash.kind)) {
      deduped[deduped.indexOf(clash)] = s;
    }
  }
  slots = deduped.sort((a, b) => a.ms - b.ms);

  // Cap at 7: remove the "weekly-build" closest to the middle until <= 7.
  // Never remove kickoff or any reminder.
  while (slots.length > 7) {
    const midIdx = (slots.length - 1) / 2;
    let removeIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].kind !== "build") continue;
      const dist = Math.abs(i - midIdx);
      if (dist < bestDist) {
        bestDist = dist;
        removeIdx = i;
      }
    }
    if (removeIdx === -1) break; // no builds left to remove — leave it (all kickoff/reminders)
    slots.splice(removeIdx, 1);
  }

  // Guarantee every scheduled_at is strictly in the future. Drop past slots,
  // but ALWAYS keep at least the kickoff (pushed to now+1h if it's not future).
  const future = slots.filter((s) => new Date(atSend(s.ms)).getTime() > nowMs);
  if (future.length === 0) {
    const pushedKickoffMs = kickoffMs > nowMs ? kickoffMs : nowMs + 60 * 60_000;
    return [{
      order_index: 0,
      label: "kickoff",
      scheduled_at: new Date(pushedKickoffMs).toISOString(),
      reason: "Kickoff — announce the campaign and set the hook.",
    }];
  }
  slots = future;

  return slots.map((s, i) => ({
    order_index: i,
    label: s.label,
    scheduled_at: atSend(s.ms),
    reason: s.reason,
  }));
}

// Render the fixed schedule as a prompt block the model writes copy against.
function formatCadenceForPrompt(slots: CadenceSlot[]): string {
  const lines = [
    `FIXED SEND SCHEDULE — write EXACTLY these ${slots.length} emails, one per slot, in this order. Do NOT add, remove, reorder, or re-time them:`,
  ];
  for (const s of slots) {
    const day = s.scheduled_at.slice(0, 10); // YYYY-MM-DD
    lines.push(`- Slot ${s.order_index}: ${s.label} — sends ${day} — purpose: ${s.reason}`);
  }
  return lines.join("\n");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

type ValidationIssue = { type: string; detail: string };
type TouchpointValidation = {
  touchpoint_label: string;
  order_index: number;
  hard: ValidationIssue[];
  warnings: ValidationIssue[];
};

function validateTouchpoint(
  tp: Touchpoint,
  brandVoice: { do_not_use?: string[] } | null,
): TouchpointValidation {
  const hard: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const subject = tp.subject ?? "";
  const bodyHtml = tp.body_html ?? "";
  const bodyText = tp.body_text ?? "";
  const bodyStripped = stripHtml(bodyHtml);
  const combined = `${subject}\n${bodyStripped}\n${bodyText}`;

  // -------- Hard: inline dollar amounts ----------
  const dollarMatch = combined.match(/\$\d[\d,]*(?:\.\d{1,2})?/);
  if (dollarMatch) {
    hard.push({ type: "inline_dollar_amount", detail: dollarMatch[0] });
  }

  // -------- Hard: unknown tokens ----------
  const seenTokens = new Set<string>();
  for (const m of combined.matchAll(/\{\{(\w+)\}\}/g)) {
    seenTokens.add(m[1]);
  }
  for (const tok of seenTokens) {
    if (!APPROVED_TOKENS.has(tok)) {
      hard.push({ type: "unknown_token", detail: `{{${tok}}}` });
    }
  }

  // -------- Hard: banned phrases from brand_voice.do_not_use ----------
  for (const phrase of brandVoice?.do_not_use ?? []) {
    if (!phrase) continue;
    const re = new RegExp(`\\b${escapeRegex(phrase)}\\b`, "i");
    if (re.test(combined)) {
      hard.push({ type: "banned_phrase", detail: phrase });
    }
  }

  // -------- Hard: "cancel" in parent-facing subject line ----------
  // v1 audience is always parents; when instructor/partner channels land,
  // gate this check on audience.
  const cancelInSubject = subject.match(PARENT_SUBJECT_CANCEL_PATTERN);
  if (cancelInSubject) {
    hard.push({ type: "cancel_in_parent_subject", detail: cancelInSubject[0] });
  }

  // -------- Soft: bare dates ----------
  const monthDate = bodyStripped.match(MONTH_DATE_PATTERN);
  const numericDate = bodyStripped.match(NUMERIC_DATE_PATTERN);
  if (monthDate) warnings.push({ type: "bare_date", detail: monthDate[0] });
  if (numericDate) warnings.push({ type: "bare_date", detail: numericDate[0] });

  // -------- Soft: exclamation count ----------
  const exSubject = (subject.match(/!/g) ?? []).length;
  const exBody = (bodyStripped.match(/!/g) ?? []).length;
  if (exSubject > 1) warnings.push({ type: "exclamation_subject", detail: `${exSubject} in subject` });
  if (exBody > 2) warnings.push({ type: "exclamation_body", detail: `${exBody} in body` });

  // -------- Soft: all-caps words ----------
  const capsWords = (combined.match(/\b[A-Z]{4,}\b/g) ?? []).filter((w) => !KNOWN_ACRONYMS.has(w));
  if (capsWords.length > 0) {
    warnings.push({ type: "all_caps", detail: capsWords.slice(0, 3).join(", ") });
  }

  // -------- Soft: emoji count ----------
  // \p{Extended_Pictographic} matches emojis. Use 'u' flag.
  const emojiMatches = combined.match(/\p{Extended_Pictographic}/gu) ?? [];
  if (emojiMatches.length > 3) warnings.push({ type: "too_many_emojis", detail: `${emojiMatches.length} emojis` });

  // -------- Soft: unverifiable claims ----------
  for (const { pattern, label } of BANNED_CLAIM_PATTERNS) {
    const m = combined.match(pattern);
    if (m) warnings.push({ type: "unverifiable_claim", detail: `"${label}" → ${m[0]}` });
  }

  // -------- Soft: marketer-speak ----------
  for (const { pattern, label } of MARKETER_SPEAK_PATTERNS) {
    const m = combined.match(pattern);
    if (m) warnings.push({ type: "marketer_speak", detail: `"${label}" → ${m[0]}` });
  }

  // -------- Soft: outcome promises ----------
  for (const { pattern, label } of OUTCOME_PROMISE_PATTERNS) {
    const m = combined.match(pattern);
    if (m) warnings.push({ type: "outcome_promise", detail: `"${label}" → ${m[0]}` });
  }

  return { touchpoint_label: tp.label, order_index: tp.order_index, hard, warnings };
}

function validateSchedule(
  schedule: Schedule,
  brandVoice: { do_not_use?: string[] } | null,
): { results: TouchpointValidation[]; anyHard: boolean } {
  const results = schedule.touchpoints.map((tp) => validateTouchpoint(tp, brandVoice));
  const anyHard = results.some((r) => r.hard.length > 0);
  return { results, anyHard };
}

type Schedule = {
  schedule_summary: string;
  notes_to_operator?: string;
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
  const userMessage = `Plan the full campaign schedule now. Topic(s): ${topicsLine}. Generate every touchpoint with its scheduled_at, subject, body_html, and topics array (no body_text — the system derives it). Return the JSON object only.`;

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
        return {
          schedule_summary: parsed.schedule_summary,
          notes_to_operator: typeof parsed.notes_to_operator === "string" ? parsed.notes_to_operator : undefined,
          touchpoints: tps,
        };
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
  const parsed = parseRequest(body);
  if (!parsed.ok) return jsonError(parsed.error, parsed.status);
  const { organization_id, inputs } = parsed.req;
  const skipAi = !!(body as Record<string, unknown>).skip_ai;

  // ---- Multi-tenant gate ----
  if (!caller.isPlatformAdmin && !caller.adminOrgIds.has(organization_id)) {
    return jsonError("forbidden: caller has no admin access to this organization", 403);
  }

  // Service-role client for downstream reads/writes (RLS already enforced by the
  // explicit auth gate above; service role lets us avoid second-guessing each
  // policy from inside this trusted function).
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ---- Rate limit: 15s cooldown + 50 drafts/day per org (AI only) ----
  if (skipAi) {
    // Manual drafts skip the AI rate limit entirely — no Claude call, no cost.
  } else {
  const DRAFT_COOLDOWN_MS = 15_000;
  const DAILY_DRAFT_CAP = 50;
  const { data: recentDrafts, error: rlErr } = await supabase
    .from("marketing_campaigns")
    .select("created_at")
    .eq("organization_id", organization_id)
    .eq("draft_source", "ai_assisted")
    .gte("created_at", new Date(Date.now() - 86_400_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(DAILY_DRAFT_CAP + 1);
  if (!rlErr && recentDrafts && recentDrafts.length > 0) {
    const lastCreated = new Date(recentDrafts[0].created_at).getTime();
    if (Date.now() - lastCreated < DRAFT_COOLDOWN_MS) {
      const waitSec = Math.ceil((DRAFT_COOLDOWN_MS - (Date.now() - lastCreated)) / 1000);
      return jsonError(`Please wait ${waitSec}s before generating another draft`, 429, { retry_after_seconds: waitSec });
    }
    if (recentDrafts.length > DAILY_DRAFT_CAP) {
      return jsonError("Daily draft limit reached (50 per org). Try again tomorrow.", 429);
    }
  }
  } // end skipAi else

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
    .select("id, default_sender_name, default_sender_email, sending_domain, brand_voice, timezone, vip_offering")
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
  let { ids: recipientIds, count: recipientCount, segment_summary } = resolved.data;

  // Optional: exclude parents who've already registered for the picked
  // programs/camps. Gated by Enrops registration (we can't dedup against
  // Squarespace etc.). Toggle set on the client (inputs.who.exclude_already_registered).
  const excludeAlreadyRegistered = (inputs.who as { exclude_already_registered?: boolean }).exclude_already_registered === true;
  let excludedCount = 0;
  if (excludeAlreadyRegistered && parsed.structuredWhat) {
    const programIds = parsed.structuredWhat.program_ids ?? [];
    const campIds = parsed.structuredWhat.camp_session_ids ?? [];
    if (programIds.length > 0 || campIds.length > 0) {
      // 1. Confirmed registrations for the picks → parent_ids
      let regQuery = supabase
        .from("registrations")
        .select("parent_id")
        .eq("organization_id", organization_id)
        .eq("status", "confirmed");
      if (programIds.length > 0 && campIds.length > 0) {
        regQuery = regQuery.or(`program_id.in.(${programIds.join(",")}),camp_session_id.in.(${campIds.join(",")})`);
      } else if (programIds.length > 0) {
        regQuery = regQuery.in("program_id", programIds);
      } else {
        regQuery = regQuery.in("camp_session_id", campIds);
      }
      const { data: regs } = await regQuery;
      const parentIds = [...new Set((regs ?? []).map((r: { parent_id: string }) => r.parent_id).filter(Boolean))];

      if (parentIds.length > 0) {
        // 2. parent_ids → emails
        const { data: parents } = await supabase
          .from("parents")
          .select("email")
          .in("id", parentIds);
        const excludedEmails = new Set(
          ((parents ?? []) as Array<{ email: string | null }>)
            .map((p) => p.email?.toLowerCase())
            .filter(Boolean) as string[],
        );

        if (excludedEmails.size > 0) {
          // 3. Find the EXCLUDED recipient ids directly — query by email IN
          // (small set), not by id IN (audience). The earlier shape was
          // '.in("id", [778 uuids])' which blew past PostgREST's URL length
          // limit, returned empty, and the filter logic mistakenly treated
          // every recipient as "already registered." Querying the smaller
          // side keeps the URL well under any limit.
          const { data: toExclude } = await supabase
            .from("marketing_recipients")
            .select("id")
            .eq("organization_id", organization_id)
            .in("email", [...excludedEmails]);
          const excludedIds = new Set(((toExclude ?? []) as Array<{ id: string }>).map((r) => r.id));
          const before = recipientIds.length;
          recipientIds = recipientIds.filter((id) => !excludedIds.has(id));
          excludedCount = before - recipientIds.length;
          recipientCount = recipientIds.length;
          if (excludedCount > 0) {
            segment_summary = `${segment_summary} (minus ${excludedCount} already registered)`;
          }
        }
      }
    }
  }

  // Zero-recipient case is a soft warning: the admin can still see the draft
  // and adjust the filter without re-running the whole question flow.
  const zeroRecipientWarning = recipientCount === 0 ? "no_recipients_matched" : null;

  // ---- Grounded facts (structured catalog picks) OR fuzzy curriculum match (legacy / mode='other') ----
  const facts = await loadGroundedFacts(supabase, organization_id, parsed.structuredWhat, parsed.derivedTopics);
  // topicsArr drives the prompt's topic line + the response's curriculum_matches
  // echo. When grounded facts resolved, facts.topics is the curriculum names of
  // picked rows; otherwise we keep the operator's typed topics from parseRequest.
  const topicsArr = facts.topics.length > 0 ? facts.topics : parsed.derivedTopics;

  let programDetailsBlock = "";
  let curriculumMatches: CurriculumMatch[] = [];
  const isOneOffMode = parsed.structuredWhat?.mode === "other";
  if (facts.programs.length > 0 || facts.camps.length > 0) {
    // Structured picks — use grounded facts. Skip fuzzy curriculum match entirely.
    programDetailsBlock = formatGroundedFactsForPrompt(facts, inputs.promo);
  } else if (isOneOffMode) {
    // Mode='other' is a one-off note (weather cancellation, holiday greeting,
    // thank-you). Curriculum matching doesn't apply — the topic is an event,
    // not a curriculum. Skip the fuzzy match. If operator_notes is thin,
    // Ennie will say so in notes_to_operator (per the prompt rule below).
    programDetailsBlock = "";
  } else {
    // Legacy string/string[] callers — fall back to fuzzy curriculum match.
    const curricula = await loadCurricula(supabase, organization_id);
    curriculumMatches = matchCurriculaToTopics(topicsArr, curricula);
    programDetailsBlock = formatCurriculaForPrompt(curriculumMatches);
  }

  // ---- Server-computed cadence ----
  // One-off sends keep their single-touchpoint path (empty slots). Multi-touchpoint
  // campaigns get a deterministic schedule the model writes copy against; the
  // handler overwrites every scheduled_at from these slots below.
  const cadenceSlots = inputs.send_at ? [] : computeCadenceSlots(inputs, facts, Date.now());
  const orgTimezone = orgRow.timezone ?? "America/Los_Angeles";

  // ---- "Write it myself" path: skip AI, create a blank draft ----
  if (skipAi) {
    // Build touchpoint slots: use the server-computed cadence (same schedule
    // the AI path would have used) so the operator gets the right number of
    // emails at the right times. One-off sends get a single touchpoint.
    const touchpointSlots = cadenceSlots.length > 0
      ? cadenceSlots.map((slot) => ({
          order_index: slot.order_index,
          scheduled_at: slot.scheduled_at,
          label: slot.label,
          reason: slot.reason,
        }))
      : [{
          order_index: 0,
          scheduled_at: inputs.send_at
            ? resolveSendAtIso(inputs.send_at, orgTimezone)
            : new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
          label: "draft",
          reason: null as string | null,
        }];

    const campaignName = ((): string => {
      const mode = parsed.structuredWhat?.mode;
      if (mode === "programs" && facts.programs.length > 0) {
        if (facts.programs.length === 1) return facts.programs[0].curriculum ?? "After-school campaign";
        const terms = [...new Set(facts.programs.map((p) => p.term).filter(Boolean))];
        const termPart = terms.length === 1 ? `${terms[0]} ` : "";
        return `${termPart}after-school: ${facts.programs.length} programs`;
      }
      if (mode === "camps" && facts.camps.length > 0) {
        if (facts.camps.length === 1) return facts.camps[0].curriculum_name ?? "Camp campaign";
        return `Camps: ${facts.camps.length} sessions`;
      }
      return topicsArr[0] ?? "Campaign";
    })().slice(0, 200);

    const { data: inserted, error: iErr } = await supabase
      .from("marketing_campaigns")
      .insert({
        organization_id,
        name: campaignName,
        campaign_type: "custom",
        status: "draft",
        subject_template: "",
        body_template: "",
        draft_source: "manual",
        draft_inputs: inputs as unknown as Record<string, unknown>,
        draft_model: null,
        approved_at: null,
      })
      .select("id")
      .single<{ id: string }>();
    if (iErr || !inserted) {
      return jsonError(`failed to persist draft: ${iErr?.message ?? "unknown"}`, 500);
    }

    const { data: insertedTps, error: tpErr } = await supabase
      .from("marketing_campaign_touchpoints")
      .insert(touchpointSlots.map((slot) => ({
        campaign_id: inserted.id,
        organization_id,
        type: "email",
        order_index: slot.order_index,
        scheduled_at: slot.scheduled_at,
        status: "queued",
        payload: { label: slot.label, subject: null, body_html: null, body_text: null, reason: slot.reason },
        topics: topicsArr,
      })))
      .select("id, order_index, type, scheduled_at, status, payload, topics");
    if (tpErr) {
      return jsonError(`failed to persist touchpoint: ${tpErr.message}`, 500);
    }

    return jsonOk({
      campaign_id: inserted.id,
      schedule: {
        summary: "",
        notes_to_operator: "",
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
          reason: (tp.payload as { reason?: string })?.reason ?? null,
          topics: tp.topics,
        })),
      },
      sender: { name: orgRow.default_sender_name!, email: orgRow.default_sender_email! },
      recipients: { ids: recipientIds, count: recipientCount, segment_summary },
      mechanical_checks: { retried: false, touchpoints: [] },
      curriculum_matches: curriculumMatches.map((m) => ({
        topic: m.topic, score: Number(m.score.toFixed(3)),
        matched: m.match ? { id: m.match.id, name: m.match.name } : null,
      })),
      grounded_facts: (facts.programs.length > 0 || facts.camps.length > 0) ? {
        mode: parsed.structuredWhat?.mode ?? null,
        program_count: facts.programs.length,
        camp_count: facts.camps.length,
        curricula: facts.topics,
        schools: [...new Set(facts.programs.map((p) => p.school_name))],
        locations: [...new Set(facts.camps.map((c) => c.location_name))],
        early_bird_active: facts.programs.some((p) => p.early_bird_price_cents && p.early_bird_deadline),
      } : null,
      model: null,
      inputs_echo: inputs,
      ...(zeroRecipientWarning ? { warning: zeroRecipientWarning } : {}),
    });
  }

  // ---- Build prompt + call Claude ----
  const todayIso = new Date().toISOString();
  const systemPrompt = buildSystemPrompt(orgRow, inputs, segment_summary, todayIso, orgTimezone, programDetailsBlock, topicsArr, cadenceSlots);
  let claudeResult = await callClaude(systemPrompt, topicsArr);
  if (!claudeResult.ok) return jsonError(claudeResult.error, claudeResult.status);
  let { schedule, model } = claudeResult;
  const brandVoice = orgRow.brand_voice as { do_not_use?: string[] } | null;

  // Mechanical-check pass. Hard failures get one retry (Claude re-rolls).
  // Soft warnings always pass through to the operator for review.
  // Count-mismatch (model returned a different number of touchpoints than the
  // server-computed schedule has slots) also counts as a hard failure — the
  // fixed cadence needs exactly one email per slot.
  const countMismatch = (s: Schedule) =>
    cadenceSlots.length > 0 && s.touchpoints.length !== cadenceSlots.length;
  let validation = validateSchedule(schedule, brandVoice);
  let retried = false;
  if (validation.anyHard || countMismatch(schedule)) {
    retried = true;
    const retry = await callClaude(systemPrompt, topicsArr);
    if (retry.ok) {
      const retryValidation = validateSchedule(retry.schedule, brandVoice);
      // Score = hard failures + a heavy penalty for count mismatch. Prefer the
      // retry only if it scores strictly better (fewer problems).
      const score = (s: Schedule, v: { results: TouchpointValidation[] }) =>
        v.results.reduce((n, r) => n + r.hard.length, 0) + (countMismatch(s) ? 1000 : 0);
      const beforeScore = score(schedule, validation);
      const afterScore = score(retry.schedule, retryValidation);
      if (afterScore < beforeScore) {
        schedule = retry.schedule;
        model = retry.model;
        validation = retryValidation;
      }
    }
  }
  const mechanicalChecks = {
    retried,
    touchpoints: validation.results.map((r) => ({
      order_index: r.order_index,
      label: r.touchpoint_label,
      hard_failures: r.hard,
      warnings: r.warnings,
    })),
  };

  // One-off mode enforcement: if Ennie produced multiple touchpoints despite
  // the prompt instruction, truncate to one and force scheduled_at to the
  // operator's chosen time. Defensive — Ennie usually follows but this guarantees.
  if (inputs.send_at) {
    const resolvedIso = resolveSendAtIso(inputs.send_at, orgTimezone);
    const first = schedule.touchpoints[0];
    if (first) {
      schedule.touchpoints = [{
        ...first,
        order_index: 0,
        scheduled_at: resolvedIso,
        label: first.label || "send",
      }];
    }
  }

  // Backstop: strip em/en dashes from every touchpoint before persistence, so
  // no AI-tell punctuation reaches the saved draft or the sent email even if
  // Claude ignored the prompt rule.
  for (const tp of schedule.touchpoints) {
    tp.subject = stripAiDashes(tp.subject);
    tp.body_html = stripAiDashes(tp.body_html);
    // Plain-text is derived server-side from the cleaned HTML — the model no
    // longer writes body_text (halves generation time / avoids timeouts).
    tp.body_text = stripHtml(tp.body_html ?? "");
  }

  // ---- Server-computed cadence enforcement ----
  // The model wrote the copy; the SERVER owns the timing. Map the model's
  // touchpoints onto the fixed slots by array order: overwrite scheduled_at +
  // label from the slot, and remember the slot reason for the payload. Extra
  // touchpoints (model over-produced) are truncated. A short list is a hard
  // failure — the count-mismatch retry above should have fixed it; if it's
  // still short, we refuse rather than silently persist an incomplete schedule.
  const reasonByOrderIndex = new Map<number, string>();
  if (cadenceSlots.length > 0) {
    if (schedule.touchpoints.length < cadenceSlots.length) {
      return jsonError(
        "Ennie returned fewer emails than the schedule needs — try again",
        502,
        { expected_touchpoints: cadenceSlots.length, got: schedule.touchpoints.length },
      );
    }
    // Truncate any extras beyond the slot count.
    if (schedule.touchpoints.length > cadenceSlots.length) {
      schedule.touchpoints = schedule.touchpoints.slice(0, cadenceSlots.length);
    }
    for (let i = 0; i < cadenceSlots.length; i++) {
      const slot = cadenceSlots[i];
      const tp = schedule.touchpoints[i];
      tp.scheduled_at = slot.scheduled_at;
      tp.label = slot.label;
      tp.order_index = slot.order_index;
      reasonByOrderIndex.set(slot.order_index, slot.reason);
    }
  }

  // First touchpoint = the "lead" email; its subject/body populate the parent
  // campaigns row so the existing campaigns list keeps working.
  const lead = schedule.touchpoints[0];

  // Human-friendly campaign name from the picks (term + type + count) instead of
  // jamming every curriculum title together and truncating mid-word. A single
  // pick just uses that offering's name.
  const campaignName = ((): string => {
    const mode = parsed.structuredWhat?.mode;
    if (mode === "programs" && facts.programs.length > 0) {
      if (facts.programs.length === 1) return facts.programs[0].curriculum ?? "After-school campaign";
      const terms = [...new Set(facts.programs.map((p) => p.term).filter(Boolean))];
      const termPart = terms.length === 1 ? `${terms[0]} ` : "";
      return `${termPart}after-school: ${facts.programs.length} programs`;
    }
    if (mode === "camps" && facts.camps.length > 0) {
      if (facts.camps.length === 1) return facts.camps[0].curriculum_name ?? "Camp campaign";
      return `Camps: ${facts.camps.length} sessions`;
    }
    return topicsArr[0] ?? "Campaign";
  })().slice(0, 200);

  // ---- Persist parent campaign row ----
  const { data: inserted, error: iErr } = await supabase
    .from("marketing_campaigns")
    .insert({
      organization_id,
      name: campaignName,
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
      reason: reasonByOrderIndex.get(tp.order_index) ?? null,
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
      notes_to_operator: schedule.notes_to_operator ?? "",
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
        reason: (tp.payload as { reason?: string })?.reason ?? null,
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
    mechanical_checks: mechanicalChecks,
    curriculum_matches: curriculumMatches.map((m) => ({
      topic: m.topic,
      score: Number(m.score.toFixed(3)),
      matched: m.match ? { id: m.match.id, name: m.match.name } : null,
    })),
    grounded_facts: (facts.programs.length > 0 || facts.camps.length > 0) ? {
      mode: parsed.structuredWhat?.mode ?? null,
      program_count: facts.programs.length,
      camp_count: facts.camps.length,
      curricula: facts.topics,
      schools: [...new Set(facts.programs.map((p) => p.school_name))],
      locations: [...new Set(facts.camps.map((c) => c.location_name))],
      early_bird_active: facts.programs.some((p) => p.early_bird_price_cents && p.early_bird_deadline),
    } : null,
    model,
    inputs_echo: inputs,
    ...(zeroRecipientWarning ? { warning: zeroRecipientWarning } : {}),
  });
});
