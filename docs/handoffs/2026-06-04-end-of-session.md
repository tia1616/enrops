# End of 2026-06-04 marathon — handoff for next chat

This was a very long single session. The chat covered: continuing yesterday's afterschool roster build, hardening staging into a true prod mirror, standing up a blank-slate Tenant Two org for testing, running a real new-tenant dry-run, and finally fixing a hard multi-tenant blocker in the parent-facing register flow. Everything below is current as of session end on 2026-06-04.

Tomorrow (Friday 2026-06-05) Jessica needs to record sales Looms and print summer instructor materials. Tomorrow-Jessica's calendar is the constraint on tonight's remaining work.

---

## What was shipped to STAGING (nothing on prod yet)

All on the `staging` branch in repo, deployed to `enrops-staging.netlify.app` + Supabase project `mumfymlapolsfdnpewci`.

**Rosters work (the original plan)**
- Afterschool tab on `/admin/rosters` (was hidden / read-only)
- Inline edit of any enrolled student, mirroring the camp roster
- Add a student by hand (offline / partner-provided)
- CSV upload (deterministic column-mapping, mirrors the camp importer)
- New edge fn: `admin-import-program-roster` (status='confirmed' + photo_release=true to satisfy the DB CHECK)
- Delete-from-roster with styled "are you sure" confirm — works on BOTH tabs
- New edge fn: `admin-remove-registration` (money-safe: refuses any reg with a real payment / Stripe intent / paid installment, clears no-action child rows first)
- Refund button pulled from camp roster — refunds belong in the Money tab per Jessica
- Migration `20260604_roster_email_sends_program_id.sql` (program_id column on roster_email_sends + index)

**Email roster modal**
- Self-heals: when a location has no `partner_id` set, auto-links to a same-named partner in the org (unambiguous match only — multiple matches fall through to the manual picker). Only works for exact-name matches.
- Sender domain on `email-program-roster` is now tenant-driven (reads `organizations.default_sender_email` / `sending_domain`). Returns clear `no_sender_configured` error for an unconfigured tenant. **`email-camp-roster` still hardcodes `updates.journeytosteam.com` — fix pending in prod-promote bundle.**

**Partner importer**
- New edge fn `import-partners-parse` parses CSV/XLSX server-side, no AI, no ANTHROPIC_API_KEY needed for file uploads. File never leaves our infra.
- ImportContactsModal rewritten: file uploads use deterministic parse → column-map → review → write. AI demoted to the "Paste text" fallback only (clearly labelled). New tenants no longer need an Anthropic key for the normal spreadsheet flow.
- Deterministic role + partner-type + org-inbox normalization client-side.

**Venue add (program_locations) bugfix**
- `slug` is NOT NULL UNIQUE on `program_locations`; the form never generated one — blocked new-tenant venue creation. Now auto-generates from name + 6-char random suffix.

**HUGE: Multi-tenant parent-facing register flow**
- The biggest finding of the dry-run. `src/pages/j2s/Register.jsx` was hardcoded `const J2S_ORG_ID = '...'`, route was `/j2s/register` only. A second tenant could NOT have collected a single registration.
- Built new `src/layouts/PublicLayout.jsx` that resolves the org from the URL `:slug`, renders J2S brand when slug='j2s' (zero change to live J2S) or Enrops base brand for any other tenant, provides `org` via Outlet context, handles not-found state.
- Refactored `Register.jsx`, `Home.jsx`, `RegisterSuccess.jsx` to read `org` from context (killed `J2S_ORG_ID` / `ORG_SLUG` constants).
- Route changed from `/j2s` to `/:slug` in `App.jsx`. J2S URLs still work because `/j2s` matches `/:slug` with slug='j2s'.
- Edge functions were already org.slug-aware — no changes needed there.
- **Validated end-to-end on staging:** Tenant Two completed a real Stripe test registration via `https://enrops-staging.netlify.app/tenant-two-test/register?program=...` with card 4242 4242 4242 4242. Receipt sent, registration row written, status='paid'.

---

## Staging environment hardened (was: barely a mirror)

Discovered partway through the day that staging had only **9 of prod's 68 edge functions** and **2 of 21 secrets**. The mirror was a lie — every "broken" feature was actually a missing function or secret. Fixed:

- Deployed all ~64 repo edge functions to staging in one pass.
- Re-deployed 15 webhook/cron functions with `verify_jwt=false` to match prod.
- Set `ANTHROPIC_API_KEY` (Jessica's key — **consider rotating since pasted in chat**), `CRON_SECRET`, `MARKETING_UNSUBSCRIBE_SECRET`.
- Locked staging's `get_campaign_recipients(uuid)` against anon/authenticated (children's-PII function — was open on staging while consultant had access; prod was already locked).
- Enabled Realtime publication on `public.curriculum_documents` (per-database, doesn't travel in schema dumps — was the real cause of "curriculum stuck on first step" earlier).
- New memory: `feedback_staging_realtime_parity.md` — must diff `pg_publication_tables` after any future Supabase clone.

**Still NOT set on staging (intentional or pending):**
- `RESEND_API_KEY` (intentional — email send OFF on staging because Tenant Two has real partner contacts loaded; we don't want accidental sends)
- Checkr keys (only needed when testing background check flow)
- Google OAuth keys (only needed when testing Drive import / Google login)
- Stripe Connect platform key (only needed when testing instructor payouts)

---

## Tenant Two (the blank-slate test org)

Live in staging only. Acceptance gate for any real second tenant before they onboard.

- org_id `b177a0ea-32c6-45c9-82ac-cbb7261c2dee`, slug `tenant-two-test`
- Owner login: `owner@tenant2.staging.enrops.test` / `Tenant2Test`
- Built a full new-tenant onboarding session against it. Validated working: curriculum upload + AI extract, partner contacts import (Jessica's real J2S spreadsheet), venue add, cycle create, program wizard, program publish (`status='open'`), parent register URL, Stripe checkout end-to-end.

---

## Prod state at session end

**Prod has been TOUCHED IN ONE WAY ONLY today:** I verified `get_campaign_recipients` is locked there (it is — no emergency).

Everything else above is on staging waiting for Jessica's go on a single bundled promotion. The promotion bundle:

1. Apply migration `20260604_roster_email_sends_program_id.sql` to prod
2. Deploy edge fns to prod: `admin-import-program-roster`, `admin-remove-registration`, `import-partners-parse`, `email-program-roster` (updated)
3. **Apply the same tenant-driven-sender fix to `email-camp-roster`** (currently still hardcodes `updates.journeytosteam.com`) and deploy
4. Merge `staging` → `main`, push, deploy-verify on enrops.com
5. **One-time data backfill on prod:** link every `program_locations` row to its same-named active partner in the same org (closes the location↔partner gap for J2S's existing ~18 partners with contacts so Mount Scott contacts surface immediately instead of one-school-at-a-time via the self-heal). Do NOT copy the synthetic `@example.test` contacts I added to staging Mount Scott — those are test-only.

---

## Top findings still open (from the Tenant 2 dry-run)

Backlog file `docs/backlog.md.md` has ~20 items added today. Top blockers for any real second tenant:

1. **New Settings architecture as a sub-nav tree** — `Profile / Brand / Registration / Waivers / Pricing / Communications / Team / Billing`. Currently no admin UI exists for any of: brand, registration form fields, waivers, "how did you hear" options. This is where a new tenant configures everything in one place.
2. **Registration is LOCKED until tenant completes Settings.** Decision from Jessica end-of-session 2026-06-04: a tenant cannot open registration unless Settings is filled in. Each canonical-workflow step gates the next.
3. **Per-tenant public-site branding pass.** Minimum-viable shipped today (PublicLayout switches between J2S brand and Enrops base brand). Right pass: read `org_branding.primary_color/accent_color` + `organizations.name/contact_email/contact_phone/tagline` and render fully tenant-branded shell. Also `Home.jsx`, register step components, `Login.jsx`, `Dashboard.jsx` all still leak J2S Tailwind classes.
4. **Partners ↔ locations architectural split** — bites in 3 places (email modal contacts, partner picker, venue create). In Jessica's mental model "a school is one thing"; in the schema it's two rows. Right fix is unification for school-type partners.
5. **Canonical operator workflow gating** — every operator surface should know its step in the order (curricula → programs → registration/marketing → district calendars → facilities → instructor survey → matching → automations → close-to-start marketing → roster email) and gate to the prereq + push to the next step. Currently every save dumps the operator at a dead end.

---

## Standing rules / memories added today

- `feedback_staging_realtime_parity.md` — diff `pg_publication_tables` after any Supabase clone
- `project_enrops_canonical_operator_workflow.md` — Jessica's 10-step in-term order
- `project_enrops_partners_locations_link.md` — split bites in 3 surfaces, treat as one architectural fix
- (Yesterday's `feedback_mirror_sibling_dont_guess.md` was already in memory)

---

## Decisions / principles set tonight (NEW)

- **Registration is locked until Settings complete.** Tenant cannot open reg without finishing Profile / Brand / Registration form fields / Waivers config.
- **Settings is sub-nav under one Settings area**, not top-level tabs.
- **Don't auto-derive** in operator-facing copy ("Auto-derived" reads as dev jargon — use "Here's how we'll number the weeks for you").
- **Camp vs Afterschool unit** is per-WEEK vs per-PROGRAM. Per-week granularity is camp-only; afterschool instructors commit to a whole program for the term.
- **Cycle envelope ≠ program duration.** Envelope is ~14 weeks (covers all districts' starts/ends); each afterschool program inside is ~8 sessions.
- **"Ask once, reuse everywhere"** pattern: min/max students, pay rates, withdrawal fees, etc. — asked during onboarding, stored on `organizations`, auto-filled on every program-creation surface.
- **Import partners (not "Import schools").** Schools, Parks & Rec, churches, community orgs are all partner types. P&R can have multiple locations under one partner.

---

## What tomorrow's Looms need from the platform

Jessica is recording sales Looms Friday 6/5 demonstrating Enrops to potential operators. The platform she records against is **prod (enrops.com)** — Tenant 2 staging is the proof-point that multi-tenant works, not the demo subject.

Likely surfaces in the Loom:
- The Program Wizard at `/admin/programs/new` (shipped earlier in the week, currently on prod)
- The afterschool roster (NOT yet on prod — would need promotion)
- Email-a-roster-to-partner (NOT yet on prod, also blocked on the same)
- Marketing campaign builder (already on prod)
- Curriculum upload + AI extract (already on prod)
- The new `/<slug>/register` parent-facing flow (NOT yet on prod — but J2S's existing `/j2s/register` works regardless)

**If the rosters work is to be demoed, the prod promotion needs to happen tonight.** If it's not in the Loom, the promotion can wait. Check with Jessica which surfaces she's recording before deciding.

---

## How to start the next chat

1. Read this doc first.
2. Read `docs/backlog.md.md` (top section, dated 2026-06-04 entries).
3. Read the three memory files added today (`feedback_staging_realtime_parity`, `project_enrops_canonical_operator_workflow`, `project_enrops_partners_locations_link`).
4. Read `docs/handoffs/2026-06-04-july3-launch-plan.md` for the broader July 3 alpha context — that's still the operative deadline; nothing today changed it.
5. Confirm with Jessica: was the prod-promotion bundle pushed last night? Are tomorrow's Looms recorded? What's the next priority?
6. Do NOT touch prod without Jessica's explicit go on the specific change.

The dry-run is the acceptance gate for tenant #2 onboarding. The Tenant Two org in staging stays around as the regression-test environment.
