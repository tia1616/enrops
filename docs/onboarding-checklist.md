# Provider onboarding — running checklist

_Started 2026-06-02. Living doc — every time we land on "this needs to be in onboarding," add it here with one-line rationale._

**Scope:** New **provider/tenant** signs up to use Enrops. NOT to be confused with the existing instructor/contractor onboarding wizard (BGC, Stripe Connect, ORS cert), which lives at `/:slug/instructor/onboarding` and is a separate flow run by individual instructors after a provider invites them.

**Target shape** (from `project_enrops_platform_vision.md`): single-sitting (~30–45 min) with save+resume. Ennie runs a highlighted-overlay tour (rest of screen greyed). On every step, surface "I can do this for you" as the default path — provider opts into manual only if they want to.

**Agent name:** Ennie. (Earlier specs used Director/Dora/Don for different Hats — consolidated to Ennie as of 2026-06-02.)

---

## Pre-requisite checks (Director asks before anything else)

These set the branching for the rest of onboarding.

- [ ] **What term are you planning?** → sets cycle context (summer camps / afterschool / mixed). Avoids assuming structures (weeks vs. days vs. one-time).
- [ ] **Do you already have programs/classes scheduled, or are you starting fresh?** → routes to "build schedule in Enrops" vs. "import your existing schedule."
- [ ] **Will registrations run through Enrops, or are you using your own system?** → gates which downstream nudges fire.
- [ ] **Do you need to make an instructor schedule for upcoming classes?** (yes/no — added 2026-06-02)
  - If yes → **Do you have their availability, or do you need to send a survey?**

---

## Step-by-step (every step shows "Ennie can do this for you" by default)

### 1. Org identity + branding
- [ ] Org name, slug, timezone, contact email
- [ ] Brand colors + fonts + logo upload (writes `org_branding`)
  - *Why:* every tenant-facing surface reads from `org_branding`; never hardcode tenant identity. (`feedback_workflow.md`)
- [ ] Brand voice JSON for marketing (defaults out of the box, tune if desired) — `project_enrops_marketing_standing_rules.md:54`

### 2. Pricing + Stripe Connect
- [ ] Connect Stripe (Standard vs. Express, recommend Express for low-friction) — `project_enrops_pricing_v1.md`
- [ ] Application-fee tier confirmed (free-to-start framing — "Free to start. We earn when you earn.")
- [ ] Absorb-vs-pass-through fee toggle
- [ ] Per-tenant pay variation — schema work queued (`project_enrops_pay_scheme.md:46`); for v1 use defaults

### 3. Locations
- [ ] Add locations (sites/venues they teach at)
- [ ] District calendar associations (for session-date math — `feedback_session_date_function.md`)
- [ ] Closure dates per location
- [ ] **Cleanup:** proper `districts` table refactor is queued (`project_enrops_districts_table_followup.md`) — current text column is good enough for v1

### 4. Curriculum / programs (the "what we teach" catalog)
- [ ] Upload existing curriculum docs (PDF, Word, Google Doc) → Ennie extracts → provider reviews
  - *Why:* curriculum is upstream — feeds marketing emails, registrations, instructor schedules (`project_enrops_curricula_upstream.md`)
- [ ] Show AI-wait UI on extraction ("usually takes X–Y seconds" + live `m:ss` counter) — `feedback_ai_wait_ui.md`
- [ ] "Polish with Dora" pattern for soft/mundane skills output — `project_enrops_polish_skills.md`
- [ ] **Minimum and maximum class size per curriculum** (`curricula.class_size_min` / `class_size_max`) — Ennie extracts when present in the uploaded doc, otherwise asks. Phrasing: _"What's the smallest class you'll run for this — and the biggest you'll take?"_
  - *Why:* drives "low enrollment" detection across Family Comms (low-enrollment-only push), instructor scheduling viability checks, and parent comms about cancellation thresholds. Without these, every feature reaches for an arbitrary `enrolled < 6` heuristic that won't fit other tenants. Added 2026-06-02 — `feedback_build_right_first_time.md`.

### 5. Program/camp schedule (NEW — added 2026-06-02)
**Prerequisite to instructor scheduling.** Provider must have a list of scheduled programs before they can match instructors to them.

- [ ] **Path A — build in Enrops:** "Where do I create my program schedule and open registrations?" → walk to the right surface (see GAP below)
- [ ] **Path B — import existing:** upload .xlsx / .csv / Google Sheet / paste → Ennie parses → provider reviews preview → writes to `programs` / `camp_sessions`
- [ ] **GAP:** there is no provider-facing "create program from scratch" UI today. `programs` and `camp_sessions` are seeded via Tracker sync (J2S only) or manual SQL. Need to build the create flow before this step is real. (Confirmed 2026-06-02 — only `ProgramsCalendar.jsx` + `EditProgramCurriculumModal.jsx` exist, no create surface.)
- [ ] **Step 2 of the create-program wizard should offer linking a district calendar regardless of whether the program is school-based** — programs usually skip holidays and major no-school days even when run from studios or community centers. Provider can also add/remove dates manually via the existing `CalendarsList` page (`/admin/calendars`).

### 6. Instructors (the roster)
- [ ] Invite instructors via email — magic-link onboarding wizard handles their side (BGC, Stripe Connect, ORS)
- [ ] **Import path for existing instructor roster:** upload sheet of names + emails → bulk-invite
- [ ] **Cleared-instructor handoff:** Ennie announces on admin home when BGC+Stripe both clear, with next-action card — `project_enrops_dora_homescreen_cleared.md` (note: old spec used "Dora" — same surface, renamed to Ennie)

### 7. Instructor availability collection (NEW — added 2026-06-02)
- [ ] **Path A — survey:** Ennie sends per-term availability survey to all instructors
- [ ] **Path B — upload:** provider uploads existing availability (xlsx / csv / pdf / doc / Google Sheet link / pasted text) → LLM parses → preview per-instructor with confidence per row → provider confirms → writes `instructor_availability` rows
- [ ] **Rule derivation from upload:** parser scans for patterns ("no one works Fridays," "all available 9–12") and surfaces as suggested defaults (not auto-applied)
- [ ] **Survey design must include structured `unavailable_dates`** (not just prose) — `project_enrops_survey_import_gap.md` + `SCHEDULING_ROADMAP.md:140-143`

### 8. Matching rules / priorities (NEW — added 2026-06-02)
**Configured once in onboarding, edited per-term via a "review priorities" link.**

- [ ] Show three columns:
  - **Hard rules (always on, can't reorder)** — physics, not preference
  - **Warnings (toggle each one on/off)** — soft, provider chooses what to enforce
  - **Priorities (drag-drop order)** — scoring weights
- [ ] Explanation at the top, in provider's voice (draft): _"These are the rules Ennie uses to suggest instructor matches. Hard rules are always on — they catch impossible situations. Warnings flag things you might want to know about. Priorities decide who Ennie picks first when more than one person fits. You'll see her suggestions before anything is final, and you can override anything."_
- [ ] Per-instructor "minimum sessions per term" field + optional tier defaults (Senior / Lead / Developing) — this is how Ennie learns who has seniority / promised days
- [ ] **Program-shape-agnostic by default** — phrase rules generically, store the camp-specific ones in a separate "Camps-only rules" section that only renders if the provider runs camps
- [ ] **Camps-specific rule set** (only shown if provider has camp-type programs):
  - Session type matching (AM / PM / full-day)
  - Week-overlap detection
  - Developing-instructor pairing (only on camps at or above the enrollment threshold, lead must be assigned first)
  - Single-site continuity bonus (AM+PM at same site same week)
- [ ] **Generic priorities** (apply to all program types):
  - Quota / promise honored (per-instructor minimums)
  - Location preference
  - Curriculum preference
  - Load balance
  - Confirmed availability beats admin-entered

### 9. Marketing defaults
- [ ] Brand voice JSON confirmed
- [ ] Six parent lifecycle emails — opt in/out per email (Thank you, Welcome, How's it going, Mid-term recap, Final recap, Happy birthday) — `project_enrops_platform_vision.md:32`
- [ ] Marketing standing rules (throttle, send times, deadline pattern) — `project_enrops_marketing_standing_rules.md`

### 10. Operational automations (opt-in)
- [ ] Stripe receipt, pre-charge reminder, failed-charge alerts
- [ ] Roster auto-send, roster auto-update
- [ ] Cron-skip operator alert
- [ ] Scheduled reminders catalog (3-month-before-term facility reservations, COI renewals, BGC expirations) — `feedback_scheduled_reminders.md`

### 11. Contacts / team
- [ ] Add admins (Jessica + Arielle pattern — `project_enrops_admins.md`)
- [ ] Role permissions

---

## Cross-cutting copy + UX rules

- [ ] **No tech jargon** anywhere in onboarding copy — translate enum status, strip version chips — `feedback_no_tech_jargon.md`
- [ ] **Pricing copy** uses "Free to start. We earn when you earn." — `project_enrops_pricing_v1.md`
- [ ] **"Not now" always** as tertiary action on every card — `feedback_enrops_principles.md`
- [ ] **3-question pattern** per Hat — `project_enrops_platform_vision.md`
- [ ] **AI wait UI** wherever extraction/generation happens — `feedback_ai_wait_ui.md`
- [ ] **Save + resume** — single-sitting target but resumable across sessions
- [ ] **Mid-cycle entry detection** — providers onboarding with existing data enter at different phases of the term cycle — `project_enrops_term_cycle.md`
- [ ] **Ennie keeps nudging missing pieces** via cards + weekly summary email (never alarmist, always opportunity + LTV) — `project_enrops_platform_vision.md:38`

---

## Existing related specs (read before designing each step)

- `Provider Onboarding (sketch)` — `1WFE3MfEyiCdEqSg5GDBwTJ5TU3QlYFgyCcf87N00Z5o`
- `Spec_Scheduling_Setup_Onboarding` — `16dDSIzqW-XPZ2O_zBw5oul_zoSBPExfT`
- `agent7_provider_onboarding` (CS inbox automation) — `15BGTFgsnPWBkbTnlSPzkgqNFSR2FPKhI`
- `Spec_01_HomeScreen_Director_v3` — `1ao7Stk91WGcnKOl1XisD5CxKaThC7-RK`

---

## Schedule wizard — 3-question entry flow (NEW — added 2026-06-02)

The schedule wizard isn't part of onboarding — it's a recurring per-term action. But the **way the provider gets into it** matters because non-tech-savvy operators are the target user. Ennie detects state and only asks what's missing.

**Entry point:** card on the admin home that says _"Ready to schedule instructors for [Fall 2026]? I'll get you a draft in 3 steps."_

### Question 1 — Term (Ennie detects, provider confirms)
Ennie reads the current scheduling cycle and asks:

> _"You're scheduling for **Fall 2026** (Aug 26 – Dec 18). Look right?"_
> [Yes, let's go] [Different term]

If no active cycle exists → Ennie asks the provider to pick one and creates it.

### Question 2 — Availability (Ennie checks state, adapts the question)
Ennie counts `instructor_availability` rows for this cycle vs. the active instructor roster:

- **State A — no availability yet:** _"I haven't heard from your instructors about when they can work this term. Want me to send the survey now, or do you have their availability in a sheet I can read?"_ → [Send survey] [I have a sheet]
- **State B — partial:** _"I've got availability from **8 of 12** instructors. Want me to nudge the 4 who haven't replied, or move ahead with what I have?"_ → [Send reminder] [Move ahead]
- **State C — complete:** _"I have availability from everyone. Ready when you are."_ → [Generate draft]

### Question 3 — Confirm priorities (only if first time or provider asks)
On first cycle: _"One last thing — these are the rules I'll use to decide who gets matched first. Want to review them, or use the defaults?"_ → [Review] [Use defaults]

On returning cycles: skip Q3 entirely. Provider can edit priorities anytime from settings; not asked every term.

### Then — Ennie generates draft + approval card
- AI wait UI (recommended duration + live `m:ss` counter, per `feedback_ai_wait_ui.md`)
- Draft schedule renders as the approval card you've seen elsewhere — ship it / change these / hold

### Prerequisites Ennie silently checks before offering the card at all
- Provider has at least one program/camp in this term (Step 5 of onboarding done — if not, Ennie offers Path A or B for program creation instead)
- Provider has at least one active instructor in roster (if zero, Ennie surfaces the invite-instructors card instead)
- Matching rules saved (if not, Ennie routes to onboarding Step 8 first)

**Why this works for non-tech operators:** Ennie does the state-checking and only asks the provider what she can't figure out herself. The provider always feels like she's being asked the next-obvious question, never confronted with a setup screen.

---

## Follow-ups discovered while building Path A (2026-06-02)

- [ ] **Add `curricula.default_price_cents` column + UI to set it during curriculum upload.** Then the create-program wizard's Step 3 auto-fills price when a curriculum is picked (provider can still override). Today the wizard asks for price every time; the J2S "robotics = $299 / standard = $285" logic is a keyword-matching fallback in `src/lib/pricing.js`, not data. A real per-tenant solution stores it on curriculum.
- [ ] **Per-tenant term configuration.** `TERM_OPTIONS` (`FA26/WI27/SP27`) is hardcoded in `ProgramsCalendar.jsx` and `ProgramWizardNew.jsx`. The DB CHECK constraint enforces format only (`^(FA|WI|SP|SU)[0-9]{2}$`), so any term name in that format is allowed — but the dropdowns are limited. Tenants with different cadences (camp-only summer, year-round, quarter system) need a per-tenant term list. Suggested home: `organizations.terms` jsonb array of `{ value, label }`. Add to provider onboarding as a step: "What terms do you run?"
- [ ] **Include-drafts toggle for the instructor schedule wizard.** When provider runs the schedule wizard, default behavior matches only scheduled programs with `status='open'`. Add an "Include drafts" toggle so a provider planning ahead can include not-yet-published programs they expect to run. Confirmed 2026-06-02 — edge case but worth the option.
- [ ] **Wizard "+ Add new curriculum/location" links** now open in a new tab so wizard state isn't lost on return (replaces the confusing "(you'll come back here after)" copy). v2 should still upgrade these to inline drawer so the provider never leaves the wizard.

## Nav reorganization (proposed, not yet applied)

Current `AdminLayout` NAV mixes "stuff about programs," "stuff about instructors," and "stuff about classes" at the top level. Cleaner shape:

```
Overview
Family Comms

Programs (group):
  - Curricula
  - Scheduled programs
  - Class rosters       ← moves from top-level Rosters
  - Locations
  - School calendars

Instructors (group):    ← NEW group
  - Roster              ← what was top-level Instructors
  - Schedule            ← moves from top-level (it's instructor→program matching)

Contacts
Money (group)
Settings
```

Why this is cleaner:
- Schedule's center of gravity is instructors, not programs. Moving it under Instructors makes that obvious.
- Class rosters are about programs (who enrolled in what), so they belong with Programs.
- Each top-level item now has one subject.

Decision pending from Jessica — small change, but it touches the NAV constant in `AdminLayout.jsx`. Don't apply until confirmed.

---

## Known gaps (must resolve before launch)

1. **Per-term registration URL.** Today every campaign defaults to one org-wide `register_url` from `organizations`. Operators with separate registration pages per term (FA26 afterschool vs SU26 camps) can override per-campaign via `registration_url_override`, but the default needs to be per-term. Suggested home: `organizations.term_register_urls` jsonb `{ "FA26": "...", "SU26": "..." }`, or proper `terms` table with a `register_url` column. Add to onboarding as a Step 2 sub-question per term the provider runs. Flagged 2026-06-02 during Family Comms Q1 build.
2. **Provider-facing "create a program/camp from scratch" UI does not exist.** Step 5 above is blocked on building this.
3. **Hardcoded J2S audit** — search for `journeytosteam`, J2S org IDs, hardcoded emails before 2nd provider onboards — `project_enrops_pricing_v1.md:48`
4. **VENUE_REGION_MAP** is J2S-specific constant; move to per-tenant column when 2nd tenant onboards — `project_enrops.md:28`
5. **Per-tenant Checkr + Stripe secrets** — currently J2S-only — `2026-05-22-onboarding-punchlist.md:31`
6. **Tracker sync (J2S-only, vestigial)** — won't apply to other tenants — `project_enrops_roster_sync_su26_patch.md`
7. **Per-tenant pay variation** — schema work queued — `project_enrops_pay_scheme.md:46`
