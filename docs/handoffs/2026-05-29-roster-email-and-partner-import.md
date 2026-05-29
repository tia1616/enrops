# Handoff — 2026-05-29 (Friday)

For Monday's Claude Code. This day had **two distinct sessions**:

- **PART 1 (morning)** — Email rosters to partner logistics contacts + partner contact ingest. Shipped as `ecdc72f`.
- **PART 2 (afternoon)** — FA26 afterschool tables + single-day sub flow end-to-end. Shipped as PRs 3.5 → 6 across `f99bd93`, `1b8faf3`, `facb770`, `fdebf6d`, `6f47f12`. See **PART 2** at the bottom of this doc.

Everything is deployed to prod (Netlify deploy verified on each push, edge functions live on Supabase).

---

## What shipped today

### Database (live)

- `program_locations.partner_id` — nullable FK → `partners(id)`, with a `BEFORE INSERT/UPDATE` trigger that enforces same-org integrity (partner and location must share `organization_id`). Migration: `supabase/migrations/20260529_program_locations_partner_link.sql`.
- `roster_email_sends` — audit table for every roster email send. Columns: `organization_id`, `camp_session_id`, `partner_id`, `sent_by_user_id`, `recipients` (jsonb snapshot), `message`, `resend_message_id`, `status`, `failure_reason`, `roster_camper_count`, `sent_at`. RLS scoped to org members. Migration: `supabase/migrations/20260529_roster_email_sends.sql`.

### Edge functions (deployed, ACTIVE)

| Slug | Version | What it does |
|------|---------|--------------|
| `email-camp-roster` | v4 | Auth-gated. `mode: 'preview'` returns recipients + default subject/body + camper count + instructors. `mode: 'send'` accepts custom subject + body, generates landscape branded PDF with conditional Homeroom column, sends one Resend email per recipient, writes audit row. |
| `import-partners-extract` | v1 | Auth-gated. Accepts `source: 'csv' \| 'xlsx' \| 'text'`. Parses spreadsheets server-side via SheetJS in Deno, then calls Claude Sonnet 4.6 to extract structured `partners[]` with `contacts[]`. Returns canonical JSON matching real schema enums. |
| `import-partners-write` | v1 | Auth-gated. Accepts reviewed rows + per-row decisions. Matches existing partners by normalized name (lowercase + alphanumeric-only). Dedupes new contacts by lowercased email under the resolved partner. Writes with `source='import'` + `last_verified=today`. |
| `admin-import-camp-roster` | v4 | Same as before, **now also accepts `homeroom_teacher`** in the registrant payload and writes it to `students`. |

### Frontend (committed)

**Rosters page (`/admin/rosters`):**
- Per-camp **"Email roster →"** button (only shown when roster count > 0).
- "Last emailed Jun 12" indicator under the camp row after a successful send.
- Roster query now selects `location_id` + `homeroom_teacher` + `start_time` + `end_time` (was missing some — caused a UUID error earlier today; see "Recent fixes").
- CSV import column aliases now include `homeroom_teacher` (matches "Homeroom teacher", "homeroom", "teacher", "classroomteacher", "homeroomname").
- Manual add-camper form has a Homeroom field.
- Edit camper form has a Homeroom field.

**Email Roster modal (`src/pages/admin/EmailRosterModal.jsx`):**
- Phase 1 — "Pick partner": shown when the camp's location has no `partner_id` linked. Picking a partner writes the link back to `program_locations` so future sends skip this step. Defensive: if the camp has no `location_id` at all, picker still works but the link isn't persisted.
- Phase 2 — Compose: recipient checkboxes (operational `partner_contacts` pre-checked, marketing/other collapsible), an "Other emails" text field for one-off recipients, **Email facts strip** (read-only camper count + instructor info), **editable Subject** field, **editable Message body** (pre-filled with default template, edit freely). PDF attaches automatically.

**Contacts page (`/admin/contacts`):**
- Partners tab is **live** (was "coming soon"). Shows partner count, contact count, by-type chips.
- **"+ Add partner"** button → `AddPartnerModal`. One-screen form, 1+ contact rows with add/remove. Submits via the same `import-partners-write` edge fn as bulk import (so name match → merge happens automatically).
- **"Import partners & contacts →"** button → `ImportContactsModal`. Multi-step: source picker (Upload file / Paste text) → extracting → review screen (per-partner cards with new/match badges, editable per-row, per-contact checkboxes) → writing → done.

### PDF roster

- **Landscape letter** (792 × 612). Fixes the clipped Emergency contact column from the portrait version earlier today.
- Branded purple header band with tenant logo (or org name fallback).
- Camp info block: title + dates/times/session type/ages + partner + location + address + instructor.
- "N campers on this roster" callout.
- Table columns: Camper, Grade, Parent, Parent phone, Parent email, Emergency contact. **Homeroom** column appears conditionally when at least one camper has `homeroom_teacher` set; other columns shrink to fit.
- DOB shown as a sub-line under the camper name.
- Multi-page if needed (continuation header on subsequent pages).

---

## Recent fixes during the session

- **"invalid input syntax for type uuid: 'undefined'"** in EmailRosterModal — the Rosters page was selecting `location_name` but not `location_id`, so the modal queried program_locations with `undefined` and Postgres rejected it. Fixed by adding `location_id` to the select + a defensive check in the modal for camps with no linked location.
- **PDF Emergency contact column clipped** — table was 622pt wide on a 612pt portrait page. Switched to landscape (792×612); plenty of room now.
- **"CC" relabeled to "Other emails (type one in)"** on the roster modal so the ad-hoc-recipient affordance reads cleaner.
- **`partner_type` had wrong enum values** in the extract LLM prompt (had `'other'`, real CHECK constraint doesn't include it). Fixed by querying `pg_constraint` for the real allowed list and updating prompt + sanitizer.
- **`partner_contacts.contact_role` was missing `'approval_gatekeeper'`** option in the LLM prompt. Fixed.

---

## What was tested in localhost today

| Flow | Status |
|------|--------|
| Inline "Add partner" form | ✅ Jessica confirmed: "1. works!" |
| Editable email preview (Subject + Body) | ✅ Jessica confirmed: "2. works!" |
| End-to-end Email roster (compose → send → gmail receive → PDF) | ✅ Jessica's gmail received the PDF, "looks good" after the landscape fix |
| `+ Add partner` writes to DB | ✅ implied by "works" |
| Bulk import — paste-text mode | ❌ **NOT tested by Jessica.** She pivoted to manual-add before completing the paste test. |
| Bulk import — file upload (CSV) | ❌ **NOT tested by Jessica.** |
| Bulk import — file upload (XLSX) | ❌ **NOT tested by Jessica.** |
| Homeroom CSV alias mapping | ❌ **NOT tested.** Built and deployed but no real CSV with a homeroom column has been imported yet. |
| Homeroom column appearing in PDF | ❌ **NOT tested.** No student in J2S currently has `homeroom_teacher` set, so the conditional column hasn't been rendered yet. |

---

## Known gaps / punchlist for Monday

### Things to test that we didn't get to

1. **Bulk import via XLSX upload.** Save a small spreadsheet with 2-3 partners + contacts, drop it into `/admin/contacts` → Import → Upload file. Confirm Claude extracts correctly. Watch for: column-header variations, multi-sheet handling.
2. **Bulk import via paste-text.** Use the sample text from the test plan I gave her last session. Confirm extraction.
3. **Homeroom column appears in PDF.** Edit a camper, set `homeroom_teacher = "Ms. Jones, Room 12"`, save, re-send the roster. Confirm the Homeroom column appears in the PDF and the other columns shrink.
4. **CSV roster import with homeroom column.** Roster Upload modal → CSV with "Homeroom Teacher" header → confirm auto-mapping picks it up and the value lands in `students.homeroom_teacher`.

### Real gaps / future work

- **No partner detail view.** Partners tab shows counts + by-type chips but no way to drill into a specific partner and see/edit its contacts. To edit a partner's existing data today, Jessica has to use Supabase Studio. Decision needed: build a partner-detail page or wait until something forces it.
- **No way to email a roster to a partner *other than* the linked one.** The modal only loads contacts for the location's `partner_id`. If she needs to email a different partner (e.g. district-level operations person who isn't tied to that school), she has to use the "Other emails" field manually. Could add a "change recipients to a different partner" action.
- **Bulk send rosters to all camps at once doesn't exist.** Each send is per-camp. Realistic ask if she's prepping a fall season — "send all 47 rosters to the right partners in one click". Significant build (preview screen × N campsx confirmation).
- **No notification when a homeroom_teacher value is missing on after-school rosters.** Once fall after-school exists, schools will expect homeroom info per kid. We should flag students without it. Currently silent.
- **Partner name normalization is loose.** `import-partners-write` matches by `lowercase + alphanumeric-only`. "St. Mark's" and "St Marks" normalize to different strings (`st mark s` vs `st marks`). Minor — only matters if a tenant has near-duplicate names with apostrophe variations.
- **Resend is one API call per recipient.** I send to each contact individually so partners don't see each other's emails. For partners with many contacts this could hit rate limits eventually. Pro plan is fine for current volume; worth flagging if a tenant has 50+ contacts on a single partner.

### Forward-looking — fall after-school rosters

Per project memory: the current Rosters page is **camps-only**. Fall after-school rosters need:
- A `program_sessions` table (afterschool equivalent of `camp_sessions`) — doesn't exist yet
- Student↔program registration link (registrations table is currently tied to camp_session_id only)
- An afterschool rosters page (or extend `/admin/rosters` to cover both)
- Email-roster flow extended to programs

This is task **#37** in the backlog ("FA26 afterschool path"). The homeroom_teacher wiring done today is a forward-compat investment — when the after-school roster system arrives, the data already has a home.

---

## Files in scope (committed in `ecdc72f`)

```
src/pages/admin/Rosters.jsx                            (modified)
src/pages/admin/EmailRosterModal.jsx                   (new)
src/pages/admin/contacts/AdminContacts.jsx             (modified)
src/pages/admin/contacts/PartnersTab.jsx               (new)
src/pages/admin/contacts/ImportContactsModal.jsx       (new)
src/pages/admin/contacts/AddPartnerModal.jsx           (new)
supabase/functions/email-camp-roster/index.ts          (new)
supabase/functions/import-partners-extract/index.ts    (new)
supabase/functions/import-partners-write/index.ts      (new)
supabase/functions/admin-import-camp-roster/index.ts   (modified)
supabase/migrations/20260529_program_locations_partner_link.sql  (new)
supabase/migrations/20260529_roster_email_sends.sql              (new)
```

### Note on on-disk vs deployed edge functions

When deploying via the Supabase MCP `deploy_edge_function` tool, I inlined the file contents into the tool call. To avoid JSON-escape headaches with multi-line strings, I replaced em-dashes (`—`) and box-drawing characters in some comments with ASCII (`-`). So the on-disk files in `supabase/functions/*/index.ts` may have stylistically nicer comments while the deployed versions are functionally identical but ASCII-only.

If Monday Claude redeploys these via `supabase functions deploy` (CLI), the on-disk versions are the source of truth and will work fine. No functional drift.

---

## Unrelated dirty files Jessica left in her tree (NOT committed)

These were modified before this session and are unrelated to roster/partner work. Did not touch:

```
public/favicon.ico
src/pages/admin/contacts/InstructorsTab.jsx
src/pages/admin/programs/ProgramsCalendar.jsx
src/pages/onboarding/OnboardingRouter.jsx
src/pages/onboarding/WizardHost.jsx
src/pages/onboarding/screens/Screen2BackgroundCheck.jsx
supabase/functions/admin-upload-background-check/index.ts
deno.lock
+ untracked: docs/*.pdf, supabase.exe, several new edge fn folders
```

Monday Claude: ask Jessica what these are before touching them.

---

## Quick reminders

- **Tia1616@gmail.com** = Jessica's personal email for test sends.
- **Live Supabase project** = `iuasfpztkmrtagivlhtj` (Enrops).
- **Netlify site** = `zesty-eclair-31c105` (deploys `main` → enrops.com).
- **Tenant slug** = `j2s` for Journey to STEAM. Don't hardcode it anywhere new.
- The pre-existing rule: **never hardcode tenant identity**, **RLS-scope everything**, **free surfaces all features**. All of today's work follows these.

---

# PART 2 — FA26 afterschool + single-day sub flow (afternoon session)

Picked up the FA26 work from the prior chat's handoff (`docs/handoffs/2026-05-19-marketing-comms.md` plus the FA26 task description). Shipped four merged PRs in sequence: **PR 3.5 → PR 4 → PR 5 → PR 6**. Each independently FF-merged to `main` with deploy-verify confirming production on enrops.com.

## What shipped today (PART 2)

### Database (live)

- **`assignment_substitutions` audit fixes (PR 3.5, `f99bd93`)** — `supabase/migrations/20260529_pr35_fa26_audit_fixes.sql`:
  - Re-aligned `program_assignments.status` enum to match `camp_assignments` verbatim (`'proposed','confirmed','change_requested','published','withdrawn','declined'`). Default changed `'pending'` → `'proposed'`. Partial unique index updated to drop `'cancelled'` from the exclusion list.
  - New `BEFORE UPDATE` trigger `restrict_assignment_substitution_sub_updates` on `assignment_substitutions`. When auth.uid() resolves to the row's `sub_instructor_id`, only `status`/`decline_reason`/`declined_at`/`email_viewed_at`/`updated_at` are mutable. Closes a path where a malicious sub could PATCH `sub_tier` and inflate effective pay.
  - Extended `validate_assignment_substitution_parent()` to also enforce `sub_instructor_id` belongs to the parent assignment's org. UPDATE trigger column list widened to include `sub_instructor_id` so swapping subs re-runs validation.

- **`instructor_payouts` extended for programs (PR 4, `1b8faf3`)** — `supabase/migrations/20260529_pr4_instructor_payouts_programs.sql`:
  - Nullable `program_id` column added. `camp_session_id` dropped to nullable.
  - CHECK constraint `instructor_payouts_camp_xor_program_check`: exactly one of `camp_session_id` / `program_id` set per row.
  - Parallel `UNIQUE PARTIAL INDEX uq_instructor_payouts_no_concurrent_program` on `(instructor_id, program_id) WHERE status IN ('pending','succeeded')`. Programs now have the same double-pay guard camps have.

- **Sub RLS for camp roster access (PR 6, `6f47f12`)** — `supabase/migrations/20260529_pr6_subs_read_camp_rosters.sql`:
  - New SELECT policies `subs_read_camp_rosters` / `_students` / `_parents` on `registrations` / `students` / `parents`.
  - Gate: `assignment_substitutions.status IN ('confirmed','taught')` with sub_instructor_id matching `private.current_instructor_id()`.
  - Pending sub offers do NOT grant roster access — must accept first. Declined / missed do not grant.

- **Coordination email config + confirmation idempotency (PR 6, `6f47f12`)** — `supabase/migrations/20260529_pr6_sub_coordination_and_confirmation_uniqueness.sql`:
  - `organizations.sub_coordination_notes TEXT NOT NULL DEFAULT ''`. Tenant-configurable middle paragraph of the 3-way sub-coordination email. J2S seeded with: *"Please coordinate the sub having all the materials they need for the class. Also let them know which lesson(s) they should teach."* — Jessica approved this copy.
  - Unique partial indexes on `session_delivery_confirmations(instructor_id, camp_session_id, session_date) WHERE camp_session_id IS NOT NULL` and the parallel program index. Closes the double-click race in `confirm-session-taught` / `confirm-sub-delivery` (was check-then-insert; now durably unique).

### Edge functions (deployed, ACTIVE)

| Slug | Version | What it does |
|------|---------|--------------|
| `create-assignment-substitution` | v1 | NEW. Admin assigns a single-day sub. UPSERTs `assignment_substitutions` on the unique (parent, type, date). Sends Ennie-voiced offer email via Resend with: program / date / time / where / address / arrival / dismissal / notes / role. Writes `email_sent_at` after successful send — the only path that writes that column (artifact-column rule, verified by grep). |
| `respond-to-sub-offer` | v2 | NEW. Sub accepts or declines. Anti-enumeration 403 for missing-row + not-yours. Verifies `status='pending'` (already_responded otherwise). Accept → `confirmed` + fires the 3-way coordination email (TO: regular + sub, CC: org alert_email, dedupes if sub==alert_email). Decline → `declined` + `declined_at` + reason, emails admin alert_email, no auto-cascade. Tenant-configurable middle paragraph from `organizations.sub_coordination_notes`. |
| `confirm-sub-delivery` | v1 | NEW. Sub clicks Mark Taught on an accepted sub day. PR 3.5 Option A: keeps `session_delivery_confirmations.instructor_id` = the regular (originally scheduled) instructor. Sets `confirmed_by='sub'`, computes `pay_amount_cents` from `assignment_substitutions.sub_tier` (NOT parent's role). 409s cleanly if the regular has already self-confirmed. Updates substitution → `'taught'`. |
| `pay-instructor` | v2 | EXTENDED. Body now accepts `program_id` alongside `camp_session_id`. Dispatches the v_effective_pay_lines fetch on whichever is set. Distance-bonus marker writes to `program_assignments.distance_bonus_paid_at` on the program branch. Hands-off zones (pay_model dispatch, _shared/handleTransferReversed.ts) untouched. |
| `get-instructor-curriculum-docs` | v2 | EXTENDED. Now allows lesson access via either (a) a confirmed camp_assignment OR (b) a confirmed/taught `assignment_substitutions` row whose parent's camp_session has the requested curriculum_id. Two-step polymorphic lookup since substitutions has no FK to camp_assignments. |
| `confirm-session-delivery` | unchanged | Was already updated in PR 3 (prior chat) to handle afterschool. No change today. |

### Frontend (committed)

**Schedule page (`/admin/schedule`):**
- New `assignSubFor` state at Schedule top level.
- CandidatePicker gained `onAssignSub` callback rendering an **"Assign sub for a day"** button as sibling to Remove in the `currentAssignment` block.
- `WeeklyGrid` now wraps `onInstructorClick` per cell to inject the cell's date — when admin clicks an instructor pill on Monday's tile, the modal opens with Monday already pre-filled. New helper `addDaysIso(weekStart, dayIndex)`.

**`AssignSubModal.jsx` (NEW):**
- Date is a locked display (not an input). Always set from the clicked day-tile context.
- Sub dropdown excludes the parent's regular instructor.
- Tier defaults to parent's role, editable to swap lead↔developing.
- Notes textarea, 1000 char limit, included in offer email + sub portal card.
- "Already covered" section lists existing sub rows for this parent.
- Submit button label dispatches on (date, sub) state: `"Send offer"` → `"Resend offer to X"` (when `email_sent_at` set + same sub) → `"Swap to Y"` (different sub on same date).
- Refreshes existingSubs after each submit so the Resent state flips immediately.

**Payroll page (`/admin/payroll`):**
- Dropped the `.not('camp_session_id', 'is', null)` filter — programs now show alongside camps.
- Fetches `programs` + `program_locations` in parallel for rows with `program_id`.
- Group key generalized: `${effective_instructor_id}|${kind}:${targetId}` where kind ∈ {camp, program}.
- Label rendering dispatches: camp shows `[Curriculum] · [Location] · Week N`; afterschool shows `[Curriculum] · [School] · m of N sessions`.
- Sort uses `program.first_session_date` for program groups, `session.starts_on` for camps. Both kinds interleave by date.
- Pay drawer + Mark-paid drawer bodies dispatch `camp_session_id` vs `program_id`.

**Instructor portal (`/j2s/instructor`):**
- New `subAssignments` state. `loadSubAssignments` queries `assignment_substitutions` filtered by `sub_instructor_id` + does separate parent lookup (no FK to camp_assignments, polymorphic via trigger). Now called from all four existing `loadAssignments(...)` Promise.all sites.
- New `SubOfferCard` component:
  - **Pending**: renders venue + role + notes + **Accept** + **"Can't make it"** (opens reason textarea → Send decline).
  - **Confirmed/taught**: renders status badge, then **"Mark this day as taught"** button (single-day, only when `date <= todayLocalISO()`), then **RosterSection** (via PR 6 sub RLS), then **LessonsSection** (via extended `get-instructor-curriculum-docs`).
- Pending sub offers render as a new **"Sub day offers"** section above the existing "Needs your response."
- Confirmed/taught sub days **merge into the existing "Confirmed schedule" section** alongside regular AssignmentCards. They interleave with the regular schedule visually. (Per Jessica's explicit ask — sub days should appear in confirmed schedule, not a separate section.)

### Pay routing — sanity check

`v_effective_pay_lines` does the right thing for sub-confirmed days:
- camp branch JOINs to `assignment_substitutions` on `(parent_assignment_id, type='camp', date)`.
- `effective_instructor_id = COALESCE(sub.sub_instructor_id, c.instructor_id)`.
- `effective_tier = COALESCE(sub.sub_tier, i.contractor_tier)`.
- `source = 'sub' WHEN sub.sub_instructor_id IS NOT NULL ELSE 'regular'`.
- `distance_bonus_cents_if_regular = NULL` for sub rows (subs don't earn distance bonus).
- Payroll page already shows "Subbing for [Regular Name]" subtitle when `source='sub'` (existing code at line 685).

## What was tested in localhost today (PART 2)

| Flow | Status |
|------|--------|
| Admin clicks instructor pill on day tile → "Assign sub for a day" → modal opens with date pre-filled | ✅ Jessica confirmed visually |
| Modal sub dropdown excludes regular instructor + tier defaults to parent's role | ✅ Confirmed visually |
| Submit sends offer email | ✅ Jessica received the offer email at jessica@journeytosteam.com (she assigned herself as the sub) |
| Sub accepts via portal → status flips to `confirmed` → card moves to Confirmed schedule | ✅ Confirmed visually |
| Sub day card shows venue + arrival + dismissal + roster + lessons inline | ✅ All four sections rendered (13 campers visible, lesson docs available) |
| Sub declines via portal → status flips to `declined` → admin email fires | ✅ Jessica received the admin decline notification at alert_email |
| **Mark Taught (confirm-sub-delivery)** | ❌ **NOT tested.** Jessica's sub day is `2026-07-08` (future), so the button never shows. Need to back-date a test row to verify the edge fn end-to-end. |
| **3-way coordination email on Accept** | ❌ **NOT tested.** Wired and copy approved, but Jessica did NOT click Accept again after I added the email — accepting would have fired a real email to the production regular instructor (Isis Joy Melendez, aidenjyo@gmail.com). She approved the rendered copy in chat only. |
| **Afterschool path (programs branch)** | ❌ **NOT tested.** No program has a sub assigned. See gaps below. |

**State at end of session:** Test sub row `e6f6e0da-e9eb-4fe7-8a84-01d367633af4` (Jessica subbing for Isis Joy on Jul 8 LEGO Architects) was **DELETED** at Jessica's request before EOD. She is unassigned. No real instructors received emails from her testing.

## Known gaps / punchlist for Monday (PART 2)

### Things to test that we didn't get to

1. **Mark Taught for subs (confirm-sub-delivery).** Easiest path: create a new sub row dated today via the Assign Sub modal, accept it via the portal, then click Mark Taught. Verify:
   - `session_delivery_confirmations` row inserted with `confirmed_by='sub'`, `instructor_id` = the regular (NOT the sub), `pay_amount_cents` computed from `sub_tier` ($80 lead morning, $65 developing, $160 lead full_day, etc).
   - `assignment_substitutions.status = 'taught'`.
   - The sub's pay shows up in `/admin/payroll` under the sub's name with "Subbing for [Regular]" subtitle.
2. **3-way coordination email on Accept.** Requires accepting a real sub offer. Two options:
   - (a) Create a test sub row where the *regular* instructor is yourself (Jessica), then accept. CC dedupe will collapse all recipients to Jessica.
   - (b) Build a `mode='test'` flag on `respond-to-sub-offer` that routes the email only to TEST_INBOX. Cleanest for ongoing dev — I started but did NOT build this; Jessica deferred (see "Decisions deferred" below).
3. **Afterschool sub flow** — pick a program in `/admin/schedule` (once afterschool view exists in Schedule.jsx, which it doesn't yet — see gap below) and assign a sub. None of the program-branch code has been exercised end-to-end yet, only the camp branch.

### Real gaps / future work

- **InstructorPortal `loadAssignments` is still camps-only** (line 257). Doesn't query `program_assignments`. So a regular instructor won't see their afterschool engagements in `/j2s/instructor` even after FA26 launches. **This is critical to land before FA26 instructors get their offers.** The query needs to mirror the camp_assignments select, joining to `programs` + `program_locations`.
- **`DailyCheckInSection` assumes Mon–Fri** (calls `weekdayRange(starts_on, ends_on)` which returns all weekdays in the span). For afterschool programs, the daily check-in must instead call `derive_program_session_dates(program_id)` (the SQL function shipped in PR 1) which returns only valid session dates, skipping `program_locations.closure_dates`. Currently the afterschool DailyCheckIn would show every weekday in the term — wrong. **Jessica explicitly flagged this — fix when extending portal to programs.**
- **No afterschool view in `/admin/schedule`.** Schedule.jsx renders camp_sessions only. To assign a sub to a program, admin currently has no UI surface. AssignSubModal supports `parentType='program'` but Schedule never passes it. Future work: extend Schedule.jsx with an afterschool tab/view that queries programs + program_assignments.
- **Coordination email sending domain hardcoded.** `respond-to-sub-offer` uses `hello@updates.journeytosteam.com` — same J2S-specific tech debt as `send-offers` / `create-assignment-substitution`. Multi-tenant fix: per-tenant `email_from_domain` column on `org_branding`. Out of scope for today; tracked across all email senders.
- **No "offer rescinded" email when admin swaps an *active* sub.** If admin assigns Sub A (pending), then changes mind and assigns Sub B for the same date, the UPSERT replaces the row. Sub A still has an offer email in their inbox but their row no longer exists for that date. Clicking Accept would 403 (sub_instructor_id no longer matches). Per Jessica's explicit note: "the original sub doesn't have to be notified if they already declined" — so this only matters for *pending → swap*. Low priority; ship as-is.
- **Sub date can be a non-class day.** Example: a camp with `class_days = ['monday','wednesday','friday']`. Modal's date display accepts whatever date the admin clicked the day-tile for. If admin clicks a Tuesday tile (which doesn't exist on that camp's calendar) — actually it can't, the WeeklyGrid only renders cells for valid class_days. So this is a non-issue with the locked-date pattern. ✅
- **PR 7 not started.** District closure admin UI + Ennie LLM-extract helper + publish-time end-date warning. Last chunk of FA26 work.

### Decisions deferred (Jessica's call required)

1. **Build `mode='test'` flag on respond-to-sub-offer** so dev can test the coordination email without firing real emails? Jessica said "decide later." Keep this in the back of the head for Monday.
2. **Afterschool view in Schedule.jsx** — does Jessica want one giant page with tabs (Camps | Afterschool), or two separate routes (`/admin/schedule/camps`, `/admin/schedule/afterschool`)? Don't build either until she picks.

## Pressure-test findings (PART 2)

End-of-session, I walked through every action in the sub flow against DB state + code. Findings:

**Works correctly:** offer modal date pre-fill, UPSERT semantics, artifact-column rule (verified by `Grep` on `assignment_substitutions` writers — only my new edge fns touch it), sub portal load (polymorphic parent join via two-step lookup), Accept path, Decline path with admin email, RLS for sub roster access (3 new policies applied), lesson access via extended ownership check, Mark Taught preserves regular `instructor_id`, pay routing via `v_effective_pay_lines`, anti-enumeration 403 patterns, column-restriction trigger on `assignment_substitutions`.

**Small gaps flagged + dispositioned by Jessica:**
- "No server-side date range validation in create-assignment-substitution" → **Skip** (UI scopes it; admins only).
- "Sub date can be a non-class day" → **Non-issue** (Schedule.jsx never renders cells for invalid class_days).
- "No 'offer rescinded' email" → **Skip** (only matters for declined, which she said doesn't need it).
- "Double-click race on confirmation insert" → **Fixed** with unique partial indexes in PR 6 migration.

## Files in scope (PART 2 — across the four PRs)

```
PR 3.5 (f99bd93):
  supabase/migrations/20260529_pr35_fa26_audit_fixes.sql

PR 4 (1b8faf3):
  supabase/migrations/20260529_pr4_instructor_payouts_programs.sql
  supabase/functions/pay-instructor/index.ts        (modified)
  src/pages/admin/Payroll.jsx                       (modified)

PR 5 (facb770 + follow-up fdebf6d):
  supabase/functions/create-assignment-substitution/index.ts   (new)
  src/pages/admin/AssignSubModal.jsx                            (new)
  src/pages/admin/Schedule.jsx                                  (modified)

PR 6 (6f47f12):
  supabase/migrations/20260529_pr6_subs_read_camp_rosters.sql                          (new)
  supabase/migrations/20260529_pr6_sub_coordination_and_confirmation_uniqueness.sql    (new)
  supabase/functions/respond-to-sub-offer/index.ts                                     (new)
  supabase/functions/confirm-sub-delivery/index.ts                                     (new)
  supabase/functions/get-instructor-curriculum-docs/index.ts                           (modified)
  src/pages/j2s/InstructorPortal.jsx                                                   (modified)
  src/pages/admin/AssignSubModal.jsx                                                   (modified — date input → locked display, per Jessica)
```

## Dirty files still in tree (unchanged from PART 1's note)

The same set listed in PART 1 is still present and was NOT touched in PART 2 either. Monday Claude: do not assume any of those are connected to the FA26 sub work.

## Sub flow at a glance — Monday Claude orientation

```
ADMIN                                  SUB                              REGULAR
─────                                  ───                              ───────
/admin/schedule
  click instructor pill on day tile
  click "Assign sub for a day"
  AssignSubModal opens with date locked
  pick sub + tier + notes
  Submit ───────────────────────►  email lands in sub's inbox
                                   sub clicks "Open your portal"
                                   /j2s/instructor
                                   sees pending offer card
                                   click Accept
                                   ↓
                                   status='confirmed'
                                   ↓
                                   3-way email fires ─────────────────► regular gets the email
  (CC on the email)                                                     ("Sub is covering your X on Y")
                                   ↓
                                   sub day appears in Confirmed schedule
                                   roster + lessons accessible
                                   ↓
                                   day arrives, sub teaches
                                   ↓
                                   click "Mark this day as taught"
                                   ↓
                                   session_delivery_confirmations row
                                   confirmed_by='sub', instructor_id=regular
                                   pay computed from sub_tier
                                   ↓
                                   shows in /admin/payroll under sub's name
                                   "Subbing for [Regular]" subtitle
```

Decline path: sub clicks "Can't make it" → reason textarea → status='declined', `declined_at` set, decline_reason saved. Admin notification email fires to `organizations.alert_email`. No auto-cascade — admin re-opens AssignSubModal and assigns a different sub manually.
