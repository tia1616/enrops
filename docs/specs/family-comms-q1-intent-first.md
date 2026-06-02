# Family Comms — Q1 Intent-First Redesign

**Status:** Spec, not built. Written 2026-06-02 by Claude. Decisions confirmed with Jessica end of FA26 ship session.
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
│ Fall 2026 After-School                 │
│ 26 programs · 24 schools               │
│ Early-bird ends Friday Jun 5           │
│ ┌──────────────────────────────────┐   │
│ │ 🔥 Last call (5 days)           →│   │
│ │ Registration just opened        →│   │
│ │ Mid-window enrollment push      →│   │
│ │ Low-enrollment-only push (1)    →│   │
│ └──────────────────────────────────┘   │
└────────────────────────────────────────┘

┌────────────────────────────────────────┐
│ Summer 2026 Camps                      │
│ 14 sessions · 4 locations              │
│ Open registration                      │
│ ┌──────────────────────────────────┐   │
│ │ Mid-window enrollment push      →│   │
│ │ Cross-sell to Fall 2026 parents →│   │
│ │ Low-enrollment-only push (3)    →│   │
│ └──────────────────────────────────┘   │
└────────────────────────────────────────┘
```

Card-level data:
- **Period name** — "Fall 2026 After-School" / "Summer 2026 Camps" — full-word format, friendlier than internal codes (decided Jessica)
- **Counts** — programs + distinct schools (or sessions + distinct locations for camps)
- **Time signal** — "Early-bird ends Friday Jun 5" (computed from min `early_bird_deadline` in the period), or "Open registration" if no deadline soon, or "Starts in 2 weeks" if first_session_date is the relevant signal
- **Intent sub-actions** — see catalog below

If the period has nothing to push (already closed, no upcoming sessions), the card is hidden entirely. Empty operator state: zero cards → show the catalog picker by default + a friendly note ("No active periods detected — pick programs manually or open the Other tab").

### Intent catalog

Each card's intent list is filtered to what makes sense for the period's current state.

| Intent | Fires when | Pre-selects | Q2-Q4 defaults |
|---|---|---|---|
| **Registration just opened** | first_session_date in period is 4-12 weeks out | all programs in the period | duration=1 month, kickoff + 2 reminders, promo=early_bird |
| **Last call** | min(early_bird_deadline) 0-7 days OR min(first_session_date) 1-14 days, whichever's closer. Label shows the active deadline ("Last 5 days for early-bird" / "Starts in 8 days") | all programs with the relevant active deadline | duration=days until deadline, 2-3 touchpoints clustered, promo=early_bird if EB-driven |
| **Mid-window enrollment push** | between registration open and 3 weeks before start | programs with current_enrollment < 50% of max | duration=2 weeks, 2-3 touchpoints, no specific promo |
| **Low-enrollment-only push** | any time | only programs flagged `isLowEnrollment(row)` | duration based on time-to-start, focused copy |
| **Cross-sell to [other-period] parents** | when another period in the org has registered parents who could enroll in THIS period | programs in THIS period that don't conflict with parents' existing registrations | audience override: registered-in-other-period parents, duration=2 weeks |

5 intents total. Shown on the **target period card** (where you're driving enrollment), not the source.

**Auto-detection of which intents to show:** filter by the "Fires when" condition. Hide intents whose condition isn't met (no zero-program intents, no "Last call" if neither deadline is close, etc.).

**Recap / mid-term / last-day thank-you intents are NOT here** — those live in the Automations sub-tab (scheduled, recurring, separate build).

### "Something else" — moves to its own card

Currently a Q1 tab. Better as a top-level card alongside the period cards:

```
┌────────────────────────────────────────┐
│ Send a one-off note                    │
│ ┌──────────────────────────────────┐   │
│ │ Schedule change / cancellation  →│   │
│ │ Photo gallery / ad-hoc recap    →│   │
│ │ Partner event invite            →│   │
│ │ Free-form (you write the topic) →│   │
│ └──────────────────────────────────┘   │
└────────────────────────────────────────┘
```

Each sub-intent presets `inputs.what.mode='other'` and pre-fills relevant `inputs.what.topics`. Audience defaults differ:
- "Schedule change" → defaults to registered parents of the affected program
- "Photo gallery" → defaults to current-program parents, expects the `registration_url_override` field for the gallery URL
- "Partner event" → defaults to whole marketing list
- "Free-form" → operator fills in topic + audience manually

Note: photo-gallery / recap one-offs live HERE. Scheduled recurring recaps (mid-term recap, last-day thank-you) live in **Automations**, not here.

### Catalog picker as escape hatch

Below the cards, a collapsible "Pick programs manually" section. When opened, shows the current Q1 catalog picker UI (Programs / Camps / Other tabs). Useful for:
- Edge cases where the operator wants 3 specific programs across 2 periods
- Operators who explicitly want fine control
- Periods the auto-detector didn't pick up (e.g. an early-stage term)

Default: collapsed. Opens with a chevron click; remembers last state per session.

---

## Behavior — what happens when an intent is clicked

1. Pre-select programs/camps that match the intent's criteria → populate `inputs.what.program_ids` (or `camp_session_ids` / `topics` for mode='other')
2. Set Q2-Q4 defaults per the intent table above
3. Set `inputs.what.intent_key` to the intent identifier (new field; Ennie reads this to adjust tone/cadence)
4. Advance the operator to Q2 (audience review) — they can see what was pre-selected and override if needed
5. Q2-Q4 are now thin: the operator typically only reads them and clicks Next, not edits

Net: a routine "FA26 last-call" goes from ~12 clicks (tab, term, 26 rows, next, etc.) to **1 click** (intent → confirm at Q4 → draft).

---

## Family Comms ↔ Automations boundary (decided)

| Lives in **Family Comms Q1** (operator-initiated) | Lives in **Automations** (scheduled / triggered) |
|---|---|
| Registration just opened | Camp-prep (X days before first session) |
| Last call | Drop-off morning (day-of) |
| Mid-window enrollment push | Mid-term recap (every 2-3 weeks during a term) |
| Low-enrollment-only push | Last-day thank-you (day after last session) |
| Cross-sell to [other-period] parents | Cross-sell on completion (kid finishes → offer next) |
| Something else (schedule changes, ad-hoc recaps, partner events) | Schedule-change auto-notify (program update → parents) |

**Cross-sell appears in BOTH.** Operator can push it manually from Q1 (campaign push from FA26 to SU26 parents) OR set the on-completion version to auto-fire (kid finishes a program → next-program offer goes out 2 days later). Two different triggers, similar copy, same goal.

---

## Auto-detection logic — how to compute the cards from data

Run once when Q1 loads. For each unique `(term, program_type)` combination across the org's open catalog:

```ts
type PeriodCard = {
  key: string;                  // e.g. "FA26-afterschool"
  label: string;                // "Fall 2026 After-School"
  programCount: number;
  schoolCount: number;
  timeSignal: string;           // "Early-bird ends Fri Jun 5" | "Starts in 2 weeks" | "Open registration"
  intents: Intent[];            // filtered to applicable ones via .filter()
};

type Intent = {
  key: string;                  // 'registration_opened', 'last_call', 'mid_window_push', 'low_enrollment_push', 'cross_sell'
  label: string;                // "Last call (5 days)"
  subtitle: string | null;      // "12 programs across 11 schools"
  appliesTo: (period: PeriodFacts) => boolean;
  preselects: (period: PeriodFacts) => InputsPatch;
};
```

Data sources:
- `programs` (after-school) joined to `program_locations` + `curricula`
- `camp_sessions` joined to `program_locations`
- `registrations` filtered to confirmed (for current_enrollment + cross-sell audience math)
- `programs.max_capacity` for low-enrollment detection

Period label format: `{Season-name} {year} {program-type}` — e.g. "Fall 2026 After-School", "Summer 2026 Camps". Derive season from `term` code (FA → Fall, SU → Summer, SP → Spring, WI → Winter).

Caching: query once per Q1 mount; ~50ms total. No need to memoize across mounts since data changes day-to-day.

---

## Edge cases

1. **Operator has zero active periods** — show empty state + catalog picker open by default + Something else card available
2. **An intent has zero matching programs after filter** — hide the sub-action entirely. Don't show "0 programs."
3. **Multiple curricula at one school** — already handled by the audience layer + multi-program token resolution from FA26 build
4. **Operator wants to combine two periods** in one campaign — use the catalog picker escape hatch. Card-level UI doesn't try to support this.
5. **Operator picks an intent then changes mind** — back button on Q2 returns to Q1; intent state should reset cleanly so they can pick a different one. Clear `intent_key` on Back.
6. **"Last call" has both deadlines within range** — pick the closer one; the label shows which deadline drove the choice ("Last 5 days for early-bird" vs "Starts in 8 days"). Operator can drill into the picker for the other deadline if needed.

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
- The "intent" itself is captured in `inputs.what.intent_key` (new field, e.g. "last_call") so Ennie can adjust tone/cadence accordingly
- Edge function reads `inputs.what.intent_key` to inform the prompt (e.g. "this is a last-call deadline push — write urgent, short")

**Schema impact:**
- `marketing_campaigns.draft_inputs.what.intent_key` — new optional string. No migration; JSONB.

---

## Build sequence

1. **Spike: period detection** — write the data query + display logic for period cards alone. ~1 hour. Verify J2S renders 2-3 plausible cards (Fall 2026 After-School, Summer 2026 Camps, maybe Winter 2026 Camps if scheduled).
2. **Intent registry + preselect logic** — code the 5-intent table as a TypeScript module. Each intent has an `appliesTo` (programs match criteria) and a `preselects` (returns an `InputsPatch`). ~2 hours.
3. **Q1 UI** — render cards + intent sub-actions, hook up to existing `setField("what", ...)` + `next()`. Keep the old catalog picker accessible via "Pick manually" toggle. ~2 hours.
4. **"Something else" card** — top-level card with 4 sub-intents (schedule change, photo gallery, partner event, free-form). Wire each to its preselect. ~1 hour.
5. **Q2-Q4 pre-filled defaults** — wire the preselect output through Q2-Q4 so they render with values pre-populated; operator just reviews and clicks Next. ~1 hour.
6. **Edge function prompt update** — add `inputs.what.intent_key` to the prompt so Ennie adjusts tone/cadence per intent. ~30 min.
7. **End-to-end test** — walk through each intent with real J2S data. Verify each produces a sensible draft. ~1 hour.

Estimated total: **~8.5 hours of focused build**.

---

## Pre-build verification (per pressure-test #11 "eat the cooking")

Before declaring done:
- [ ] Each of the 5 period intents was clicked end-to-end (Q1 → Q4 → Draft) on real J2S data
- [ ] Each "Something else" sub-intent was clicked end-to-end
- [ ] Each produced a draft whose copy matched the intent's tone (urgent for "last-call", warm for free-form, etc.)
- [ ] The catalog-picker escape hatch still works (mode='other', mode='programs' manual select)
- [ ] An intent with zero matching programs is hidden, not shown empty
- [ ] Q2-Q4 are clearly pre-filled with editable defaults, not locked
- [ ] Period labels read as "Fall 2026 After-School" (not "FA26 After-School")
- [ ] Period auto-detection runs on Q1 mount (fresh data each visit, no stale memo)
- [ ] `intent_key` flows from Q1 click → draft_inputs → Ennie prompt → tone differentiation visible in output

---

## Handoff prompt for a new chat

Copy-paste this when opening the new chat (after Jessica's break):

```
Build the Q1 intent-first redesign for Family Comms.

Full spec: docs/specs/family-comms-q1-intent-first.md
(All design decisions are already settled — don't re-litigate. If
something looks ambiguous, ask me, but the table-of-intents and the
FC↔Automations boundary are final.)

Before coding:
1. Read the spec end-to-end
2. Read pressure-test rules in ~/.claude/.../memory/feedback_pressure_test_questions.md
   — especially #11 (eat the cooking) is mandatory
3. Read CLAUDE.md user-memory files for project context
4. Propose the build sequence (the spec has one; confirm or adjust),
   then start with step 1 (the period-detection spike)

Existing code you'll work with:
- src/pages/admin/marketing-v2/questions/Q1_What.jsx (the current
  catalog UI — gets reworked but keep the picker as escape hatch)
- src/pages/admin/marketing-v2/AICampaignBuilder.jsx (the reducer +
  flow — add intent_key to INITIAL shape + DEFAULTS handling)
- supabase/functions/marketing-draft-campaign/index.ts (the edge
  function — add inputs.what.intent_key support to the prompt; new
  rule "INTENT-DRIVEN TONE/CADENCE" right before SCHEDULE-PLANNING)

Don't break the existing flow. The catalog picker stays accessible.
Existing drafts (without intent_key) should still work — backward-compatible.

Don't ship without running the verification checklist at the end of
the spec.
```
