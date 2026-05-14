// Versioned prompts for program-detail extraction.
// Add v2, v3 etc. as siblings — the test surface dropdown reads PROMPT_VERSIONS keys.

export type PromptVersion = "v1";

type PromptDef = {
  system: string;
  userTemplate: (documentText: string) => string;
  model: string;
  maxTokens: number;
};

const SYSTEM_V1 = `You are extracting structured program data from a kids' enrichment program curriculum guide. The extracted data will populate two surfaces:

1. A parent-facing program listing where parents decide whether to enroll their child
2. An instructor portal where the instructor preps for class

You will be given the full text of an instructor guide. Your job is to return a JSON object with the structured data needed to populate these surfaces.

CRITICAL RULES:

- Never fabricate. If a field is not present in the document, return null with confidence 0. Do not infer values that are not stated.

- The short_description is parent-facing. Lead with what kids will DO and MAKE, not what they will LEARN. Avoid education jargon ("computational thinking," "fine motor skills," "21st-century skills"). Avoid emotional claims ("kids will feel proud," "boost confidence," "build self-esteem"). Parents decide on emotions, not your description. Keep it positive, outcomes-based, fun. 2-3 sentences max.

- The tone should match a warm, knowledgeable program director who knows kids and gets excited about what they're making. Not a textbook. Not a brochure.

- Pop culture themes (Pokémon, Minecraft, Demon Slayer, etc.) should be named explicitly when present. Parents scrolling flyers respond to recognizable themes.

- If the program has 5 sessions, return 5 session entries. Do not collapse, do not summarize across sessions.

- Each session should have a title that names the activity, not the concept. "Build a Marble Maze" not "Physics of Gravity."

- Confidence scores: 1.0 = explicitly stated in document, 0.7-0.9 = strongly implied, 0.4-0.6 = inferred from context, 0.0-0.3 = uncertain or fabricated (don't fabricate). If confidence would be below 0.4, return null instead.

Return ONLY valid JSON. No preamble, no markdown code fences, no commentary.`;

const USER_TEMPLATE_V1 = (documentText: string) => `Here is the curriculum document. Extract structured data per the schema.

<schema>
{
  "name": { "value": "string", "confidence": 0-1 },
  "short_description": { "value": "string (2-3 sentences, parent-facing)", "confidence": 0-1 },
  "age_range": { "value": { "min": int, "max": int }, "confidence": 0-1 },
  "session_count": { "value": int, "confidence": 0-1 },
  "format": { "value": "afterschool | summer_camp | other", "confidence": 0-1 },
  "themes": { "value": ["string", "string"], "confidence": 0-1 },
  "skills": { "value": ["string", "string"], "confidence": 0-1 },
  "materials": { "value": ["string", "string"], "confidence": 0-1 },
  "narrative_arc": { "value": "string or null (e.g., 'Factory Glitch' story thread that runs across sessions; only populate if the curriculum has an explicit recurring story or framing device that ties sessions together — not for one-off themes)", "confidence": 0-1 },
  "sessions": {
    "value": [
      {
        "session_number": int,
        "title": "string",
        "description": "string (1-2 sentences, what kids do)",
        "skills_practiced": ["string"]
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
    maxTokens: 8000,
  },
};
