# Spec: Afterschool instructor lifecycle (survey -> match -> offer -> confirm)

**Status:** DRAFT v2 for pressure-test (2026-06-07). Not approved. No code until pressure-tested.
**Origin:** Day-1 staging test (`docs/handoffs/2026-06-07-fa26-afterschool-test-day1.md`) + grounded comparison against the camp system + the **real J2S availability form** (`Spring & Summer Availability 2026 (Responses).xlsx`), which is the source of truth for what the survey actually asks.

**Build split (agreed):** Stage A (survey + schema + matcher) this weekend-ish; Stage B (offer loop) post-Italy. NOTE: Stage A grew once we corrected the survey model — see Section 7 scope flag.

> **Hard rule:** nothing hardcoded for J2S. The survey's areas come from the tenant's locations; its curricula come from the tenant's curricula; bonus amounts/buckets are platform defaults, not J2S values.

---

## 1. The real survey (ground truth, from the responses file)

The live J2S form serves spring (afterschool) + summer (camp) together. Columns observed:
- Name; **days/week** ("3-4"); **per-weekday time availability** (Mon–Fri, each a time range — e.g. Mon "2pm–4pm", Tue "12pm–2pm"); **location preferences ranked by AREA** (Beaverton, Happy Valley, Hillsboro, Lake Oswego, Newberg, Corbett, Portland, Tigard, Vancouver/Camas, Forest Grove, West Linn/Oregon City) with values Highly Preferred / Preferred / Not Preferred / Unavailable; **curriculum preferences ranked** (Legos, Coding, Robotics); plus camp-only: AM/PM/all-day, weeks, Saturdays, and role (Lead/Developing/Both).

## 2. The afterschool survey (what we build) — SETTLED

Generated per-tenant (no hardcoded lists):
1. **Per-weekday time availability** — for each weekday Mon–Fri: **multi-select of the standard buckets** `9am–12pm / 12pm–2pm / 2pm–4pm / 4pm–6pm` (the real form's set; combos like "2pm–4pm, 4pm–6pm" occur). Empty = not available that day. Adjacent buckets compose into a contiguous window. (Replaces the built form's single global earliest/latest.)
2. **Days/week target** — a **range** ("1-2", "3-4", "4-5"); store `min_days`+`max_days`, matcher cap = upper bound.
3. **Location preference, ranked by AREA = `program_locations.district`** — Highly Preferred / Preferred / Not Preferred / Unavailable. Areas listed are the distinct districts across the tenant's locations.
4. **Curriculum preference, ranked** — the tenant's curricula. **Very soft.**

**Not collected (afterschool):** unavailable dates (dropped — we don't ask), weeks, AM/PM, Saturdays. Role Lead/Developing is **out for v1** (one lead per class).

**Open survey detail (#A):** the fixed-bucket set for afterschool afternoons. The camp form's buckets (9–12, 12–2, 2–4) don't cover real afterschool class windows (1:35–4:20pm). Proposed platform default: per-weekday earliest-start choice ("available from 1:30 / 2:00 / 2:30 / 3:00 / 3:30 pm", plus an optional "must leave by"). Needs Jessica's sign-off on the exact buckets.

## 3. Schema changes (Stage A)

`instructor_term_availability` is restructured (it currently has single `earliest_start`/`latest_end`, `available_days[]`, `unavailable_dates[]`, and a per-**location** `location_preferences` jsonb — all wrong now):
- **Per-weekday time:** store a bucket per weekday (jsonb `{mon: 'from_1430', tue: ..., }` or 5 nullable columns). Drop `earliest_start`/`latest_end`/`available_days`.
- **Drop `unavailable_dates`.**
- **Area preference:** mirror the camp pattern — a term-keyed area-preference store keyed by **district** (not location_id). (Camp uses `instructor_location_preferences` by region; afterschool analog keyed by district.)
- **Curriculum preference:** mirror camp `instructor_curriculum_preferences`, term-keyed.
- Keep `max_days`, `notes`, `needs_confirmation`, `submitted_at`.
- **Open #B:** separate preference tables (mirror camps, DRY with their patterns) vs jsonb on the availability row (fewer tables). Recommend mirroring camps for consistency.

## STAGE A — Survey form + schema + matcher (build target: this weekend-ish)

### A1. Time eligibility (HARD) — SETTLED
- Matcher loads each instructor's per-weekday bucket + the program `start_time`/`end_time` (currently omitted; and they're 12h **text** "2:05 PM" — parse in place, do NOT migrate the column: it's read in 14 src files).
- **Rule:** instructor eligible on a program only if their bucket for that weekday covers **[class_start − 15min, class_end]** (arrive 15 min early, stay to end). 15 min = platform constant, per-provider later.
- Fix the grid display bug this exposes (`AfterschoolSchedule.jsx:58-64` `fmtTime` mis-parses "2:05 PM" → "2").

### A2. Location (area) preference — soft with hardship — SETTLED model
- Area = the program's location's `district`. Preference scoring (mirror camp's soft model, afterschool bonus amounts):
  - Highly Preferred / Preferred → rank up, no bonus.
  - **Not Preferred → assignable, +$30 bonus + flag.**
  - **Unavailable → assignable only as last resort, +$50 bonus + flag.**
- Never a hard reject (you said: assign there only if no one else matches). Surface the bonus + reason in the grid (not a bare "Flagged").
- **Open #1 (carried):** greedy currently lets a strong preference get "used up" before its preferred program is reached (Casey/Jackson). Fix = two-phase (seat preferred-area matches first, then fill) vs leave greedy vs full optimization. Recommend two-phase. STILL OPEN.

### A3. Curriculum — VERY soft — SETTLED
- Not a hard filter (anyone can be assigned any curriculum). A small tiebreak weight, below area and days/time. Highly/Preferred nudge up; Not Preferred nudges down slightly.

### A4. Exclude drafts — SETTLED
- Match only `status='open'` (the only live status; `draft` is the only other value present). Drafts render on the grid, greyed, not counted as needs_hire. Manual assignment still allowed.

### A5. Small correctness
- Deprioritize `needs_confirmation` in tiebreak (camp does this).
- One-line "why needs hire" reason (full alternates list is post-alpha).

### Matcher rule order (afterschool)
HARD: weekday available -> time bucket covers [start−15, end] -> one program per weekday -> within max_days -> program is `open`.
SOFT (rank eligible): area preference (w/ hardship) > load balance / needs_confirmation > curriculum (very soft) > name.

---

## STAGE B — Offer loop (post-Italy)

The offer loop is **camp-only today** (`respond-to-assignment` hardcodes `camp_assignment_id`; `send-offers`/`send-patch-offer`/`offer-reminders-cron`/`offer-message-reply` likewise). Afterschool instructors can't yet be offered a class or accept/decline/request-change — though the survey email promises it.
- **B1:** make those functions **polymorphic (camp | program)** — mirror the sub system's `parent_assignment_type` pattern; don't fork copies. `instructor_offer_messages.program_assignment_id` already exists. Carry the camp lessons (clear offer state on reassignment; warm no-cancel removal; email audit log as source of truth; preferred_name greeting; venue + "arrive by [start−15]" in the email).
- **B2:** multi-tenant sender fix — `send-afterschool-survey/index.ts:129` hardcodes `updates.journeytosteam.com`; drive from org branding.

### Stage B parity checklist (every summer feature after-school still needs — do not ship Stage B without these)
- [ ] Approve proposed → **Send offers** (bulk, per-instructor selection, test/real mode, preview)
- [ ] Instructor portal: **offer cards → Accept / Decline / Request change**
- [ ] `respond-to-assignment` made polymorphic (`program_assignment_id`)
- [ ] **Change-request review modal** + admin reply (`offer-message-reply`)
- [ ] **Send patch offer** (mid-term single-class adds)
- [ ] **Auto-reminders** (`offer-reminders-cron`: reminder + expire passes; honor the cycle's auto_reminders flag)
- [ ] **Email activity log** ("View email activity" — `instructor_offer_messages` as source of truth)
- [ ] Reassignment **clears offer state** (email_sent_at / response / flags) + **warm no-cancel removal** (`notify-instructor-removed`)
- [ ] **Realtime**: instructor responds → board updates without refresh
- [ ] **Publish** → instructors see their confirmed schedule in the portal
- [ ] Status labels: **Proposed → Awaiting response → Accepted / Change requested** (kill the ambiguous "Draft")
- [ ] **preferred_name greeting** + venue details ("arrive by [start−15]") in offer emails
- Nice-to-haves (backlog, not blockers): day-of subs, print schedule, Ennie tips, drag-drop assign.

> Note: the earlier "unavailable-dates → subs" idea is **dropped** — we don't collect dates. An instructor unavailable for a class's day/time simply isn't recommended for it.

---

## 4. Explicitly OUT of scope (v1)
Role tiers (developing), per-instructor quotas, recommendations engine, full top-5 alternates. Afterschool = one lead per class.

## 5. Data-model follow-ups (separate hygiene)
Normalize `programs.start_time`/`end_time` from 12h text to `time` (touches 14 src files + registration — its own task).

## 6. Decisions
- **SETTLED:** drop unavailable-dates; per-weekday fixed buckets; area = district; curriculum very soft; not_preferred +$30 / unavailable +$50 (last resort); one lead per class v1; time hard-reject with 15-min arrival; exclude drafts; 1-line why-needs-hire.
- **SETTLED #1:** two-phase (seat highly-preferred/preferred area matches first, then fill).
- **SETTLED #A:** buckets = the real form's set, multi-select per weekday: 9am–12pm / 12pm–2pm / 2pm–4pm / 4pm–6pm.
- **SETTLED #B:** mirror camp pref-table pattern — separate term-keyed area + curriculum preference tables.

## 7. SCOPE FLAG (read this)
Stage A is no longer just "fix the matcher." It now includes: rewrite the availability **form** (per-weekday buckets, area-by-district prefs, curriculum, remove dates/global-window), a **schema migration** (restructure `instructor_term_availability` + area/curriculum preference stores + backfill/clear the synthetic staging rows), AND the **matcher rewrite**. That is more than one weekend. Options: (a) do the schema+form first, matcher next weekend; (b) compress; (c) accept it slips. Flagging so the pre-Italy non-negotiables (BGC, $1 payroll, audit) aren't squeezed.

## 8. Self pressure-test (8 questions)
- **Underspecified:** time-bucket set (#A); preference-storage shape (#B); two-phase tiebreak (#1).
- **Inconsistent w/ existing:** reuse camp pref-table patterns + shared assignment status enum; don't invent. Area=district must handle districts that span the form's grouped areas ("Vancouver/Camas").
- **Security/multi-tenant:** areas/curricula/buckets all tenant-derived or platform-default — zero J2S hardcode; run tenant-rls-audit before push.
- **Errors/edge:** instructor with no weekday buckets (didn't submit); a district with no preference given (treat as neutral/Preferred default, like camp's `?? 'preferred'`); a program whose location has a null district (area unknown — needs a fallback).
- **Clickability/next action:** grid shows hardship reason + needs-hire reason; survey generated from tenant data.
- **What it touches:** form + schema migration + matcher + grid fmtTime + (Stage B) 5 offer fns.
- **Artifact columns:** "Offer sent" keys off `instructor_offer_messages`/`email_sent_at`.
- **Parallel schema:** diff against camp pref tables and mirror.

**Your turn:** settle Open #1 (and ideally #A buckets), and tell me how to handle the Section 7 scope/timeline. Then I build.
