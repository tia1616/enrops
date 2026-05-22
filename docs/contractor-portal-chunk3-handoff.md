# Contractor portal chunk 3 — wizard build handoff

**You are Claude Code, the build agent. Jessica iterated chunks 1 + 2 specs in claude.ai and I (the previous Claude Code session) built and deployed all of chunk 1 (DB migration) and chunk 2 (14 of 17 edge functions; 3 Stripe ones deferred). Your job is chunk 3: the React wizard that consumes those edge functions.**

Read this whole file before writing any code. Don't ask "want me to start building?" — start.

---

## Critical first move

Before anything else, load these memory files. They contain non-obvious rules and product context that will save you from repeating mistakes the previous session learned the hard way:

- `feedback_build_iteration.md` — **how Jessica and I work together. Read this first.**
- `feedback_workflow.md` — terse responses, no auto-push, never hardcode tenant identity
- `project_enrops.md` — repo + Supabase IDs, branding architecture
- `project_enrops_instructor_portal_scope.md` — **camps-only, adults-only — minors are W-2 in Gusto, not in the portal**
- `project_enrops_contractor_portal_deploy_status.md` — what's deployed, env vars, Checkr staging task
- `project_enrops_districts_table_followup.md` — districts are text in program_locations.district for v1; cleaned up 2026-05-21

If a memory says one thing and this doc says another, ask Jessica.

---

## Where things are

- **Codebase:** `C:\Users\JVorster\Desktop\Projects\enrops` (Vite + React JS + Tailwind v3)
- **Branch:** `contractor-portal` (already pushed to `origin/contractor-portal`). Continue on this branch.
- **Supabase project:** `iuasfpztkmrtagivlhtj`
- **Spec for chunk 3:** `C:\Users\JVorster\Downloads\chunk_3_onboarding_wizard_v3.md` — this is the source of truth for screen contents, validation copy, JSONB shapes, error handling.
- **Visual mockup:** `mockups/contractor-onboarding-wizard.html` (open in browser to see all 8 screens + completion/declined/abandoned/error states)
- **Chunks 1 + 2 specs (for reference, already implemented):**
  - `C:\Users\JVorster\Downloads\chunk_1_database_migration_FINAL (1).md`
  - `C:\Users\JVorster\Downloads\chunk_2_edge_functions_CLEAN.md`

---

## What's already done (don't redo)

### Chunk 1 — live in production

7 new tables in Supabase: `legal_documents`, `contractor_onboarding_status`, `contractor_acknowledgments`, `contractor_agreements`, `contractor_ors_certification`, `contractor_emergency_contacts`, `session_delivery_confirmations`. Plus 7 new columns on `instructors`, the `private` schema with `current_instructor_id()`, sync trigger `trg_sync_onboarding_status`, RLS policies, CHECK constraints, 7 seeded legal documents for J2S (real body text, no placeholders), and a `contractor-documents` storage bucket. Verify schema by running:

```sql
SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'contractor_%' OR table_name = 'legal_documents';
```

### Chunk 2 — 14 of 17 functions deployed

| # | Function | Endpoint | verify_jwt |
|---|---|---|---|
| 1 | `contractor-invite` | `POST /contractor-invite` | true (admin caller) |
| 2 | `checkr-webhook` | `POST /checkr-webhook` | false (HMAC verified) |
| 4 | `submit-ors-certification` | `POST /submit-ors-certification` | true |
| 5 | `submit-agreement` | `POST /submit-agreement` | true |
| 6 | `submit-acknowledgments` | `POST /submit-acknowledgments` | true |
| 7 | `submit-onboarding-declined` | `POST /submit-onboarding-declined` | true |
| 8 | `update-onboarding-step` | `POST /update-onboarding-step` | true |
| 9 | `create-checkr-candidate` | `POST /create-checkr-candidate` | true |
| 11 | `confirm-session-delivery` | `POST /confirm-session-delivery` | true |
| 12 | `session-confirmation-cron` | (cron only) | false (x-cron-secret) |
| 13 | `contractor-onboarding-reminders` | (cron only) | false (x-cron-secret) |
| 14 | `get-legal-document` | `POST /get-legal-document` | true |
| 15 | `request-resume-onboarding` | `POST /request-resume-onboarding` | true |
| 17 | `resend-onboarding-invite` | `POST /resend-onboarding-invite` | false (anti-enum) |

**Deferred (don't touch — Arielle hasn't done Stripe Connect setup yet):**
- Function 3 `stripe-connect-instructor-webhook`
- Function 10 `create-stripe-connect-account`
- Function 16 `refresh-stripe-status`

The wizard's Screen 7 will need to call Function 10 eventually. For now, render Screen 7 with a disabled state + a TODO comment. Document the expected call in code so swap-in is mechanical once Stripe Connect is wired.

### Cross-cutting edge-function contract you MUST honor in the wizard

All instructor-facing edge functions (4, 5, 6, 7, 8, 9, 11, 14, 15) return these standard response codes. **Build a shared `fetchWrapper` that handles all of these centrally.** Per-screen code should only handle 2xx + 4xx-other.

| Status | Body | Wizard action |
|---|---|---|
| 401 | `{ error: 'auth_required' / 'invalid_auth' }` | Redirect to login. If the user just arrived via an expired magic link, navigate to `/error?reason=link_expired`. |
| 403 | `{ error: 'not_an_instructor' / 'forbidden' }` | Redirect to `/error?reason=deactivated` (do NOT bounce to login — they can't fix it by re-auth'ing). |
| 410 | `{ error: 'onboarding_terminated', overall_status, redirect }` | Navigate to the `redirect` field as-is. It points to `/${slug}/onboarding/declined` or `/${slug}/onboarding/abandoned`. |
| 5xx | varies | Show generic "Something went wrong" toast; allow retry. |

---

## Build order (recommended)

### Phase B-1: Foundation (commit + push when done)
1. `src/lib/onboardingSteps.js` — exports `STEP_KEYS` constants matching the 8 step_name values
2. `src/lib/onboardingFetch.js` — shared fetch wrapper with 410/403/401 interception
3. `src/lib/heicConvert.js` — wrapper around `heic2any` (install via `npm install heic2any`); converts HEIC/HEIF → JPEG before upload
4. `src/pages/error/ErrorPage.jsx` — handles `/error?reason=<reason>`. Reasons: `org_misconfigured`, `deactivated`, `link_expired`, default. No tenant branding.
5. `src/pages/onboarding/MagicLinkResend.jsx` — embedded in ErrorPage when `?reason=link_expired`. Anti-enum: always shows "If registered, we sent a link."

### Phase B-2: Routing + auth callback
6. Wire routes in `src/App.jsx`:
   - `/error` → ErrorPage
   - `/:slug/onboarding` → OnboardingRouter
   - `/:slug/onboarding/declined` → DeclinedPage
   - `/:slug/onboarding/abandoned` → AbandonedPage (calls Function 15 on submit)
7. `src/pages/onboarding/OnboardingRouter.jsx` — implements the routing logic from chunk 3 spec lines ~95-130. **HARD-FAIL** on null org slug → navigate to `/error?reason=org_misconfigured`. **HARD-FAIL** on `is_active = false` → navigate to `/error?reason=deactivated`.

### Phase B-3: Screens in order of dependency
8. Screen 1: Welcome (`update-onboarding-step` with `step_name=welcome`) — includes photo upload to `contractor-documents/{instructor_id}/photo_{timestamp}.{ext}` with HEIC conversion
9. Screen 3: ORS certification (`submit-ors-certification`)
10. Screen 8: Emergency + prefs (`update-onboarding-step` with `step_name=emergency_and_prefs`) — districts from cleaned-up `program_locations.district`, JSONB shape `{ districts: [...names] }`. Form sends ordered contacts array; the edge function assigns `is_primary` from position (don't send is_primary from the client).
11. Screen 4: Agreement (`submit-agreement` for write, `get-legal-document` for body_text). Client-side PDF via `@react-pdf/renderer` (npm install needed) — Times New Roman 11pt body / 14pt headers, letter size, 1" margins. PDF is a presentation copy; legal record is in `contractor_agreements.agreement_text_snapshot` (server-snapshotted).
12. Screens 5, 6: Acknowledgments (`submit-acknowledgments` with `step: 'policies'` or `'additional'`)
13. Screen 2: Background check (`create-checkr-candidate`) — opens invitation_url in new tab, then marks step
14. Screen 7: Stripe payment (Function 10 deferred — render with disabled state + a "Will be enabled by June 12" message for now, OR a stub that just marks `stripe_submitted` so testing of later screens can proceed; Jessica's call)
15. Completion screen: reads `contractor_onboarding_status.overall_status` and renders one of 4 variants (complete / pending_background_check / pending_stripe / payouts_disabled)

---

## Things that will burn you if you forget

1. **Never hardcode `/j2s/`.** The slug comes from `organizations.slug` for the instructor's org. The OnboardingRouter resolves it once and passes it down via context or props. If you see `'j2s'` in code, you wrote a bug.

2. **The wizard cannot query `legal_documents` directly.** RLS only allows `org_members` and `platform_admin` to read. Instructors get zero rows. **Always use `get-legal-document` edge function** for body text on Screens 4, 5, 6.

3. **`steps_completed` JSONB keys must match exactly.** Use `STEP_KEYS` constants everywhere. A typo silently breaks the gate check. The 8 keys: `welcome`, `checkr_submitted`, `ors_certification`, `agreement_signed`, `policies_acknowledged`, `additional_acks`, `stripe_submitted`, `emergency_and_prefs`.

4. **Server-render the agreement text.** Function 5 looks up the canonical body_text from `legal_documents` and snapshots that. Do NOT send agreement text from the client. The client sends only `agreement_version`.

5. **Anti-enumeration on `confirm-session-delivery` 403s.** The function returns 403 (not 404) for both missing-confirmation and wrong-instructor. Don't expose the distinction in the UI.

6. **Screen 8 emergency contacts:** form sends an ordered array. Edge function assigns `is_primary = (index === 0)`. Don't send `is_primary` from the client.

7. **Camps only.** Per memory `project_enrops_instructor_portal_scope.md`: no after-school program flow, no Camp Assistants (minors). If anyone asks "what about minor instructors?" — they go through Gusto W-2, not this portal.

8. **Districts are text, not UUIDs.** Per memory `project_enrops_districts_table_followup.md`: `site_preferences` JSONB shape is `{ districts: ["Hillsboro", "Beaverton", ...] }`. The 15 canonical district names came from the 2026-05-21 cleanup of `program_locations.district`. Don't propose a `districts` table — that's a separate refactor.

9. **Mid-session status flip detection:** there is no polling, no realtime channel. Detection is stale-on-next-API-call via the 410 response. The shared fetch wrapper handles this.

10. **HEIC handling:** convert client-side via `heic2any` BEFORE the 2MB size check. iPhone-default HEIC won't render in Chrome/Firefox/Edge if stored as-is.

---

## DB schema highlights (the tables your wizard touches)

Run `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '<name>'` to see exact columns. Quick map:

- **`instructors`** — has new columns: `contractor_tier`, `onboarding_status` (denormalized, kept in sync by trigger; never write directly), `site_preferences` jsonb, `availability` jsonb, `first_aid_cpr_url`, `first_aid_cpr_expires_at`, `photo_url`, `last_resend_requested_at`
- **`contractor_onboarding_status`** — one row per instructor. Read `overall_status`, `current_step`, `steps_completed` JSONB, `checkr_status`, `stripe_connect_status`, `stripe_payouts_enabled`
- **`legal_documents`** — 7 J2S rows seeded. Wizard never queries this directly; goes through Function 14.
- **`program_locations`** — already-existing table. Read `DISTINCT district` for Screen 8 site preferences. Has 47 rows for J2S across 15 districts after the 2026-05-21 cleanup.
- **`organizations`** — read `slug`, `name`, `default_sender_name`, `default_sender_email` as needed.

---

## Env vars status (Supabase Dashboard → Edge Functions → Manage secrets)

Already set (don't touch): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CRON_SECRET`, `CHECKR_PACKAGE_SLUG`.

Pending from Jessica: `CHECKR_API_KEY`, `CHECKR_API_BASE_URL` (her staging-vs-prod decision is open). When she sends, you can set via: `npx --yes supabase secrets set NAME=value --project-ref iuasfpztkmrtagivlhtj`.

Pending from Arielle (deferred): `STRIPE_CONNECT_WEBHOOK_SECRET`. Not needed for chunk 3 build.

---

## Workflow rules (read `feedback_build_iteration.md` for full version)

- Commit in waves (3-5 related files). Summarize the commit.
- **Don't push without Jessica's go-ahead.** After committing, summarize + ask.
- Don't auto-deploy edge functions. Chunk 3 is the wizard, not edge function changes. (If you do need to update an edge function, see the `_shared/` modules in `supabase/functions/_shared/` — instructor.ts, onboardingStep.ts, gateCheck.ts.)
- Tight responses with recommendation + tradeoff. Jessica is non-developer; she wants the pick and the reason, not paint-by-numbers menus.
- Ask precise questions with your best-guess answer + reasoning. One concrete decision at a time. Not 7 questions.
- Never break the user's in-progress work. Already-modified files in this repo when you start: check `git status`; if there are uncommitted changes on other files (e.g., `src/pages/admin/curricula/CurriculumReview.jsx`), don't touch them.

---

## Existing repo conventions to match

- Tenant routing already uses `/j2s/` subpaths in `src/pages/j2s/`. The onboarding pages can sit at `src/pages/onboarding/` (NOT inside `j2s/`) and accept the slug via the route param so they're tenant-agnostic from day one. The route is `/:slug/onboarding`, not `/j2s/onboarding` hardcoded.
- Supabase client at `src/lib/supabase.js` (existing). Tenant helpers at `src/lib/tenants.js`.
- Vite + React JS (not TS for the frontend). Edge functions ARE TypeScript. Don't mix.
- Tailwind v3.
- No router library is set up beyond what's already in `App.jsx` — read it before adding new routes.

---

## First steps when you sit down

1. Read this whole doc.
2. Open the mockup HTML (`mockups/contractor-onboarding-wizard.html`) in a browser and walk through all the screens.
3. Read the chunk 3 spec (`C:\Users\JVorster\Downloads\chunk_3_onboarding_wizard_v3.md`) end-to-end.
4. `cd C:\Users\JVorster\Desktop\Projects\enrops && git checkout contractor-portal && git pull origin contractor-portal`
5. Skim `src/App.jsx`, `src/lib/supabase.js`, `src/pages/j2s/` to understand the existing patterns.
6. Build Phase B-1 (foundation: STEP_KEYS, fetch wrapper, HEIC helper, ErrorPage, MagicLinkResend). Commit, summarize, ask Jessica before pushing.
7. Then Phase B-2 (routing), then B-3 (screens in dependency order).

---

## Open questions to settle EARLY with Jessica (don't guess)

- **Screen 7 (Stripe) interim behavior** — render disabled-with-message, or render a stub that lets the wizard progress past it for testing?
- **Auth callback page** — Supabase magic links land somewhere. Is there an existing auth callback handler? If yes, modify it to route instructors into the wizard. If no, build one.
- **Photo display location** — never specified. Where will the photo eventually surface (admin roster? engagement letters?)? Doesn't block chunk 3 but informs whether HEIC handling is the right call vs. just rejecting HEIC.

---

That's everything. Start with the memory load, then the mockup walkthrough, then code.
