\# Backlog



\## 2026-05-20

\- \[task] Enable google drive doc and pdf import for curricula

\- \[task] delete the 'schedule it' confirmation ask and button in the curricula celebration. change to 'market' or 'check enrollment'

\- \[question] How does a provider cancel a program if it's numbers are too low to run? This should happen in 'programs', then flow to instructor schedule and partner notification. Both need to be notified of cancelled program, and it should be taken off instructor schedules.



\- \[task] pick back up marketing Don build



\- \[task] add counting seconds when extracting ci=urriculum



\- \[task] enable 'cancel send' after sending, or cancel send to anyone who hasn't gotten it yet



**## 2026-05-21**

\- \[task] Chunk 03, Step 3 | Fix before building chunk 03\*\* marketing, marketer Done



The spec says that when the “who” input is ambiguous, a sub-call to Claude converts it into a database filter. But there’s no definition of what that filter can look like — what columns it can reference, what operators are allowed, what the output format is.



\*\*Why it matters:\*\* An LLM generating open-ended query logic against your database is a security and reliability risk. If Claude hallucinates a column name, you get an error. If it constructs a filter that crosses tenant boundaries, you get a data leak. If it returns something your code doesn’t expect, the flow breaks silently.



\*\*What to do:\*\* Before building chunk 03, define:



\- The exact fields Claude is allowed to filter on (e.g., `segments`, `school\\\_name`, `city`, `enrollment\\\_status` — whatever exists on `marketing\\\_recipients`)

\- A strict JSON schema for the filter output (e.g., `{ field: string, operator: "eq" | "contains" | "in", value: string | string\\\[] }`)

\- A validation step between Claude’s output and the database query — if the filter doesn’t match the schema, reject it and return a helpful error instead of executing it

How are existing `marketing\\\_recipients` segments tagged?

* \[task] marketing, marketor don
* &#x20;Claude Code:\*\* When specs reference each other, paste both into context. “Here’s the function spec (chunk 03) and the UI spec that calls it (chunk 06). The regenerate feature is in 06 but missing from 03. Help me add the regenerate section to the function spec so they’re consistent.” Claude Code is much better at reconciliation when it can see both sides.



Default sender display name — confirmed or still open?

\- \[ ] Is there an existing campaign list/history view, or does that need to be built?



* fix timer in the corner to be more realistic
* enable 2 uploads per materials uploads with curricula



**## 26-05-22**

* need 'engagement letter' with schedule offers
* test stripe connect to instructor onboarding
* end to end test for different providor profiles ui- don't have 'preferred/not preferred' on locations in surevey, for example
* \# Backlog — open items as of 2026-05-25
* 
* \## Carrying over (post-PWA, pre-partner-locations)
* 
* \### Brand refactor (next up — in flight)
* \- \[ ] Fix Enrops colors across codebase: replace PLUM #691D39 / GOLD #CFB12F (currently misapplied as "Enrops") with the real Enrops palette: Deep Purple #1C004F, Cream #FBFBFB, Vivid Violet #8C88FF, Mint Green #26D687, Bright Pink #F16BF1, Soft Yellow #F8F068, Soft Lilac #F2F0FF
* \- \[ ] Fix J2S colors across codebase: PLUM/GOLD are NOT J2S either. Real J2S = Purple #674ee8 / Orange #f8a638 (+ #4430ac darker purple, #e85b37 darker orange)
* \- \[ ] Font swap: Enrops surfaces (admin, marketing landing) → Poppins. J2S surfaces (instructor portal, parent site) → Titan One (headings) + Nunito Sans (body)
* \- \[ ] Update `tailwind.config.js` color tokens for both brand systems
* \- \[ ] Update PwaInstallButton placement on /admin — move from bottom of sidebar to somewhere more obvious (top of main content header? floating bottom action?)
* 
* \## Features queued behind brand refactor
* 
* \### Admin-who-teaches (quick win, \~1 hr)
* \- \[ ] On /admin overview, add "Your teaching schedule" card if the signed-in admin is ALSO in the instructors table (shows their next 1-2 assignments)
* \- \[ ] In admin sidebar, add "Open my instructor view →" link when admin has an instructor row
* 
* \### Admin: add-instructor form (\~1 hr, discovered 2026-05-25 during contractor smoke test)
* \- \[ ] /admin/instructors lists instructors but has no "Add instructor" button — rows currently only get created via direct SQL or the availability survey signup. Add an "Add instructor" CTA on the Instructors page that opens a small form (first name, last name, email, phone, contractor\_tier) and inserts a row in `instructors`. Follow-up prompt: "Send onboarding invite now?" → fires `contractor-invite` immediately. Until this ships, the only way to onboard a new contractor is for an engineer to insert the row by hand.
* 
* \### Magic-link email copy: add "onboarding" context (small, discovered 2026-05-25)
* \- \[ ] `auth-send-magic-link` edge function currently has three branches: admin / instructor / parent. The instructor branch says "Sign in to view your schedule" — wrong copy for a contractor who's mid-onboarding wizard (no schedule yet). Add a fourth `context: 'onboarding'` branch with subject "Continue your onboarding at \[org name\]" and body "Pick up where you left off." Wire the SignInPanel inside OnboardingRouter to pass `context: 'onboarding'` (and/or have client code pass it whenever the email recipient has `overall_status != 'complete'`).
* 
* \### Screen 3 ORS: supplies bullet rewritten 2026-05-25
* \- \[x] `src/pages/onboarding/screens/Screen3ORS.jsx` line 89-91 was "You use your own supplies, transportation, and insurance unless you've agreed otherwise in writing." Dropped the supplies clause since J2S provides materials. Now reads "You use your own transportation and carry your own car insurance." ⚠️ Heads-up: provider-supplied materials is one of the IRS factors that pushes toward "employee" classification. If a future tenant ships where the contractor DOES bring their own supplies, this bullet should be made configurable or surfaced in their engagement letter. Worth a CPA review once Enrops has 2+ tenants.
* 
* \### Partner locations (medium chunk)
* \- \[ ] Build `partner\_locations` + `partner\_location\_contacts` tables (schema in mockups/partner-location-detail.html section 5)
* \- \[ ] Build admin form for add/edit partner location with multi-contact support
* \- \[ ] Build Dora-style AI-extraction flow (paste email/PDF → extract structured fields → flag low-confidence for admin review)
* \- \[ ] Wire Google Places Autocomplete + Geocoding once Maps API key is provisioned
* \- \[ ] Render Location/Phone/Arrival/Dismissal section inside assignment detail view (drop parking — out of scope v1)
* \- \[ ] Add "Get directions" + "Open in Maps" buttons
* 
* \### Roster CSV import (depends on real Squarespace export)
* \- \[ ] Get a real Squarespace export from an actual past camp to map columns
* \- \[ ] Build admin "Upload Squarespace export" UI
* \- \[ ] Build diff-and-preview before write (new / updated / cancelled registrations)
* \- \[ ] Populate per-camper rows: name, age, allergies, emergency contacts, pickup-authorized list
* \- \[ ] Wire the instructor roster section to read from the new rows
* \- \[ ] Resolve open questions in mockups/instructor-roster-detail.html bottom yellow box (notify-on-update, pickup-authorized field source, expanded camper visibility)
* 
* \## Routing / UX polish
* \- \[ ] Decide whether to replace silent catch-all redirect (`\*` → `/`) with a real 404 page. Keeping current behavior for now per Jessica 2026-05-25.
* \- \[ ] Decide on admin install-button placement post-refactor
* 
* \## Carryover from earlier
* \- \[ ] Squarespace MCP connector — wasn't visible in Claude Code after restart on 2026-05-25. Re-verify in your connector settings. If web-only, stay on CSV import path.
* \- \[ ] Real product screenshots in PWA manifest (`screenshots\[]` array) for Chrome's "rich install UI"
* \- \[ ] Smoke test PWA install on iPhone (Arielle) + verify update toast behavior on next deploy
* 
* \## Done this session (2026-05-25)
* \- Instructor portal v1 (admin pipeline card, documents view, assignment detail, lessons section, roster stub)
* \- New edge function `get-instructor-curriculum-docs` (deployed, verify\_jwt: true, ACTIVE)
* \- Admin nav restructure (Instructors top-level, Team dropped from nav)
* \- PWA full setup (vite-plugin-pwa, install button on instructor/admin/J2S portals, update toast, manifest, icon, Vercel headers)
* \- PWA icon swap from placeholder "E" → real Enrops "e" mark in Deep Purple
* \- Smart-redirect on `/` for signed-in users (admins → /admin, instructors → /:slug/instructor)
* \- `/instructor` shortcut redirect to `/j2s/instructor`
* optimize admin for mobile
* for admin doing onboarding/hiring- add advice 'check with your state's employment laws or a lawyer when deciding to hire contractors or w2 employees'

\## 2026-05-26

\### Team tab missing from /admin (discovered 2026-05-26)
\- \[ ] Jessica reported `/admin/team` isn't surfacing a Team tab in the admin nav. Admin-invite edge function v1 deployed 2026-05-23 (per [Arielle enrops platform access session]) and is working, but the UI entry point is gone or never wired. Per `docs/handoffs/` notes, "Admin nav restructure (Instructors top-level, Team dropped from nav)" landed 2026-05-25 — likely got dropped during that pass. Restore a "Team" entry (under Settings or top-level) that loads the existing `/admin/team` route, so admins can invite teammates without a CLI/edge-function call.

\### RLS disabled on `public.capability_definitions` (Supabase advisor, 2026-05-26)
\- \[ ] Supabase flagged `public.capability_definitions` as having Row Level Security disabled while anon + authenticated roles can still reach it. It's a lookup/reference table (14 rows of capability metadata), so the data isn't sensitive, but on principle every `public.*` table should be RLS-on. Enable RLS and add a permissive `SELECT` policy for `authenticated` (and `anon` if any pre-login flow needs it). Remediation SQL from advisor: `ALTER TABLE public.capability_definitions ENABLE ROW LEVEL SECURITY;` — but DO NOT run as-is; add a SELECT policy in the same migration or every read will start failing. Low priority; bundle into next housekeeping pass.

\### Cleanup: `dev-seed-designer-access` edge function (deployed 2026-05-26)
\- \[ ] One-shot dev function deployed to seed designer test accounts (Sasha + Oleksandra admin invites, 3 fake personas: instructor/parent/contractor). Gated by `x-seed-secret` header, idempotent — re-run any time to refresh magic links. After designers wrap their visual-direction pass, delete the function from Supabase dashboard and remove `supabase/functions/dev-seed-designer-access/` from the repo. Also delete the 3 fake personas from the DB: `designer-instructor@enrops.com`, `designer-parent@enrops.com`, `designer-contractor@enrops.com` (auth.users + instructors/parents/contractor_onboarding_status rows).

\### "Your assignment changed" instructor email (gap found mid-reassignment)
\- \[ ] Today's `send-patch-offer` only emails instructors who were **newly assigned and not yet emailed**. If an admin reassigns a camp from Instructor A (already emailed, may have accepted) to Instructor B, A is silently bumped — no email, no offer activity log entry, no "your schedule changed" notice. A finds out by realizing their portal no longer shows the camp, or worse, by showing up.
\- \[ ] Detect the case: on a `camp_assignments` update where `instructor_id` changes AND the row's previous `email_sent_at` is not null, queue a "removed from camp" notice for the previous instructor. Capture `prev_instructor_id` so the notice has a target after the row mutates.
\- \[ ] Surface as a Schedule tip (same pattern as the existing pending-patches banner): *"You moved [Camp] off [Instructor A]'s schedule — let them know?"* with a "Preview email" → "Send" flow. Don't auto-fire; the admin should see the wording first.
\- \[ ] Email copy: warm, brief, no blame. State the camp + week is no longer on their schedule, why if a reason was captured (low enrollment, schedule change, etc.), what's still on their schedule, and offer to reach out with questions. **No "cancel" language** (J2S principle applies even though this is internal-facing — it's instructor-facing, not parent-facing, but the tone rule still holds).
\- \[ ] If their **entire** cycle assignment count just dropped to zero, change the framing — they were de-staffed for the cycle, not just shuffled. Different copy + soft check-in.
\- \[ ] Write to `instructor_offer_messages` with a new `kind` (e.g. `removal_notice` or `assignment_changed`) so the EmailActivityModal timeline stays complete.
\- \[ ] Pay reconciliation: if pay rows / Stripe transfers were already created against the removed assignment, flag for admin review in the same tip (don't auto-void).

\### Cancel-a-program flow (originally raised 2026-05-20 as a question; now scoped)
\- \[ ] Programs tab is currently read-only and only shows afterschool (`programs` table, FA26/WI27/SP27). Summer camps live in the Schedule tab (`camp_sessions`, by `cycle_id`). Unify these so cancellation has one home.
\- \[ ] On the Programs tab, surface SU26 camps alongside afterschool runs (UNION of `programs` + `camp_sessions`, tagged by source) so the operator has one place to manage scheduled offerings.
\- \[ ] Add a "Cancel program" row action with confirmation modal. Capture an optional reason ("low enrollment", "venue unavailable", "other").
\- \[ ] On confirm, the action must:
  1. Set program/camp status → `cancelled` (programs) / `withdrawn` (camp_sessions) — match existing status enums.
  2. Clear or mark instructor assignments (`camp_assignments` for camps, equivalent for programs once `program_assignments` exists) so the instructor frees up in the Schedule view.
  3. Flag any paid/installment registrations for refund (out of scope for zero-signup cancellations, but the general case needs it).
  4. Trigger partner-location notification (school/venue contact gets an email — wording must avoid "cancel" with parents; internal admin/partner copy is fine).
  5. Trigger instructor notification (their offer/assignment is no longer happening; offer alternative slots if any are open).
\- \[ ] Once cancelled, the row stays visible on Programs (struck through, status pill) for audit, not deleted.
\- \[ ] Schedule tab should reflect the freed instructor immediately — they appear back in the available pool.


\### Per-row gating on `program_locations` sensitive columns (deferred 2026-05-26)

\- \[ ] Anon read on `program_locations` was locked to public columns only on 2026-05-26 (REVOKE/GRANT migration `lock_anon_program_locations_columns`). Sensitive columns (`contact_phone`, `arrival_instructions`, `room_number`, `food_drink_policy`, `notes`, `contact_name`, `contact_email`, `dismissal_time`) are still readable by ANY authenticated user - instructors, parents, contractors, designers - via the table-level `authenticated` GRANT. Door codes (Catlin Gabel `9016#`, Happy Valley `59031#`) and personal cells embedded in arrival text leak to any logged-in user, not just instructors actually assigned to that site.

\- \[ ] **Goal:** an instructor can only read the sensitive columns for locations where they have an active `camp_assignment` (or `program_assignment` once FA26 lands) tied to a `camp_session.location_id` matching that `program_locations.id`. Admins (`is_org_member` of the same org) and platform admins keep full access.

\- \[ ] **Approach options:**
  1. Split sensitive cols into `program_locations_private` table, FK to `program_locations.id`, RLS scoped to instructor-with-active-assignment + admin. Cleanest, requires query JOINs in InstructorPortal + LocationsList.
  2. Keep one table, drop the broad `public_read_program_locations` policy and replace with a row-scoped policy on the existing table. Use a VIEW for the public-anon columns. Less migration churn but RLS subqueries get expensive on hot reads.

\- \[ ] **Trigger to do this:** second tenant onboarding, OR a real incident where a non-instructor account was found able to read another site's door code. Until then, the anon lockdown is the meaningful protection.

\- \[ ] When you tackle it, also remove the unused `contact_name` / `contact_email` columns from `program_locations` (admin-only fields per the original spec; should move into `partner_location_contacts` per the [partner-location-detail.html v2 mockup](../mockups/partner-location-detail.html)).


\### Fill arrival/dismissal for 7 TBD camp partners (deferred 2026-05-26)

\- \[ ] These rows have address + phone but `arrival_instructions IS NULL` because the partner hasn't sent procedures yet. The instructor portal's Location card cleanly hides the arrival section, but instructors will be flying blind on drop-off/pickup at these sites:
  1. `Zellerbach Admin Center` (Camas Community Ed runs 2 summer camps here, 7/6-7/10 + 7/20-7/24) — confirm with Brenda Snell
  2. `Camas P&R: Lacamas Lodge` — Mon/Wed 7/6-7/30
  3. `Camas P&R: Camas Community Center` — 8/3-8/7
  4. `Catlin Gabel Summer Camp` — first year for camps; Chris Dorough (April 2026 email) says 9-3 with before/aftercare, full procedures TBD
  5. `Forest Grove Senior and Community Center` — new venue for SU26; Cody at Forest Grove P&R
  6. `Happy Valley Annex` — camp schedule shows winter/spring break camps; no SU26 procedures documented
  7. `St. Paul's Episcopal Church` — camp arrival not in master dash
\- \[ ] When the partner sends procedures: paste into the `program_locations.arrival_instructions` column directly via Supabase Studio or the admin LocationsList page. No code change needed.

\### Phone format inconsistency on `program_locations` (deferred 2026-05-26)

\- \[ ] Phone values across J2S `program_locations` rows are in 3 different formats:
  - `503-844-1240` (most common)
  - `(503) 681-5380` (Hillsboro Tyson Rec Center)
  - `503-208-7312`, `503-431-3500` etc.
- I changed the one weird value during backfill (`5038441300` → `503-844-1300` for Ladd Acres) but didn't standardize the rest. Worth a one-shot normalization migration to pick a canonical format (`xxx-xxx-xxxx`) so the instructor portal renders consistent phone strings.
\- \[ ] When you do this, also update the `tel:` link generation in `LocationSection` (currently strips non-digits, so it works regardless of format — but consistent display is cleaner).

\### Dead-data DB rows in `program_locations` (deferred 2026-05-26)

\- \[ ] 4 rows still have all sensitive fields NULL after the 2026-05-26 backfill — possibly historical/inactive:
  - `Community of Faith Church` (West Linn; you said leave for historical records)
  - `First Congregational UCC` (Hillsboro; same)
  - `Forest Hills` (LOSD)
  - `Forest Park` (Portland)
\- \[ ] Decide: archive (add `inactive=true` flag or move to `notes`) or delete. If kept, they pollute the admin LocationsList and any "all locations" picker. Forest Hills and Forest Park especially — the original spreadsheet had no row for them at all, so they may be from a prior term that ended.

\### Split renamed rows into `partner_name` + `location_name` (deferred 2026-05-26)

\- \[ ] Three rows were renamed to a "Partner: Site" string format because there's no `partner_name` column yet:
  - `Camas P&R: Lacamas Lodge` (was `Lacamas Lodge`)
  - `Camas P&R: Camas Community Center` (was `Camas Parks and Rec`)
- The v2 partner-location mockup ([mockups/partner-location-detail.html](../mockups/partner-location-detail.html)) introduces a proper `partner_locations` table with `partner_name` + `location_name` as separate fields. When that lands, migrate these colon-named rows back to clean schema. Original names are preserved in `name_aliases` so the tracker sync stays unbroken.

