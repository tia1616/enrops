# Tenant 2 blank-slate new-tenant test (staging)

Created 2026-06-04. Purpose: prove the whole stack — onboarding, partner import,
roster, roster email — works for a brand-new tenant with ZERO data, no J2S
assumptions, nothing hardcoded.

## The test tenant

A blank org `Tenant Two Test Academy` (slug `tenant-two-test`,
org_id `b177a0ea-32c6-45c9-82ac-cbb7261c2dee`) was created in the **staging**
Supabase project (`mumfymlapolsfdnpewci`). It has zero partners, contacts,
programs, locations, curricula — a true clean slate.

Login at https://enrops-staging.netlify.app/admin/login (email/password, not Google):

- email: `owner@tenant2.staging.enrops.test`
- password: `Tenant2Test`

(Login verified working against staging GoTrue.)

## One setup step needed first: ANTHROPIC_API_KEY

The partner-import "extract" step uses Claude to parse the spreadsheet. Staging
does NOT have an `ANTHROPIC_API_KEY` set, so the import will fail at the extract
step until one is added. Either:
- paste the key to Claude and it sets it via `supabase secrets set` on staging, OR
- add it in the staging dashboard: Project Settings -> Edge Functions -> Secrets.

## Known caveats (expected, not bugs)

- **Email won't actually deliver on staging** — no `RESEND_API_KEY` is set
  (intentional isolation). The roster-email test validates that the right
  contacts resolve + the preview renders; real delivery is only verifiable in prod.
- **Sender domain is hardcoded** to `updates.journeytosteam.com` (J2S) in the
  roster-email function. For tenant 2 a real send would misbrand — a known
  multi-tenant gap to fix before a second tenant ships.

## Test script

1. Log in as Tenant Two (above). Confirm Programs / Rosters / Contacts are empty.
2. **Add a location** (Programs -> new program -> "+ Add a new location"). Name it
   like a real school you'll have a partner for, e.g. `Lincoln Elementary`.
3. **Add a curriculum** ("+ Add a new curriculum").
4. **Create a program** at that location via the wizard.
5. **Import partner contacts** (Contacts -> import). Use a small slice of your
   real spreadsheet OR a test file. IMPORTANT: make sure one partner's name
   matches the location name exactly (`Lincoln Elementary`) so the self-heal can
   link them.
6. **Add a student by hand** to the program roster (Rosters -> Afterschool ->
   expand -> Add / upload) so the roster isn't empty.
7. **Email the roster** -> confirm the partner's contacts appear (the location
   auto-links to the same-named partner). The actual send will error/no-op on
   staging (no email service) — that's expected.

## What we're looking for

- Can a brand-new tenant get from nothing to a roster email with NO J2S data and
  no manual DB surgery?
- Where does onboarding feel rough / what's missing (the prereq steps,
  location/curriculum creation, partner linking)?
- Does anything assume J2S specifically?

Capture anything that breaks or feels wrong — that's the deliverable.
