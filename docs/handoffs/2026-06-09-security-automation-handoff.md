# 2026-06-09 Handoff: Security, Automation, and Figma Reskin

## What was built today

### Password auth removed from all sign-in screens
- **Prod (enrops.com):** Password form gone. Google + magic link only.
- **Staging:** Password preserved behind `VITE_ALLOW_PASSWORD_AUTH=true` env var (set in staging Netlify) so the consultant's test accounts still work during break-testing (6/11-22).
- Files changed: `AdminLogin.jsx` (env-var gate), `Login.jsx` (dead code cleaned), `RegisterSuccess.jsx` (dead code cleaned), `AuthContext.jsx` (removed `signInWithPassword`/`signUpWithPassword` exports).
- Commits: `7417438` (removal) + `4d6112e` (env-var gate).

### Security audit SKILL.md expanded
- Added check #6: secret key scan (greps repo for `sk_live_`, `sk_test_`, `sbp_`, `re_`, `eyJ`, `service_role` in committed source)
- Added check #7: external API dependency note (Google Maps Places API has graceful fallback; standing INFO reminder)
- Next scheduled run: Monday 2026-06-15 at 8:07am

### New scheduled tasks
- **`enrops-staging-prod-parity`** — Mondays 8:15am. Checks edge function parity, migration parity, realtime publication membership, git branch state. First run triggered 6/9 (tool approvals granted).
- **`enrops-efficiency-review`** — Fridays 9am. Reviews past week's sessions for repeating patterns, uncaptured corrections, stale memories, missing automations. Needs first "Run now" to approve tools.

### Figma reskin shipped to prod (separate chat)
- Homepage State 1 (invite-only entry card) live on prod
- Indigo sweep (all action buttons plum->indigo) across admin + instructor portal
- Shared `Chevron` component replacing old expand toggles
- `TimeSavedPage.jsx` new page
- State 2 backlog committed (staging 1 commit ahead of main — doc only, no code diff)

### Edge function parity closed
- `match-afterschool` deployed to staging (v12) to close the last substantive code gap between prod and staging.

## Backlog items saved (post-Italy)
- **S3 storage backup:** Enable versioning/replication for Supabase Storage buckets (91 files not covered by PITR). Walk Jessica through console settings. Memory: `project_enrops_backlog_s3_backup.md`.
- **Tenant folder isolation:** Restructure `org-assets`/`public-assets` to `{org_id}/` folders + add INSERT WITH CHECK RLS policies. Pre-Tenant-2 gate. Memory: `project_enrops_backlog_tenant_folder_isolation.md`.

## Branch state
- `main` = prod deploy (`dfa08cb`)
- `staging` = 1 commit ahead (`f3af9be` — backlog doc only, no code change)

## Calendar / what's next
- **6/9 (today):** BGC sketch was due — check if it landed in another chat.
- **6/10 (tomorrow):** Last build day before vacation. Any remaining pre-vacation items.
- **6/11-6/22:** Jessica on vacation. Consultant break-tests staging. Scheduled tasks run automatically (security Mon 8:07, parity Mon 8:15, efficiency Fri 9:00).
- **6/22-6/29:** BN Digital applies portal Figma designs.
- **July 3:** Alpha launch.

## Open items (not blocking vacation)
- Efficiency review task needs its first "Run now" to pre-approve MCP tools
- After 6/15 audit run: review SKILL.md baselines for new checks (memory reminder saved)
- BGC/Checkr staging setup: post-Italy backlog
- $1 payroll test: confirmed done in prior session
