# Spec Chunk 1 of 3 (REWRITE): Extraction Prompt + Testing Surface

## LOCKED VOCABULARY (applies to all chunks)
- **Curriculum** = reusable lesson library. Lives in `curricula`. UI: "Curriculum."
- **Program** = scheduled offering. Lives in `programs`. UI: "Program."
- **Session** = single class meeting. Lives in `curriculum_sessions` (content) + program runtime data.
- **Term** = time window (FA26, SU26).
- **Registration** = parent+kid enrolled in a program.
- Do NOT use "Class" / "Course" / "Offering" anywhere.
- Chunk 0 cleans up the existing codebase to match this vocabulary before this chunk runs.

## Why this chunk exists
Programs Onboarding hinges on AI doing a great job extracting structured curriculum data from messy lesson plan docs. The extraction needs to produce enough structured data that downstream features — flyers, registration listings, welcome emails, session recaps, parent portal highlights, instructor portal class detail, substitute coordination — can pull what they need without further AI generation. **Prove the extraction works first, then build the UI around it.**

## Data model context
Three separate tables — the data model for Chunk 2:

- **`curricula`** (new) — reusable curriculum library, AI-populated, slow-changing
- **`programs`** (already exists) — scheduled instances. Will get a `curriculum_id` FK in Chunk 2.
- **`registrations`** (already exists) — roster data lives here

Chunk 1's only job: extraction function + test surface. No DB tables yet.

---

## Goal
Admin-only route at `/admin/dev/extraction-test`:
1. Drop a curriculum doc (file upload only this chunk; Drive support in Chunk 2.5)
2. AI extraction runs with live status updates
3. Full structured JSON output displays
4. Can A/B test prompt variations side-by-side

Stays in codebase as debugging tool.

---

## The full extraction schema

Single JSON object. Every field carries `confidence` 0-1.

### Curriculum-level fields

```
name: { value, confidence }
short_description: { value (2-3 sentences, parent-facing, no jargon, no emotional claims), confidence }
age_range: { value: { min, max }, confidence }
session_count: { value: int, confidence }
format: { value: "afterschool" | "summer_camp" | "other", confidence }
session_types_supported: { 
  value: array of "full_day" | "half_day_am" | "half_day_pm" | "afterschool",
  confidence,
  note: "Which session structures this curriculum can run as"
}
themes: { 
  value: array of strings (pop culture themes parents recognize — Pokémon, Minecraft, etc.),
  confidence
}
narrative_arc: { 
  value: string or null (only if explicit recurring story thread ties sessions together),
  confidence
}
skills_overall: { 
  value: array of strings (plain language — "building game logic" not "computational primitives"),
  confidence
}
materials: { 
  value: array of strings (materials needed across the curriculum),
  confidence
}
instructor_guide_notes: {
  value: string or null (instructor-facing prep notes, classroom mgmt tips, common pitfalls — multi-paragraph plain text fine),
  confidence
}
```

### Per-session fields (one entry per session)

```
sessions: {
  value: [
    {
      session_number: int,
      title: string (names the activity not the concept — "Build a Marble Maze" not "Physics of Gravity"),
      description: string (1-2 sentences, what kids do this session),
      skills_practiced: array of strings,
      materials_session: array of strings (materials specific to this session),
      recap_template: string (auto-sent to parents after session runs. Template variables in {curly_braces}. Standard variables: {photos}, {instructor_name}. Tone: warm, specific, parent-voice. Ends naturally with the engagement question or similar prompt),
      parent_engagement_question: string (one specific "ask your kid about ___" prompt, conversational, not generic)
    }
  ],
  confidence
}
```

---

## The extraction prompt — v1

**System prompt:**

```
You are extracting structured curriculum data from a kids' enrichment program lesson plan document. The extracted data will populate multiple downstream surfaces:

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

9. INSTRUCTOR GUIDE NOTES preserve what doesn't fit structured fields. Classroom mgmt approaches, common pitfalls, lesson flow structure (threshold → intro → warm-up → build → share → debrief if mentioned). Multi-paragraph plain text fine.

10. SKILLS USE PLAIN LANGUAGE. "Building game logic with conditional statements" not "Boolean primitives." Skills appear in parent-facing surfaces.

Return ONLY valid JSON. No preamble, no markdown fences, no commentary.
```

**Model:** `claude-sonnet-4-5` (or current Sonnet)
**Max tokens:** 16000 (per-session recap templates take real space — a 10-session curriculum can produce ~12K tokens)

---

## Edge function: `extract-curriculum-details`

**Inputs:** `document_path` (Supabase Storage path), `prompt_version` (optional, defaults to `v1`)

**Steps:**
1. Fetch document from Storage
2. Parse to text:
   - `.pdf` → use existing PDF parsing pattern or `pdf-parse` lib
   - `.docx` → `mammoth`
   - `.txt` / `.md` → read directly
   - `.xlsx` → SheetJS
3. Call Anthropic API with extraction prompt
4. Return structured JSON
5. Stream status updates to client via Supabase Realtime

**Status messages** (real, driven by function progress, not faked):
- "Reading your curriculum..."
- "Pulling out the lesson structure..."
- "Writing recap templates for each session..."
- "Drafting a parent description..."
- "Done!"

---

## Test surface: `/admin/dev/extraction-test`

Admin-only (gate behind `platform_admins` row check).

Layout:
- Left: drop zone + prompt version dropdown + "Run extraction" button
- Right: live status messages, then prettified JSON output
- Below: comparison view — if two extractions run on same doc, side-by-side

No persistence. "Copy JSON" button for review.

---

## Validation — REQUIRED before moving to Chunk 2

Run extraction against all three J2S test docs:

1. **LEGO Game Makers** (Drive: `1fiQXjc1zDf9z39xWNK3Wzp8Bq3-ay5hb`)
   - Expected: 11 sessions, themes include Pokémon/Minecraft/Demon Slayer, format `afterschool`, session_types_supported = `["afterschool"]`, age range 6-10
   - Each session has a real recap_template referencing what kids built
   - Each session has a parent_engagement_question that sounds like Jessica wrote it

2. **Minecraft Makers** (Drive: `1rdyeytriuX0iSfxwALPYwz8kPACxeUTU`)
   - Expected: 10 sessions, theme Minecraft, format `afterschool`, age range 7-11
   - Skills span coding in plain language

3. **Toy Designers Camp** (Drive: `1ogPUhc8rWbZSM5ge_aDyA9tvuNbIfOXv`)
   - Expected: 5 sessions, format `summer_camp`, session_types_supported includes half_day variants, narrative_arc captures "Factory Glitch", age range 6-10

### Gut checks per doc

- session_count matches the document
- sessions[] has correct count, distinct titles
- short_description passes the "would Jessica send this to a parent" test
- recap_template for each session sounds like a real recap, not a placeholder
- parent_engagement_question is specific to that session, not generic
- No fabrication: missing fields return null with confidence 0
- session_types_supported is correct

### If extraction is mediocre

Iterate on the prompt. Track versions as `v1`, `v2` in the dropdown. Common failure modes:
- Education jargon → strengthen rule, add "what to avoid" examples
- Generic recap templates → add good-vs-bad example to system prompt
- Sessions collapsed → emphasize "one entry per session"
- Fabricated data → strengthen "never fabricate" with explicit example

Run each doc **twice** per prompt version. AI has run-to-run variance. If quality is good on run 1 and mediocre on run 2, the prompt needs more constraints.

---

## Build rules
1. Read this chunk end-to-end before writing code
2. Multi-tenant: gate test surface on `platform_admins`
3. Test from the surface, not curl
4. Do NOT move to Chunk 2 until all three test docs produce usable JSON, including good recap_templates and parent_engagement_questions

---

## Out of scope for this chunk
- Database tables — Chunk 2
- Drive link extraction — Chunk 2.5
- Production onboarding UI — Chunk 2
- Persisting extracted data — Chunk 3
- Follow-up questions for low-confidence fields — Chunk 3

---

## When this chunk is done
- `/admin/dev/extraction-test` works end-to-end
- `extract-curriculum-details` edge function deployed
- All three J2S test docs produce JSON Jessica approves
- Recap templates + engagement questions sound natural
- Prompt locked at the version that produces parent-ready output

Then proceed to Chunk 2.
