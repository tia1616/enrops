# Family Comms — Q1 Intent-First Redesign

**Status:** Spec, not built. Written 2026-06-02 by Claude at end of the FA26 ship marathon.
**Implements:** session-task #19 + backlog item "Q1 redesign: intent-first surfaces"
**Replaces:** the current Q1 catalog tabs (Programs / Camps / Something else)

---

## Problem

Current Q1 forces the operator to map their **intent** ("I want to push fall registration") through a **data structure** (Programs tab → Term chip → check rows). That's backwards. Operators don't think "I'll click the Programs tab now"; they think "fall enrollment closes Friday and I need to get parents to register."

Catalog-tab UX also has visible friction:
- "5 drafts hidden, click to fix" warning hits the operator before they've even started picking
- Term chips require the operator to KNOW which term has urgent stuff (Ennie knows; the operator shouldn't have to repeat it)
- Manual checkbox selection across 26 rows for a routine "push the whole term" campaign
- No on-ramp for non-Enrops content (photo galleries, schedule changes, partner events) — the "Something else" tab is bare topics

---

## Design principle

**Operator picks an intent. Ennie picks the data.**

Q1 shows auto-detected cards representing **what's marketable right now** at this org, with one click per intent. Catalog picker stays as escape hatch.

---

## Surface design

### Top of Q1 — auto-detected period cards

Each card represents a coherent slice of the operator's catalog that's currently actionable. Examples for J2S today:

```
┌────────────────────────────────────────┐
│ FA26 After-School registration         │
│ 26 programs · 24 schools               │
│ Early-bird ends Friday Jun 5           │
│ ┌──────────────────────────────────┐   │
│ │ 🔥 Last-call early-bird push    →│   │  (intent sub-action)
│ │ Registration just opened        →│   │
│ │ Low-enrollment-only push (1)    →│   │
│ │ Last call before start           │   │  (greyed if start is far away)
│ └──────────────────────────────────┘   │
└────────────────────────────────────────┘

┌────────────────────────────────────────┐
│ SU26 Summer Camps                      │
│ 14 sessions · 4 locations              │
│ Open registration                      │
│ ┌──────────────────────────────────┐   │
│ │ Mid-window enrollment push      →│   │
│ │ Cross-sell to FA26 parents      →│   │
│ │ Low-enrollment-only push (3)    →│   │
│ └──────────────────────────────────┘   │
└────────────────────────────────────────┘
```

Card-level data:
- **Period name** — derived from `programs.term` (FA26, SU26, WI26) + program type (after-school vs camps)
- **Counts** — programs + distinct schools (or sessions + distinct locations for camps)
- **Time signal** — "Early-bird ends Friday Jun 5" (computed from min `early_bird_deadline` in the period), or "Open registration" if no deadline soon, or "Starts in 2 weeks" if first_session_date is the relevant signal
- **Intent sub-actions** — see catalog below

If the period has nothing to push (already closed, no upcoming sessions), the card is hidden entirely. Empty operator state: zero cards → show the catalog picker by default + a friendly note ("No active periods detected — pick programs manually or open the Other tab").

### Intent sub-actions catalog

Each card's intent list is filtered to what makes sense for the period's current state. The catalog of intents:

| Intent | Fires when | Pre-selects | Q2-Q4 defaults |
|---|---|---|---|
| **Registration just opened** | first_session_date in period is 4-12 weeks out | all programs in the period | duration=1 month, kickoff + 2 reminders, promo=early_bird |
| **Last-call early-bird push** | min(early_bird_deadline) is 0-7 days away | all programs with active early-bird in the period | duration=days until deadline, 2-3 touchpoints clustered, promo=early_bird |
| **Mid-window enrollment push** | between registration open and 3 weeks before start | programs with current_enrollment < 50% of max | duration=2 weeks, 2-3 touchpoints, no specific promo |
| **Low-enrollment-only push** | any time | only programs flagged `isLowEnrollment(row)` | duration based on time-to-start, focused copy |
| **Last call before start** | first_session_date in 1-2 weeks | all programs starting that soon | duration=until start, urgent tone, 1-2 touchpoints |
| **Cross-sell to existing parents** | only meaningful when ANOTHER period has registered parents to target | programs in THIS period that don't conflict with existing registrations | audience override: registered-in-other-period parents, duration=2 weeks |
| **Thank-you / wrap-up** | period has past first_session_date | all programs that started | duration=now, single touchpoint, tone=warm recap |

Each intent has a 1-line subtitle ("Last 5 days to save · 12 programs across 11 schools").

### Catalog picker as escape hatch

Below the cards, a collapsible "Pick programs manually" section. When opened, shows the current Q1 catalog picker UI (Programs / Camps / Other tabs). Useful for:
- Edge cases where the operator wants 3 specific programs across 2 periods
- Non-Enrops campaigns (photo galleries, schedule changes — the Other tab)
- Operators who explicitly want fine control

Default: collapsed.

### "Something else" — moves to its own card

Currently a tab. Better as a top-level card alongside the period cards:

```
┌────────────────────────────────────────┐
│ Send a one-off note                    │
│ ┌──────────────────────────────────┐   │
│ │ Schedule change / cancellation  →│   │
│ │ Photo gallery / weekly recap    →│   │
│ │ Partner event invite            →│   │
│ │ Free-form (you write the topic) →│   │
│ └──────────────────────────────────┘   │
└────────────────────────────────────────┘
```

Each sub-intent presets `inputs.what.mode='other'` and pre-fills relevant `inputs.what.topics`. Audience defaults differ (e.g., "Schedule change" defaults to registered parents of the affected program).

---

## Behavior — what happens when an intent is clicked

1. Pre-select programs/camps that match the intent's criteria → populate `inputs.what.program_ids` (or `camp_session_ids` / `topics` for mode='other')
2. Set Q2-Q4 defaults per the table above
3. Advance the operator to Q2 (audience review) — they can see what was pre-selected and override if needed
4. Q2-Q4 are now thin: the operator typically only reads them and clicks Next, not edits

Net: a routine "FA26 last-call" goes from ~12 clicks (tab, term, 26 rows, next, etc.) to **1 click** (intent → confirm at Q4 → draft).

---

## Auto-detection logic — how to compute the cards from data

Run once when Q1 loads. For each unique `(term, program_type)` combination across the org's open catalog:

```ts
type PeriodCard = {
  key: string;                  // e.g. "FA26-afterschool"
  label: string;                // "FA26 After-School registration"
  programCount: number;
  schoolCount: number;
  timeSignal: string;           // "Early-bird ends Fri Jun 5" | "Starts in 2 weeks" | ...
  intents: Intent[];            // filtered to applicable ones
};

type Intent = {
  key: string;                  // 'eb_lastcall', 'reg_opened', etc.
  label: string;
  subtitle: string;             // "Last 5 days to save · 12 programs"
  preselects: () => InputsPatch;
};
```

Data sources:
- `programs` (after-school) joined to `program_locations` + `curricula`
- `camp_sessions` joined to `program_locations`
- `registrations` filtered to confirmed for current_enrollment
- `programs.max_capacity` for low-enrollment detection

Caching: query once per Q1 mount; ~50ms total. No need to memoize across mounts since data changes day-to-day.

---

## Edge cases

1. **Operator has zero active periods** (rare for any active tenant) — show empty state + catalog picker open by default
2. **An intent has zero matching programs after filter** — hide the sub-action entirely. Don't show "0 programs."
3. **Multiple curricula at one school** — already handled by the audience layer + multi-program token resolution from FA26 build
4. **Operator wants to combine two periods** (e.g. FA26 after-school AND SU26 camps in one campaign) — use the catalog picker escape hatch. Card-level UI doesn't try to support this.
5. **Operator pre-selects an intent then changes mind** — back button on Q2 returns to Q1; intent state should reset cleanly so they can pick a different one

---

## What stays vs. changes

**Stays:**
- The four-question flow (Q1 → Q2 → Q3 → Q4)
- Existing audience-resolution logic in Q2
- Existing draft pipeline + Ennie prompt + send pipeline
- Existing inputs.what shape (`mode`, `program_ids`, `camp_session_ids`, `topics`)

**Changes:**
- Q1 catalog-tabs UI replaced by intent cards + collapsible catalog picker
- Q2-Q4 still render but are typically pre-filled and just confirmed
- The "intent" itself is captured in `inputs.what.intent_key` (new field, e.g. "eb_lastcall") so Ennie can adjust tone/cadence accordingly
- Edge function reads `inputs.what.intent_key` to inform the prompt (e.g. "this is a last-call deadline push — write urgent, short")

**Schema impact:**
- `marketing_campaigns.draft_inputs.what.intent_key` — new optional string. No migration; JSONB.

---

## Open questions for Jessica

1. **Period card naming** — "FA26 After-School registration" or just "Fall 2026 After-School"? Decide before build.
2. **Intent catalog completeness** — the table above has 7 intents. Are there others you want? Specifically: "Photo gallery / recap" lives under Something Else card today. Should it also appear under each period card as "Mid-camp recap"? (My instinct: yes, after a period starts.)
3. **"Last call before start" vs "Last-call early-bird push"** — both are deadline-driven, different deadlines (start date vs early-bird date). Worth keeping both, or collapse into one with smart detection of which deadline is closer?
4. **Cross-sell trigger** — fires for FA26-to-SU26 audience. Should the intent show on the SU26 card (offering FA26 parents) or the FA26 card (cross-sell our other period)? Both? Pick one.
5. **What about Automations overlap** — some intents here (last-day thank-you, mid-camp recap) overlap with the Automations sub-tab being built separately. Decide: automation-driven (no operator click, just fires on schedule) vs intent-driven (operator clicks "send a recap" each time). Probably some are one-and-done campaigns (operator-initiated), some are evergreen (automated).

---

## Build sequence

1. **Spike: period detection** — write the data query + display logic for period cards alone. ~1 hour. Verify J2S renders 2-3 plausible cards (FA26 after-school, SU26 camps, maybe Winter Break Camps if scheduled).
2. **Intent registry + preselect logic** — code the 7-intent table as a TypeScript module. Each intent has a `filter` (programs match criteria) and a `preselect` (returns an `InputsPatch`). ~2 hours.
3. **Q1 UI** — render cards + intent sub-actions, hook up to existing `setField("what", ...)` + `next()`. Keep the old catalog picker accessible via "Pick manually" toggle. ~2 hours.
4. **Q2-Q4 pre-filled defaults** — wire the preselect output through Q2-Q4 so they render with values pre-populated; operator just reviews and clicks Next. ~1 hour.
5. **Edge function prompt update** — add `inputs.what.intent_key` to the prompt so Ennie adjusts tone/cadence. ~30 min.
6. **End-to-end test** — walk through 3 different intents with real J2S data. Verify each produces a sensible draft. ~30 min.

Estimated total: **~7 hours of focused build**.

---

## Pre-build verification (per pressure-test #11 "eat the cooking")

Before declaring done:
- [ ] Each of the 7 intents was clicked end-to-end (Q1 → Q4 → Draft)
- [ ] Each produced a draft whose copy matched the intent's tone (urgent for "last-call", warm for "thank-you", etc.)
- [ ] The catalog-picker escape hatch still works (mode='other', mode='programs' manual select)
- [ ] An intent with zero matching programs is hidden, not shown empty
- [ ] Q2-Q4 are clearly pre-filled with editable defaults, not locked

---

## Handoff prompt for a new chat

Copy-paste this when opening the new chat:

```
Build the Q1 intent-first redesign for Family Comms.

Full spec: docs/specs/family-comms-q1-intent-first.md

Before coding:
1. Read the spec end-to-end
2. Read pressure-test rules in memory (especially #11 — eat the cooking)
3. Resolve the 5 open questions in the spec with me before writing any UI
4. After Q1 is resolved, propose the build sequence (the spec has one; confirm
   or adjust)

Existing code you'll work with:
- src/pages/admin/marketing-v2/questions/Q1_What.jsx (the current catalog UI)
- src/pages/admin/marketing-v2/AICampaignBuilder.jsx (the reducer + flow)
- supabase/functions/marketing-draft-campaign/index.ts (the edge function;
  add inputs.what.intent_key support)

Don't break the existing flow. The catalog picker stays as escape hatch.
```
