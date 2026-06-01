\# Backlog



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
