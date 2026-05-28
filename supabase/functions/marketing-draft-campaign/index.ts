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
// fits comfortably; if Ennie wants more, future chunks can stream or paginate.
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
  // or a list of topics (multi-topic campaign — Ennie weaves them into one
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
  "org_name", "sender_name", "sender_email", "register_url", "reply_to",
  "logo_url", "closer", "phone", "website",
  // per-program (computed from this recipient's school's programs)
  "savings", "early_bird_price", "regular_price", "early_bird_deadline",
  "first_session_date", "session_count", "day_of_week", "curriculum", "vip_price",
  // per-campaign
  "topic", "topics_list", "promo_code", "promo_amount",
]);

function buildSystemPrompt(
  org: OrgConfig,
  inputs: DraftInputs,
  segmentSummary: string,
  todayIso: string,
  orgTimezone: string,
  curriculumMatches: CurriculumMatch[],
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

  const topics = Array.isArray(inputs.what) ? inputs.what : [inputs.what];
  const topicLine = topics.length === 1
    ? `Campaign topic: "${topics[0]}"`
    : `Campaign topics (weave them across the schedule — each touchpoint covers one or more; tag each touchpoint with which topics it covers): ${topics.map((t) => `"${t}"`).join(", ")}`;

  const channelNote = inputs.channels.length > 1
    ? `Channels requested: ${inputs.channels.join(", ")}. v1 generates email touchpoints only; flyer + social are placeholders.`
    : "Channels: email only in v1.";

  const tokenList = `Approved merge tokens (use these for ALL specifics):
- Per-recipient: {{first_name}}, {{parent_name}}, {{child_first_name}}, {{child_last_name}}, {{school}}, {{city}}, {{zip}}, {{geo_segment}}, {{unsubscribe_url}}
- Per-org: {{org_name}}, {{sender_name}}, {{sender_email}}, {{register_url}}, {{reply_to}}, {{logo_url}}, {{closer}}, {{phone}}, {{website}}
- Per-program (pulled per recipient's school): {{savings}}, {{early_bird_price}}, {{regular_price}}, {{early_bird_deadline}}, {{first_session_date}}, {{session_count}}, {{day_of_week}}, {{curriculum}}, {{vip_price}}
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

THINGS YOU SHOULD NEVER CLAIM
- That a program is "selling fast" or "almost full" (unless the operator said so).
- That it's "award-winning," "accredited," or "the most popular" anything.
- That a child will achieve a specific outcome ("your child will master Python"). Describe what they'll do, not what they'll become.
- That this program is better than another provider's.
- Never use cancellation language with parents. If a program isn't running, say "isn't running this term" or "we've moved that to next session."

TENANT ISOLATION
You never reference any other provider's data, copy, instructors, parents, or numbers when working for ${sender}. No "most providers do X" comparisons. ${sender} is the only tenant you're thinking about right now.

VOICE DETAILS
- One exclamation point per email max; zero in subject lines unless one really earns it.
- Address the parent, not the kid. "Your student" not "you."
- Subject line under 60 characters; no all-caps; no clickbait.
- Preheader (first ~80 chars of body) extends the subject, never repeats it.
- Match length to purpose: a kickoff can be substantial — paint the picture. A 24-hour reminder is three or four sentences, but still warm, not curt.
- Leave the parent feeling something positive after reading: curiosity, anticipation, that "this sounds like my kid" hum. Don't just inform — connect.
- End every email body with the closer line on its own paragraph: "${v.closer ?? "(no closer set)"}" — only if a closer is set, otherwise omit.

${tokenList}

SCHEDULE-PLANNING RULES (you plan a multi-touchpoint sequence, not a single send)
- DEFAULT SEND TIMES (org timezone ${orgTimezone}): Tuesday/Thursday 10am for regular sends. Deadline-day reminders at 7am. Welcome notes Monday 9am. NEVER Friday afternoons or weekends.
- THROTTLE: this org caps at 1 email per parent per 10 days. Space consecutive emails at least 6 days apart.
- For any topic with a known deadline, include BOTH a 48-hour-before AND a 24-hour-before reminder email.

PER-TENANT NOTES
If the tenant has refined your voice over time (their "Ennie's notes" file), those corrections beat your defaults. None supplied yet for this draft.`;

  const cadenceGuidance = `CADENCE HEURISTICS by duration:
- "2 weeks": 2-3 emails. Kickoff + 1 mid + 1 final-call if a deadline lives in-window.
- "1 month": 4-6 emails. Kickoff, mid-window, plus 48h + 24h reminders for each deadline. Add a "thanks for registering" send if appropriate at the end.
- "2 months": 5-7 emails. Slower build with longer gaps between general sends; ALWAYS the 48h + 24h reminders near deadlines.
- "custom": pick a reasonable cadence with 6-10 day spacing.`;

  const curriculumBlock = formatCurriculaForPrompt(curriculumMatches);

  return [
    personaBlock,
    ``,
    `Today is: ${todayIso} (org timezone: ${orgTimezone})`,
    topicLine,
    `Sending to: ${segmentSummary}`,
    `Campaign duration: "${inputs.duration}" — count from today.`,
    channelNote,
    ``,
    curriculumBlock,
    ``,
    cadenceGuidance,
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

const MONTH_DATE_PATTERN = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?\b/i;
const NUMERIC_DATE_PATTERN = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/;

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

  // ---- Curriculum grounding ----
  const topicsArr = Array.isArray(inputs.what) ? inputs.what : [inputs.what];
  const curricula = await loadCurricula(supabase, organization_id);
  const curriculumMatches = matchCurriculaToTopics(topicsArr, curricula);

  // ---- Build prompt + call Claude ----
  const orgTimezone = orgRow.timezone ?? "America/Los_Angeles";
  const todayIso = new Date().toISOString();
  const systemPrompt = buildSystemPrompt(orgRow, inputs, segment_summary, todayIso, orgTimezone, curriculumMatches);
  let claudeResult = await callClaude(systemPrompt, topicsArr);
  if (!claudeResult.ok) return jsonError(claudeResult.error, claudeResult.status);
  let { schedule, model } = claudeResult;
  const brandVoice = orgRow.brand_voice as { do_not_use?: string[] } | null;

  // Mechanical-check pass. Hard failures get one retry (Claude re-rolls).
  // Soft warnings always pass through to the operator for review.
  let validation = validateSchedule(schedule, brandVoice);
  let retried = false;
  if (validation.anyHard) {
    retried = true;
    const retry = await callClaude(systemPrompt, topicsArr);
    if (retry.ok) {
      const retryValidation = validateSchedule(retry.schedule, brandVoice);
      // Prefer the retry only if it has fewer hard failures (or zero).
      const beforeHard = validation.results.reduce((n, r) => n + r.hard.length, 0);
      const afterHard = retryValidation.results.reduce((n, r) => n + r.hard.length, 0);
      if (afterHard < beforeHard) {
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
    model,
    inputs_echo: inputs,
    ...(zeroRecipientWarning ? { warning: zeroRecipientWarning } : {}),
  });
});
