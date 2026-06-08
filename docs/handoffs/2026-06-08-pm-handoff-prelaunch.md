# Handoff — 2026-06-08 PM session → next chat (pre-launch)

**Alpha = Friday July 3, 2026** (white-glove, Jessica hand-onboards 5 founders). Cohort "opens" July 6 per Arielle's playbook. NOT July 1. Build deadline is **July 3**; Jessica is in Italy **6/11–6/22** (consultant break-tests staging during that window).
**Flow (NEW):** build → push `staging` → Jessica reviews on `enrops-staging.netlify.app` → push `main` (prod) on her go. **No `dev` branch anymore.** Keep staging↔prod at parity. No auto-push to main. Terse, recommendation+tradeoff, never hardcode tenant identity.

---

## 0. READ FIRST
1. This doc.
2. `docs/handoffs/2026-06-04-pre-italy-schedule.md` (day-by-day source of truth) + `2026-06-04-july3-launch-plan.md` (underlying plan).
3. `docs/backlog.md.md` — the full open-items list, incl. the 2026-06-04 **Tenant-2 dry-run findings** (Jessica wants the branding ones pre-launch — see §3) and the 2026-06-08 payroll/refund items.
4. Memory (auto-loads): `feedback_branch_pipeline` (staging→prod, no dev), `feedback_absolute_parity_staging_prod`, `feedback_pre_merge_test_local` (test on staging not localhost), `project_enrops_payroll_routes`, `project_enrops_pay_scheme`, `project_enrops_staging_env`.

Prod ref `iuasfpztkmrtagivlhtj`; staging ref `mumfymlapolsfdnpewci`; staging site `enrops-staging.netlify.app`. Supabase CLI is logged in (bulk function deploys work). `SUPABASE_ACCESS_TOKEN` is NOT in env but the CLI session is authenticated.

---

## 1. DONE this session (verified — do NOT redo)

**Shipped to PROD (deploy-verified by commit SHA):**
- **$1 LIVE PAYROLL TEST PASSED** 🎉 — real Stripe transfer `tr_1Tg7AjILl02bk33x7fvWuRe5` to Jessica's Express `acct_1Tbm5MREgn4BTNX4`, payout `succeeded`, line `paid`. Live-money path validated for July 3. (J2S `legacy_own_platform` route.)
- **Schedule NEEDS HIRE counter fix** — now counts open slots (missing lead + wanted-but-missing developing), matches the board's coral badges. Camp board only; after-school is single-slot (no bug).
- **Admin-home open-hires banner** (`AdminOverview.jsx`) — sign-in alert for unfilled instructor slots (active camp cycles + staffing-started after-school terms).
- **Instructor-portal redirect fix** — magic-link/Google sign-in returns to the current tenant's `/:slug/instructor`, not hardcoded `/j2s/instructor`.
- **Registration copy:** "Fall only" → "Fall" when no VIP all-terms option to contrast with.
- **Payroll manual adjust + bonus** (`Payroll.jsx`) — per-line "Adjust" (override a day's total, non-destructive) + group "+ Add bonus", required reason, audited (`admin_override_*`), feeds the Stripe payout. Paid lines locked.
- **Payroll "Pay via Stripe" gating** — only shows for a live Stripe payout rail (`legacy_own_platform` today). Manual / `enrops_platform` tenants see only "Mark paid manually." (`Payroll.jsx canStripePayout`.)
- **`supabase/config.toml`** — pins per-function `verify_jwt` (mirrors prod) so deploys can't silently flip a webhook.
- **Prod migration `afterschool_cycle_nullable_dates`** — closed a latent FA26 cycle-creation crash (scheduling_cycles dates nullable for after-school + guard CHECK).

**Staging:**
- **All ~70 edge functions redeployed to staging** at current code (via config.toml) — was badly stale (stripe-webhook v9 vs prod v50, etc.). verify_jwt verified across the board; caught+fixed `marketing-resend-webhook` flip.
- **`STRIPE_WEBHOOK_SECRET` confirmed correct on staging** (matches Jessica's Stripe TEST endpoint).
- **Cascade Enrichment Co. demo tenant fully built** (org `b177a0ea-32c6-45c9-82ac-cbb7261c2dee`, slug `tenant-two-test`) — renamed from "Tenant Two Test Academy", `org_branding` seeded, 2 programs (LEGO Inventors Lab Tue 3:30 + Robotics Explorers Thu 3:45), 4 instructors, 6 paid registrations ($1,200 history), both waivers, manual-pay enabled (`instructor_pay_enabled=true`), 3-session payroll group for the demo, instructor magic-link working.
- **Public-page branding (token CSS-vars)** — SHIPPED TO PROD `4faaaac`, verified (Cascade Enrops-branded, J2S unchanged). j2s-* tokens default to J2S values (J2S/admin untouched), overridden to Enrops inside the `.brand-enrops-public` shell. Covers catalog/register/dashboard/login/register-success for non-J2S tenants.

**Memory updated:** branch pipeline (staging→prod, no dev), absolute parity, pre-merge=staging, `project_enrops_payroll_routes` (new), pay-scheme pointer.

---

## 2. AWAITING JESSICA'S CHECK
- **Branding fix:** ✅ DONE — verified on staging (Cascade Enrops, J2S unchanged) and shipped to prod `4faaaac`.
- **Arielle demo (3 click-tests, Jessica with Arielle):** (1) operator login `owner@tenant2.staging.enrops.test` / `DemoPass123!`; (2) instructor magic-link actually **arrives** at `arielle@journeytosteam.com` (enter it at `/tenant-two-test/instructor` → "Email me a sign-in link" → click) — if it doesn't arrive, next chat generates a one-time sign-in link; (3) one fresh parent test-payment (`4242 4242 4242 4242`) auto-reconciles to paid. Demo guide: `C:\Users\JVorster\Downloads\Enrops_Demo_Guide_Arielle.docx`.

---

## 3. OPEN PRE-LAUNCH TASKS (priority order)

**Branding — Jessica's expanded ask 2026-06-08: ALL multi-tenant surfaces must be Enrops-branded, not J2S (reg, instructor, parent portal, all of it).**
- ✅ The token CSS-var fix (this session) already covers, for non-J2S tenants, every parent surface under `PublicLayout`: **catalog (Home), register + register-steps, parent Dashboard, Login, RegisterSuccess** — all inherit the `.brand-enrops-public` override. **Verify each on staging as Cascade.**
- ⚠️ **Instructor portal** (`/:slug/instructor`, `InstructorPortal.jsx`) is a top-level route NOT under PublicLayout, but it uses **no `j2s-*` classes** (already Enrops — header reads "Enrops Instructor portal"). Verify visually as Cascade/Maya.
- ⚠️ **`PolicyPage` edge case:** `/:slug/privacy` + `/:slug/terms` hardcode `orgSlug="j2s"` in `App.jsx` — every tenant's policy pages show J2S's policy TEXT (content bug), and colors render J2S unless wrapped. Fix: resolve policy org from slug + wrap non-J2S in `.brand-enrops-public`.
- 🔜 **Full per-tenant branding (read `org_branding` colors/logo/hero per tenant)** so Cascade shows ITS palette (not just generic Enrops) — bigger "full pass," backlog. Generic-Enrops-for-non-J2S (done) satisfies "not J2S."

**The 7 gap tasks (task list #15–21):**
- **#15 Enrops-brand public pages** — ✅ DONE, shipped to prod `4faaaac`. (Remaining sub-items: PolicyPage edge case + full per-tenant `org_branding` colors — see branding section above.)
- **#16 Wire refund action** — paid FA26 regs have NO refund/cancel path in UI (Finances Refunds tab is a stub; Rosters Remove refuses paid regs). Add Refund row action → `refund-registration` (Stripe refund + `cancelled_at` + free seat), full/partial/keep-admin-fee + confirm. **Alpha gap** (real money, live FA26 reg).
- **#17 Reconcile + document staging logins** — **before 6/11.** Conflicting passwords across docs (`EnropsStaging1`, `J2s-Staging-2026!`, `Stg-Owner-7h2Kp!q`, `Tenant2Test`) + several changed to `DemoPass123!` this session. Set clean known creds; update `docs/handoffs/2026-06-04-staging-consultant-note.md` (after-school now live, Cascade demo, root redirect, safe/unsafe). Rotate `Stg-Owner-7h2Kp!q` + `ANTHROPIC_API_KEY` per old note.
- **#18 Parent portal additions** — register-for-new-term (FA26 parent registers WI27/SP27 from dashboard) + notifications view w/ per-type unsubscribe. (Plan marks droppable-first if time slips.)
- **#19 Weekly security-audit automation** — `security-audit-alert` edge fn (Resend→jessica@, findings + shared secret) + weekly remote cron `0 16 * * 1` (4 static sweeps + Supabase spend >$150 check + monthly heartbeat). Test once. (Droppable-second.)
- **#20 Billing explainer + blank-slate test** — plain-English money chain for Jessica/Arielle; clean-org onboarding walk on staging verifying multi-tenant isolation.
- **#21 Verify FA26 matcher fixes** — 6/7 found 3 bugs (time-window ignored, location-pref lost to greedy, `programs.start_time` stored as 12h text → renders "2-3"). Memory said "Sunday=fix" — confirm landed or still open. Matcher quality is post-alpha-acceptable (manual match fine), but start_time-text is a real display/data bug.

**Tenant-2 dry-run findings (backlog 2026-06-04) — Jessica wants the branding ones pre-launch.** The branding leaks are handled by the token fix + the PolicyPage item above. The OTHERS from that list are mostly post-Italy/post-alpha by design (alpha is hand-onboarded): Settings architecture (registration-locked-until-Settings), canonical-workflow gating, per-tenant terms/pricing, K=K display, min-students, cycle-modal afterschool copy, district-filter-hide, registration-visibility surface, partners↔locations unification. **Confirm with Jessica which beyond branding she wants pre-launch** — most were explicitly deferred.

---

## 4. Payroll Option 2 (logged, post-alpha)
"Enrops moves the money" (`enrops_platform` payout) is BLOCKED (501, untested) — NOT a copy of J2S's path (J2S has its own Stripe platform; new tenants are connected accounts under Enrops). Connecting Stripe for registrations does NOT unlock payroll (separate outbound flow + instructor Express signup under Enrops). Build scope in `backlog.md.md` (2026-06-08) + memory `project_enrops_payroll_routes`. Money always from the OPERATOR's Stripe balance, never Enrops's. Manual pay is fine for the hand-onboarded alpha.

---

## 5. Standing guardrails (every feature)
Scope → build on staging → 8 pressure-tests → restate guardrails → pause for Jessica's guardrail Qs → verify in DB (Claude runs Supabase) → commit per feature → `npm run build` before push (pre-push hook on main) → deploy-verify by **commit_ref** (not just HTTP 200). Money/blast-radius + tenant-rls-audit + SECURITY DEFINER self-check + in-app-preview + AI-wait-UI + no-tech-jargon + session-dates-via-`derive_program_session_dates` + one-editable-surface. `.tmp/commit-msg.txt` + `git commit -F` for non-ASCII.

## 6. Immediate next actions for the next chat
(Branding #15 is already shipped to prod `4faaaac` — staging + main in parity. Don't re-push.)
1. **#17** staging logins + consultant note — **hard 6/11 deadline** (consultant break-tests staging). Start here.
2. **#16** refund action — alpha gap (paid FA26 regs can't be refunded in UI).
3. **#21** verify FA26 matcher fixes, then **#18** parent-portal additions, **#19** weekly security audit, **#20** billing explainer + blank-slate test.
4. Branding cleanup: PolicyPage edge case (`/:slug/privacy` hardcodes orgSlug=j2s); spot-check instructor portal as a non-J2S tenant; consider full per-tenant `org_branding` colors.
5. Keep `main`↔`staging` in parity; nothing to prod without Jessica's go.
