# Staging links & test reference

**Last updated:** 2026-06-23

Quick reference for testing on staging. Staging has its own Supabase + Netlify and
synthetic data — it does **not** touch prod. Safe to register, refund, poke at anything.

## Sites

| What | URL |
|------|-----|
| Staging site root | https://enrops-staging.netlify.app |
| Production (for contrast) | https://enrops.com |
| Netlify project (admin) | https://app.netlify.com/projects/enrops-staging |

## Parent-facing (J2S, slug `j2s`)

| Page | URL |
|------|-----|
| Camp catalog (parent start here) | https://enrops-staging.netlify.app/j2s |
| Register (needs a camp picked from the catalog) | https://enrops-staging.netlify.app/j2s/register |
| Parent login | https://enrops-staging.netlify.app/j2s/login |
| Parent dashboard | https://enrops-staging.netlify.app/j2s/dashboard |

## Operator / staff

| Page | URL |
|------|-----|
| Admin login | https://enrops-staging.netlify.app/admin/login |
| Admin home | https://enrops-staging.netlify.app/admin |
| Instructor portal | https://enrops-staging.netlify.app/j2s/instructor (or `/instructor`) |
| Contractor onboarding | https://enrops-staging.netlify.app/j2s/onboarding |

## Tenant 2 (Cascade Enrichment Co., slug `tenant-two-test`)

| Page | URL |
|------|-----|
| Catalog | https://enrops-staging.netlify.app/tenant-two-test |

## How to run a test parent registration

1. Start at the **catalog** (`/j2s`), not `/register` directly — register needs a camp
   selection passed from the catalog or it loads empty.
2. Pick a camp where **`runs_own_registration = false`** (native Enrops checkout). The
   `runs_own_registration = true` camps bounce to an external provider link and don't
   test the native flow.
3. Use a Stripe **test card**: `4242 4242 4242 4242`, any future expiry, any CVC.
   ✅ **Verified 2026-06-23:** staging runs on Stripe **test mode** — a checkout session
   returned `cs_test_…` (test key `sk_test_`). Staging's J2S Connect account
   (`acct_1Tg9aE…`) is also separate from prod's (`acct_1TcBGh…`). No real charges.
4. A real test enrollment row is written, plus an intelligence/abandoned-registration
   event if you bail mid-flow. Expected — staging is synthetic.

## Backing project IDs

- Staging Supabase ref: `mumfymlapolsfdnpewci`
- Prod Supabase ref: `iuasfpztkmrtagivlhtj`
- J2S org (staging): `1adf10ad-d091-4aa0-82e3-af331468ea2b`
