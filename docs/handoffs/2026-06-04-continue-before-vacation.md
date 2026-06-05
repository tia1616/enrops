# Continuation prompt — pre-vacation (paste into a fresh Claude Code chat)

Continue Enrops July-3 launch prep. **Read first:** `docs/handoffs/2026-06-04-july3-launch-plan.md`
(source of truth; see the "Progress — end of 6/4" section) and memory `project_enrops_staging_env`
+ `project_enrops_july3_launch_plan`.

**Already DONE 6/4 — do NOT redo:**
- Staging is LIVE + isolated: Supabase `mumfymlapolsfdnpewci`, Netlify `enrops-staging.netlify.app`
  (`staging` branch). Real J2S catalog mirrored + synthetic people; Stripe TEST checkout works; no real
  emails. Logins `@staging.enrops.test` / `EnropsStaging1`. Rebuild recipe: `supabase/schema/README.md`.
- Sensitive-data access verified on staging (anon, cross-user, BGC isolation) — the in-app + API half of
  the BGC sketch.
- Program Wizard shipped: `/admin/programs/new` live on enrops.com + staging.
- `main` + `staging` in sync.

**Remaining before vacation (6/11) — work top-down, pause after each step for guardrail/pressure-test
questions. **Pipeline = dev → staging → prod:** build on `dev`, merge to `staging` (deploys staging site,
test there), then merge to `main` (deploys prod). Don't push straight to main even if asked — flag it.
Test on STAGING; do DB work via the Supabase MCP; never hardcode tenant identity; build before push;
commit per-feature (don't bundle); verify each deploy landed.**

1. **Cleanup the dangling untracked files (low effort, do first — risk of loss).** Commit the
   already-applied intelligence migrations `supabase/migrations/20260604_intelligence_*.sql` (live on
   prod, just untracked). Leave the afterschool files for step 2 (commit them once their flow is green).

2. **FA26 afterschool end-to-end test on STAGING** (the flow has never run against real data). Walk:
   open availability survey → instructors submit availability → `match-afterschool` → send offers →
   accept. Fix breakage. Then commit the scoped afterschool pile (`AfterschoolSchedule.jsx`,
   `AfterschoolAvailabilityForm.jsx`, `match-afterschool`, `send-afterschool-survey`,
   `marketing-resend-webhook`, `20260603_afterschool_term_availability.sql`). Build → push → verify.

3. **BGC security sketch — DUE 6/9** (Jessica owns scope; help with the role map + code/storage check).
   Map roles→access (paper then code). Confirm BGC documents live in a **private** Storage bucket
   (`contractor-documents`) — locked, not merely unlisted. Design "all minors' data returns
   paginated/chunked, never a full dump" (no unbounded list endpoints over minors' PII). The anon +
   cross-user RLS is already verified on staging — extend to storage + the unbounded-list check.

4. **Live $1 payroll test on PROD** to Jessica's own Stripe Express account (proves the real transfer +
   webhook path). Prereq: Jessica as a test instructor with completed Express onboarding.

5. **Billing explainer** (plain English, no jargon): the full money chain — parent pays → Stripe →
   operator's connected account minus the Enrops fee → payroll → instructor Express. For Jessica to
   re-read and explain to Arielle.

6. **Parent portal additions:** register-for-new-term + a notifications/automations view.

7. **Blank-slate onboarding test:** create a clean admin org with ZERO J2S data on staging; test
   onboarding from a true empty slate (also a multi-tenant isolation check for a fresh operator).

8. **Weekly security-audit routine:** build the `security-audit-alert` edge function (reuses
   Resend / alerts@enrops.com; emails jessica@ only on findings) + create the weekly remote routine
   (Mon 9am PT).

**Optional staging follow-ups:** wire instructor-payroll Stripe (`STRIPE_INSTRUCTOR_PLATFORM_KEY`) + the
rest of the edge functions on staging if Darren should break-test those too (left off on purpose now).
