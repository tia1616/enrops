# Pre-Italy + post-Italy schedule (single source of truth)

**Written:** 2026-06-04 late evening
**Owner:** Jessica
**Italy departure:** Thu 2026-06-11
**Italy return:** Mon 2026-06-22
**White-glove alpha:** Fri 2026-07-03 — 5 hand-onboarded founders

This doc supersedes the day-by-day section of `2026-06-04-july3-launch-plan.md` (which was written 6/3 evening, before today's discovery added ~20 backlog items + a hard multi-tenant blocker fix). It reconciles:
- Original pre-vacation work list (continuation prompt + July-3 plan)
- Today's surprise multi-tenant register refactor + roster bundle (need to ship to prod for Friday's Looms)
- Today's Tenant-2 dry-run findings (which are MOSTLY post-Italy; called out below where any leak earlier)
- Jessica's confirmed constraints: Loom recordings 6/5 (feature walkthroughs), ~3hrs weekend each day, all four hard pre-vacation items remain non-negotiable

---

## Calendar reality

| Date | Day | Availability | Constraint |
|---|---|---|---|
| Thu 6/4 | tonight | ~2hrs left | prod promote window |
| Fri 6/5 | Looms day | not for building | feature walkthroughs against prod |
| Sat 6/7 | weekend | ~3hrs | family + rest |
| Sun 6/8 | weekend | ~3hrs | family + rest |
| Mon 6/8 | full | ~6hrs |  |
| Tue 6/9 | full | ~6hrs | **BGC sketch hard deadline** |
| Wed 6/10 | full | ~6hrs | last full day pre-Italy |
| Thu 6/11 | travel | 0 | leave |
| 6/11–6/22 | Italy | 0 | **consultant break-tests staging** |
| 6/22–6/29 | post-Italy | varies | BN Digital Figma lands |
| 6/30–7/2 | final sprint | full | last days before alpha |
| Fri 7/3 | ALPHA | 0 build | hand-onboard 5 founders |

**Total available build hours:** ~2 tonight + ~24 across 6/7–6/10 = **~26 hours pre-vacation.**

---

## TONIGHT (Thu 6/4) — Prod promotion for tomorrow's Looms

**Window:** ~90 min focused. STOP after this. Sleep.

The bundle on `staging` (19 files ahead of `main`) needs to ship to prod so tomorrow's Looms can demo the new afterschool roster + the multi-tenant register fix.

**The promotion bundle:**
1. Apply migration `20260604_roster_email_sends_program_id.sql` to prod
2. Deploy edge fns to prod: `admin-import-program-roster`, `admin-remove-registration`, `import-partners-parse`, `email-program-roster` (updated tenant-driven sender)
3. **Apply the same tenant-driven-sender fix to `email-camp-roster`** (currently still hardcodes `updates.journeytosteam.com`) and deploy
4. Merge `staging` → `main`, push, deploy-verify on enrops.com
5. One-time prod backfill: link every `program_locations` row to its same-named active partner in the same org. (Closes the location↔partner gap for J2S's existing ~18 partners with contacts.)
6. Smoke-test on enrops.com: J2S register URL renders, admin rosters page shows tabs, a partner email modal opens with contacts pre-checked.

**Side fix (5 min, staging only — required to validate Tenant 2 properly):** set `STRIPE_WEBHOOK_SECRET` on staging from the Stripe TEST dashboard. Today's Tenant 2 registration row is `status='pending'` because the webhook was rejected (signing secret unset). Doesn't affect prod (prod webhook is configured); fixing on staging just so the dry-run regression-test environment is honest.

**Don't ship tonight (deferred — too risky after a 12-hour day):**
- Settings architecture (big, multi-day, post-Italy)
- Per-tenant branding pass (post-Italy)
- Canonical workflow gating (post-Italy)
- Partners↔locations unification (post-Italy)

---

## Fri 6/5 — Loom recording day

**Build: NONE.** Whole day is yours for the Looms.

The Looms cover sales + feature walkthroughs. Surfaces likely demoed (all on prod after tonight's promote):

- Curriculum upload + AI extract (already on prod)
- Program wizard (already on prod)
- **Afterschool roster + tabs + email-to-partner** (shipped tonight)
- Marketing campaign builder (already on prod)
- Partner contact import (already on prod)
- Native registration flow (`/j2s/register` — unchanged for J2S even with the multi-tenant refactor)

If any feature looks broken on prod after the morning verify, ping me — I'll fix and re-deploy fast rather than have you re-record.

---

## Sat 6/7 (~3hrs) — FA26 afterschool end-to-end, part 1

**Why this first on the weekend:** the consultant will start break-testing 6/11. The FA26 afterschool flow has **never run against real data** — code exists (`AfterschoolSchedule.jsx`, `match-afterschool`, `send-afterschool-survey`, `AfterschoolAvailabilityForm.jsx`) but **0 program_assignments, 0 FA26 availability rows, 0 FA26 survey_state rows** against 26 open FA26 programs and 20 active instructors. If we don't exercise it, the consultant will be the first to.

**Plan (~3 hrs):**
1. On STAGING: open the FA26 availability survey to the 20 staging-instructors.
2. Submit 5–10 synthetic availability responses (a mix of "want all my FA26 programs" / "only certain days" / partial unavailability).
3. Run `match-afterschool`; review matches; identify any obvious wrongness.
4. Capture every breakage with file:line refs, don't fix yet — just survey.

**Carry into Sunday:** the fixes themselves.

---

## Sun 6/8 (~3hrs) — FA26 afterschool, part 2 + commit untracked files

**Plan (~3 hrs):**
1. Fix Saturday's breakage list.
2. Send offers to matched instructors; accept some, decline some.
3. Confirm `program_assignments` rows land correctly with `status='confirmed'`.
4. **Commit the dangling untracked afterschool pile** (per the original plan):
   - `AfterschoolSchedule.jsx`, `AfterschoolAvailabilityForm.jsx`, `match-afterschool`, `send-afterschool-survey`, `marketing-resend-webhook`
   - Migration `20260603_afterschool_term_availability.sql`
   - `scripts/git-hooks/pre-push` (still untracked from 6/4 morning)
5. Build → push → deploy-verify.

---

## Mon 6/8 (~6hrs) — Parent portal additions + $1 payroll setup

**Half 1 (~3hrs): Parent portal — register-for-new-term + notifications view.**
- The "register for new term" surface for the existing parent dashboard (so a FA26 parent can register for WI27/SP27 from inside their account).
- A notifications/automations view (what reminders they're subscribed to, ability to unsubscribe per-type rather than nuking all).

**Half 2 (~3hrs): $1 payroll test prep on PROD.**
- Set Jessica up as a test instructor with completed Stripe Express onboarding (the same Connect flow camp instructors use).
- Verify the Express account is fully onboarded (transfers enabled).
- Schedule the actual $1 transfer for Tue (don't do it Monday in case anything's off — Tue gives a buffer day).

---

## Tue 6/9 (~6hrs) — **BGC sketch (HARD DEADLINE)** + $1 payroll execute

**Half 1 (~3-4hrs): BGC security sketch — Jessica deliverable.**

Per consultant promise, must be done by EOD 6/9. Scope from the July-3 plan:
- Map roles → access (paper/whiteboard first), then to code.
- Verify BGC documents live in the **private** `contractor-documents` storage bucket — locked, not merely unlisted. Confirm RLS + signed-URL policy + edge-function access patterns.
- Verify "all minors' data" endpoints return **chunked/paginated**, never a full dump.
- The anon + cross-user RLS is already verified on staging — extend to storage + unbounded-list endpoints.

**I help with:** the code/storage audit (greps, RLS policy review, Supabase MCP queries) and the role-map markdown doc.
**Jessica owns:** the sketch itself + sign-off.

**Half 2 (~2hrs): $1 payroll live test on PROD.**
- Run the PayDrawer → `pay-instructor` (`via_stripe: true`) → transfer flow to Jessica's own Express account.
- Confirm the dollar arrives, `session_delivery_confirmations.pay_status` flips to `paid`, Stripe transfer id is recorded.
- If it works: ✅ live-money path is validated for alpha.
- If it doesn't: triage immediately — this is the single largest risk for July 3.

---

## Wed 6/10 (~6hrs) — Weekly security audit routine + billing explainer + leave-staging note

**Half 1 (~3hrs): Weekly security-audit routine.**
- Build the `security-audit-alert` edge function (reuses Resend / `alerts@enrops.com`; emails Jessica only on findings).
- Create the weekly remote routine (Mon 9am PT cron) that runs the 4 automatable static sweeps from the July-3 plan.
- Test it manually once before relying on the cron.

**Half 2 (~2hrs): Billing explainer draft + leave-staging note.**
- Plain-English money chain explainer (parent → Stripe → operator's Connect account minus Enrops fee → payroll → instructor Express). For Jessica to re-read and explain to Arielle.
- Update `2026-06-04-staging-consultant-note.md` with current staging state + what's safe/unsafe to poke.

**~1hr buffer:** final smoke test on prod, last verify on Tenant 2, last verify on J2S afterschool flow.

---

## 6/11–6/22 — Italy. Consultant break-tests staging.

No build by us. Consultant note already in place; he hits the staging URL and tries to break the UI.

**What I do during this window:** nothing (no autonomous runs). Any logs / findings he generates queue for review when Jessica returns.

---

## 6/22–6/29 — Post-Italy week, BN Digital Figma lands

**Triage consultant findings.** Anything load-bearing → fix. Cosmetic/UX nits → backlog.

**BN Digital Figma:** they design the admin portal. Apply designs as they land (rather than build the Ennie home from scratch).

**Catch up on today's Tenant 2 dry-run backlog (top items):**
- Settings architecture (Profile / Brand / Registration / Waivers / Pricing / Communications / Team / Billing) — the new requirement from tonight: registration is LOCKED until Settings is complete. This unblocks any real second tenant.
- Canonical-workflow gating on every operator surface — every save ends with explicit next-action affordance.

---

## 6/30–7/2 — Final pre-alpha sprint

- Final dogfood of the founding-5 onboarding path Jessica will run by hand.
- Per-tenant branding pass (logo + colors + copy from `org_branding`).
- Per-tenant defaults ("ask once, reuse everywhere" pattern — min/max students, pay rates, fees).
- Whatever's left from the consultant's findings.

---

## Fri 7/3 — White-glove alpha. Jessica hand-onboards 5 founders.

---

## Genuinely post-alpha (do NOT build before 7/3)

Already deferred to August in the July-3 plan, plus everything from today's dry-run that doesn't block tenant #2:

- **Self-serve onboarding wizard** (alpha is hand-onboarded).
- **Day-1 setup checklist UI.**
- **Full Director feed / Ennie wins-tasks-reminders home** (BN Figma drives this; basic version may land pre-alpha if Figma's quick).
- **FA26 auto-assign polish** (manual match is fine for alpha).
- **Predictive enrollment + data-backed recommendations** (the intelligence layer is being instrumented; the recommendation engine itself is August+).
- **PostHog analytics scope v1** (queued in memory).
- **Partners↔locations architectural unification** (the 3-surface bite — needs design pass, post-alpha).
- **Bulk-import for school locations** (sibling to partner contacts importer).
- **"Import partners" naming + multi-location partners** (Parks & Rec etc. having multiple venues).
- **Cycle modal rewrite** (afterschool-shaped copy, no week-by-week breakdown for afterschool).
- **Auto-link locations to partners on import** (the architectural fix that closes the gap end-to-end).
- **District filter hide on small catalogs.**
- **K = K display fix everywhere grades show.**
- **Min students field + "ask once" pattern.**
- **Session-dates preview disclosure** (placeholder vs district-calendar-applied).
- **Subdomain-per-tenant** (j2s.enrops.com etc. — out of scope; backlog).
- **The Settings architecture is technically post-alpha BUT we lift it forward to 6/22–6/29 because real tenant #2 can't onboard without it.**

---

## Today's decisions / principles (NEW — record so they survive into future chats)

- **Registration is LOCKED until tenant completes Settings.** A tenant cannot publish a program / open registration until Profile / Brand / Registration form fields / Waivers are configured. Each canonical-workflow step gates the next.
- **Settings is one sub-nav area**, not fragmented top-level tabs: `Profile / Brand / Registration / Waivers / Pricing / Communications / Team / Billing`.
- **Don't auto-derive** in operator-facing copy.
- **Camp vs Afterschool unit:** per-WEEK (camp) vs per-PROGRAM (afterschool). Per-week granularity is camp-only.
- **Cycle envelope ≠ program duration.** Envelope ~14 weeks (covers all districts); afterschool program ~8 sessions.
- **"Ask once, reuse everywhere"** for fields that repeat across programs.
- **Import partners (not "Import schools").** Schools, P&R, churches, community orgs all partner types. Some partners have multiple locations.
- **The Tenant 2 dry-run is the acceptance gate** for any real second tenant. Lives in staging permanently.

---

## What the NEXT CHAT needs to know first

1. **Read THIS doc** before anything else.
2. Read `docs/handoffs/2026-06-04-july3-launch-plan.md` for the underlying launch plan.
3. Read `docs/backlog.md.md` (top section, 2026-06-04 entries) for the full findings list.
4. Read three memory entries added today:
   - `feedback_staging_realtime_parity`
   - `project_enrops_canonical_operator_workflow`
   - `project_enrops_partners_locations_link`
5. **Verify with Jessica** before any prod write: what got shipped between sessions, what's the next priority on the schedule above.

---

## Bottom line / commitments

| Window | What ships | What ships honestly NOT |
|---|---|---|
| **Tonight** | Roster bundle + multi-tenant register fix to prod. Looms tomorrow have the surfaces they need. | Settings, branding pass, workflow gating — deferred to post-Italy. |
| **Pre-Italy** | FA26 afterschool tested + committed, BGC sketch, $1 payroll proven on prod, weekly security audit running, parent portal additions, billing explainer drafted. | Most of today's dry-run findings — captured but not built. |
| **Post-Italy** | Settings architecture, registration lock, canonical workflow gating, per-tenant branding pass. Tenant #2 actually onboardable. | Subdomain tenancy, full Director feed, predictive recommendations. |
| **Post-alpha** | Everything else from the backlog. | — |

If the schedule above turns out to slip by a day or two during 6/7–6/10, the order to drop in is: parent portal additions → weekly audit (those are nice-to-have for alpha; everything else is hard). The four non-negotiables (today's bundle, BGC, FA26 test, $1 payroll) all stay.
