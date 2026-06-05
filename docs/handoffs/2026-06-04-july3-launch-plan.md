# July 3 Launch Plan — verified build state + execution map

**Written:** 2026-06-03 ~8pm (start cold tomorrow 6/4 morning)
**Target:** White-glove ALPHA on **July 3, 2026** — 5 founding users Jessica hand-onboards. NOT self-serve. (Self-serve onboarding beta is August, per Arielle's Gantt.)
**Owner:** Jessica (J2S / Enrops)

This doc is the single source of truth to start 6/4 cold. It captures (a) what's actually built (verified against code + DB, not specs), (b) what's genuinely missing for July 3, (c) what's deferred to August, (d) the day-by-day plan around Jessica's calendar, and (e) the staging-isolation method.

## ✅ Progress — end of 6/4 (updated this session)
- **Staging: DONE (exceeded plan).** Isolated twin LIVE at **enrops-staging.netlify.app** — separate Supabase project `mumfymlapolsfdnpewci` + separate Netlify site on the `staging` branch. Real J2S catalog/config **mirrored** from prod (PII/secrets scrubbed) + **100% synthetic people**. Stripe **TEST** registration checkout working end-to-end; no real emails. Logins `@staging.enrops.test` / `EnropsStaging1`. Rebuild recipe: `supabase/schema/README.md`. Consultant guide: `docs/handoffs/2026-06-04-staging-consultant-note.md`. Memory: `project_enrops_staging_env`.
- **Sensitive-data access controls VERIFIED on staging** (anon sees 0 rows of students/regs/BGC; cross-family + cross-instructor BGC access blocked; 0 real BGC files, 0 real minors) — covers the **in-app + direct-API** half of the BGC sketch below.
- **Program Wizard SHIPPED to prod:** `/admin/programs/new` is live on enrops.com (and staging). Was the disabled route that had been breaking deploys.
- **Cleanup shipped to prod:** avatars hardcoded-URL fix; rebuild scripts committed. `main` + `staging` in sync.
- **Still pending before 6/11** (detail in Day-by-day): afterschool end-to-end test on staging + commit the dangling untracked pile; BGC sketch (role map + confirm BGC files in a PRIVATE bucket + chunked-minors-data) **due 6/9**; live $1 payroll test (prod); billing explainer; parent-portal register-for-new-term + notifications; blank-slate onboarding test; weekly security-audit routine + edge fn.

---

## Calendar constraints (the real shape of the runway)

- **6/4 (Thu, morning):** Jessica wakes up, staging work begins. Tonight (6/3) = no build.
- **6/11–6/22:** Jessica on vacation. A **consultant** gets access to the **staging site** and tries to **break it** by roaming the UI. He does NOT build and does NOT run unit tests. So staging must be (a) isolated from prod data, (b) reachable, (c) seeded enough to click through.
- **6/22–6/29:** BN Digital applies portal Figma designs (they own portal design).
- **July 3:** First 5 founding alpha users, hand-onboarded by Jessica.

Implication: the only real *building* windows are **6/4–6/10** (before vacation) and **6/23–7/2** (after). The vacation window is consultant break-testing, not our build time.

---

## Verified build state (checked against code + live DB on 2026-06-03)

| Area | State | Evidence |
|---|---|---|
| **Payroll calculator** | BUILT | `src/pages/admin/Payroll.jsx` (1266 lines). Loads `v_effective_pay_lines`, groups by instructor + camp_session/program, Approve/Withhold/Re-approve/Pay-via-Stripe/Mark-paid. PayDrawer → `pay-instructor` edge fn. Handles camps + afterschool. |
| **Finances / Stripe Connect billing** | BUILT | `src/pages/admin/Finances.jsx` (1080 lines). 5 states off `organizations.stripe_account_status`. Fee config, fee pass-through, onboarding via `stripe-connect-onboard` + `create-stripe-operator-login-link`. "Enrops/Stripe billing thing" = done. |
| **Native registration (Stripe)** | LIVE | **303 confirmed registrations** in DB right now (was 302 last night). Real Stripe incl. installments, live since 2026-06-03. |
| **Parent portal (fall afterschool view)** | BUILT, correct scope | `src/pages/j2s/Dashboard.jsx` joins registrations→students→programs, filters `status in ('confirmed')`. Shows fall afterschool only. Confirmed correct — parents are NOT in portal for summer, only fall. |
| **Contacts (CSV)** | BUILT | Existing contacts surface. |
| **Marketing (Don)** | BUILT + live | Lifecycle automations cron jobid 19 fires 15:00 UTC daily; all camp automations toggled ON 6/3. See `docs/handoffs/2026-06-03-family-comms-automations-shipped.md`. |
| **Instructor onboarding + portal (camps)** | BUILT, end-to-end | invite → wizard → schedule → roster → daily check-in → pay → Stripe Express. Done 2026-05-26. |
| **Camp scheduling** | BUILT | camp_assignments + scheduling_cycles + Calendar UI. |
| **FA26 afterschool scheduling** | BUILT + WIRED, **NEVER RUN** | `src/pages/admin/AfterschoolSchedule.jsx` (889 lines) calendar; `match-afterschool` + `send-afterschool-survey` edge fns; `AfterschoolAvailabilityForm.jsx` instructor side. But **0 program_assignment rows, 0 FA26 availability rows, 0 FA26 survey_state rows** against **26 open FA26 programs + 20 active instructors**. Code exists; the flow has never executed against real data. |

**Admin home (`AdminOverview.jsx`):** still a placeholder card grid ("Welcome back, {name}" + cards). The "Ennie's wins/tasks/reminders" home is NOT built. Minor bug: Settings card says "Coming soon" though `AdminSettings.jsx` exists.

---

## Genuinely missing for July 3 (the real list)

1. **Isolated staging** for the consultant — must not touch the 303 live registrations or send real emails/charges.
2. **Test FA26 afterschool end-to-end** (open survey → instructors submit availability → match → send offers → accept), fix whatever breaks, and **commit the untracked afterschool files** (currently dangling in the working tree).
3. **Parent portal additions:** register-for-new-term + a notifications/automations view.
4. **Admin home → Ennie wins/tasks/reminders** (after BN Digital Figma lands 6/22–6/29).

## Deferred to August self-serve beta (do NOT build for July 3)

- Provider onboarding wizard (July 3 is hand-onboarded by Jessica).
- Branding/logo upload UI.
- Day-1 setup checklist.
- FA26 auto-assign polish (manual match is fine for alpha).
- Full Director feed.

---

## Untracked / uncommitted working-tree files (scope commits carefully)

Per git status at handoff. **Do not bundle unrelated changes into one commit.**

- **Untracked (afterschool feature — commit together after test passes):** `AfterschoolSchedule.jsx`, `ProgramWizardNew.jsx`, `ProgramPrereqEmptyState.jsx`, `AfterschoolAvailabilityForm.jsx`, `supabase/functions/marketing-resend-webhook/`, `supabase/functions/match-afterschool/`, `supabase/functions/send-afterschool-survey/`, migrations `20260602_preview_program_session_dates.sql` + `20260603_afterschool_term_availability.sql`.
- **Untracked (junk — don't commit):** `docs/prod vs data.txt`.
- **Modified:** `deno.lock`, `docs/backlog.md.md`, `InstructorPortal.jsx`, `apps-script-roster-sync/index.ts`.
- **Staged, comment-only (ship separately):** `lifecycle-automations-cron/index.ts` — header-comment fix; commit + deploy on its own per the 6/3 handoff.

---

## Staging isolation method (the 6/4 first task)

**Principle:** the app is fully env-var driven, so staging = point the same codebase at a different backend. No code fork.

- **Client (Netlify deploy context):** swap the two Vite vars
  - `VITE_SUPABASE_URL` → isolated Supabase environment
  - `VITE_SUPABASE_ANON_KEY` → that environment's anon key
  - (`VITE_GOOGLE_OAUTH_CLIENT_ID` stays unless OAuth callback domain differs.)
  - `src/lib/supabase.js` reads exactly these + derives `API_BASE = ${url}/functions/v1`. Nothing else hardcodes the project.
- **Backend isolation — pick one (decide 6/4):**
  - **(A) Supabase branch** of project `iuasfpztkmrtagivlhtj` — fast, schema-synced, but confirm it does NOT share the prod `auth`/data and that branch lifecycle fits a 2-week consultant window.
  - **(B) Separate Supabase project** — cleanest isolation; cost = re-running migrations + seeding. Safer for "a stranger is trying to break it."
- **Stripe:** edge-function secrets must use **Stripe TEST keys** in staging — never live keys. (Consultant clicking "Pay" must not move real money.)
- **Resend:** sandbox/test mode (or a throwaway audience) so break-testing can't email 303 real families.
- **Netlify:** serve staging from a separate deploy context / site with its own env values, distinct from the `main`→enrops.com prod deploy.

**Hard guardrail:** the 303 live confirmed registrations + live marketing cron (jobid 19) are on prod. Staging must be incapable of writing to them or triggering real sends.

> No secret VALUES are recorded in this doc on purpose. Pull them from Netlify/Supabase/Stripe dashboards at execution time.

---

## Live $1 payroll test (PROD track — separate from staging)

**Why it's its own track:** a real $1 test must run on **LIVE Stripe** to mean anything. Staging uses Stripe TEST mode (fake money), which proves the code path but not that live keys + a real Express account actually move a real dollar. So this is a prod action, not a staging break-test.

- **Recipient (decided 6/3):** Jessica's **own** Stripe Express connected account. She sets herself up as a test instructor so the $1 lands somewhere she fully controls and can verify + ignore afterward.
- **Path under test:** `Payroll.jsx` PayDrawer → `pay-instructor` edge fn (`via_stripe: true`) → transfer to the instructor's Express account. Confirm the dollar arrives, `session_delivery_confirmations.pay_status` moves to `paid`, and a Stripe transfer id is recorded.
- **Prereq:** Jessica's test-instructor record + a completed Stripe Express onboarding (the same Connect flow camp instructors use).
- **When:** 6/4–6/10 window, on prod, with a tiny real amount. Keep it to $1.

## "Understand & explain billing" deliverable (Jessica-facing)

Write a plain-English explainer (no jargon) of the **full money chain** so Jessica can re-read it and explain it to Arielle:

> parent pays (native Stripe registration) → Stripe → operator's connected account, **minus the Enrops platform fee** → operator runs payroll → instructor paid to their Stripe Express account.

Cover: where Enrops earns (platform fee config in `Finances.jsx` — `platform_fee_card_pct`/`ach_pct`/`cap_cents`, `fee_pass_through` toggle), what the operator sees ("Receivables"), and what the instructor sees (Express payout). Frame around the business goal (how Enrops makes money only when the operator does). Draft 6/4.

## New items added 2026-06-03 evening check-in

1. **Security sketch — sensitive-data access control (BGC / minors' data). DUE BEFORE TUESDAY 6/9.** Scope now defined (from consultant notes, 6/4):
   - **Verify BGC access is admin-only.** We *believe* opening/downloading a background check is admin-only — **verify it in code, don't assume.**
   - **Map roles → access first (paper/whiteboard), then to code:** who should see what. Sketch the role/access matrix before reading code.
   - **Find where the files actually live.** Confirm the BGC document storage (likely a Supabase Storage bucket; instructor Checkr/BGC state is in `contractor_onboarding_status`). Determine whether it's genuinely **locked down** (auth + RLS/storage policies + signed URLs) or merely **unlisted** — unlisted ≠ secure.
   - **Protect BOTH attack surfaces, not just the UI:**
     1. **In-app access** — the admin view / UI path.
     2. **Direct API calls** — Supabase REST / Storage endpoints / edge functions that bypass the UI entirely. An admin view is one way in; an API endpoint is another.
   - **Edge case to design for:** any request for "all minors' data" must return in **chunks / paginated**, never one full dump. Principle: if someone who shouldn't have access gets through, leaking *a little* is far better than *everything*. No unbounded list endpoints over minors' PII.
   - **Reminder surfaced 6/4; resurface before 6/9.** Sketch is Jessica's deliverable; I help with the role map + the code/storage verification.
   - **Supabase security-advisor baseline (run 6/4) — leads for the sketch:**
     - 🔴 **Public storage buckets allow listing:** `org-assets` and `public-assets` are public buckets with broad SELECT on `storage.objects` → clients can **list all files**, not just fetch by URL. **This is exactly the "locked down vs merely unlisted" concern. FIRST: confirm where BGC documents live** — if they're in (or reachable from) a public bucket, that's a real exposure. Likely they're in a private bucket, but VERIFY.
     - 🔴 **`cron_unschedule_by_name` is `anon`-executable** — an unauthenticated caller could unschedule cron jobs. Lock it (revoke anon/authenticated). Several other internal/trigger SECURITY DEFINER funcs (`rls_auto_enable`, `recompute_camp_session_enrollment`, `sync_instructor_onboarding_status`, `guard_organizations_locked_columns`) are also anon-executable and should be reviewed — the legit RLS helpers (`is_org_member`, `current_parent_id`, `user_org_ids`, etc.) are expected.
     - 🟠 `SECURITY DEFINER` views `v_effective_pay_lines` + `program_enrollment` (ERROR level) — enforce creator's perms, not caller's; review for the money path.
     - 🟠 Pre-existing WARNs: 4 functions with mutable `search_path`; `pg_net`/`citext` extensions in `public`; OTP expiry > 1h. Lower priority, batch into hardening.
     - ✅ **Fixed today during this run:** the new `log_enrollment_event` doorway was anon/authenticated-executable via Supabase's default-privileges quirk — revoked, now service_role-only (migration `20260604_intelligence_lock_doorway.sql`).
   - **Reusable lesson (applies to the weekly audit + all future functions):** every new `SECURITY DEFINER` function in `public` is auto-granted EXECUTE to `anon` + `authenticated` by Supabase default privileges — you must `revoke ... from anon, authenticated` explicitly, not just `public`.

2. **Predictive-enrollment data layer (NEW major workstream, docs incoming).** Goal: instrument the platform to capture as much user/provider behavioral data as possible so Enrops can later do **predictive enrollment** and **data-backed recommendations** to operators — e.g. *"70% of providers see a 50% increase in summer-camp enrollment when they set an early-bird deadline."* Jessica has docs to hand over and will "train me" on this layer.
   - **My recommendation (better/faster/safer):** the *recommendation engine* itself is post–July-3 (it's an August+ platform capability, not alpha-critical). BUT the **data-capture instrumentation should start as early as possible** — every week we don't capture events is data we can never backfill. So: when the docs land, separate "what to capture now" (build into the schema during the July-3 window so data accrues) from "what to compute later" (the recommendations engine, deferred). This also aligns with the existing PostHog analytics scope (queued) and the platform-voice rule that everything Ennie says must be data-backed.
   - **Status (updated 6/4):** moat docs read; `intelligence` schema + `enrollment_events` table + `public.log_enrollment_event()` doorway BUILT & applied to prod (migration `20260604_intelligence_schema.sql`). Clear seam: operational data in `public`, append-only telemetry in `intelligence`, single controlled doorway, no UPDATE/DELETE granted, schema unexposed to the API. Decisions #2 (parents already platform-level — verify RLS) and #3 (school_partners — defer; existing `partners` is a different operator-scoped marketing CRM) per the 6/4 analysis.
   - **TODO — event audit sweep (Jessica owns the list; pre-wiring).** Before wiring write-calls into the live funnel, do an audit sweep of *what events to log*. v1 starting scope = parent enrollment funnel (`initiated`, `payment_completed`, `waitlist_added`, `waitlist_converted`, `cancelled`, `refunded`). Jessica to add more (e.g. instructor/payroll actions, marketing touch responses, schedule changes). **Open decisions to settle during the sweep (from the 6/4 guardrail run):**
     - **action_type vocabulary** — must be centralized as code constants so a typo (`payment_complete` vs `payment_completed`) can't silently fragment the data. No enum in DB (kept open on purpose), so discipline lives in code.
     - **Fail-safe wiring (non-negotiable)** — every `log_enrollment_event` call wraps in try/catch and swallows errors. A failed event log must NEVER break a registration/payment. This is the #1 wiring rule.
     - **Idempotency** — Stripe retries webhooks, so `payment_completed`/`refunded` can fire 2+ times. Decide dedupe strategy (store Stripe event id in metadata, or unique key on registration_id+action_type).
     - **PII / children's data** — events carry `parent_id`/`student_id`. Keep `metadata` to IDs and facts, NEVER raw names/emails (COPPA-adjacent). Set a retention stance.
     - **Cross-tenant rule** — operational is strict per-tenant RLS; intelligence is *deliberately* cross-tenant (benchmarks = the moat). But no operator may ever see another's raw events — future read access must aggregate/anonymize. Write this rule down before any reporting is built.
     - **Backfill option** — existing 303 confirmed registrations could be seeded as historical `payment_completed` events (from their timestamps) so the starting dataset isn't empty. Decide yes/no.
     - **site_id naming** — column is `site_id` (from the moat doc) but operational naming is `program_location_id`; reconcile when wiring.
   - **TODO — dedicated intelligence-layer workstream + dual-residence audit (NEW, 6/4).**
     - **Spin up a dedicated Claude Code conversation for the intelligence layer.** It's a cross-cutting concern (every new feature may generate an event worth capturing), so it gets its own ongoing chat rather than living inside one feature's thread.
     - **Audit which data may need to live in BOTH places** (operational `public` *and* intelligence). Key pattern to look for: values the operational layer **mutates** but the intelligence layer needs **frozen at the moment an event happened** — e.g. the price/fee config at time of registration, the enrollment count when a waitlist conversion fired, the deadline config when a parent registered. Operational holds "current"; intelligence needs the point-in-time snapshot. That's the dual-residence list.
     - **Capture it in a markdown doc** (e.g. `docs/moat/DUAL_RESIDENCE_DATA.md`) — what's snapshotted, why, and into which event's `metadata`.
     - **Keep that doc in context during feature builds** so the intelligence layer stays top-of-mind. *Mechanism note (the part that makes this actually work):* "keep in context" across conversations isn't automatic — it needs a pointer in repo `CLAUDE.md` and/or a MEMORY entry that says "when building a feature, check the dual-residence doc + ask: does this generate an event?" Otherwise the doc is just hoped-for. Wire that pointer when the doc exists.

### Consultant data-layer notes (6/4) — mapped to current state

Six notes from the consultant. Four validate what we built today; two are new actions (one urgent).

1. **Stable entity IDs** — every key thing (programs, instructors, parents, kids) needs a durable, explicit ID. **[MOSTLY DONE]** operational tables already use uuid PKs. **Action:** audit that nothing load-bearing matches on *names/strings* instead of IDs — this directly reinforces the queued fix for the **tracker-sync brittleness** (it matches on `curriculum_name`/`location_name` strings; a rename silently breaks it). Replace string-matching with ID-based.
2. **Append-only activity logs** — append, never overwrite/delete; the consultant says "you decide the shape (per business / per program / per region)." **[DONE]** `enrollment_events` is append-only, enforced at the grant level (no UPDATE/DELETE). Our shape = one global table scoped by `organization_id` (= "per business" via column), filterable by program/site/region. Good.
3. **Operational ↔ intelligence seam** — keep them separate even in one DB; avoid querying live operational data a year from now just to answer a business question. **[DONE]** this is precisely the `public` ↔ `intelligence` seam + doorway built today.
4. **Capture events from day one — including the happy paths** — successful payments, payroll runs (with size + who), Ennie feedback, import successes *and* failures. Successes are often the more valuable story. **[PARTIALLY DONE → expand in the audit sweep]** `payment_completed` is wired. **New event types to add:** `payroll_run` (amount + instructor count + who ran it), `ennie_feedback`, `import_succeeded` / `import_failed`. Note this widens scope beyond the parent funnel into operator + platform actions — fold into the event audit sweep.
5. **Backups & redundancy** — ~20 min on Supabase's built-in backup options, pick one, run it *before live data flows*; no single point of failure; too-infrequent/too-short-window is its own trap. **[NEW — URGENT]** ⚠️ **Correction: live data is ALREADY flowing** — native registration has been live since 6/3 with 303 confirmed registrations and real money via Stripe. So "before live data flows" has passed; this is now *overdue*, not future. **Action: verify + configure Supabase backups (daily backups + PITR window) in the 6/4 setup half-day.** Highest-urgency item in this batch. ✅ **DONE 6/4:** PITR enabled (7-day window) after bumping compute to Small; Spend Cap disabled to allow the add-ons (~$105–115/mo total). **Follow-up — billing alert (added 6/4):** Supabase has NO native budget/threshold alert (roadmap only), and with the Spend Cap now OFF, the quota-warning emails won't fire either. So: **fold a Supabase spend check into the weekly security-audit routine** — it already emails Jessica, so add a line that reads current month spend and flags if it crosses a threshold (e.g. >$150/mo). That's the real automated billing alert for our direct-billing (non-AWS-Marketplace) setup. Interim manual safety net: glance at Organization → Usage in the Supabase dashboard, which shows the accruing monthly cost.
6. **New-API question** — for every endpoint Claude builds, ask **"who is this for: operational, business-intelligence, or both?"** and serve both where needed. **[NEW — standing guardrail]** Adding to the standing pressure-test list alongside the blast-radius question.

### Weekly automated security audit (consultant's security list, 6/4)

Jessica wants a **recurring weekly security sweep that emails her ONLY when something is wrong.** Mechanism = a **remote scheduled Claude Code agent** (runs in the cloud, clones `github.com/tia1616/enrops`). Split honestly between what a weekly sweep can actually check vs. what's really a build-time guardrail:

**Automatable weekly static sweeps (repo-level — the agent CAN do these):**
1. **Hardcoded values** — grep edge functions + endpoints for hardcoded admin UUIDs/emails. Access must be **role-based (any admin)**, never a single ID baked into a function. (Extends the existing `tenant-rls-audit` skill.)
2. **Scale check** — heuristic flags for unbounded queries (no `limit`/pagination), missing FK indexes used in filters, N+1 patterns — "**would this break at 10,000 tenants?**"
3. **File imports** — enforce a strict file-type allowlist (**spreadsheet / Google Sheet / Excel, NOT PDF**) + a **25MB size limit**. On malformed/oversized: **fail cleanly, write NOTHING to the DB, log the failure** (so patterns show over time), and give the user clear feedback + a how-to-submit tip.
4. **Ennie** — **structured-output enforcement** (e.g. required salutation / a JSON shape, validated before the output is used) layered on top of brand-voice rules; AND hard **tenant isolation** — Ennie can NEVER pull one family's or one provider's data into another's view.

**Build-time guardrails (NOT weekly sweeps — routed to standing guardrails + MEMORY):**
5. **Blast radius** — "if this goes wrong, how far does it spread?" Keep it small; this feeds access-control decisions better than a checklist. (Already a standing guardrail.)
6. **Verification practice** — keep adding unit tests as features land (incl. the **money path**); pair tests with health checks. **Caution: harden the behavior FIRST, then lock a unit test around it** — a test that enshrines flawed behavior passes while still being wrong. Weekly proxy the agent CAN report: test-count trend + whether health checks exist.

**Email mechanism — DECIDED 6/4: build the Enrops email endpoint.** A small `security-audit-alert` edge function reusing the existing Resend / `alerts@enrops.com` path; the weekly cloud agent calls it with findings → real email to jessica@journeytosteam.com. Robust, headless-safe, no connector dependency.

**Build sequence (grouped with the BGC security sketch, 6/5–6/9, after staging is up):**
1. Build + deploy the `security-audit-alert` edge function (accepts findings + a shared secret; emails jessica@ via Resend). Additive, no payment-path risk.
2. Create the weekly remote routine — repo `github.com/tia1616/enrops` (private; remote env needs GitHub access), model `claude-sonnet-4-6`, env Default. Cron `0 16 * * 1` = **Mon 9am PT**. Prompt = the 4 automatable sweeps above; calls the endpoint only on findings; **monthly heartbeat so silence ≠ broken cron.** Routine link surfaced after creation.
3. Items 5 (blast radius) + 6 (verification / harden-then-test) → add to standing guardrails + MEMORY, not the weekly job.

## Process & setup improvements (dedicate ~half-day on 6/4, before feature work)

Jessica's standing ask (2026-06-03): proactively flag better/faster/safer ways to work — connectors, guardrails, process. These are the agreed set to action 6/4:

1. **Deploy-verify hook — ✅ DONE 6/4.** A git **pre-push hook** (`scripts/git-hooks/pre-push`, activated via `git config core.hooksPath scripts/git-hooks`) runs `vite build` before any push to `main` and aborts the push if the build fails — the "build before push" rule made mechanical, catching the silent-deploy-failure class (18-silent-failures + untracked-import incidents). Scoped to `main` only (feature branches pass through). Bypass: `git push --no-verify`. Tested both paths; current tree builds clean in ~13s. **Post-push** verification (deploy actually landed on enrops.com) remains the existing `deploy-verify` skill. **Note:** `scripts/git-hooks/pre-push` is untracked — commit it with the next feature commit so it's preserved in history.
2. **Add a Stripe connector (read-only / test mode).** Only real connector gap. Today I infer money state from DB rows; for the $1 test, billing explainer, and all Connect/payroll work I should read Stripe directly (transfers, account status, balances). Add before the payroll push.
3. **Commit-per-feature discipline.** Stop letting untracked files pile up (the afterschool pile has sat for days = bundling/loss risk). First action: clear the dangling untracked afterschool files (commit scoped once the test is green), then commit each feature as it goes green going forward.
4. **Add a money/blast-radius guardrail question** to the standing pressure-test list (and to memory): *"Could this move money, charge, or email real people?"* — applied manually to the $1 test; make it automatic before any prod write/send.
5. **Analytics isolation in staging.** Staging's Resend must be sandbox/test so break-test clicks/opens don't pollute real marketing + automation analytics (`marketing-resend-webhook` writes open/click events). Fold into the staging stand-up. *(Captured from the stray `docs/prod vs data.txt` note, now removed.)*

## Open threads swept from last 4 days (6/1–6/4) — nothing critical left hanging

Reviewed recent sessions. Everything load-bearing is already in MEMORY or this plan. The few worth re-confirming:

- **Stripe Connect webhook confirmation (from 5/29 session).** A prior session left "confirm the webhook is registered in the Stripe dashboard" as a manual Jessica step. Connect is live and her payouts are enabled, so it's likely done — the **$1 test will exercise the transfer + webhook path** and prove it. If the $1 doesn't reconcile, check the webhook first.
- **Zero automated tests on the React app (from 6/2 "Endpoint testing" session).** Known gap. The consultant explicitly does NOT run unit tests, so it's acceptable for the July 3 alpha — logged, not scheduled.
- **Roster-sync SU26 patch (J2S-only).** Operational, tracked in MEMORY (`roster_sync_su26_patch`); vestigial once FA26 native registration is the source of truth. Not July 3 platform work.
- **Flash-sale retrospective (6/4 session).** A throwaway path already documented in the 6/3 family-comms handoff; no platform impact.

## Docs cleanup (proposed — confirm before deleting history)

Deleted tonight: `docs/prod vs data.txt` (2-line scratch; idea preserved in item 5 above).

**Do NOT delete** `docs/handoffs/2026-05-26-instructor-portal-completion.md` — it's referenced by MEMORY.md.

Stale candidates to confirm in the morning (shipped work; safe to archive but they're project history, so confirm rather than nuke): `docs/mockups/*.html` (3 old HTML mockups), `specs/chunk-0..3.5-*.md` (curriculum onboarding chunks, shipped), `handoffs/2026-05-22-onboarding-punchlist.md`, `specs/claude-code-kickoff-prompt.md`. Recommend: keep — they're cheap and form the audit trail. Only `prod vs data.txt` was clear junk.

## Day-by-day plan

**6/4 (Thu) — process/setup half-day, then staging.**
- First ~half-day: the 5 process & setup improvements above (deploy-verify hook → Stripe connector → clear untracked afterschool pile → blast-radius guardrail → analytics isolation). Start with the deploy-verify hook (10 min, highest payoff).
- Then staging: decide branch vs separate project (lean B / separate project for a stranger break-test unless branch isolation is provably clean).
- Stand up isolated Supabase + Stripe TEST + Resend sandbox; wire a separate Netlify deploy context with swapped `VITE_SUPABASE_*`.
- Seed enough data to click through (a few programs, instructors, a parent reg).
- Smoke-test that staging cannot reach prod.

**By 6/9 (Tue) — security sketch** for the consultant (Jessica owns scope; I remind). Slot it into the 6/5–6/9 days.

**6/5–6/10 — afterschool end-to-end + parent portal.**
- Run FA26 afterschool flow on staging: open survey → instructors submit availability → match → offers → accept. Fix breakage.
- Once green, commit the untracked afterschool files (scoped), build locally (`npm run build`) before push, verify deploy landed.
- Parent portal: register-for-new-term + notifications/automations view.
- **Live $1 payroll test on prod** to Jessica's own Express account (see PROD track above).
- **Draft the billing explainer** for Jessica/Arielle (full money chain, plain English).
- **Blank-slate onboarding test (NEW — before Italy).** Create a clean admin account with **zero J2S/JTS data** so Jessica can test onboarding from a true blank slate — exactly what the white-glove alpha founders will see (an empty org, not J2S's pre-loaded world). Best done on staging. Doubles as a real check that multi-tenant isolation holds (new org sees none of J2S's programs/instructors/registrations) and that the moat decision #2 (parents are platform-level, students/data are operator-scoped) behaves correctly for a fresh operator.

**6/11–6/22 — vacation. Consultant break-tests staging.** No build by us. Leave staging up + a short "what to poke" note for him.

**6/23–7/2 — admin home + QA.**
- After BN Digital Figma (6/22–6/29), build admin home → Ennie wins/tasks/reminders.
- Fix consultant-found breakage.
- Final dogfood of the founding-5 onboarding path Jessica will run by hand.

**July 3 — white-glove alpha.** Jessica hand-onboards 5 founding users.

---

## Open decisions to make 6/4

1. Supabase **branch vs separate project** for staging (recommend separate project for a stranger break-test).
2. Does staging need its own Google OAuth client (callback domain)? Only if instructor/parent login is in the consultant's break-test scope.
3. Seed scope for staging — minimum clickable dataset vs a sanitized prod snapshot (prefer minimal synthetic; never copy the 303 real regs with real emails into a Resend-live env).
