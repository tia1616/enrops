\# Backlog



\## 2026-06-04

\- \[task] **BEFORE the real Tenant 2 onboards: full blank-slate dry-run in staging as Tenant 2.** Walk EVERY onboarding step end-to-end as the Tenant Two staging org (`owner@tenant2.staging.enrops.test`, zero J2S data): add a location → add a curriculum (upload doc → AI extract) → create a program → import partner contacts (deterministic spreadsheet path) → add a roster → email a roster (preview-only on staging; send is intentionally off) → and any other operator step. Confirm each works from scratch and nothing assumes J2S specifically. This is the acceptance gate before onboarding any real second tenant. Surfaced 2026-06-04 while making staging a true prod mirror (staging had only 9 of prod's 68 edge functions + 2 of 21 secrets — being fixed now).

\## 2026-06-03

\- \[task] Family Comms: end-to-end test of the "Link to include" field (registration_url_override). Field exists + prompt block exists (LINK TO INCLUDE IN THIS CAMPAIGN tells Ennie to adapt CTA copy by link purpose — "See the photos" / "Reschedule" / "Sign up"). **Untested in production** as of 2026-06-02 — no J2S draft has ever had the field set. Test plan: redraft FA26 (or a fresh campaign) with a non-registration URL in Q4 (e.g. `https://journeytosteam.com/photos/fall-week-1`) plus `operator_notes: "link goes to a photo gallery from this week's classes"`. Verify: (1) Ennie uses `{{register_url}}` token in the body, not the literal URL; (2) CTA copy adapts — should read "See the photos" not "Register here"; (3) preview iframe renders the URL clickable (just fixed); (4) sent email actually links to the operator's URL, not the default `enrops.com/<slug>`. If Ennie defaults to "Register here" regardless of context, the prompt block needs tightening.

\- \[task] marketing_campaigns RLS gap: the campaign-creating user gets 403 on SELECT against rows that marketing-draft-campaign wrote via service-role. Surfaced 2026-06-02 when the preview dropdown silently failed because ScheduleReview tried to re-read the campaign's draft_inputs.what.program_ids. Workaround landed: pass `inputs` through from AICampaignBuilder so the UI doesn't need to re-read the campaign. Real fix: add a SELECT RLS policy to marketing_campaigns granting access to org_members.role in ('owner','admin') for the campaign's organization_id. Same gap probably exists on marketing_campaign_touchpoints and marketing_sends; audit all marketing_* tables. Without this, "return to an existing draft to edit later" can't work — you'd 403 on the read.

\- \[task] Family Comms post-FA26 audit follow-ups (surfaced 2026-06-02): (1) `buildVipBlock` in marketing-touchpoint-send has hardcoded "🔑 Want the full year?" framing — fine for J2S, wrong for a tenant whose VIP isn't year-shaped. Let `org.vip_offering.description` be the entire paragraph and emit it verbatim; drop the wrapper text. (2) Email shell wrapper lacks Outlook MSO conditional comments — fine in Gmail/Apple/iOS but desktop Outlook may have layout quirks; do a real test send to an outlook.com address before any tenant expects pristine Outlook rendering. (3) Cron stale-claim recovery: if marketing-touchpoint-send times out partway, the touchpoint stays in `sending` status and cron's CAS won't re-claim it — add a "claims older than 10 min get released to queued" sweep. (4) Mechanical-check validator doesn't scan Ennie's body_html for broken HTML (mismatched tags, anchors without href, tokens in attribute values). Add a small HTML-validity check to draft pipeline.

\- \[task] Transactional vs promotional email separation. Today everything routes through `marketing_recipients` and a single unsubscribe link kills BOTH marketing pitches AND transactional updates (schedule change, instructor swap, registration confirmation). Schema work needed: split unsubscribe state into `unsubscribed_from_promotional` (the existing one) vs `unsubscribed_from_transactional` (rarely set; transactional should reach everyone who registered). Then add a `mailing_type: 'promotional' | 'transactional'` to the send pipeline; transactional sends query the broader audience and bypass the promotional-unsubscribe. Trigger: pending the first real "your program changed dates" send. Until then, every send is functionally promotional and the single-list model is fine.

\- \[task] DONE 2026-06-02: Auto-add Enrops registrants to `marketing_recipients`. Trigger `auto_add_registrant_to_marketing_list` fires on registration confirmation, honors `organizations.auto_subscribe_registrants` (default true). Backfilled J2S: 27 historical parents added (3 resolved school_name via program_location, 24 are historical registrations with no resolvable school link).

\- \[task] Replace every `alert()` and `confirm()` across the admin app with a real shared Toast/Banner component. Browser-native dialogs look like 1998 OS chrome ("localhost:5173 says" / "enrops.com says") and feel out-of-place against the rest of Enrops. Sweep: Family Comms (AICampaignBuilder onSendTest / onApprove / onSaveDraft), Payroll, Finances, AdminSettings, CurriculumNew — anywhere `alert(` or `confirm(` appears in src/. Component pattern: top-right stacking toast with soft-green for success, red for error, neutral for info; auto-dismiss after 6s; manual close on long messages; `confirm()` becomes an inline confirmation card with primary/secondary buttons (no modal flash). Build once, replace globally.

\- \[task] Platform-voice audit: every operator-facing surface should frame asks around the provider's actual business goals (make money → increase enrollment → grow LTV via parent/child/instructor satisfaction) and be backed by data (industry benchmark, tenant's past-campaign numbers, or honest "we'll measure this next time"). Memory rule lives at feedback_platform_voice_data_backed.md. Audit list lives in task #21. Spell out LTV on first mention; operators aren't developers. (See task #21.)

\- \[task] **Platform-integration coaching audit:** every operator-facing surface that uses another Enrops feature (curricula, Stripe Connect, surveys, registrations, instructor portal, scheduled-reminders, etc.) should EXPLICITLY state the dependency AND coach the operator on the upstream feature for the best result. Example pattern from Automations descriptions (DONE for Automations tab 2026-06-03): `mid_recap` says "Pulls from the curriculum you uploaded… Upload your curriculum to unlock the richest version of this email." Sweep: Director feed cards, Marketing campaign cards, Curriculum publish celebration, Schedule UI, Payroll, Finances, AdminSettings, Instructor portal onboarding. Per surface: (1) identify which Enrops features this uses, (2) state the dependency explicitly in the operator-facing copy, (3) coach operator on what to do upstream for the richest result. Companion to the platform-voice audit above — that's about business-outcome framing; this is about platform-feature interconnection. Jessica's framing 2026-06-03: "highlight the use of the platform, and how it should be used."

\- \[task] **Site-wide unit-test audit + sweep.** Pass over the whole repo identifying high-ROI test targets and writing tests against them. Pattern already exists in `supabase/functions/_shared/tests/` (Deno's built-in test runner — `computePlatformFee.test.ts`, `statementDescriptor.test.ts`, `connectChargeParams.test.ts`). Approach: prioritize PURE FUNCTIONS that have already burned us once or have non-obvious edge cases. Skip what doesn't pay off (mocked Supabase queries, React-component lifecycle tests, schema migrations). Concrete high-ROI starting points: (1) `bodyEditorUtils` round-trip (`htmlToEditable` ↔ `editableToHtml`) including the negative-lookahead regex that broke during FA26 ship — token inside `href` killed anchor tags; (2) Token rendering in `lifecycle-automations-cron` + `marketing-touchpoint-send` — `renderTokens` with plain vs `PRE_RENDERED_HTML_TOKENS`, escape behavior in body context vs attribute context; (3) `senderNameForBody` strip behavior across the various sender_name shapes ("Name @ Org", "Name", null); (4) Showcase / next-term-link block builders — empty vs populated; (5) Date helpers (`derive_program_session_dates` consumers, midpoint math, session-count math); (6) Pricing math (`computePlatformFee` extension if any sub-helpers are still untested); (7) Token-substitution coverage in `stripe-webhook` confirmation override path. Sequence: do an audit first (list the pure functions that haven't been tested yet, sort by past-failure-frequency + edge-case complexity), then write tests in batches. Jessica's framing 2026-06-03 after her consultant flagged it: focus on bits that have actually broken before, not paint-on-top "test everything" enterprise advice. Today's `{{next_term_link_block}}` token + `hasFutureProgramsForOrg` helper renders the footer link ONLY when the org has programs/camps starting >14 days out, and points at the generic `enrops.com/{slug}/register` page (which already filters to what's open). Polish: derive the SPECIFIC next-term and deep-link to it (`enrops.com/{slug}/register?term=FA26`) so a parent finishing SU26 camp gets pushed straight to the FA26 catalog rather than the multi-term register landing. Either add `term_register_urls jsonb` keyed by term code (operator-set) OR fully derive from `cycle_id` / first\_session\_date + a term-naming heuristic (system-derived; preferred). Jessica's framing 2026-06-03: "system should know the reg link. it's in the system. it's one system. if reg isn't on Enrops, they add a link. that shouldn't be difficult." Tenants who don't run registration on Enrops use the existing manual override path (paste their own link in the body editor).

\### Provider scheduling end-to-end — promoted from onboarding-checklist.md (2026-06-03)

\- \[task] DONE 2026-06-02: **Path A — create-program wizard** at `/admin/programs/new`. Three steps: curriculum+location → when/how many+live preview (calls new `preview_program_session_dates` RPC, applies district + location closures) → price + open registration OR save as draft. Empty-state checklist routes providers to add curricula/locations first. Soft warnings: missing district calendar, conflicting program at same loc/day/time. Live in working tree, not yet pushed; eat-the-cooking pass caught one bug (legacy `sessions` column defaulted to 8 while `session_count` was 5 — fixed by writing both). Test rows cleaned up. Spec lives in `docs/onboarding-checklist.md` Step 5.

\- \[task] **Instructor schedule wizard — end-to-end for FA26. Real feature, tenant 2 will need it.** Original ask from this chat 2026-06-02; Path A (create programs) is the upstream prereq and ships separately. Four sub-builds, all multi-tenant from day 1:
  1. **Availability collection.** Provider chooses survey (Ennie sends per-term form to instructors) OR upload (drop xlsx/csv/Google Sheet, LLM parses into `instructor_availability` rows with preview/confirm per instructor). Survey form needs a structured `unavailable_dates` field with a real date picker — current SU26 free-text is unparseable. Both paths land the same row shape.
  2. **Matching rules UI.** Three columns: hard rules (always on, can't reorder — physics not preference), warnings (toggle each on/off), priorities (drag to reorder). Camp-specific rules render only if provider runs camps. Per-instructor "minimum sessions per term" + optional tier defaults (Senior/Lead/Developing). Saved to `org.matching_rules` jsonb. Edits available per-term via a "review priorities" link.
  3. **3-question wizard entry.** Ennie detects state and only asks what's missing. Q1: term (auto-detected, confirm). Q2: availability state (no avail → send survey OR upload; partial → nudge stragglers OR proceed; complete → straight to draft). Q3: confirm priorities (skipped on returning cycles). Then draft schedule + approval card.
  4. **Auto-matcher reads the configured rules.** Refactor `match-instructors` edge function to read `org.matching_rules` instead of using hardcoded J2S behavior (current quota bonus, location preference scores, `VENUE_REGION_MAP`, etc. are baked-in J2S logic). Add "include drafts" option so provider can plan against not-yet-published programs.

  Critical-path target: late August 2026 (FA26 starts ~Sept 8). Wizard flow design lives in `docs/onboarding-checklist.md` "Schedule wizard — 3-question entry flow" section. Without this, tenant 2 has no path to a working instructor schedule.

\- \[task] **Provider/tenant onboarding wizard** (the whole 11-step thing — distinct from the contractor onboarding wizard already at `/:slug/instructor/onboarding`). Provider/tenant signup wizard does not exist yet. Spec in `docs/onboarding-checklist.md`. 11 steps: org identity, pricing/Stripe Connect, locations, curricula, program schedule (calls Path A), instructors, availability collection (calls schedule-wizard item above), matching rules (same), marketing defaults, operational automations, contacts/team. Target shape: single-sitting ~30–45 min with save+resume. Ennie runs highlighted-overlay tour. Every step surfaces "I can do this for you" as default. **Blocker for tenant 2 launch (July 31, 2026 target).**

\- \[task] **Per-tenant terms.** `TERM_OPTIONS` hardcoded to `FA26/WI27/SP27` in `ProgramsCalendar.jsx` + `ProgramWizardNew.jsx`. DB CHECK enforces format only (`^(FA|WI|SP|SU)[0-9]{2}$`) but the dropdowns are limited to J2S's three. Tenants with different cadences (camp-only summer, year-round, quarter system) need their own list. Suggested home: `organizations.terms` jsonb array of `{ value, label }`. Becomes a question in provider onboarding: "What terms do you run?" Blocker for tenant 2.

\- \[task] **Curriculum default price column + Step 3 auto-fill.** `curricula` has no price column today; create-program wizard asks for price every time. J2S's "robotics = $299, standard = $285" logic is a keyword-matching fallback in `src/lib/pricing.js`, not data. Add `curricula.default_price_cents` (and optionally `default_price_tier`). Populate during curriculum upload — Ennie can suggest based on the J2S formula for existing rows. Then wizard Step 3 auto-fills from selected curriculum; provider overrides if they want. Side benefit: also fix `pricing.js:230` `||` order which currently prefers legacy `sessions` over canonical `session_count`.

\- \[task] **Nav reorganization** (proposed 2026-06-02, not applied). Schedule belongs under Instructors group (it's instructor→program matching). Rosters belongs under Programs group (it's about class enrollments). Proposed shape: Programs group {Curricula, Scheduled programs, Class rosters, Locations, School calendars}, Instructors group (NEW) {Roster, Schedule}. Touches `NAV` constant in `AdminLayout.jsx`. Small change, separate commit.

\- \[task] **Path A polish pass — small items, bundle into one commit when ready.**
  - Wizard "+ Add new curriculum / location" → inline drawer instead of new-tab link, so wizard state is preserved without navigation
  - Curriculum + location dropdowns: swap `<select>` for autocomplete combobox when org has > 50 items (J2S currently fine at 13 curricula + ~50 locations)
  - `publishProgram` in `ProgramsCalendar.jsx`: add explicit `eq("organization_id", org.id)` defense-in-depth filter (RLS already blocks cross-tenant updates; this is for code clarity)
  - Step 2 silent gap when no closures + no district set: optional muted hint "No closures loaded — these are just every Tuesday at this time" for non-school venues
  - `program_type` hardcoded to `'standard'` in wizard saves: when multi-tenant pricing schema lands, the CHECK constraint `'standard'/'coding_robotics'` comes out and this hardcode does too

\## 2026-06-02

\- \[task] Q1 redesign: intent-first surfaces. Keep the "What do you want to promote?" wording. Replace Programs/Camps/Other tabs with auto-detected period cards (Fall 2026 After-School, Summer 2026 Camps, Winter Break Camps — pulled from the operator's actual data, not hardcoded terms). Each card has intent sub-actions (Early-bird push, Registration just opened, Low enrollment push, Last call before start). Click an intent → pre-selects the relevant programs/camps + sets Q2-Q4 defaults. Promo codes do NOT belong under period cards (they're a tactic, not a period — that's the promo step). Keep "Pick manually from catalog" as escape hatch — current picker lives underneath. Defer until after FA26 ships. (See task #19 in session task list.)



\## 2026-06-01

\- \[task] Set up a customer-support inbox for Enrops (e.g. hello@enrops.com or support@enrops.com). Mailbox must actually receive mail (forward to Jessica or shared inbox), Resend-verify the domain so platform sends from it, and swap into: (1) Google OAuth consent screen → User support email, (2) `_shared/orgBrand.ts` ENROPS_PLATFORM_BRAND defaults, (3) any other places currently using `jessica@journeytosteam.com` as a stand-in for an Enrops platform address.



\## 2026-05-20

\- \[task] Enable google drive doc and pdf import for curricula

\- \[task] delete the 'schedule it' confirmation ask and button in the curricula celebration. change to 'market' or 'check enrollment'

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
* \### ORS supplies clause — future-tenant configurability
* \- \[ ] Screen3ORS currently hardcodes "You use your own transportation and carry your own car insurance." (the supplies-bullet was dropped because J2S provides materials). If a future tenant ships where contractors DO bring their own supplies, this bullet should be made configurable per org or surfaced in their engagement letter. Worth a CPA review once Enrops has 2+ tenants — provider-supplied materials is one of the IRS factors that pushes toward "employee" classification.
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
* optimize admin for mobile
* for admin doing onboarding/hiring- add advice 'check with your state's employment laws or a lawyer when deciding to hire contractors or w2 employees'

\## 2026-05-26

\### Team tab missing from /admin (discovered 2026-05-26)
\- \[ ] Jessica reported `/admin/team` isn't surfacing a Team tab in the admin nav. Admin-invite edge function v1 deployed 2026-05-23 (per [Arielle enrops platform access session]) and is working, but the UI entry point is gone or never wired. Per `docs/handoffs/` notes, "Admin nav restructure (Instructors top-level, Team dropped from nav)" landed 2026-05-25 — likely got dropped during that pass. Restore a "Team" entry (under Settings or top-level) that loads the existing `/admin/team` route, so admins can invite teammates without a CLI/edge-function call.

\### RLS disabled on `public.capability_definitions` (Supabase advisor, 2026-05-26)
\- \[ ] Supabase flagged `public.capability_definitions` as having Row Level Security disabled while anon + authenticated roles can still reach it. It's a lookup/reference table (14 rows of capability metadata), so the data isn't sensitive, but on principle every `public.*` table should be RLS-on. Enable RLS and add a permissive `SELECT` policy for `authenticated` (and `anon` if any pre-login flow needs it). Remediation SQL from advisor: `ALTER TABLE public.capability_definitions ENABLE ROW LEVEL SECURITY;` — but DO NOT run as-is; add a SELECT policy in the same migration or every read will start failing. Low priority; bundle into next housekeeping pass.

\### Parent dashboard renders camp registrations as bare names (discovered 2026-06-03)

\- \[ ] `src/pages/j2s/Dashboard.jsx` only joins `registrations.programs` (afterschool), not `registrations.camp_sessions`. When a parent has camp registrations (summer), the card renders student name + nothing else — no curriculum, no school, no day/time, no first session date. Discovered while seeding Demo Parent for designer review.

\- \[ ] **Fix:** extend the registrations query to also embed `camp_sessions(curriculum_name, location_name, starts_on, start_time, end_time, ...)`, then render whichever side is non-null in each card. Camp sessions don't have `day_of_week` (they run multi-day blocks), so the day/time line needs a different shape for camps — show the date range instead.

\- \[ ] **Why it matters:** through summer (SU26 → SU27 → ...), the parent dashboard is the only place parents see their kids' camp enrollments. Right now it's effectively broken for camps even though the data is correctly stored. Fix before SU26 first session date (June 15) at the latest, ideally well before — parents will start using the portal as soon as registrations roll in.

\- \[ ] **Side effect**: the empty-state "Browse fall programs →" CTA links to `/j2s` which is fine for after-school; in summer it should probably say "Browse summer camps →" or route to a camp-specific listing. Decide once the camp branch of the dashboard is rendering.

\### Cleanup: `dev-seed-designer-access` edge function (deployed 2026-05-26)
\- \[ ] One-shot dev function deployed to seed designer test accounts (Sasha + Oleksandra admin invites, 3 fake personas: instructor/parent/contractor). Gated by `x-seed-secret` header, idempotent — re-run any time to refresh magic links. After designers wrap their visual-direction pass, delete the function from Supabase dashboard and remove `supabase/functions/dev-seed-designer-access/` from the repo. Also delete the 3 fake personas from the DB: `designer-instructor@enrops.com`, `designer-parent@enrops.com`, `designer-contractor@enrops.com` (auth.users + instructors/parents/contractor_onboarding_status rows).

\### "Your assignment changed" instructor email — queued tail
\- \[ ] Write to `instructor_offer_messages` with new `kind` for EmailActivityModal timeline. Audit currently only lives in Resend logs (`type=instructor_removed` tag).
\- \[ ] Pay reconciliation flag — if installments / Stripe transfers exist against the removed assignment, surface for admin review in the modal.
\- \[ ] handleDrop (drag-and-drop move) source DELETE doesn't open the modal yet; only Remove from the picker + Reassign via Pick do.

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

- add legal docs to enrops site- local folder in downloads zip

\## 2026-05-27

\### Still pending before / during real instructor invites
\- \[ ] Add enrops legal docs to marketing site (after invites go out — local folder is in downloads zip)
\- \[ ] Reset full end-to-end test by Jessica (her DB row is reset — walk wizard with magic link)
\- \[ ] Reassignment v2 (queued): write to instructor_offer_messages with new `kind`, pay reconciliation flag, handleDrop source-delete also gate on modal
\- \[ ] Dora "newly cleared" homescreen surface (admin email is the placeholder for now)

Programs UI
-be able to filter and view all and by term (summer/fall/etc) -- see all have on file like arrival dismissal an room #, choose to send emails to all or some to confirm logistics still true

\## 2026-05-28

\### Single-day substitute instructor flow (raised by Jessica during instructor-portal status check)

\- \[ ] Current model: `camp_assignments` ties one instructor to a whole camp_session (the week). No way to assign a sub for just Tuesday. Pay calc reads from the assignment row, so a sub today would either need a fake whole-week assignment (wrong) or no record (no pay).

\- \[ ] **Proposed design (bundle with FA26 afterschool work, ~+0.5d on top):**
  - New table `assignment_substitutions`: `(parent_assignment_id, parent_assignment_type 'camp' | 'program', sub_instructor_id, date, status, sub_tier 'lead' | 'developing', assigned_at, assigned_by, notes)`. Unique on `(parent_assignment_id, parent_assignment_type, date)` — one sub per assignment per day.
  - `parent_assignment_type` allows the same table to handle camps now and afterschool once `program_assignments` lands — no migration when afterschool subs arrive.
  - `confirm-session-delivery` updated to check for a sub row on the given date BEFORE crediting pay to the regular instructor. If present, pay flows to sub at their tier rate; original instructor earns zero for that day with no "missed" stigma.
  - RLS: sub instructor can read camp_session roster + lessons ONLY for dates they have a substitution row for. Existing `registrations` + `students` + `parents` policies need a second pass that unions in sub access.
  - Admin UI: on a camp/program detail page, "Add sub for [date]" button → pick instructor + tier → sends sub an email (warm Ennie copy: "You're subbing for [camp] on [date] — here's the roster and lesson plan").
  - Sub portal UX: their "My schedule" shows sub days tagged distinctly ("Sub · [Camp Name] · Tue 7/15"). Mark-taught from their portal works the same as a regular assignment.
  - Original instructor sees the day as "covered by [sub]" on their schedule — locked from check-in, no pay deduction stigma.

\- \[ ] **Edge cases to handle:**
  - Sub for an entire week is NOT this flow — that's the existing reassignment (change `camp_assignments.instructor_id`). Sub flow is per-day only.
  - Sub for a date in the past (after-the-fact, e.g., emergency cover that wasn't logged): allow with admin-only confirmation, audit trail.
  - Sub declining the offer: status='declined' frees the slot; admin sees they need to find another sub.
  - Sub flow + assignment cancellation flow need to be aware of each other: if a camp is cancelled, all pending subs auto-decline + get the same "isn't running" copy.

\- \[ ] **Trigger to build:** before camps start (~early July). Realistically the first sub need probably hits in July, so this should land in June.

\- \[ ] **Notification side:** sub assignment is essentially a one-day offer. Reuse the `NotifyRemovalModal` pattern (preview email before send) for sub offers. Original instructor should also get a "your 7/15 is covered" email — quick, no fuss.

### Stripe-integrated instructor pay v2 (deferred 2026-05-29)

\- \[ ] **v1 ships calculator only.** New tenants default to `instructor_pay_enabled=false` so `pay-instructor`'s Stripe path is blocked at the circuit breaker. The Payroll page explainer card lays out three routes; only `Option 1` (manual / calculator) is active. `Options 2` and `3` show `Tell us you want this` CTAs that mailto hello@enrops.com for interest capture.

\- \[ ] **Option 2 - Enrops routes the pay (`enrops_platform` mode).** Code path is drafted in `pay-instructor` (transfers from operator's connected account via `stripeAccount` header), in `create-stripe-connect-account` (instructor Express accounts created under Enrops's main Stripe), and in `stripe-webhook` v19 (instructor `account.updated` + `transfer.reversed` routing). Gated behind a `pay_route_not_yet_supported` safety net (returns 501). To unlock:
  1. Remove the safety-net refusal in `pay-instructor`.
  2. Validate end-to-end with a sandbox tenant (small live-mode test).
  3. Add `transfer.reversed` + `account.updated` subscriptions on the Enrops Connected Accounts webhook destination.
  4. Set `STRIPE_WEBHOOK_SECRET_CONNECT` env var to the Connected Accounts destination's signing secret.
  5. Per-tenant: platform admin flips `instructor_pay_enabled=true` + sets `instructor_pay_model='enrops_platform'` after they Connect for Receivables.

\- \[ ] **Option 3 - tenant's own Stripe Connect platform (`legacy_own_platform` mode).** This is what J2S runs today (set up by Jessica, pre-Enrops). For new tenants on this route: tenant must enable Stripe Connect on their account, accept Stripe Connect platform terms, and onboard instructors as Express accounts under their platform. Then we configure their `STRIPE_INSTRUCTOR_PLATFORM_KEY` equivalent (one secret key per tenant — needs proper per-tenant key storage; current code uses a single env var). Heavy lift. Build trigger: a tenant who already has Connect set up and explicitly asks.

\- \[ ] **Trigger to build either option:** first non-J2S tenant signals interest via the mailto CTA. Until then, calculator works and nobody's blocked.


### Partner-invoicing (Receivables `Invoices` tab) - target July 2026 beta

\- \[ ] **Use case:** Tenant runs camps/programs at partner locations where the partner handles their own parent registration (Squarespace, their own site, etc.). The partner collects parent payments, then owes the tenant a per-head or per-camp fee. Today J2S does this in QuickBooks — Arielle creates an invoice at the end of each school term (after-school) or end of each camp week (summer), sends to the partner, partner pays.

\- \[ ] **What we want:** Receivables -> Invoices tab becomes real. Tenant picks a partner + a date range (term, week, custom), Enrops computes the amount from enrollment data, renders an invoice with line items, sends it to the partner's billing email, accepts payment via ACH (preferred — fee-free at scale) and card, tracks paid/overdue/outstanding statuses, and shows a list view of all invoices with filters.

\- \[ ] **Cadence:** End of every school term for after-school programs. End of every camp week (or end of summer) for partners running J2S camps at their location. Operator-triggered, not automated send — Arielle reviews before sending.

\- \[ ] **Target date:** In place before first beta tester goes live in July 2026 (Jessica directive 2026-05-29).

\- \[ ] **Multi-tenant from day 1** — partners table is per-org, invoice templates are per-org, branding pulls from orgBrand (the cascade used by parent emails). Never hardcode J2S partner names or invoice numbering.

\- \[ ] **Build scope sketch (subject to change after design):**
  1. New `partners` table: id, organization_id (FK), name, billing_email, billing_address_json, default_payment_terms_days, default_fee_per_head_cents OR default_flat_fee_cents (one of), notes, created_at.
  2. New `invoices` table: id, organization_id, partner_id, status (draft/sent/paid/overdue/void), period_start, period_end, line_items_json (camp_session_id + count + amount per line), subtotal_cents, total_cents, stripe_invoice_id, due_date, sent_at, paid_at, created_at.
  3. Edge function `create-partner-invoice`: takes partner_id + date range, pulls eligible enrollments, computes line items, drafts the Stripe Invoice via stripe.invoices.create (Connect platform's invoicing API), records our row.
  4. Edge function `send-partner-invoice`: marks Stripe Invoice as sent (stripe.invoices.sendInvoice), flips our row to `sent`, partner gets the Stripe-hosted invoice + payment link via email.
  5. Stripe webhook handles `invoice.paid` (flip our row to `paid`, send a thank-you, optionally trigger a notification to Arielle).
  6. UI: InvoicesTab becomes a real list (status filter chips + create button), drawer for create/send.
  7. **Question: is partner-invoice payment routed through Enrops platform or direct to operator?** If Stripe Connect destination charges are an option for invoices, route 98% to operator and Enrops keeps 2% (same as parent registrations). If not, the invoice payment lands in operator's connected account directly.

\- \[ ] **Open questions to resolve before building:**
  - Per-head fee or flat-per-camp? Or both as configurable per partner? J2S's actual structure for SU26 partners.
  - Which partners does J2S currently invoice? (Need names + billing emails to seed.)
  - Where does enrollment data come from for SU26 (Squarespace export? camp_sessions table after Apps Script sync?) vs FA26+ (Enrops native registrations)?
  - Should QuickBooks stay the system of record, or does Enrops become primary and we push to QuickBooks? Either is fine; need decision.
  - ACH vs card vs both? ACH is free above ~\$8\/txn; card is 2.9%. For invoice amounts in the hundreds-to-thousands, ACH-only is probably right.
  - Notification flow when partner is overdue — auto-remind at +7 days, +14 days, +30?
