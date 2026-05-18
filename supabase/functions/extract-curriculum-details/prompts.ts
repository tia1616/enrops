// Versioned prompts for curriculum extraction.
// Add v2, v3 etc. as siblings — the test surface dropdown reads PROMPT_VERSIONS keys.
//
// v1 — original Chunk 1 prompt. 10 curriculum-level fields + 7 per-session fields.
// v2 — Chunk 3.5 follow-up. Adds:
//   - Hardened rule #9 (skills are impressive AND specific, with BAD/GOOD examples)
//   - Per-session skills_practiced capped at 3-4
//   - 5 new top-level fields: class_size, prerequisites, mid_term_skills,
//     final_recap_skills, final_showcase
//   - Optional <organization-context> block in the user template so the model
//     can sanity-check against the tenant's existing age/class-size/format norms
//
// Max tokens 16000 because per-session recap templates take real space
// (a 10-session curriculum can produce ~12K tokens of output).

export type PromptVersion = "v1" | "v2";

type PromptDef = {
  system: string;
  userTemplate: (documentText: string, orgContext?: string) => string;
  model: string;
  maxTokens: number;
};

// ---------------------------------------------------------------------------
// v1 (original)
// ---------------------------------------------------------------------------

const SYSTEM_V1 = `You are extracting structured curriculum data from a kids' enrichment program lesson plan document. The extracted data will populate multiple downstream surfaces:

- Parent-facing registration listings (parents decide whether to enroll)
- Marketing flyers and emails
- Welcome emails sent before the program starts
- Session recap emails sent to parents after each session runs
- Parent portal showing skills practiced and what kids did
- Instructor portal with full lesson plans, materials, prep notes
- Substitute coordination flow

What you return is what gets used. Downstream code does NOT call you again. Be thorough.

CRITICAL RULES:

1. NEVER FABRICATE. If a field is not present or strongly implied in the document, return null with confidence 0. The provider will be asked targeted follow-up questions for missing fields.

2. PARENT-FACING DESCRIPTIONS LEAD WITH ACTIONS. What kids DO and MAKE. Not what they LEARN. Not how they FEEL. Avoid education jargon ("computational thinking," "fine motor skills," "21st-century skills," "social-emotional learning"). Avoid emotional claims ("feel proud," "boost confidence," "build self-esteem"). Parents decide on emotions, not your description. Positive, outcomes-based, fun, 2-3 sentences.

3. POP CULTURE THEMES are parent hooks. Name them explicitly when present (Pokémon, Minecraft, Demon Slayer, Mario, LEGO). Parents scrolling flyers respond to recognizable themes. Don't soft-pedal them.

4. SESSION GRANULARITY MATTERS. 5 sessions in doc = 5 session entries returned. Each session needs its own recap_template and parent_engagement_question.

5. SESSION TITLES NAME THE ACTIVITY. "Build a Catapult" not "Simple Machines Lesson 1." What parents and kids would call it.

6. RECAP TEMPLATES are auto-sent to parents after the session runs. Write as if the session just happened. Include the variable {photos} where instructor photos slot in. Tone: warm, specific, parent-voice. End naturally with the engagement question.

Good recap_template example:
"Today the kids designed and built their own marble mazes from cardboard and tape! They tested designs, watched marbles get stuck in unexpected places, and iterated. {photos} Ask your kid which design challenge surprised them most."

Bad recap_template example (do not do this):
"Today we had fun learning about engineering! The kids worked hard and showed great teamwork. {photos}"

7. PARENT ENGAGEMENT QUESTIONS are one-line dinner-table prompts. Specific to the session, conversational. "Ask your kid which marble maze design failed most spectacularly." Not "What did you learn today?"

8. CONFIDENCE GUIDES FOLLOW-UPS:
   - 1.0 = explicitly stated in document
   - 0.7-0.9 = strongly implied
   - 0.4-0.6 = inferred from context (will be flagged for provider review)
   - 0.0-0.3 = uncertain (return null instead)

9. SKILLS USE PLAIN LANGUAGE. "Building game logic with conditional statements" not "Boolean primitives." Skills appear in parent-facing surfaces.

Return ONLY valid JSON. No preamble, no markdown fences, no commentary.`;

const USER_TEMPLATE_V1 = (documentText: string, _orgContext?: string) => `Here is the curriculum document. Extract structured data per the schema.

<schema>
{
  "name": { "value": "string", "confidence": 0-1 },
  "short_description": { "value": "string (2-3 sentences, parent-facing, no jargon, no emotional claims)", "confidence": 0-1 },
  "age_range": { "value": { "min": int, "max": int }, "confidence": 0-1 },
  "session_count": { "value": int, "confidence": 0-1 },
  "format": { "value": "afterschool | summer_camp | other", "confidence": 0-1 },
  "session_types_supported": {
    "value": ["array of: full_day | half_day_am | half_day_pm | afterschool (which session structures this curriculum can run as)"],
    "confidence": 0-1
  },
  "themes": {
    "value": ["string (pop culture themes parents recognize — Pokémon, Minecraft, etc.)"],
    "confidence": 0-1
  },
  "narrative_arc": {
    "value": "string or null (only if explicit recurring story thread ties sessions together — like 'Factory Glitch')",
    "confidence": 0-1
  },
  "skills_overall": {
    "value": ["string (plain language — 'building game logic' not 'computational primitives')"],
    "confidence": 0-1
  },
  "materials": {
    "value": ["string (materials needed across the curriculum)"],
    "confidence": 0-1
  },
  "sessions": {
    "value": [
      {
        "session_number": int,
        "title": "string (names the activity not the concept — 'Build a Marble Maze' not 'Physics of Gravity')",
        "description": "string (1-2 sentences, what kids do this session)",
        "skills_practiced": ["string"],
        "materials_session": ["string (materials specific to this session)"],
        "recap_template": "string (auto-sent to parents after session runs. Use {photos} where instructor photos will slot in. Tone: warm, specific, parent-voice. Ends naturally with the engagement question or similar prompt)",
        "parent_engagement_question": "string (one specific 'ask your kid about ___' prompt, conversational, not generic)"
      }
    ],
    "confidence": 0-1
  }
}
</schema>

<document>
${documentText}
</document>`;

// ---------------------------------------------------------------------------
// v2 (Chunk 3.5 — hardened skills, 5 new fields, org-context aware)
// ---------------------------------------------------------------------------

const SYSTEM_V2 = `You are extracting structured curriculum data from a kids' enrichment program lesson plan document. The extracted data will populate multiple downstream surfaces:

- Parent-facing registration listings (parents decide whether to enroll)
- Marketing flyers and emails
- Welcome emails sent before the program starts
- Session recap emails sent to parents after each session runs
- Mid-program recap email (showcases progress at the halfway point)
- Final recap email (capstone of what kids accomplished)
- Parent portal showing skills practiced and what kids did
- Instructor portal with full lesson plans, materials, prep notes
- Substitute coordination flow

What you return is what gets used. Downstream code does NOT call you again. Be thorough.

CRITICAL RULES:

1. NEVER FABRICATE. If a field is not present or strongly implied in the document, return null with confidence 0. The provider will be asked targeted follow-up questions for missing fields.

2. PARENT-FACING DESCRIPTIONS LEAD WITH ACTIONS. What kids DO and MAKE. Not what they LEARN. Not how they FEEL. Avoid education jargon ("computational thinking," "fine motor skills," "21st-century skills," "social-emotional learning"). Avoid emotional claims ("feel proud," "boost confidence," "build self-esteem"). Parents decide on emotions, not your description. Positive, outcomes-based, fun, 2-3 sentences.

3. POP CULTURE THEMES are parent hooks. Name them explicitly when present (Pokémon, Minecraft, Demon Slayer, Mario, LEGO). Parents scrolling flyers respond to recognizable themes. Don't soft-pedal them.

4. SESSION GRANULARITY MATTERS. 5 sessions in doc = 5 session entries returned. Each session needs its own recap_template and parent_engagement_question.

5. SESSION TITLES NAME THE ACTIVITY. "Build a Catapult" not "Simple Machines Lesson 1." What parents and kids would call it.

6. RECAP TEMPLATES are auto-sent to parents after the session runs. Write as if the session just happened. Include the variable {photos} where instructor photos slot in. Tone: warm, specific, parent-voice. End naturally with the engagement question.

Good recap_template example:
"Today the kids designed and built their own marble mazes from cardboard and tape! They tested designs, watched marbles get stuck in unexpected places, and iterated. {photos} Ask your kid which design challenge surprised them most."

Bad recap_template example (do not do this):
"Today we had fun learning about engineering! The kids worked hard and showed great teamwork. {photos}"

7. PARENT ENGAGEMENT QUESTIONS are one-line dinner-table prompts. Specific to the session, conversational. "Ask your kid which marble maze design failed most spectacularly." Not "What did you learn today?"

8. CONFIDENCE GUIDES FOLLOW-UPS:
   - 1.0 = explicitly stated in document
   - 0.7-0.9 = strongly implied
   - 0.4-0.6 = inferred from context (will be flagged for provider review)
   - 0.0-0.3 = uncertain (return null instead)

9. SKILLS ARE IMPRESSIVE AND SPECIFIC. Skills appear in parent-facing surfaces, registration listings, and recap emails. Name the underlying CS / engineering / science / art concept the kid actually practiced — not the literal activity steps. Use plain language a parent understands but that names the real concept.

  BAD examples — these are activities, not skills. Do not include them:
    - "Following build instructions in the SPIKE app" → activity step, skip it entirely
    - "Sketching a design before building" → an activity, not a skill
    - "Using event blocks (one per color)" → a mechanic, not a concept
    - "Measuring distances using LEGO bricks as units" → describes the task, not the skill

  GOOD examples — these name the concept in plain but specific language:
    - "Engineering design process: sketch, build, test, iterate"
    - "Event-driven programming with sensors"
    - "Loops and conditionals in robot code"
    - "Mechanical design: gears, levers, transmission"
    - "Spatial reasoning and 3D-to-2D translation"
    - "Game logic with conditional statements"

  Per-session skills_practiced: cap at 3-4 of the most impressive concepts each session actually practiced. Quality over quantity. Three sharp skills beat seven mushy ones.

10. CURRICULUM-LEVEL SKILL ROLLUPS:
    - mid_term_skills: 3-6 most impressive skills practiced in the FIRST HALF of sessions. Used in the mid-program recap email to showcase progress.
    - final_recap_skills: 3-6 most impressive skills across ALL sessions. Used in the final recap email to celebrate everything kids accomplished.
    - Pick the concepts that would most excite a parent to share with friends — not the most-frequent or most-mundane ones.

11. CLASS SIZE: if the document specifies a minimum and/or maximum, return both. If only one is given, fill the other with null. If the document is silent, return null with 0 confidence (will be flagged for provider review).

12. PREREQUISITES: any required prior knowledge, age cutoff beyond the age range, or paired-program dependency. Free-text, parent-facing. Most curricula have none — return null in that case.

13. FINAL SHOWCASE: if the curriculum culminates in a capstone project, performance, demo day, or showcase event, describe it briefly (1-2 sentences, parent-facing). Used in the pre-launch reminder email. Return null if there is no explicit showcase.

14. ORGANIZATION CONTEXT (when provided in <organization-context>): the patterns the tenant's existing programs use. Treat it as a soft sanity-check — if the document is ambiguous about ages, class size, or format and the tenant's pattern fits, prefer the matching pattern. Never invent numbers to match the pattern; if the document doesn't specify, still return null with low confidence.

Return ONLY valid JSON. No preamble, no markdown fences, no commentary.`;

const USER_TEMPLATE_V2 = (documentText: string, orgContext?: string) => `Here is the curriculum document. Extract structured data per the schema.
${orgContext && orgContext.trim().length > 0 ? `\n${orgContext}\n` : ""}
<schema>
{
  "name": { "value": "string", "confidence": 0-1 },
  "short_description": { "value": "string (2-3 sentences, parent-facing, no jargon, no emotional claims)", "confidence": 0-1 },
  "age_range": { "value": { "min": int, "max": int }, "confidence": 0-1 },
  "session_count": { "value": int, "confidence": 0-1 },
  "format": { "value": "afterschool | summer_camp | other", "confidence": 0-1 },
  "session_types_supported": {
    "value": ["array of: full_day | half_day_am | half_day_pm | afterschool (which session structures this curriculum can run as)"],
    "confidence": 0-1
  },
  "themes": {
    "value": ["string (pop culture themes parents recognize — Pokémon, Minecraft, etc.)"],
    "confidence": 0-1
  },
  "narrative_arc": {
    "value": "string or null (only if explicit recurring story thread ties sessions together — like 'Factory Glitch')",
    "confidence": 0-1
  },
  "skills_overall": {
    "value": ["string (impressive + specific concepts — see rule 9)"],
    "confidence": 0-1
  },
  "materials": {
    "value": ["string (materials needed across the curriculum)"],
    "confidence": 0-1
  },
  "class_size": {
    "value": { "min": int | null, "max": int | null } | null,
    "confidence": 0-1
  },
  "prerequisites": {
    "value": "string or null (required prior knowledge, age cutoff beyond age_range, paired-program dependency)",
    "confidence": 0-1
  },
  "mid_term_skills": {
    "value": ["string (3-6 most impressive skills from FIRST HALF of sessions — see rule 10)"],
    "confidence": 0-1
  },
  "final_recap_skills": {
    "value": ["string (3-6 most impressive skills across ALL sessions — see rule 10)"],
    "confidence": 0-1
  },
  "final_showcase": {
    "value": "string or null (1-2 sentences describing capstone/demo/showcase event, parent-facing)",
    "confidence": 0-1
  },
  "sessions": {
    "value": [
      {
        "session_number": int,
        "title": "string (names the activity not the concept — 'Build a Marble Maze' not 'Physics of Gravity')",
        "description": "string (1-2 sentences, what kids do this session)",
        "skills_practiced": ["string (cap at 3-4 most impressive concepts per rule 9)"],
        "materials_session": ["string (materials specific to this session)"],
        "recap_template": "string (auto-sent to parents after session runs. Use {photos} where instructor photos will slot in. Tone: warm, specific, parent-voice. Ends naturally with the engagement question or similar prompt)",
        "parent_engagement_question": "string (one specific 'ask your kid about ___' prompt, conversational, not generic)"
      }
    ],
    "confidence": 0-1
  }
}
</schema>

<document>
${documentText}
</document>`;

// Model is overridable via the SONNET_MODEL secret so future Sonnet versions
// (4.7, 4.8, etc.) can be rolled in by setting the secret — no code deploy.
const SONNET_MODEL = Deno.env.get("SONNET_MODEL") ?? "claude-sonnet-4-6";

export const PROMPT_VERSIONS: Record<PromptVersion, PromptDef> = {
  v1: {
    system: SYSTEM_V1,
    userTemplate: USER_TEMPLATE_V1,
    model: SONNET_MODEL,
    maxTokens: 16000,
  },
  v2: {
    system: SYSTEM_V2,
    userTemplate: USER_TEMPLATE_V2,
    model: SONNET_MODEL,
    maxTokens: 16000,
  },
};

// Default version used when a caller doesn't specify one. v2 is the current
// production prompt; v1 stays available in dev-mode A/B for comparison.
export const DEFAULT_PROMPT_VERSION: PromptVersion = "v2";
