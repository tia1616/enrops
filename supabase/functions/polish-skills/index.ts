// polish-skills
//
// Takes an array of kid-program skills + curriculum context and asks Claude
// to polish them into parent-impressive, concept-specific language per the
// v2 extraction prompt's rule #9 (see ../extract-curriculum-details/prompts.ts).
//
// Use case: the "[Polish] Polish with Dora" button on chip fields in
// CurriculumReview.jsx. Operator clicks -> we re-rank and rewrite the skills
// list -> operator accepts or edits the preview before saving.
//
// Body:
//   {
//     curriculum_id: uuid,
//     field: "skills_overall" | "skills_practiced" | "mid_term_skills" | "final_recap_skills",
//     current: string[],
//     session_id?: uuid,        // required when field === "skills_practiced"
//     target_count?: number,    // default: 4 for per-session, 6 for curriculum-level
//   }
//
// Auth: caller must be a platform_admin OR own/admin the curriculum's org.
//
// Response: { polished: string[] }
//
// No DB writes. The component decides whether to commit the polished list.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Anthropic from "npm:@anthropic-ai/sdk@0.96.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SONNET_MODEL = Deno.env.get("SONNET_MODEL") ?? "claude-sonnet-4-6";

const SUPPORTED_FIELDS = new Set([
  "skills_overall",
  "skills_practiced",
  "mid_term_skills",
  "final_recap_skills",
]);

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

// ---------------------------------------------------------------------------
// Auth (mirrors extract-curriculum-details)
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
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are polishing a list of kid-program skills to make them parent-facing and impressive-specific. Skills appear in registration listings, recap emails, and the parent portal -- parents skim them when deciding to enroll and when telling friends what their kid is doing.

GOAL: name the underlying CS / engineering / science / art / craft concept the kid actually practiced -- NOT the literal activity steps. Use plain language a parent understands but that names the real concept.

BAD examples (activities or mechanics, not skills -- drop these):
- "Following build instructions in the SPIKE app" -> activity step, skip it entirely
- "Sketching a design before building" -> an activity, not a skill
- "Using event blocks (one per color)" -> a mechanic, not a concept
- "Measuring distances using LEGO bricks as units" -> describes the task, not the skill

GOOD examples (concepts in plain but specific language):
- "Engineering design process: sketch, build, test, iterate"
- "Event-driven programming with sensors"
- "Loops and conditionals in robot code"
- "Mechanical design: gears, levers, transmission"
- "Spatial reasoning and 3D-to-2D translation"
- "Game logic with conditional statements"

Quality over quantity. Three sharp skills beat seven mushy ones. Pick the concepts most likely to excite a parent to share with friends -- not the most frequent or most mundane ones.

Return ONLY a JSON object with this shape:
{ "polished": ["skill 1", "skill 2", ...] }

No preamble, no markdown fences, no commentary.`;

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

type CurriculumContext = {
  organizationId: string;
  name: string;
  format: string | null;
  ageMin: number | null;
  ageMax: number | null;
  themes: string[];
  narrative: string | null;
  sessionCount: number | null;
};

type SessionContext = {
  title: string | null;
  description: string | null;
};

async function loadCurriculum(
  admin: SupabaseClient,
  curriculumId: string,
): Promise<CurriculumContext | null> {
  const { data, error } = await admin
    .from("curricula")
    .select("organization_id, name, format, age_range_min, age_range_max, themes, narrative_arc, session_count")
    .eq("id", curriculumId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    organizationId: data.organization_id,
    name: data.name,
    format: data.format,
    ageMin: data.age_range_min,
    ageMax: data.age_range_max,
    themes: data.themes ?? [],
    narrative: data.narrative_arc,
    sessionCount: data.session_count,
  };
}

async function loadSession(
  admin: SupabaseClient,
  sessionId: string,
  curriculumId: string,
): Promise<SessionContext | null> {
  const { data, error } = await admin
    .from("curriculum_sessions")
    .select("title, description")
    .eq("id", sessionId)
    .eq("curriculum_id", curriculumId)
    .maybeSingle();
  if (error || !data) return null;
  return { title: data.title, description: data.description };
}

function renderContext(c: CurriculumContext, s: SessionContext | null): string {
  const lines: string[] = ["CURRICULUM CONTEXT:"];
  lines.push(`- Name: ${c.name}`);
  if (c.format) lines.push(`- Format: ${c.format}`);
  if (c.ageMin != null && c.ageMax != null) lines.push(`- Age range: ${c.ageMin}-${c.ageMax}`);
  if (c.themes.length > 0) lines.push(`- Themes: ${c.themes.join(", ")}`);
  if (c.narrative) lines.push(`- Narrative arc: ${c.narrative}`);
  if (c.sessionCount) lines.push(`- Session count: ${c.sessionCount}`);
  if (s) {
    lines.push("");
    lines.push("THIS SESSION:");
    if (s.title) lines.push(`- Title: ${s.title}`);
    if (s.description) lines.push(`- Description: ${s.description}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("Method not allowed", 405);

  const auth = await verifyCaller(req.headers.get("Authorization"));
  if (!auth.ok) return jsonError(auth.reason, auth.status);
  const { caller } = auth;

  let body: {
    curriculum_id?: string;
    field?: string;
    current?: unknown;
    session_id?: string;
    target_count?: number;
  };
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body");
  }

  if (!body.curriculum_id || typeof body.curriculum_id !== "string") {
    return jsonError("curriculum_id is required");
  }
  if (!body.field || !SUPPORTED_FIELDS.has(body.field)) {
    return jsonError(`field must be one of: ${[...SUPPORTED_FIELDS].join(", ")}`);
  }
  if (!Array.isArray(body.current)) {
    return jsonError("current must be an array of strings");
  }
  const currentSkills = body.current
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (currentSkills.length === 0) {
    return jsonError("current must contain at least one non-empty skill");
  }
  if (body.field === "skills_practiced" && !body.session_id) {
    return jsonError("session_id is required when field is skills_practiced");
  }

  // Default targets:
  //   per-session skills_practiced  -> 4  (matches v2 rule #9 cap of 3-4)
  //   curriculum-level skill rollups -> 6  (matches v2 rule #10 cap of 3-6)
  const defaultTarget = body.field === "skills_practiced" ? 4 : 6;
  const targetCount = Math.max(
    1,
    Math.min(10, typeof body.target_count === "number" ? body.target_count : defaultTarget),
  );

  // Service role for downstream reads -- auth gate is the caller check above.
  const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const curriculum = await loadCurriculum(admin, body.curriculum_id);
  if (!curriculum) return jsonError("Curriculum not found", 404);
  if (!caller.isPlatformAdmin && !caller.adminOrgIds.has(curriculum.organizationId)) {
    return jsonError("You need admin/owner access to this curriculum's organization", 403);
  }

  let session: SessionContext | null = null;
  if (body.session_id) {
    session = await loadSession(admin, body.session_id, body.curriculum_id);
    if (!session) return jsonError("Session not found for this curriculum", 404);
  }

  const contextBlock = renderContext(curriculum, session);
  const userMessage = `${contextBlock}

CURRENT SKILL LIST (rewrite + filter to the top ${targetCount} most impressive concepts these represent; drop pure activity steps):

${currentSkills.map((s) => `- ${s}`).join("\n")}

Target count: ${targetCount}`;

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  let raw = "";
  try {
    const resp = await anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
    for (const block of resp.content) {
      if (block.type === "text") raw += block.text;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("anthropic call failed:", message);
    return jsonError(`Polish failed: ${message}`, 502);
  }

  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let parsed: { polished?: unknown };
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return jsonError(
      `Couldn't parse the polished response as JSON: ${e instanceof Error ? e.message : String(e)}`,
      502,
    );
  }
  if (!Array.isArray(parsed.polished)) {
    return jsonError("Response missing 'polished' array", 502);
  }
  const polished = parsed.polished
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (polished.length === 0) {
    return jsonError("Polished list came back empty", 502);
  }

  return jsonOk({ polished });
});
