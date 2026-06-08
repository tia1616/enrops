# Resume cold-start — after the weekend, pre-Italy (read this first)

**Written:** end of the 6/6–6/8 session. **Italy departure: Thursday 6/11.** Consultant break-tests staging 6/11–6/22. White-glove alpha 7/3.
**Tone/rules:** terse, recommendation + tradeoff, **no auto-push**, never hardcode tenant identity. Jessica is non-technical — plain English, no jargon.

---

## 0. READ FIRST (do not skim)

1. This doc.
2. `docs/handoffs/2026-06-04-pre-italy-schedule.md` — the day-by-day source of truth (calendar + non-negotiables).
3. `docs/handoffs/2026-06-04-july3-launch-plan.md` — underlying launch plan (backups, security-audit automation spec, standing guardrails).
4. `docs/handoffs/2026-06-06-bgc-sensitive-data-sketch.md` — the delivered BGC/sensitive-data sketch.
5. Memory entries (auto-load, but re-read): `project_enrops_fa26_afterschool_test_day1` (afterschool running log + prod-ship), `project_enrops_sensitive_data_posture`, `project_enrops_pay_scheme`, `project_enrops_staging_env`, `project_enrops_july3_launch_plan`, `feedback_branch_pipeline`, `feedback_build_workflow_process`, `feedback_in_app_preview`, `feedback_claude_runs_supabase`.
6. **Before any prod write, confirm with Jessica** what shipped between sessions and the next priority.

Prod ref `iuasfpztkmrtagivlhtj`; staging ref `mumfymlapolsfdnpewci`; staging site `enrops-staging.netlify.app` (root redirects to `/admin/login`, host-gated). Branch pipeline: build on `dev`/feature → `staging` → `main` (prod). `main` and `staging` are currently in sync.

---

## 1. DONE this session (verified prod + staging — do NOT redo)

- **After-school instructor lifecycle SHIPPED to prod + staging.** Full offer loop: survey → match → **Approve** (proposed→confirmed) → **Send offers** (with in-app Preview, recipient pre-select, optional deadline) → instructor **Accept / Request change** → admin **reply** → confirmed schedule. Realtime board, warm reassign/remove, change-request HatGuide notification, camp-parity filters (Instructors/Locations/Status + clickable load pills).
- **Edge fns deployed to prod:** `respond-to-assignment` v7 (polymorphic camp|program + admin impersonation), `send-afterschool-offers` v1 (new), `offer-message-reply` v19 (polymorphic). Staging has the same.
- **Prod schema brought to parity** (migration `afterschool_availability_v2`): `instructor_term_availability` v2 (`weekday_availability`), `instructor_term_area_preferences` table, `program_locations.area`. Realtime publication: added `program_assignments` + `camp_assignments` + `curriculum_documents` (prod + staging).
- **Area auto-default trigger** (`20260606_default_location_area_from_city.sql`, prod + staging) — fills `area` from US address city on any write (form/import/sync); operator override wins. **J2S backfill: 61/61 locations have area** (your manual corrections preserved from staging). NOTE: PG word boundary is `\y` not `\b` (JS) — bug caught + fixed.
- **BGC/sensitive-data sketch delivered** (`docs/handoffs/2026-06-06-bgc-sensitive-data-sketch.md`). Audit extended to the new after-school tables; **fixed a real RLS gap** (`20260606_iom_instructor_self_read_program.sql`, prod + staging) — `instructor_offer_messages` self-read was camp-only, blocking real after-school instructors from their own offer threads.
- **Camp send-offers** got the same in-app Preview. `main`/`staging` synced. The 3 security migrations (search_path, security_invoker views, bucket listing) confirmed applied to prod + committed to git.

**Already done earlier (don't redo):** staging env (6/4); **backups/PITR 7-day window (6/4)**; manual weekly security sweep (6/6, `docs/handoffs/security-audit-2026-06-06.md`).

---

## 2. REMAINING before Thursday 6/11 (priority order)

### A. $1 payroll test — PROD, real money *(highest priority; single biggest July-3 risk)*
**State (verified):** operator J2S Stripe = active, payouts enabled, `instructor_pay_enabled=true`, `instructor_pay_model='legacy_own_platform'`. **Jessica Vorster is a fully-onboarded instructor** (`instructors.id = d7201431-8fa8-4411-b84c-808b4243ce3b`, Stripe Express **complete + payouts enabled**). 12 instructors payouts-ready. **BUT 0 `session_delivery_confirmations` exist** → payroll screen is empty; nothing to pay yet.
**Steps:**
1. Get Jessica's go to send herself **$1** (she controls + can verify the account).
2. Create ONE controlled pay line: a `session_delivery_confirmations` row for her instructor id on a real J2S `camp_session`, `pay_amount_cents=100`, `pay_status='approved'`, `instructor_payout_id=null`. (Confirm `confirmed_by` ≠ pending so it's payable.)
3. In `Payroll.jsx` (`/admin/payroll`) → her group → **Pay via Stripe** → `pay-instructor` (`via_stripe:true`).
4. **Verify (Claude runs SQL + Jessica checks Stripe):** `instructor_payouts` row `status='succeeded'` + `stripe_transfer_id`; `session_delivery_confirmations.pay_status='paid'`; the $1 actually arrives in her Stripe Express.
5. If it fails → triage immediately (check the Connect webhook first). Consider adding a **read-only Stripe connector** to verify transfers directly (flagged in launch plan §"Process improvements").
**Money/blast-radius guardrail applies:** this moves REAL money — double-check recipient + amount before the call.

### B. Staging handoff for the consultant (before 6/11)
- **Reset + document staging logins.** I set `jessica@journeytosteam.com` staging pw to `J2sStaging2026!`; `admin@staging.enrops.test` was changed earlier. Synthetic logins are `@staging.enrops.test` / `EnropsStaging1` (some may have drifted — verify). Decide clean known creds for the break-test.
- **Update `docs/handoffs/2026-06-04-staging-consultant-note.md`** with current staging state (after-school now live there, root redirect, what's safe/unsafe to poke).

### C. Parent-portal additions *(droppable first if time slips)*
- Register-for-new-term surface in the parent dashboard (FA26 parent → register WI27/SP27 from their account).
- Notifications/automations view: see subscribed reminders + unsubscribe **per type** (not nuke-all).
- Confirm scope with Jessica before building.

### D. Weekly security-audit AUTOMATION *(droppable second)*
The manual sweep is done; the recurring automation is not. Per launch plan §"Weekly automated security audit":
1. Build + deploy `security-audit-alert` edge fn (Resend → jessica@; accepts findings + shared secret).
2. Weekly remote routine, repo `github.com/tia1616/enrops`, cron `0 16 * * 1` (Mon 9am PT): the 4 static sweeps (hardcoded values; scale/unbounded-query check; file-import allowlist+25MB; Ennie structured-output + tenant isolation) + **Supabase monthly-spend check, flag >$150/mo** (no native budget alert; Spend Cap is OFF). Monthly heartbeat so silence ≠ broken cron.
3. Test once manually before relying on it.

### E. Billing explainer + blank-slate test
- **Billing explainer** (plain English, for Jessica → Arielle): parent pays → Stripe → operator connected account **minus Enrops platform fee** → payroll → instructor Express. Cover fee config in `Finances.jsx`, what operator/instructor each see.
- **Blank-slate onboarding test** on staging: clean admin org with **zero J2S data**; verify multi-tenant isolation (new org sees none of J2S's programs/instructors/regs) — mirrors what alpha founders see.

---

## 3. Backlog / NOT before Italy (don't build now)
- After-school deferred parity: `send-patch-offer` polymorphic, `offer-reminders-cron` program pass (afterschool has no auto_reminders flag model). Bulk Send covers mid-term adds for now.
- **Multi-tenant payroll (post-Italy, big):** (1) one source of truth for pay rates — today `confirm-session-delivery` hardcodes J2S rates AND `confirm-session-taught` reads org hourly config; they diverge. Build a per-tenant tier×format pay-rate config, deprecate the hardcode, backfill J2S. (2) The `enrops_platform` payout path in `pay-instructor` is BLOCKED (501, untested) — build + test with Tenant Two so non-J2S tenants can pay. (3) Payouts "Bank"/"Reports" stub tabs (history, 1099s, statements). Full scope in the session transcript.
- Settings architecture + registration-lock + canonical-workflow gating (post-Italy; unblocks real tenant #2). Per-tenant branding pass (final sprint).
- A real-instructor (non-impersonated) click-through of the after-school offer loop on staging — shipped + DB-validated, but worth a live-login pass since impersonation masked the RLS gap.

---

## 4. Standing guardrails — run these EVERY feature (don't skip)

**Per-feature build loop** (`feedback_build_workflow_process`): scope → build on staging → run the 8 pressure-tests → restate standing guardrails + hard rules → **pause and invite Jessica's guardrail questions** → verify in DB (Claude runs Supabase, never paste SQL for her) → **commit per feature** → `npm run build` before push (pre-push hook enforces on `main`) → **deploy-verify with a real signal** (read `commit_ref` / check the live bundle, NOT just HTTP 200).

**8 pressure-test questions** (`feedback_pressure_test_questions`): underspecified? inconsistent-with-existing? security/multi-tenant? errors/edge-cases? clickability/next-action? what-does-this-touch? artifact-column (does state key off the artifact, not a derived status)? parallel-schema (mirror the existing sibling, query pg_constraint — don't infer)?

**Plus the standing additions:**
- **Money/blast-radius:** "Could this move money, charge, or email real people?" — applied manually before any prod write/send.
- **New-API question:** "who is this endpoint for — operational, business-intelligence, or both?"
- **Tenant safety:** run the `tenant-rls-audit` skill before saying anything is ready; never hardcode `j2s`/tenant UUIDs/branding.
- **SECURITY DEFINER rule:** any row-returning SECURITY DEFINER **function OR view** must self-check org/role or be service-role-locked; new `public` tables get explicit RLS + grants; run the security advisor after schema changes. New SECURITY DEFINER fns are auto-granted EXECUTE to anon+authenticated — `revoke ... from anon, authenticated` explicitly.
- **Branch pipeline:** `dev`/feature → `staging` → `main`. Don't push features straight to `main`; keep `main`↔`staging` in sync (they diverged this week and forced a conflict-laden prod merge — merge `main→staging` periodically).
- **In-app preview over send-to-self** for email flows; **AI-wait UI** (duration + m:ss) on any AI step; **no tech jargon** in UI; **session dates** via `derive_program_session_dates`, never hand-rolled; **one editable surface per field**.
- **Commit messages with non-ASCII** → use `.tmp/commit-msg.txt` + `git commit -F` (PowerShell here-strings break on em-dashes).

---

## 5. First actions for the resuming session
1. Read §0 list. Confirm with Jessica which of §2 A–E to start (recommend **A: $1 payroll test** — it's the biggest risk and is one decision away).
2. For each item: scope → confirm → build per the §4 loop → verify in DB → commit per feature → deploy-verify.
