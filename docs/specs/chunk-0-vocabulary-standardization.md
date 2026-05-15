# Spec Chunk 0: Vocabulary Standardization

## Why this chunk exists
Before building Curriculum Onboarding (Chunks 1-3), the existing codebase needs vocabulary cleanup. Right now the `programs` table holds both curriculum-level data (the lesson plan, the description, the skills) and program-level data (location, term, day, time, price). The vocabulary is muddled because the data model is muddled. Building Chunks 1-3 on top of this without cleaning up first creates two sources of truth and two vocabularies.

This chunk does the cleanup pass. No new features. Just standardization so Chunks 1-3 land cleanly.

## Locked vocabulary

**Curriculum** = reusable lesson library. Lives in `curricula` (new table, built in Chunk 2). UI label: "Curriculum." Verbs: upload, extract, edit, publish, version.

**Program** = scheduled offering. A curriculum running at a location for a term. Lives in `programs` (existing table). UI label: "Program." Verbs: schedule, open registration, run, cancel.

**Session** = a single class meeting within a program. Tied to a `curriculum_sessions` row for content + a date/time in the program for when it actually runs.

**Term** = a time window programs run within. FA26, WI27, SU26, etc. Has its own data model question (Chunk 4) but for now, just settle on the word.

**Registration** = a parent-and-kid enrolled in a program. Lives in `registrations`.

**Cycle** = legacy word from the scheduling agent for "the season we're scheduling instructors for." Lives in `scheduling_cycles`. **Keep for now** — Chunk 4 will reconcile cycles with terms.

## Vocabulary that should NOT exist anywhere after this chunk
- "Class" used to mean program (some legacy UI strings) — switch to "Program"
- "Course" — never been used much, but if it exists, kill it
- "Offering" — kill it
- "Program" used to mean curriculum — switch every such reference to "Curriculum"

---

## What needs to change

### 1. Database — column renames on existing `programs` table

The current `programs` table has columns that describe curriculum-level data. Those columns will eventually move to `curricula` (during Chunk 2), but for this chunk, just rename them to make the muddled state explicit and stop the bleeding.

Audit the table first. Likely columns to rename (verify before changing):
- `programs.curriculum` (text — the curriculum name) → keep this name, this is correct (the curriculum's name as known by the program)
- Any column called `program_name` that's actually the curriculum name → rename to `curriculum_name`
- Any column called `description` that's actually the parent-facing curriculum description → rename to `parent_description` or `marketing_description`

**Run this as a discovery step first.** Use `list_tables` on the `programs` table, look at every column, and report back what's actually there before renaming anything. Some columns may already be named correctly.

### 2. Code — search-and-replace audit

Run a codebase grep for these patterns and report findings before changing:

- `"class"` or `'class'` used in user-facing strings (HTML, JSX text, email templates) — flag for review, may need to become "program"
- `"program"` used in places where it means the lesson plan / curriculum — flag for review
- `"course"` anywhere — flag for review
- `programDescription` or similar variable names — may need rename
- Any function named `getProgramDetails` that returns curriculum-level data — rename to `getCurriculumDetails` (or split)

This is a discovery pass. Don't rename code yet — produce a list, Jessica reviews, then we rename.

### 3. UI — string audit

Pull every user-facing string from:
- All `.jsx` and `.tsx` files in `/src`
- All email templates in `/templates` or wherever they live
- All edge function response messages

Group strings by which word they use ("class" / "program" / "course" / "offering" / "curriculum"). Report counts and example contexts.

This is also a discovery pass. Don't change strings yet.

### 4. Multi-tenant audit file — create if not exists

Create `MULTITENANT_AUDIT.md` at repo root. Seed with the known hardcoded J2S items (listed in Chunk 2 spec). This file becomes the running log of hardcoded references through all subsequent chunks.

---

## Workflow for this chunk

1. **Discovery pass** — Claude Code runs the audits above and reports findings. NO RENAMES YET.
2. **Jessica reviews** the discovery report and approves which renames to do.
3. **Rename pass** — Claude Code does the renames in a single commit, with clear git history.
4. **Verify** — run the test suite (if any), spot-check the UI, confirm nothing broke.
5. **Commit + push.**

Then proceed to Chunk 1.

---

## What this chunk explicitly does NOT do

- Move data between tables (that's Chunk 2's migrations)
- Create the `curricula` table (that's Chunk 2)
- Change any data — only column names and string labels
- Touch the scheduling agent code (that uses "cycle" which we're keeping)
- Touch any RLS policies (column renames don't affect RLS expressions if column names stay aliased properly — verify but don't refactor)
- Add new features

---

## Build rules

1. Discovery before changes. Never rename anything before showing Jessica the list.
2. One commit per rename batch (database renames separate commit from code renames separate from UI string renames).
3. After each rename batch, verify the app still runs locally before pushing.
4. If a rename touches an RLS policy, RAISE A FLAG and stop — Jessica decides whether to proceed.
5. Update `MULTITENANT_AUDIT.md` with any newly-discovered hardcoded J2S items found during the audit.

---

## When this chunk is done

- All user-facing strings use "Curriculum" / "Program" / "Session" / "Term" / "Registration" correctly
- All database columns are named correctly (no `programs.program_name` where it's really the curriculum)
- All code variables and function names match the vocabulary
- `MULTITENANT_AUDIT.md` exists at repo root, seeded with known items
- Codebase is ready for Chunks 1-3 to land cleanly

Then proceed to Chunk 1.
