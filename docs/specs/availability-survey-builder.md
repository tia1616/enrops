# Spec: Custom Availability Survey Builder (camps + after-school)

**Status:** Scoped, not built. Source of truth for the build-chats.
**Flagged:** 2026-07-02 by Jessica.
**Contexts:** after-school (term-keyed) + camps (cycle-keyed) — one shared builder, two default templates.
**Schema verified against live prod DB (`iuasfpztkmrtagivlhtj`) 2026-07-02.**

> 🔁 **Always re-verify against the live DB + schema before building — this spec may be stale.**
> Column names, tables, RLS, and constraints may have changed since it was written (2026-07-02).
> Treat every table/column/constraint reference here as "was true on 2026-07-02"; re-query
> `information_schema` + `pg_constraint` on **both** staging and prod and reconcile before any migration.

> ⚠️ **READ FIRST — this is NOT a standalone feature.** It is **sub-build #1 (Availability
> collection)** of the already-scoped, critical-path **Instructor schedule wizard** for FA26
> (`docs/backlog.md.md:137-143`, flow design in `docs/onboarding-checklist.md` §"Schedule wizard").
> That wizard has four sub-builds — availability collection (this), matching-rules UI
> (`org.matching_rules`), 3-question Ennie entry, and a matcher refactor to read the configured
> rules. Target: **late August 2026** (FA26 starts ~Sept 8); it's also called by the 11-step
> provider-onboarding wizard (tenant-2 blocker, July 31). **Build this as that wizard's availability
> module, not a parallel thing.** See §17 for the reconciliation + the scope pushback.

---

## 0. WHAT WE'RE BUILDING NOW (lean v1 — Jessica confirmed lens 2026-07-02)

Lean, nothing guessed/invented, no overengineering, most-useful-to-tenants-now. v1 serves **both**
Enrops scheduling models and ships in **three independently-useful phases** — validate each before
the next. Suggested order: **A (fall surveys, now) → C (membership/tenant-2) → B (editing).**

**The one real divider between models is who takes registration/money — NOT term-vs-monthly:**
- **Model 1 — Enrops takes reg (term-based, J2S):** existing `programs` + term/cycle availability +
  `match-afterschool`/`match-instructors` + offer/accept. **Unchanged.**
- **Model 2 — reg outside Enrops (Wufoo/own Stripe; monthly/ongoing, e.g. Shoreview Chess):** the
  `class_schedule` table (weekly recurring, no term/price), assigned via the manual dropdown in
  `src/pages/admin/ClassSchedule.jsx`. No term machinery.

### Phase A — the survey drawer (immediate need: fall)
1. **Right slide-in** replacing `SurveyDialog`; button relabeled **"Edit / Send Availability Survey"**.
2. **Live preview** of the real survey email (reuse `OfferDialog`'s iframe-preview pattern).
3. **Edit the intro + deadline** (rest of the email auto-generated/locked).
4. **Recipient picker** (reuse `OfferDialog`'s checkbox list) with **non-responders pre-selected**
   once the survey's been sent — the new-hire / straggler case.
5. **Fix** the hardcoded `jessica@journeytosteam.com` test-email → logged-in caller (§12.1).
6. Both term contexts (afterschool + camps); time-saved pill on send.

### Phase C — smart assign + recurring availability  [Model 2]
Assignment for outside-registration tenants is **LIVE (shipped 7/2)**: it happens on **Instructors →
Schedule** via the shared **`ClassScheduleView`** component in **`assignable={true}`** mode, gated by
`organizations.uses_enrops_registration` (boolean, default `true`; membership tenants = `false`). The
per-class `<select>` there (`assignInstructor` → writes `class_schedule.instructor_id`) is what this
scope makes intelligent. **The base surface already exists — this scope adds smarts ON TOP of it; do
NOT build a new assignment surface.** (Supersedes the earlier ClassSchedule.jsx reference and the
"owned by another chat" seam — that chat is done.)

Confirmed with Jessica: the **email survey is still the right collection method** even for a tiny
club — instructor fills it once, the system remembers, beats the owner hand-maintaining it.

Ships in three lean sub-steps, each independently useful — **order C1 → C2 → C3:**

**C1 — Conflict / double-booking warning (no new data; ship first).** Real bug caught in testing: a
coach was assigned to two overlapping classes with no warning. On the assignable surface, when an
instructor is (or is being) assigned, warn if they're already on another `class_schedule` row with
the **same `day_of_week`** and an **overlapping time window** — e.g. *"Coach Sam already teaches
Chess Club Mon 5:30–6:30 PM — overlaps this class."* **Warning, not a block** (operator confirms).
Pure client-side check over the org's already-loaded rows — no new table, no availability data
needed, so it's useful even before any survey goes out. Highest-certainty win; build it first.

**C2 — Recurring (term-less) availability capture.** NEW lean table
`instructor_recurring_availability(organization_id, instructor_id, weekday_availability jsonb,
submitted_at, updated_at, unique(organization_id, instructor_id))` — mirrors the existing
`weekday_availability` jsonb shape so the same survey widget works. RLS + grants, org-scoped. The
survey (recurring mode) asks which weekdays + time windows the instructor is generally free — not
tied to a term/cycle. Writes this row.

**C3 — "✓ free" positive hint in the dropdown (consumes C2).** For a class's `day_of_week` +
`start_time`/`end_time`, mark instructors who are free ("✓ free"); leave everyone else **unlabeled**;
**never mark anyone "busy"** (pushback #1) — soft/stale data must not make the operator skip a valid
coach. When no one has availability on file, the dropdown behaves **exactly like today**.

**Real formats (verified 2026-07-02 — build against these, not assumptions):**
- `day_of_week`: **Title Case** full day — "Monday", "Friday", "Saturday" (see `DAY_ORDER` in `ClassScheduleView`).
- `start_time`/`end_time`: **12-hour text with AM/PM** — "5:30 PM", "1:00 PM", "12:00 PM". The overlap
  parser (C1 + C3) must **parse 12-hour AM/PM → minutes** and compare numerically; string compare is
  wrong (pushback #5). No DB CHECK enforces the format — the importer does.
- **C3 cross-format note:** C1 compares `class_schedule` vs `class_schedule` (both 12h AM/PM). C3
  compares `class_schedule` (12h AM/PM) vs `weekday_availability` (survey-written) — have the recurring
  survey store times in one canonical form and normalize **both** sides to minutes. Don't assume they match.
- `uses_enrops_registration`: boolean, default `true`. `class_schedule` is LIVE on prod but **empty
  there** (0 rows); staging has real rows. No cross-org leak — `ClassScheduleView` scopes reads by
  `organization_id` (RLS).
- **NO auto-assign, NO offer/accept, NO new matcher edge fn.**

### Phase B — simple question editing  [both models]
Providers **can** edit/add questions — the simple version, **not** a form builder:
- **Standard matcher (wired) questions:** reorder + show/hide + add an optional description/help line.
  **Labels are LOCKED** (pushback #4) — renaming "Which weekdays can you teach?" → "Which do you
  *prefer*?" would silently change the answer's intent and corrupt matching. Can't delete the engine.
- **Add their own questions** — a few types: short text · paragraph · single-choice · multi-choice ·
  yes/no. Free label. Informational only (matcher ignores them).
- **Storage (lean, no 4-table builder), context-keyed (pushback #6):**
  `org_survey_config(organization_id, context, intro text, custom_questions jsonb, updated_at,
  unique(organization_id, context))` where `context ∈ {afterschool, camp, recurring}` — so a tenant
  running more than one model gets its **own** intro + custom questions per context, not one shared
  blob. Answers land in an **additive nullable `custom_answers jsonb`** column on each availability
  table. Instructor form renders the standard fields + loops `custom_questions` to append inputs. No
  dynamic-everything renderer, no versioning table.
- **NOT in v1:** deleting/replacing matcher questions; renaming wired-question labels; per-question
  logic/branching; answer-version snapshots.

### Total schema changes (all additive; staging first, prod same pass — parity)
- NEW `instructor_recurring_availability` (Phase C) — RLS + grants.
- NEW `org_survey_config` (Phase B), **keyed `(organization_id, context)`** — RLS + grants. Editable
  intro + custom questions live here, per context (supersedes the earlier single-blob / "custom_intro
  on the state row" ideas).
- Phase C's smart-assign work (conflict warning C1 + "✓ free" hint C3) is **added onto the existing
  `ClassScheduleView` (`assignable` mode)** — no new tables for C1/C3, no new surface. Only C2 adds a
  table (`instructor_recurring_availability`).
- ADD nullable `custom_answers jsonb` to `instructor_term_availability`, `instructor_availability`,
  `instructor_recurring_availability` (Phase B).
- **No other new tables.** Everything in §2–§16 (the full four-`survey_*`-table builder + dynamic
  renderer) stays DEFERRED design reference — **do not build it for v1.**

### Verified schema (live DB, 2026-07-02)
- `class_schedule` is **LIVE on prod (shipped 7/2)** — empty on prod (0 rows), real rows on staging.
  Columns: `instructor_id uuid null`, `day_of_week text` (Title Case), `start_time`/`end_time` **text**
  (12h AM/PM), `location_text`, `offering_id`, `program_location_id`, `effective_start/end_date`,
  `status`, `source`, `capacity`, `age_min/max`, `age_format`, `instructor_name/email`.
- `organizations.uses_enrops_registration` exists — boolean, default `true` (gates the assign surface).
- Assign surface is LIVE: `src/pages/admin/ClassScheduleView.jsx` (`assignable` mode), no conflict logic yet.
- No recurring-availability or survey-config table exists yet.
- `weekday_availability` jsonb shape confirmed on `instructor_term_availability` (reuse for recurring).

### Verify-before-build (Phase C) — mostly resolved 2026-07-02
- [x] Time format: `class_schedule` times are **12h AM/PM text**; day is **Title Case**. Parser must
  handle 12h AM/PM → minutes.
- [x] RLS: `ClassScheduleView` already scopes `class_schedule` reads by `organization_id`.
- [ ] **Still open:** decide the canonical time format the recurring survey (C2) writes into
  `weekday_availability`, and normalize **both** sides to minutes in C3 (don't assume the survey and
  `class_schedule` share a format).
- [ ] Re-confirm all of the above against the live DB at build time (schema may have moved again).

The non-responder picker (A) shares code with the schedule wizard's Ennie Q2 straggler-nudge (§17A).

---

## 1. Problem & goal

Today the availability survey is fixed: providers can't preview, edit, or choose recipients.
The email copy is hardcoded in the edge functions; the questions are hardcoded in two React
forms; sending is all-active-instructors, all-or-nothing.

**Goal:** a provider opens one **right slide-in drawer** where they can (a) edit/add **any**
questions — ours become a starting template, (b) edit the email message + deadline, (c) preview
both the email and the instructor form, and (d) choose who to send to — with new-hires / non-
responders pre-selected so "send to the people who haven't answered yet" is one click.

Audience: non-technical operators. The builder should feel like Google Forms, with inline
coaching and safe defaults.

---

## 2. Core design principle (the crux)

Providers get **fully custom questions**. The one logical constraint: **the auto-matcher runs on
specific structured answers.** We resolve this honestly, not with a hard lock:

> Every question is custom. A few question **types** are *wired to the auto-scheduler*.
> Keep them → Enrops builds the schedule for you. Delete them → the survey still works as a
> plain questionnaire; you just place instructors manually.

That's graceful degradation: total freedom, but the auto-scheduling value is preserved when the
wired questions are present. It's explainable in one sentence to a non-tech user.

---

## 3. Current-state map (verified against code 2026-07-02)

| | After-school | Camps |
|---|---|---|
| Survey "open" state | `afterschool_survey_state` (org, term, opened_at, deadline, updated_at) | flag `scheduling_cycles.availability_survey_opened_at` |
| Keyed by | `term` (e.g. `FA26`) | `cycle_id` |
| Send fn | `supabase/functions/send-afterschool-survey` | `supabase/functions/send-availability-survey` |
| Instructor form | `src/pages/j2s/AfterschoolAvailabilityForm.jsx` | `src/pages/j2s/InstructorAvailabilityForm.jsx` |
| Matcher | `match-afterschool` | `match-instructors` |
| Canonical answer tables | `instructor_term_availability`, `instructor_term_area_preferences` | `instructor_availability` + `instructor_location_preferences` + `instructor_curriculum_preferences` |
| Admin surface | `src/pages/admin/AfterschoolSchedule.jsx` (`SurveyDialog`, `Header`) | `src/pages/admin/Schedule.jsx` |
| "Submitted" marker | `instructor_term_availability.submitted_at` | `instructor_availability.submitted_at` (verified — same shape) |
| Structured unavailable-dates | **MISSING** — no date column; only free-text `notes` (the gap to close) | `instructor_availability.unavailable_dates` (`date[]`) already exists |

**Verified live columns (prod, 2026-07-02):**
- `instructor_availability` (camp): `session_types[]`, `available_weeks[]`, `available_days[]`, `available_terms[]`, `unavailable_dates[] (date)`, `unavailable_notes`, `saturdays_ok`, `role_preference`, `developing_min_enrollment`, `needs_confirmation`, `submitted_at`.
- `instructor_term_availability` (afterschool): `weekday_availability jsonb`, `min_days`, `max_days`, `preferred_categories[]`, `needs_confirmation`, `notes`, `submitted_at`. **No dates column.**
- `instructor_location_preferences`: `location_name`, `preference`. `instructor_curriculum_preferences`: `curriculum_category`, `preference`.
- `scheduling_cycles`: `availability_survey_opened_at`, `survey_deadline`, `auto_reminders_enabled`, `dev_instructor_threshold`, `weeks jsonb`, `status`.
- `afterschool_survey_state`: `organization_id`, `term`, `opened_at`, `deadline`, `updated_at`.
- **No `survey_*` builder tables exist.** `organizations.matching_rules` does **not** exist yet (sub-build #2 will add it).

The offers dialog in `AfterschoolSchedule.jsx` (`OfferDialog`, ~line 1911) already implements the
exact recipient-picker + iframe-preview pattern we mirror. Reuse it.

---

## 4. Data model (additive, empty-by-default, both envs same pass)

> Build-chat must gate every DDL step: query `pg_constraint` (incl CHECK) before relying on shape,
> add RLS + GRANTs on every new public table (org-scoped), verify column names against the live DB.
> No hardcoded tenant slug/UUID anywhere. Schema hits **staging AND prod in the same pass** (parity).

```
survey_definitions
  id                uuid pk
  organization_id   uuid  not null            -- RLS scope
  context           text  not null            -- 'afterschool' | 'camp'   (CHECK)
  term              text  null                 -- set for afterschool
  cycle_id          uuid  null                 -- set for camps
  is_org_default    bool  not null default f   -- the reusable template (term/cycle both null)
  created_at, updated_at
  -- exactly one of (term, cycle_id) set for a live survey; org-default has neither.

survey_questions
  id                uuid pk
  definition_id     uuid  not null  -> survey_definitions
  sort_order        int   not null
  type              text  not null            -- see §6 (CHECK against allowed set)
  label             text  not null
  help_text         text  null
  required          bool  not null default f
  options           jsonb null                 -- for choice types
  matcher_binding   text  null                 -- see §5 (null = informational only)
  is_system         bool  not null default f   -- came from template vs provider-added

survey_responses
  id                uuid pk
  definition_id     uuid  not null  -> survey_definitions
  instructor_id     uuid  not null
  submitted_at      timestamptz null
  unique (definition_id, instructor_id)

survey_answers
  id                uuid pk
  response_id       uuid  not null  -> survey_responses
  question_id       uuid  not null  -> survey_questions
  value             jsonb not null
  question_label_snapshot text not null        -- frozen at answer time; protects history
```

Store an **org-level default template** (`is_org_default = true`). When a survey is first opened
for a term/cycle, **snapshot** the default into a new definition. Editing one term never rewrites
history or the next term.

---

## 5. Binding layer — keeps the matchers untouched

Matcher-bound answers **dual-write**: into `survey_answers` (generic capture) **and** into the
canonical table the matcher already reads. Custom questions write to `survey_answers` only.
**The matchers do not change.** (Additive-and-empty: the working scheduler keeps working.)

| `matcher_binding` | Context | Dual-writes to (verified columns) |
|---|---|---|
| `weekday_time` | afterschool | `instructor_term_availability.weekday_availability` (+ `min_days`/`max_days`) |
| `area_ranking` | afterschool | `instructor_term_area_preferences` (row per `area` + `preference`) |
| `unavailable_dates` | afterschool | **needs new `instructor_term_availability.unavailable_dates date[]` column** (afterschool gap; camp already has it) |
| `camp_weeks` | camp | `instructor_availability.available_weeks[]` |
| `session_type` | camp | `instructor_availability.session_types[]` |
| `location_pref` | camp | `instructor_location_preferences` (`location_name` + `preference`) |
| `curriculum_pref` | camp | `instructor_curriculum_preferences` (`curriculum_category` + `preference`) |
| `role_pref` | camp | `instructor_availability.role_preference` |
| `unavailable_dates` | camp | `instructor_availability.unavailable_dates[]` (exists) |
| `null` | either | `survey_answers` only (informational) |

**Alignment with sub-build #4 (matcher refactor):** `match-instructors` (and eventually
`match-afterschool`) are slated to be de-J2S-hardcoded to read `org.matching_rules` jsonb. The
binding layer above is orthogonal to that (it's about *where instructor answers land*, not *how the
matcher weighs them*) — but the two must be designed together so the "which answers exist" contract
and the "how rules consume them" contract don't drift. Don't ship a binding vocabulary here that
the matching-rules UI can't reference.

**Graceful degradation:** if a provider deletes all bound questions for a context, the matcher for
that context simply has no input and auto-match is skipped — the survey still collects and stores
answers; the provider assigns manually. Deleting a bound question shows a coaching warning (§8).

---

## 6. Question types (Google-Forms-simple)

Generic: `short_text` · `paragraph` · `single_choice` · `multi_choice` · `dropdown` · `yes_no` ·
`date` · `date_range` (covers "dates I can't make") · `number` / `rating`.

Wired (pre-placed by templates, badged "Powers auto-scheduling"):
- After-school: **weekly availability grid** (`weekday_time`), **program areas ranking** (`area_ranking`).
- Camps: **which weeks** (`camp_weeks`), **session types** (`session_type`), **locations**
  (`location_pref`), **role preference** (`role_pref`).

## 7. Default templates (two, seeded from the current hardcoded forms)

- **After-school seed** ← `AfterschoolAvailabilityForm.jsx`: weekday grid (from/until), days-per-week
  (No limit / 1–2 / 3–4 / 4–5), program areas (LEGO/Coding/Robotics, ranked), notes.
- **Camp seed** ← `InstructorAvailabilityForm.jsx`: which weeks, session types (morning/afternoon/
  full-day), locations, curricula, role preference (lead/either/developing), Saturday availability,
  unavailable-date notes, free notes.

Keep them strictly separate — the camp seed must not leak weekday-recurring fields, or vice-versa.

---

## 8. Builder drawer — right slide-in, three steps

Mirrors Typeform / Sawyer / Google Forms (Build → Preview → Send). New `SlideOver` component
(we only have centered `Overlay` today).

Button label (replaces "Open/Resend availability survey"): **"Edit / Send Availability Survey"**
(constant label; live state shows underneath as now: "Survey open · 3 of 7 submitted · due Aug 15").

1. **Build** — question cards; drag to reorder; add (type picker); edit label/help/required/options;
   delete. Wired questions badged. **Coaching warning** on deleting a wired question, and on
   deleting/retyping a question that already has responses (§9).
2. **Preview** — render **both** the email **and** the instructor form exactly as the instructor
   sees it (reuse the iframe preview pattern from `OfferDialog`).
3. **Send** — editable email message + deadline, then the recipient picker (§10), then send.
   "Send test to me" + "Send to N". Time-saved pill on send.

## 9. Edit-after-responses rules (the real hazard)

Once any response exists for a definition:
- **Allowed freely:** add questions; edit label / help / required.
- **Warn-or-lock:** deleting a question, or changing its `type` / `options`, when it already has
  answers → warn ("N people already answered this — hiding keeps their answers but removes it for
  new responders"). `question_label_snapshot` on `survey_answers` preserves historical integrity.
- Recommended: soft-hide (a `hidden` flag) rather than hard delete once answered.

## 10. Audience picker + non-responder default

Mirror `OfferDialog`'s picker (checkbox list, select-all/clear, live count, per-name chip).
- ✓ submitted / ○ waiting chip per instructor.
- **Smart default:** never sent → all active instructors pre-selected. Already sent → **only
  non-responders pre-selected** ("4 haven't responded — pre-selected: Sarah, Marcus, Dev, Priya").
- Covers the new-hire case: hire week 3, open drawer, they're auto-selected, send to just them.
- This is also the **manual survey nudge** (doesn't exist today — existing auto-reminders are for
  *offers*, not surveys).
- Non-responder detection is per context: after-school = `instructor_term_availability.submitted_at`
  is null; camps = **[VERIFY]** the equivalent submitted marker.

## 11. Dynamic instructor-facing form (biggest chunk)

`AfterschoolAvailabilityForm.jsx` and `InstructorAvailabilityForm.jsx` become **generic renderers**
driven by the definition: render questions in order, enforce `required`, persist wired answers to
canonical tables + all answers to `survey_answers`. The current hardcoded forms become the seeds.

---

## 12. Pressure-test / guardrail checklist (fold into build)

1. **Multi-tenant bug — fix in same pass:** "Send test to me" is hardcoded to
   `jessica@journeytosteam.com` in BOTH send fns → on another org the test goes to Jessica. Route
   to the logged-in caller's email instead.
2. **New tables:** RLS + GRANTs, org-scoped; no hardcoded slug/UUID. Staging + prod same pass.
3. **Preview must render the dynamic form,** not just the email.
4. **Eat the cooking (P2 gate):** submit a real response, SELECT it back, run the matcher, confirm
   a schedule builds — before calling the renderer done.
5. **Two default templates, one builder** — no field leakage between contexts.
6. **Time-saved pill** on send.
7. **Empty/loading/error states** in the drawer (no questions yet; no active instructors; send
   partial-failure).
8. **Test as anon** where the instructor form is public-facing (RLS not visible to admin).

## 13. Verify-before-build (resolved 2026-07-02 unless noted)

- [x] Camp "submitted" marker → `instructor_availability.submitted_at` (same as afterschool).
- [x] Camp pref tables → `instructor_location_preferences.location_name`, `instructor_curriculum_preferences.curriculum_category`.
- [x] Camp survey open/close → `scheduling_cycles.availability_survey_opened_at` (+ `survey_deadline`).
- [x] Structured unavailable-dates → exists on camp (`unavailable_dates date[]`); **missing on afterschool** → new column needed.
- [ ] **Still required per-migration:** `pg_constraint` (incl CHECK) + RLS + GRANTs on every new table, verified against live, before `apply_migration`. Confirm on **staging first**, then prod same pass.
- [ ] Confirm whether `match-afterschool`/`match-instructors` are being refactored to `org.matching_rules` in a parallel chat before finalizing the binding vocabulary (§5).

---

## 14. Phasing (sequence for build-chats)

Two tracks depending on decision #4 (§17C). **Recommended = the "custom-lite" track**, which ships
the FA26-critical value fast and defers the risky builder rewrite.

**Custom-lite track (recommended, FA26-safe):**
- **L1 — Editable message + audience picker + non-responder default** on the *existing* survey
  dialogs (both contexts). No schema-heavy builder. Ships the "preview/edit message, choose who,
  nudge stragglers" value in days. Fold in the hardcoded-`jessica@` test-email fix (§12.1).
- **L2 — Structured `unavailable_dates` for afterschool** (new column + date picker on the form).
  Closes the named gap; camp already has it.
- **L3 — Append-only custom questions** (generic types → `survey_answers`), matcher questions stay
  standardized (reorder/relabel/hide). Provider "adds their own questions" without touching the engine.
- **L4 — Survey-reminder cadence** reusing the reminders cron/infra (§17E).

**Full-builder track (Phase 2, after FA26 — only if decision #4 says so):**
- **P1 — Schema + binding layer.** The four `survey_*` tables, RLS/grants, dual-write, seed templates.
- **P2 — Dynamic instructor renderer.** Definition-driven form; matchers must still pass (§12.4).
- **P3 — Builder drawer** (Build/Preview/Send), add/remove/retype-anything.
- **P4 — Edit-after-response versioning** (§9).
- **P5 — Camps parity** on the full builder.

Either way, keep the audience-picker/non-responder code shared with the schedule wizard's Ennie
Q2 straggler-nudge (§17A) so there's one implementation, not two.

## 15. Open decisions
- Edit-after-responses rule (§9) — rec: add/relabel free, warn-or-soft-hide on destructive edits.
- Template scope — rec: org-level default snapshotted per term/cycle.
- Question types v1 — full list (§6) or trim (e.g. drop rating/number to start)?

## 16. Out of scope (later)
Per-question branching/logic; SMS survey; cross-term template library UI; parent/family surveys.

---

## 17. Reconciliation with the FA26 schedule wizard + scope pushback

This spec was written as a standalone survey builder. Verifying against the backlog changed that:
it collides with an already-scoped, **critical-path** feature. The build-chats must reconcile these,
and there's a real scope decision for Jessica.

**A. It's sub-build #1 of the schedule wizard, not a new island.**
`docs/backlog.md.md:137-143` scopes the "Instructor schedule wizard" (late-Aug FA26 target) as:
1. Availability collection — **survey OR upload** (this spec covers the survey half only).
2. Matching-rules UI → `org.matching_rules`.
3. 3-question Ennie entry (Q2 = availability state: none→send survey/upload; partial→**nudge
   stragglers**; complete→draft).
4. Matcher refactor to read the rules.
The onboarding-checklist §"Schedule wizard" already specifies the exact straggler-nudge copy
("I've got availability from 8 of 12 — nudge the 4, or move ahead?"). **Our audience picker's
non-responder default IS that nudge.** Build it so Ennie's Q2 and the drawer call the same code.

**B. The upload path (Path B) must coexist — this spec ignored it.**
Providers can skip the survey entirely and upload a sheet (xlsx/csv/Google Sheet/pasted text) →
LLM parses → per-instructor preview/confirm → writes the same `instructor_availability` /
`instructor_term_availability` rows. The survey is one of two doors to the same room. The drawer
should not present itself as the only way to get availability in.

**C. Scope pushback — a full Typeform-style custom builder is probably the wrong v1.**
Jessica asked for "edit/add any questions." I'd push back on doing that *first*, for three reasons:
- **Deadline math.** FA26 needs a working schedule by late Aug; tenant-2 onboarding is July 31. A
  generic form-builder + dynamic renderer + edit-after-response versioning is weeks of work and
  rebuilds two working forms. It's the highest-risk path to a hard date.
- **The matcher needs structure.** The whole value is auto-scheduling. 90% of what a provider
  actually needs to *customize* is the **message/wording**, the **deadline**, and **a couple of
  their own informational questions** — not restructuring the matcher inputs.
- **The real, named gap is smaller:** afterschool has **no structured `unavailable_dates`** field
  (backlog + `project_enrops_survey_import_gap.md` + `SCHEDULING_ROADMAP.md:140-143`). Closing that
  one gap + editable message + audience picker delivers most of the value now.

  **Recommended v1 ("standardized + custom-lite"):** keep the matcher questions standardized
  (reorder / relabel / show-hide only), **add the structured unavailable-dates picker for
  afterschool**, allow providers to **append their own informational questions** (the generic types
  in §6), editable message, audience picker with non-responder default. **Defer the full
  add/remove/retype-anything builder + dynamic-renderer rewrite to a Phase 2** after FA26 ships.
  This still lets a provider "add questions they want" — it just doesn't let them delete the engine.

  If Jessica still wants the full builder as v1, that's a legitimate call — but it should be a
  conscious trade against the FA26 date, not the default. **This is decision #4 below.**

**D. Best-practice grounding (checked 2026-07-02).**
- Availability/preference surveys are a recognized category with a standard shape: submit →
  manager-approve in the schedule view → analytics on patterns
  ([MyShyft](https://www.myshyft.com/blog/availability-and-preference-surveys/)). Our submit →
  offers loop → board already matches this.
- "Send reminders **only to non-responders**" is explicit best practice; the one caveat (can't
  target on anonymous surveys) doesn't apply — ours are identified. Reminders should be **set up at
  survey-creation time**, on a cadence (1–3 follow-ups, ~24–72h apart), not only fired manually
  ([TheySaid](https://www.theysaid.io/blog/write-a-perfect-survey-reminder-email),
  [Jotform](https://www.jotform.com/blog/how-to-write-a-survey-reminder-email/)).

**E. Reminder cadence — fold in, don't reinvent.**
We already have `scheduling_cycles.auto_reminders_enabled` + a cron + `AfterschoolReminders` UI, but
it fires on **offer** responses, not **survey** submissions. Add a survey-reminder cadence
(scheduled at send time, auto-targets non-responders, stops on submit) reusing that infra rather
than building a second reminder system. The manual "send to non-responders" (§10) is the on-demand
version of the same thing.

**Revised decision list (supersedes §15):**
1. Edit-after-responses rule — add/relabel free, warn-or-soft-hide on destructive edits (§9).
2. Template scope — org default snapshotted per term/cycle.
3. Question types v1 — full list (§6) or trim.
4. **★ v1 ambition — "standardized + custom-lite" (recommended) vs. full custom builder now.**
5. Survey vs. upload — confirm both doors ship together (or upload lands in a later wizard chunk).
6. Reminder cadence — auto survey-reminders at send time, or manual-nudge only for v1.
