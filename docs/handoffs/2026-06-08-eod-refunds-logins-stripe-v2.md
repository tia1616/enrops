# Handoff — 2026-06-08 EOD (refunds shipped, logins reconciled, Stripe v2 risk found)

**Branches:** `main` = `staging` = `c03f8ab` (parity). Working branch: `staging`. No `dev`.
**Pipeline:** build → push `staging` → Jessica reviews on enrops-staging.netlify.app → push `main` (prod) on her go. Pre-push hook builds on main.
**Refs:** prod `iuasfpztkmrtagivlhtj`, staging `mumfymlapolsfdnpewci`. Supabase CLI authenticated (bulk fn deploys work).

---

## DONE this session (verified)

### #17 — staging logins reconciled (HARD 6/11 deadline — CLEARED)
- Reset all shared staging auth users to known values, **verified via real GoTrue login** (not just hashes):
  - 5 consultant break-test accounts (`admin@`, `instructor1/2@`, `parent1/2@staging.enrops.test`) → `EnropsStaging1`
  - Cascade demo (`owner@tenant2.staging.enrops.test`, `arielle@journeytosteam.com`) → `DemoPass123!`
  - `jessica@journeytosteam.com` left untouched (her personal login; `J2s-Staging-2026!` per prior doc).
- `Stg-Owner-7h2Kp!q` rotated (it was admin@'s temp pw; overwritten). No `sk-ant-` key anywhere in repo (nothing to purge).
- Consultant note updated (`docs/handoffs/2026-06-04-staging-consultant-note.md`): after-school live, Cascade second tenant for cross-tenant isolation tests, root-redirect note. **Word version for Darren:** `C:\Users\JVorster\Downloads\Enrops_Staging_BreakTest_Guide.docx`.

### #16 — refund action SHIPPED TO PROD (alpha money gap closed)
- New shared `src/components/RefundDrawer.jsx`: refundable math (paid − already-refunded), full/partial, **keep-$X-admin-fee** quick-fill (from `organizations.withdrawal_admin_fee_cents`), **forced keep-spot-vs-withdraw choice** (no default — Jessica's call: a full refund can keep the spot), plain-English error mapping.
- Rosters: "Refund…" row action (shows on paid regs; Remove only on unpaid) + cancelled/refunded status badge.
- Finances → Refunds tab: read-only refund ledger (was a stub).
- `refund-registration` edge fn: added churn telemetry (`refunded` + `cancelled` via `logEnrollmentEvent` doorway). Deployed to **prod + staging**.
- **Installments:** withdraw pauses pending installments (`paused_program_cancelled`; cron only charges `pending`); refundable = only what's actually been paid.
- **Proven green end-to-end on staging** (real Stripe test refund + transfer reversal). To unblock that test, J2S-staging org was force-set Stripe-connected (left connected per Jessica).

### #21 — FA26 matcher bugs VERIFIED FIXED (in code + staging)
The matcher was reworked (per-day `{from,until}` windows + `instructor_term_area_preferences` table). All 3 bugs from the 6/7 test confirmed fixed in source:
1. Time-window enforced in `eligible()` (arrival buffer + earliest/latest). 2. Location pref: two-phase, **preference-first Phase 1**. 3. `start_time` 12h text handled both in matcher (`parse12h`) and UI (`fmtTime` AM/PM parse).
- **Parity gap (not alpha-blocking):** reworked matcher is staging v7 + repo, but **prod is still old `match-afterschool` v2**. Deploy to prod before FA26 after-school actually runs. (Task #12.)

---

## ⚠️ TOP PRIORITY NEXT — Stripe v2 account activation (pre-July-3 must-verify)
Found while testing the staging Stripe-connect dry-run. **Our operator-activation webhook (`stripe-webhook` → `handleAccountUpdated`) only handles the classic v1 `account.updated`.** But `stripe-connect-onboard` (same code prod uses) produced a **v2 account** in the Enrops Dev sandbox, emitting `v2.core.account.*` events that never trigger our v1 handler — even with the endpoint subscribed to v1 `account.updated`.

- **Why prod *probably* fine:** J2S prod activated via v1 `account.updated` (`stripe_last_account_event_id` set). Likely the live platform still defaults to v1 (sandboxes run ahead) or J2S predates the v2 default.
- **The risk:** if the LIVE platform now mints v2 accounts for NEW operators, a fresh founder finishes Stripe onboarding but Enrops never flips them to `active` → registrations never open. There is **no UI status-refresh fallback** for operators (only the webhook updates `stripe_account_status`).
- **Robust fix (build next session, money-path-careful):** add a `v2.core.account.*` handler to `stripe-webhook` so activation works for v1 AND v2 accounts; staging already emits v2 events so it's directly testable. Full notes: top of `docs/backlog.md.md` (ALPHA-RISK entry).

Also logged in backlog: staging missing `sync-operator-stripe-status` (not in repo); staging Connect webhook unfinished (recreate as **v1/snapshot `account.updated`** endpoint — `STRIPE_WEBHOOK_SECRET_CONNECT` already set on staging from Enrops Dev sandbox); deferred parent refund email; Finances account-search fast-follow (reuses RefundDrawer).

---

## Queued (July-3 scope, NOT all needed before 6/11)
Jessica pulled these in 2026-06-08: per-tenant terms & pricing, settings-gated registration + canonical gating, min-students/K=K display, PolicyPage per-tenant policy+brand, #18 parent portal (register-new-term + notifications), #19 weekly security-audit automation, #20 billing explainer + blank-slate test. Plus deferred structural parity sweep (migrations-by-name + realtime publication + the prod-only-functions question: `marketing-send`, `admin-convert-logo`, `sync-operator-stripe-status` exist on prod, not in repo).

## Next chat: start here
1. Build the **Stripe v2 activation handler** (the ALPHA-RISK item) → test on staging → deploy prod on Jessica's go.
2. Then resume the July-3 queue in priority order.
