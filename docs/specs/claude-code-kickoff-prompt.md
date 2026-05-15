# Message to paste into Claude Code

We're building Curriculum Onboarding for Enrops. Before we build new features, the codebase needs a vocabulary cleanup pass so the new build lands on a coherent foundation.

There are 5 spec files attached:

1. **chunk-0-vocabulary-standardization.md** — Codebase cleanup. Discovery + renames. NO new features.
2. **chunk-1-extraction-test.md** — AI extraction prompt + admin test surface for curriculum docs.
3. **chunk-2-data-and-upload.md** — Data model (curricula + curriculum_sessions + supporting tables) + upload-first onboarding flow (Steps 1-2 of 3).
4. **chunk-2.5-drive-import.md** — Google Drive integration so curricula can be imported from Drive.
5. **chunk-3-review-and-publish.md** — Review screen with AI follow-up questions for low-confidence fields, plus publish flow.

## Locked vocabulary across the entire build

- **Curriculum** = reusable lesson library, AI-extracted from docs. Lives in `curricula` (new table). UI label: "Curriculum."
- **Program** = scheduled offering. Curriculum running at a location for a term. Lives in `programs` (existing table). UI label: "Program."
- **Session** = single class meeting. Content lives in `curriculum_sessions`, runtime data in `programs`.
- **Term** = time window (FA26, SU26, etc.). Existing data model question reconciled later.
- **Registration** = parent+kid enrolled in a program. Already exists.
- Do NOT use "Class" / "Course" / "Offering" anywhere.

If you find yourself wanting to call something a "program" but it's actually a lesson plan, it's a curriculum. If you find yourself calling something a "curriculum" but it's actually a scheduled offering at a school, it's a program.

## Order of operations

1. **Start with Chunk 0.** Do the discovery pass first — audit existing columns, code variables, and UI strings. Report findings to me. DO NOT RENAME ANYTHING YET. I'll review the list and approve renames.

2. **After I approve renames**, execute them. One commit per batch: database renames separate from code renames separate from UI string renames. Verify the app still runs locally after each batch before pushing.

3. **Then Chunk 1.** Build the extraction test surface at `/admin/dev/extraction-test`. Validate against the three test docs in Drive. Do NOT move to Chunk 2 until I've reviewed the JSON output for all three docs and approved the prompt.

4. **Then Chunk 2.** Build the data model and the upload-first onboarding flow (Steps 1-2). Includes a backfill script for existing FA26 programs — DO NOT auto-run this; I'll run it manually after reviewing.

5. **Then Chunk 2.5.** Google Drive integration. DO NOT START until I've completed Google Cloud setup and given you the CLIENT_ID/SECRET via env vars. I'll do this between Chunks 2 and 2.5.

6. **Then Chunk 3.** The review screen with follow-up questions and publish flow.

## Build rules (always)

1. Read the spec end-to-end before writing code.
2. Write a checklist before coding.
3. Spec wins — if I said something casual in conversation that conflicts with the spec, follow the spec.
4. Multi-tenant: every query filters by `organization_id`. Never hardcode J2S.
5. RLS on every new table BEFORE writing code that touches it.
6. Mockup before UI for any new screen.
7. Ask before writing user-facing copy that isn't in the spec.
8. Files local + present after each session.
9. No deploy until live test passes end-to-end.
10. Append any newly-discovered hardcoded J2S references to `MULTITENANT_AUDIT.md` as you find them. Don't fix existing items — just log.

## What I'm doing while you work

I'm the tester. I'll upload our real J2S curriculum docs (afterschool curricula like LEGO Game Makers and Inventors, plus camp curricula like Toy Designers) so we get real-world feedback on extraction quality, library navigation, and recap template variation between afterschool and camp formats.

## Start with Chunk 0 discovery. Report findings. Wait for my approval before renames.
