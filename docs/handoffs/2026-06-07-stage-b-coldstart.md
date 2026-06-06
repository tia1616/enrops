# FA26 afterschool — Stage B cold-start (start here in the new chat)

**Goal:** finish Stage B — the after-school **offer loop** (the hire/confirm back-half), to summer parity. Decided 2026-06-07: "no point shipping half-built" — afterschool does NOT go to prod until Stage B is done.

## Read first
- `docs/specs/afterschool-instructor-lifecycle.md` — the spec. **Section "Stage B parity checklist"** is the definitive to-do list (every summer feature afterschool must match).
- Memory: `project_enrops_fa26_afterschool_test_day1` (now the running afterschool log).

## Where the build lives
- Worktree: `C:\Users\JVorster\Desktop\Projects\enrops-afterschool`, branch **`as-staging-merge`** — this tracks `origin/staging` and is the **real source of truth** (HEAD `c73371f`). Push work with `git push origin HEAD:staging`. (The `fa26-afterschool-lifecycle` branch is STALE — only has the first commit; ignore it.) These docs (spec + this handoff) are committed on this branch under `docs/`. Stage A is live on staging + verified.
- Staging Supabase: `mumfymlapolsfdnpewci`. Prod: `iuasfpztkmrtagivlhtj`. Afterschool is **staging-only** (NOT on prod/main).

## Stage A — DONE + on staging (don't redo)
Survey (per-weekday from/until + area prefs + days range), matcher v2 (`match-afterschool` v4 deployed: time-window + 15-min arrival, two-phase area pref w/ $30/$50 hardship, open-only), availability form, admin staffing-list view (pills, enrollment from `program_enrollment`, instructor-load strip, List/Week toggle, day-grouped + time-sorted), cycle setup (afterschool = dateless, registration-driven), area = `program_locations.area` (backfilled from address city).

## Stage B — STATUS
- ✅ `respond-to-assignment` made **polymorphic** (accepts `program_assignment_id`; accept/decline/request-change on program_assignments). Committed `c73371f`. **NOT deployed to staging Supabase yet.**
- 🛠️ `send-afterschool-offers` — NEW function written (approve→send email, confirmed→published, offer-message audit, "arrive by start−15", hardship bonus, area). Committed, **NOT deployed, NOT wired to UI, NOT tested.**
- ⏳ Remaining: reminders-cron + send-patch-offer + offer-message-reply + notify-instructor-removed made program-aware; **admin offer UI** (Approve, Send-offers modal+preview, status labels Proposed→Awaiting→Accepted [kill "Draft"], email-activity log, change-request modal, Publish, realtime); **instructor portal** afterschool offer cards (Accept/Decline/Request change → respond-to-assignment with program_assignment_id) + confirmed schedule; deploy all + guardrails + e2e test.

## Status lifecycle (mirror camps)
`proposed` (matcher) → **[Approve]** `confirmed` → **[Send offers]** `published` (+email) → **[instructor Accept]** `confirmed` / **[Request change]** `change_requested` / decline→`declined`. So the admin UI needs an **Approve** step (proposed→confirmed) before Send-offers reads `confirmed`.

## Deploy notes
- `respond-to-assignment` imports `../_shared/instructor.ts` — MUST include that file in the MCP `deploy_edge_function` `files` array. `send-afterschool-offers` is self-contained.
- Schema is READY — `program_assignments` has all offer columns (email_sent_at, instructor_response_at, deadline, change_request_message, decline_reason, admin_response_message, published_at, reminder_sent_at); `instructor_offer_messages` has `program_assignment_id`. **No migrations needed for Stage B.**

## Testing on staging
- J2S admin login: `jessica@journeytosteam.com` / `J2s-Staging-2026!` (or `admin@staging.enrops.test` / `Stg-Owner-7h2Kp!q`). **Reset both before consultant window 6/11.**
- Synthetic FA26 data present: 7 availability rows, 20 proposed `program_assignments`, areas set. To test the loop: Approve some → Send offers (test mode) → Accept/Decline in instructor portal.
- Build before push (Netlify staging is strict); ESLint no-undef + load the page (the build does NOT catch undefined-variable runtime errors — caught a `CREAM` white-screen this way).

## Pre-Italy non-negotiables still pending (don't let Stage B crowd these)
BGC sketch (hard deadline Tue 6/9), $1 payroll (Tue), weekly security audit (Wed), parent-portal additions (Mon). See `docs/handoffs/2026-06-04-pre-italy-schedule.md`.
