# Spec Chunk 3.5 of 4: Dora the Director — Celebration Moment + Capability Tracking

## LOCKED VOCABULARY (see Chunk 0)
"Curriculum" = lesson library. "Program" = scheduled offering. "Session" = single class meeting. "Term" = time window. Never substitute.

## Prerequisites
- Chunks 0–3 complete
- Curriculum can be published end-to-end through the upload → extract → review → publish flow

## What this chunk builds
The post-publish magic moment. When a provider publishes a curriculum (or hits other key milestones later), **Dora** — the Enrops Director — appears with a celebration of what just got unlocked and a single recommendation for what to do next. Plus the capability tracking system that powers this and the Programs tab capability column.

This is the chunk that turns Enrops from a tool into a partner.

---

## Design principles

1. **Every action is tied to a provider goal.** Never "feature available." Always "this unlocks X outcome." This is the locked Enrops product principle (memory).
2. **One clear next action.** Choice paralysis kills momentum. Dora recommends ONE thing.
3. **Clickable everywhere.** Locked capabilities are still clickable — they explain what's needed and why.
4. **Real stats only.** Cite source. If no real stat exists, use a qualitative argument. Never fabricate.
5. **Sticky, not pushy.** Dora encourages, doesn't badger. Once-per-event, not on every page load.

---

## The Dora character

**Name:** Dora. Used in UI ("Dora's recommendation," "Ask Dora") and in conversation.

**Visual:** We have an existing AI-generated character image from Gemini. Jessica will provide the file (PNG with transparent background, ~512x512 source). Display sizes:
- Celebration screen: 160-200px
- Inline recommendations: 64-80px
- Programs tab column header (small): 32px

**Animation:** Pure CSS. No new dependencies.
- **Entrance:** Fade in + slight bounce (translateY from +20px to 0, with subtle overshoot). 600ms.
- **Idle:** Very subtle floating motion (translateY ±3px, 4s loop). Optional — disable if it feels distracting.
- **Exit:** Fade out + slight downward slide. 300ms.

**One pose for v1.** Future variations (thinking, celebrating, waving) come later.

---

## Data model

### New table: `capability_definitions`

The source of truth for every Enrops capability — what it is, what unlocks it, why it matters.

```sql
create table capability_definitions (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null, -- e.g., 'parent_marketing_copy', 'registration_form'
  display_name text not null, -- 'Parent-facing marketing copy'
  category text not null check (category in ('curriculum', 'program', 'parent', 'instructor', 'marketing', 'operations')),
  
  -- The "what" and "why"
  short_description text, -- one-liner shown in cards
  why_it_matters text not null, -- the "in order to ___" / outcome framing
  stat_text text, -- e.g., "Promo codes lift registrations 12-23%"
  stat_source text, -- e.g., "Eventbrite 2024 study"
  stat_source_url text, -- citation link
  
  -- Requirements logic
  required_states text[] not null default '{}', -- machine-readable, e.g., ['curriculum_published', 'program_scheduled']
  required_states_human text, -- "Needs a published curriculum and at least one scheduled program"
  
  -- Display
  icon_name text, -- maps to a Lucide icon or similar
  display_order int not null default 0,
  is_available boolean not null default true, -- some capabilities aren't built yet; mark as 'coming soon'
  
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

**No RLS needed** — this is shared platform data, not org-specific.

### New table: `capability_unlock_states`

Per-org, per-capability state. Lets us render the Programs tab column and the celebration screen without recomputing every time.

```sql
create table capability_unlock_states (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  capability_id uuid not null references capability_definitions(id),
  
  -- Optional: scope to a specific entity (a curriculum, a program, etc.)
  scoped_entity_type text, -- 'curriculum' | 'program' | null (org-wide)
  scoped_entity_id uuid,
  
  is_unlocked boolean not null default false,
  unlocked_at timestamptz,
  last_action_at timestamptz, -- when the provider last used this capability
  
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  
  unique(organization_id, capability_id, scoped_entity_type, scoped_entity_id)
);
```

**RLS:** Org-scoped.

### Migration: seed `capability_definitions`

Seed the table with the initial set of capabilities. Each row needs a thoughtful `why_it_matters` written by Jessica (or drafted by Claude Code and reviewed by Jessica before committing).

**Initial seed list:**

| slug | display_name | category | required_states |
|---|---|---|---|
| `parent_marketing_copy` | Parent-facing description | curriculum | `curriculum_published` |
| `flyer_generation` | Auto-generated flyer | marketing | `curriculum_published` |
| `instructor_lesson_plans` | Instructor lesson plans | instructor | `curriculum_published` |
| `recap_templates_ready` | Session recap templates | parent | `curriculum_published` |
| `program_schedule` | Scheduled programs | program | `curriculum_published` |
| `registration_form` | Registration form | program | `curriculum_published`, `program_scheduled` |
| `welcome_emails` | Welcome emails | parent | `program_scheduled`, `registrations_received` |
| `auto_session_recaps` | Automated session recaps | parent | `program_running` |
| `parent_portal_view` | Parent portal | parent | `registrations_received` |
| `instructor_offers` | Instructor offer flow | instructor | `program_scheduled` |
| `promo_codes` | Promotional codes | marketing | `registration_open` |
| `re_enrollment_campaigns` | Re-enrollment campaigns | marketing | `past_registrations_exist` |
| `waitlist_management` | Waitlist | program | `program_at_capacity` |
| `boss_mode_inbox_scan` | Weekly inbox scan (Boss Mode) | operations | `boss_mode_enabled` |

**Claude Code should draft `why_it_matters` copy for each row, with stat + source where available, then pause for Jessica's review before committing the seed.** This is content writing, not just code — it sets the tone for every Enrops capability.

Examples of what good `why_it_matters` copy looks like:

- `parent_marketing_copy`: "Parents skim listings in seconds. The right description is the difference between a click and a scroll-past. According to a 2023 study by The Knot, listings with vivid, specific descriptions get 40% more inquiries."
- `flyer_generation`: "Flyers are still the #1 way parents discover afterschool programs at their school (NAEYC, 2024). A branded flyer in the office Monday morning fills more seats than any email."
- `promo_codes`: "Promo codes convert fence-sitters. Eventbrite's 2024 ticketing report found that discount codes lift registrations 12-23%, with most parents using them when offered."
- `re_enrollment_campaigns`: "Re-enrolled families have ~2× the lifetime value of single-term families. (Based on enrichment industry benchmarks — Enrops will replace with platform data once available.)"

Where no real stat exists, use a qualitative argument. Do NOT fabricate.

---

## The celebration moment

### Trigger
Fires when `curricula.status` flips to `published` for the first time.

### Where it appears
Replaces the current "Curriculum published" confirmation screen in Chunk 3.

### Screen flow

**Phase 1 — Celebration (5 seconds, or skip)**

Centered on screen:
- Dora avatar fades in (160px) with bounce
- Heading: "Done! {Curriculum name} is in your library."
- Subheading: "Here's what just unlocked."
- Capability grid fades in, item by item over 1.5s

Grid shows ~6-10 most relevant capabilities for this milestone, drawn from `capability_definitions` filtered by what's now unlocked (the curriculum publish unlocks marketing copy, lesson plans, recap templates, etc.) plus a sampling of the next-tier locked capabilities (registration, welcome emails) so the provider sees the path forward.

Each tile:
- ✓ for unlocked: green checkmark + display_name + short_description (1 line)
- ⊝ for locked: muted color + display_name + "needs: [required_states_human]"

All tiles clickable. Clicking unlocked → navigate to that surface. Clicking locked → modal/popover with the "why it matters" + "to unlock this: [next step]" + button to take the next step.

Skip button in top-right ("Skip celebration") — gentle, not aggressive.

**Phase 2 — Dora's recommendation (replaces Phase 1)**

Dora moves to a smaller position (lower-right corner or centered card, depending on layout). Speech bubble:

> "Most providers' next move is to schedule a program from this curriculum. I'll have your registration page ready as soon as you do. Want to schedule one now?"

Two CTAs:
- **Primary:** "Schedule a program" → routes to scheduling flow (will exist after Chunk 4)
- **Secondary:** "Take me to my library" → routes to `/admin/curricula`

If the provider already has scheduled programs for *other* curricula (system can check), Dora's recommendation shifts:

> "Most providers schedule this curriculum at the same locations they're already running other curricula. Want to copy a schedule from Inventors?"

**Don't overdo this** — Dora should have 2-3 recommendation patterns, not infinite variations. Logic for which one fires:

1. If org has 0 programs scheduled: "Let's schedule your first program."
2. If org has programs scheduled for other curricula: "Want to schedule this at the same locations?"
3. If org has open registrations on other programs: "While you're at it, want me to draft a marketing email about this new curriculum?"

Each variation maps to a clear primary CTA.

---

## The Programs tab capability column

### Where it appears
On the existing `/admin/programs` page (or the Curricula tab — confirm with Jessica which page is the natural home).

### Layout
Each curriculum row gets a horizontal capability strip showing icons for: marketing copy, flyer, schedule, registration, welcome emails, recaps, etc.

- ✓ (green) for unlocked
- ⊝ (muted) for locked

Hover or click on an icon → popover with:
- Capability name
- Status (Active / Needs X)
- Why it matters (with stat + source)
- CTA button (use it / unlock it)

This is the "what's my state" view the provider can scan in 2 seconds.

### Mobile

Stack the capability strip vertically or collapse into a "5 of 8 unlocked" badge that expands on tap.

---

## Backend logic

### Computing unlock state

When a relevant event happens (curriculum published, program scheduled, registration received, etc.), update the `capability_unlock_states` rows for that org + the affected curriculum/program.

Implementation options:
1. **Postgres triggers** on `curricula`, `programs`, `registrations` tables that recompute unlock states. Reliable, runs in the DB, no app code involved.
2. **Edge function called from app code** at each event. Easier to test, more flexible, but easier to forget to call.

**Recommendation: Postgres triggers** for the obvious state transitions (curriculum publish, program schedule, registration insert). Edge functions only for derived states that depend on time (e.g., "program_running" = current_date between program.start_date and end_date) which can run via pg_cron.

### Edge function: `compute-unlock-states`

A nightly pg_cron job that recomputes time-derived unlock states (program_running, registration_open windows, etc.) for the whole org. Cheap to run, keeps the Programs tab fresh.

---

## Build rules

1. Read this spec end-to-end before writing code.
2. Confirm Chunks 0-3 are complete.
3. **Pause after seeding `capability_definitions` with draft `why_it_matters` copy** — Jessica reviews and edits before committing. This is content, not just code.
4. Multi-tenant: every query filters by `organization_id`. Capability definitions are global; unlock states are org-scoped.
5. RLS on `capability_unlock_states` before any code touches it.
6. Mockup the celebration screen and the Programs tab capability column before building either.
7. Test the celebration flow with at least 2 curricula (the second publish should NOT show the celebration in the same heavy way — Dora should adapt: "Another one in the library. Here's what's left to unlock.").
8. Append any new hardcoded references to `MULTITENANT_AUDIT.md`.
9. No deploy until Jessica has seen the celebration moment with Dora rendering correctly.

---

## Multi-tenant audit

Append to `MULTITENANT_AUDIT.md`:
- Dora character is universal across tenants (intentional — she's an Enrops character, not a provider character)
- `capability_definitions` table is global, not org-scoped
- `why_it_matters` copy must be generic — never reference J2S programs/locations specifically
- Recommendation logic (the 3 Dora patterns) must work for any provider

---

## Verification before shipping

1. Publish a fresh curriculum from scratch → celebration screen fires
2. Dora renders correctly at 160px + 80px sizes
3. Capability grid shows correct unlocked/locked state
4. Click an unlocked tile → routes correctly
5. Click a locked tile → modal shows "why it matters" + next step
6. Phase 2 recommendation shows the right variation based on org state
7. Publish a second curriculum → Dora's recommendation adapts (doesn't repeat the same script)
8. Programs tab capability column renders correctly for all existing curricula
9. Mobile layout works
10. Multi-tenant: create test second org, confirm capability states are isolated

---

## Out of scope (defer)

- Dora chat interface (FAQ-style) — Phase 2
- Multiple Dora poses/expressions — after one pose proves out
- Dora at non-publish moments (program scheduled, first registration, milestone hit) — extend later by adding triggers
- Provider-customizable capability stat copy — Phase 2 if tenants ask
- Real Enrops platform stats — gathered over time, swap in once multi-tenant data exists
- A/B testing different recommendation copy — wait until enough data

---

## When this chunk is done

- Dora exists in the codebase
- Celebration moment fires on curriculum publish
- Programs tab shows capability state per curriculum
- Every capability has a "why it matters" with cited source (or qualitative argument)
- Provider sees momentum, not a dead end, after every meaningful action

This is the chunk that makes Enrops feel like a partner. Get it right.
