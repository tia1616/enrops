# Spec Chunk 3 of 3 (REWRITE): Review Screen + Follow-Up Questions + Publish

## LOCKED VOCABULARY (see Chunk 0)
"Curriculum" = lesson library, "Program" = scheduled offering. Never substitute.

## Prerequisites
- Chunk 1: extraction function validated
- Chunk 2: data model live, upload flow ships Steps 1-2
- Chunk 2.5: Drive integration working (if Jessica wants to use Drive imports for testing)

## What this chunk builds
Step 3 of the curriculum onboarding flow: review screen where provider sees extracted data, answers AI-generated follow-up questions for low-confidence fields, edits anything, and publishes.

This is where the magic moment lands. The provider went from "I uploaded my lesson plan" to "Enrops has structured my curriculum and is asking me targeted questions to fill in gaps."

---

## Step 3 — Review with follow-up questions

Route: `/admin/curricula/:id/review`

### Layout

Two-column on desktop, single column on mobile.

**Left column** — Source documents
- List of uploaded/linked documents with filenames
- Click a doc to expand a preview pane (v1: filename + "View original" link in new tab; rendering inline is a rabbit hole)

**Right column** — Two sections stacked:

### Section A — Follow-up questions (only shown if there are any)

The AI extraction returned some fields with low confidence or null. Surface these as a friendly checklist of questions at the top of the review screen.

Build the follow-up questions on the client by inspecting `curriculum_extracted_fields`:
- For each row where `confidence < 0.5` OR `extracted_value` is null AND the field is essential
- Generate a human-readable question

**Essential fields** (always ask if missing):
- `age_range` → "What age range is this curriculum for?"
- `format` → "Is this an afterschool program, summer camp, or something else?"
- `session_types_supported` → "Can this run as a full-day camp, half-day, or only afterschool?"

**Conditional questions** (ask if low confidence):
- `themes` empty or low confidence → "What themes or pop culture references does this curriculum lean on? (Optional — but parents respond to recognizable themes like Minecraft or Pokémon)"
- `narrative_arc` flagged → "Is there a story or theme that runs across all sessions? (Like a 'factory glitch' or 'space mission' — leave blank if there isn't one)"
- `short_description` low confidence → render the AI's draft + "Does this sound right? Feel free to edit." with the textarea pre-filled

Each follow-up question renders as a small card:
- Question text
- Appropriate input (number range, dropdown, multi-select, textarea)
- "Skip for now" button (allows publishing with the field still null)
- "Save" button (writes value to `curricula` row + marks the field `human_approved=true` in `curriculum_extracted_fields`)

As provider answers each question, it disappears from the list with a subtle "✓ Saved" confirmation.

If no follow-up questions, Section A doesn't render.

### Section B — Full curriculum review (always shown)

Every extracted field rendered as editable input. Order:

1. **Name** — text input
2. **Short description** — large textarea (this is the parent-facing description — most important field on the page)
3. **Age range** — two number inputs
4. **Session count** — number input (read-only after extraction; changing this requires re-uploading)
5. **Format** — dropdown
6. **Session types supported** — multi-select checkboxes: "Afterschool", "Full-day camp", "Half-day AM camp", "Half-day PM camp"
7. **Themes** — chip list, editable
8. **Narrative arc** — text input, optional, helper text: "If your curriculum has a story or theme that runs across sessions, this is where it lives."
9. **Skills overall** — chip list, editable
10. **Materials** — chip list, editable
11. **Instructor guide notes** — large textarea, optional, helper text: "Prep notes, classroom management tips, or anything else instructors should know."

### Sessions — accordion list

Below the curriculum-level fields, sessions render as an accordion. Each session card:
- Session number (read-only header)
- Title — text input
- Description — textarea
- Skills practiced — chip list
- Materials for this session — chip list
- Recap template — textarea, helper text: "Auto-sent to parents after this session. Use {photos} where instructor photos will be slotted in."
- Parent engagement question — text input

Expand/collapse per session. First session expanded by default.

### Confidence indicators

Fields with `confidence < 0.7` in `curriculum_extracted_fields` get a subtle gold border + small icon. Tooltip on hover: "Double-check this one — we weren't fully sure."

Do NOT use red/warning colors. Tone is "please verify," not "this is wrong."

### Saving edits

Every field edit writes to `curriculum_extracted_fields.human_edited_value` AND sets `human_approved=true` for that field. Debounce 800ms after last keystroke for text inputs. Chip add/remove saves immediately.

Also update the canonical `curricula` row column (or `curriculum_sessions` row for session-level fields) so the data is queryable without joining through the extracted_fields audit table.

### Bottom CTAs

- Secondary: "Save as draft" — keeps `status='extracted'`, returns to curricula list
- Primary: "Publish curriculum" — flips `status='published'`, returns to curricula list

On publish, all extracted fields with `human_approved=true` AND any answered follow-up questions are final.

---

## Edit flow for published curricula

Route: `/admin/curricula/:id/edit`

Same layout as the review screen but title is "Edit curriculum." CTAs:
- Primary: "Save changes" — keeps `status='published'`, updates fields
- Secondary: "Upload more curriculum docs" — opens upload zone modally; on submit triggers re-extraction

**Re-extraction overwrite rules:**
- New extraction overwrites only `curriculum_extracted_fields` rows where `human_approved=false`
- Rows the provider touched stay put
- Show a notification after re-extraction: "Found new info from your upload. Review the highlighted fields."
- Highlighted fields = fields that changed in the most recent extraction run

---

## Curricula list page updates

Update from Chunk 2's placeholder:
- **Extracted** cards' CTA now routes to `/admin/curricula/:id/review`
- **Published** cards' "Edit" CTA now routes to `/admin/curricula/:id/edit`
- Show small inline indicator on Extracted cards if any field has `confidence < 0.7` and is not yet `human_approved`: "Needs your review" tag

---

## Build rules
1. Read this chunk end-to-end before writing code
2. Confirm Chunks 1, 2, 2.5 are complete
3. Checklist before coding
4. Multi-tenant: every query filters by `organization_id`
5. Mockup the review screen first — it's the most complex piece
6. Test end-to-end before deploying:
   - Upload curriculum doc via Step 1
   - Watch extraction run (Step 2)
   - Land on review screen with follow-up questions + extracted fields populated
   - Answer follow-up questions, confirm they disappear
   - Edit a field, confirm `human_approved` flips to true
   - Publish
   - Confirm `curricula` table row has correct final values
   - Confirm `curriculum_sessions` rows have correct values
7. Files local + present
8. No deploy until live test passes

---

## Multi-tenant audit log

Append to `MULTITENANT_AUDIT.md`:
- Default values for fields when extraction returns null — don't hardcode J2S-style defaults
- Follow-up question copy is generic — should work for any provider
- Coachmark copy (if any added later) needs to be tenant-aware

---

## Verification before shipping

Walk through end-to-end for each of the three test docs:

1. **LEGO Game Makers** — confirm 11 session cards in review, themes include pop culture references, short description passes "would Jessica send this to a parent" test, follow-up questions are minimal (rich doc means high confidence on most fields)

2. **Minecraft Makers** — confirm 10 sessions, coding-focused skills in plain language, no emotional outcome claims in description

3. **Toy Designers** — confirm 5 sessions, summer camp format identified, narrative arc field populated with Factory Glitch, session_types_supported includes half_day variants

Edge cases:
- Re-upload a doc after publishing → confirm re-extraction triggers, human-approved fields preserved
- Edit a field, then re-upload → confirm edited field stays edited
- Multi-tenant: create test second org, confirm curricula and extracted fields don't cross-contaminate
- Run twice on the same doc → confirm idempotent (no duplicate session rows)

---

## Out of scope (defer)
- OCR for scanned PDFs
- Bulk import of existing J2S Drive folder (one-off script after Chunks 1-3 ship)
- Program scheduling flow (next major piece of work, separate spec)
- Curriculum templates / cloning
- Versioning of extracted data over time
- Translation / multilingual extraction
- Coachmarks / walkthrough (after first real provider tests the flow)
- Side-by-side diff when re-extraction runs

---

## When this chunk is done
Provider can:
- Upload a curriculum doc
- Watch AI extract structured data with live status
- Answer targeted follow-up questions for gaps
- Review and edit everything
- Publish a curriculum that's ready to be scheduled into programs

Curriculum Onboarding is shipped. Next: the scheduling flow that creates `programs` rows from `curricula`. Separate spec.
