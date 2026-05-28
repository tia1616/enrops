# Stripe Connect Implementation Spec v2

**Date:** 2026-05-27
**Status:** Ready to build (supersedes 2026-05-27 v1 handoff)
**Goal:** Route J2S fall registration payments through Enrops Stripe Connect with platform fee, using J2S as dogfood tenant

---

## 0. Why this rewrite exists

v1 of the handoff had a fatal inconsistency between **Express Connect** (its Section 2/4/7 narrative) and **Standard Connect** (Chunk 6's OAuth-with-`ca_...`-client-id implementation). It also left several real issues unspecified (refund mechanics, fee-freeze timing, webhook idempotency, OAuth CSRF binding, `stripe_account_id` write-guard) and one inconsistency between Chunk 1 and Chunk 7 over who can toggle `fee_pass_through`.

v2 resolves all of those. Decisions baked in:

| Issue | v2 decision |
|---|---|
| Connect type | Express (operators do not have their own Stripe accounts) |
| `ca_Ub6d...` Connect Client ID | Unused — Express does not use OAuth client IDs |
| `stripe_account_id` writability | Locked to platform admin / service_role via trigger |
| `fee_pass_through` writability | Editable by org owner/admin (Chunk 7 wins) |
| Three rate columns writability | Locked to platform admin / service_role via trigger |
| Webhook idempotency | Per-org `stripe_last_account_event_id` column, mirrors instructor side |
| Refund flow | Out of scope; Stripe dashboard only. Documented gap. |
| Partial refund fee math | Stripe default — keep full application fee. Acceptable for v1. |
| Fee freeze | Snapshot at first successful charge (new columns on `registrations`); installments 2/3 reuse the snapshot |
| Statement descriptor | Per-tenant; new `statement_descriptor` column on `organizations` |
| Pass-through display at checkout | Deferred — J2S is absorb mode and no tenant needs pass-through today. Documented gap. |
| `transfer.created` webhook event | Dropped from event list. No handler needed. |
| `stripe_account_status` mapping | Defined explicitly in Chunk 5 |
| `platform_fee_cents` / `platform_monthly_cents` (deprecated cols) | Left in place, unused; cleanup deferred |

---

## 1. Integration map — what already exists

Verified by grepping the codebase 2026-05-27:

**Existing instructor-side Connect** (separate Stripe account, do not confuse with this build):

- Lives on a separate Stripe account (env: `STRIPE_INSTRUCTOR_PLATFORM_KEY`, webhook secret: `STRIPE_CONNECT_WEBHOOK_SECRET`).
- Stores `acct_` IDs on `contractor_onboarding_status.stripe_connect_account_id`.
- Webhook: `stripe-connect-instructor-webhook`.
- Login link helper: `create-stripe-express-login-link` (instructor-scoped).
- Shared status helper: `supabase/functions/_shared/stripeAccountStatus.ts`.

This build does NOT touch any of the above. Operator-Connect is a parallel, independent system on the original Enrops Stripe account.

**Operator-side state on `organizations` — currently unused by any code:**

Columns `stripe_account_id`, `stripe_account_status`, `stripe_charges_enabled`, `stripe_payouts_enabled`, `platform_fee_cents`, `platform_monthly_cents`, `platform_plan` exist on `organizations` but no edge function or frontend reads or writes any of them. They are greenfield. We can shape them as this spec defines.

**Only writer of `organizations` today:** `regenerate-email-logo` (writes `logo_email_url`). One writer. Trigger we add for fee/Connect column protection will not interfere.

**Front-end (`src/`):** zero direct writes to `organizations`. All org mutation goes through edge functions.

---

## 2. Credentials and IDs

```
Original Enrops Stripe account (operator-Connect platform):
  Secret key env: STRIPE_SECRET_KEY  (already configured)
  Webhook secret env: STRIPE_WEBHOOK_SECRET  (already configured)

J2S standalone Stripe account: acct_1TZhD8ILl02bk33x
  Reference only. NOT used as a connected account ID. The Express flow will
  generate a NEW acct_ ID for J2S as a connected account under Enrops.
  Database stores whatever the Express onboarding flow produces.

J2S organization ID (Supabase): 1adf10ad-d091-4aa0-82e3-af331468ea2b
Enrops organization ID:         f45cf2af-fcd5-4c0a-a8c2-0d5ad822292c
Supabase project ID:            iuasfpztkmrtagivlhtj
```

**Stripe Connect Client ID `ca_Ub6d523muIZXLwOhFR1VWcz9VoKX6BQT`** captured in v1 is **dropped from this spec**. Express does not use OAuth client IDs. Operator does not need to add `STRIPE_CONNECT_CLIENT_ID` as a Supabase secret. Chunk 8 (the v1 secret step) is gone.

---

## 3. Stripe dashboard configuration (Jessica — manual)

These must be done in the **Enrops** Stripe account (the one whose secret is in `STRIPE_SECRET_KEY`), not the J2S-instructor Stripe account.

1. **Confirm Connect platform settings (already done per v1):**
   - Funds flow: Buyers purchase from platform (destination charges)
   - Payouts: Sellers paid out individually
   - Account creation: Onboarding hosted by Stripe → **Express**
   - Account management: Express Dashboard
   - Liability: Platform (Enrops) handles refunds/chargebacks

2. **Webhook events** — add to the existing platform webhook endpoint:
   - `account.updated` *(Connect events flavor)*
   - `account.application.deauthorized` *(Connect events flavor)*
   - The existing endpoint must be configured to "Listen to events on Connected accounts" (a checkbox in the endpoint config). If it currently only listens to platform events, change that setting; do not create a second endpoint.

3. **No OAuth redirect URI** — Express uses Account Links, not OAuth. Skip the v1 "Connect → Settings → Integration → Redirects" step entirely.

4. **No new Supabase secrets needed** — Express uses the existing `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.

5. **Manual bank transfer of $3,320 to J2S** — outside Stripe, anytime. Covers the 13 grandfathered pre-Connect registrations. Not a code blocker.

---

## 4. Database schema (final)

Single migration: `20260527_organizations_stripe_connect_fee_config.sql` (already written; needs the schema additions below before applying).

### 4a. `organizations` — new columns

| column | type | default | notes |
|---|---|---|---|
| `platform_fee_card_pct` | NUMERIC(5,4) NOT NULL | 0.02 | Locked column |
| `platform_fee_ach_pct` | NUMERIC(5,4) NOT NULL | 0.005 | Locked column. ACH not accepted today (card only); column is forward-looking but the rate field stays so we don't migrate later. |
| `platform_fee_cap_cents` | INTEGER NOT NULL | 500 | Locked column |
| `fee_pass_through` | BOOLEAN NOT NULL | true | Editable by org owner/admin |
| `statement_descriptor` | TEXT NULL | NULL (falls back to platform default) | Stripe bank statement string. 5-22 chars, ASCII, uppercased automatically; no `< > " \` chars. Per-tenant. |
| `stripe_last_account_event_id` | TEXT NULL | NULL | Webhook idempotency. Mirrors instructor pattern. |

### 4b. `organizations` — CHECK constraints

- `chk_fee_card_pct` — rate in [0, 1]
- `chk_fee_ach_pct` — rate in [0, 1]
- `chk_fee_cap_cents` — non-negative
- `chk_stripe_account_status` — value in (`not_connected`, `onboarding`, `active`, `disconnected`, `restricted`)
- `chk_statement_descriptor_shape` — when not null, length 5..22 AND matches `^[A-Z0-9 .,\-]+$` after uppercase normalization (Stripe-safe charset)

### 4c. `organizations` — write-guard trigger

`BEFORE UPDATE` trigger `guard_organizations_locked_columns` raises ERRCODE `42501` when any of the following columns changes AND the caller is neither service_role, direct-DB context, nor a platform admin:

- `stripe_account_id` *(new in v2 — payout-theft prevention)*
- `platform_fee_card_pct`
- `platform_fee_ach_pct`
- `platform_fee_cap_cents`

`fee_pass_through` and `statement_descriptor` are NOT guarded — org owner/admin edits these via the Finances tab.

Bypass conditions:
- `auth.role() IS NULL` → direct DB / migration / pg_cron context
- `auth.role() = 'service_role'` → edge functions
- `public.is_platform_admin()` → Enrops staff (Jessica, Arielle if added)

### 4d. `registrations` — new columns (fee snapshot)

| column | type | default | notes |
|---|---|---|---|
| `platform_fee_rate_at_charge` | NUMERIC(5,4) NULL | NULL | Set when the first payment for the registration succeeds. Reused by installments 2/3. |
| `platform_fee_cap_cents_at_charge` | INTEGER NULL | NULL | Same lifecycle as above. |
| `platform_fee_payment_method` | TEXT NULL | NULL | `card` or `us_bank_account` — which side of the rate config was used. |

Snapshot writer: `stripe-webhook` on `checkout.session.completed` (Chunk 5).
Snapshot reader: `process-installments` for installments 2 and 3 (Chunk 4).

### 4e. J2S seed (one-time)

```sql
UPDATE organizations
SET
  platform_plan    = 'free',
  fee_pass_through = false
WHERE id = '1adf10ad-d091-4aa0-82e3-af331468ea2b';
```

`stripe_account_id` is NOT seeded — the Express onboarding flow populates it (Chunk 6). The J2S UUID is hardcoded once here as a one-time bootstrap of the dogfood tenant; this is acceptable because it's a single seed UPDATE, not application logic. Future tenants self-configure via the UI.

### 4f. RLS — no changes

Existing `members_update_own_org` policy stays. The new trigger does the column-level protection that RLS can't express cleanly.

---

## 5. Fee calculation rules

### Helper: `computePlatformFee`

```ts
function computePlatformFee(
  amountCents: number,
  paymentMethodType: 'card' | 'us_bank_account',
  org: { platform_fee_card_pct: number; platform_fee_ach_pct: number; platform_fee_cap_cents: number }
): number
```

Returns the platform fee in cents:
- `0` when `amountCents <= 0`
- `min(round(amountCents * rate), cap)` otherwise
- `rate = card_pct` if card, `ach_pct` if us_bank_account
- Math.round, not Math.floor (handout v1 specified Math.round)

### Unit tests (required, same as v1)

| amount | pmt | rate | cap | expected | reason |
|---|---|---|---|---|---|
| $275 | card | 2% | $5 | 500 | cap |
| $200 | card | 2% | $5 | 400 | below cap |
| $250 | card | 2% | $5 | 500 | exactly cap |
| $100 | ACH | 0.5% | $5 | 50 | ACH rate |
| $0 | card | 2% | $5 | 0 | zero amount |
| $1 | card | 2% | $5 | 0 | rounds to 0 |

### Fee snapshot rule (resolves v1's freeze ambiguity)

On `checkout.session.completed` for a registration's **first payment**:
1. Look up the registration's `organizations` row.
2. Compute the fee using the rate config in effect at this moment.
3. Write `platform_fee_rate_at_charge`, `platform_fee_cap_cents_at_charge`, `platform_fee_payment_method` to every registration in the charge.

On any subsequent charge (installments 2/3, cron):
1. Read the snapshot off the registration. If null (legacy/edge case), fall back to current org config and log a warning.
2. Compute fee with the snapshotted rate + cap, not the current org config.
3. This makes the cron's Stripe idempotency key safe even if Jessica changes the rate between installment 1 and 3.

### Per-installment vs upfront

Each installment is its own PaymentIntent → its own `application_fee_amount` → its own cap. A $275 program split into 3 installments of ~$92 each yields 3 × min($92 × snapshot_rate, snapshot_cap) ≈ $5.50 total fees vs. $5 for a single upfront charge. Difference of $0.50 absorbed by J2S (in absorb mode) or shown to parent (in pass-through). Documented; not a bug.

---

## 6. Build chunks

### Chunk 1 — Database migration

File: `supabase/migrations/20260527_organizations_stripe_connect_fee_config.sql`

Current state: written for v1, needs three additions before applying:
1. Add `statement_descriptor` and `stripe_last_account_event_id` columns to `organizations`.
2. Add `platform_fee_rate_at_charge`, `platform_fee_cap_cents_at_charge`, `platform_fee_payment_method` columns to `registrations`.
3. Extend the existing `guard_organizations_locked_columns` trigger to also guard `stripe_account_id`.
4. Add the statement_descriptor shape CHECK constraint.

### Chunk 2 — `computePlatformFee` helper + unit tests

File: `supabase/functions/_shared/computePlatformFee.ts` plus tests under `supabase/functions/_shared/__tests__/`.

Pure function (no I/O), per Section 5. Tests run via Deno test runner — confirm with `deno test supabase/functions/_shared/__tests__/computePlatformFee.test.ts`. No drop-in test framework required.

### Chunk 3 — Wire `create-checkout` to Connect

File: `supabase/functions/create-checkout/index.ts`.

Both the standard path (line 262) and the installments path (line 194) get the same treatment:

1. Before creating the Checkout Session, look up the registration's org:
   ```ts
   const { data: org } = await admin
     .from('organizations')
     .select('stripe_account_id, stripe_charges_enabled, platform_fee_card_pct, platform_fee_ach_pct, platform_fee_cap_cents, fee_pass_through, statement_descriptor')
     .eq('id', orgId)
     .single();
   ```
2. **Connect-gated path** (`org.stripe_account_id && org.stripe_charges_enabled`):
   - Compute fee via `computePlatformFee(amount, 'card', org)`.
   - Set `payment_intent_data.application_fee_amount` and `payment_intent_data.transfer_data.destination`.
   - Set `payment_intent_data.statement_descriptor_suffix` from `org.statement_descriptor` (or fall back to a sanitized form of `org.name`).
3. **Fallback path** (no `stripe_account_id` OR `stripe_charges_enabled = false`):
   - Behave exactly as today. Direct charge to Enrops. **Log a WARN** with the org_id when `stripe_account_id IS NOT NULL && stripe_charges_enabled = false` so a half-configured org doesn't fall through silently.

Pass-through display: **deferred**. When `fee_pass_through = true`, the current code still charges the base price and Enrops still keeps the application fee (which means the operator absorbs it). This is fine because no tenant has `fee_pass_through = true` today; J2S is explicitly absorb. Add a TODO comment in the code linking to this spec's Section 9. Do not block the build on it.

### Chunk 4 — Wire `process-installments` to Connect

File: `supabase/functions/process-installments/index.ts`.

The cron already fetches `organizations` for `alert_email` (line 161). Extend the select to include `stripe_account_id`, `stripe_charges_enabled`. **Do NOT** read the fee config off the org — instead read the snapshot off the registration (Section 5).

For each group, before `stripe.paymentIntents.create()`:
1. Read `platform_fee_rate_at_charge`, `platform_fee_cap_cents_at_charge`, `platform_fee_payment_method` from one of the active registrations (they should all match; assert).
2. If snapshot is null AND `org.stripe_account_id && org.stripe_charges_enabled`: compute fee from current org config, log a warning that we're using fresh rates instead of snapshot.
3. If `org.stripe_account_id && org.stripe_charges_enabled`: add `application_fee_amount` (from snapshot) + `transfer_data.destination = org.stripe_account_id` to the PaymentIntent params.
4. Otherwise: charge directly (current behavior).

Idempotency key stays the same (`installment_group_<sorted_ids>`). Because the fee comes from the snapshot rather than current org config, Stripe's amount-match retry check is safe.

### Chunk 5 — Webhook handlers in `stripe-webhook`

File: `supabase/functions/stripe-webhook/index.ts`.

Add handlers for:

**`checkout.session.completed`** — extend the existing handler to also write the fee snapshot to all registrations covered by this session. Compute fee with current org config; write `platform_fee_rate_at_charge`, `platform_fee_cap_cents_at_charge`, `platform_fee_payment_method` to the registrations. Idempotent (re-running the webhook re-writes the same values).

**`account.updated`** — NEW. Operator's connected account state changed.
1. Get `account.id` from the event.
2. Look up `organizations` by `stripe_account_id = account.id`. If no match, 200 no-op (could be a stale account or different env).
3. Idempotency check: if `stripe_last_account_event_id = event.id`, 200 no-op.
4. Apply status mapping:

   | Stripe state | Our `stripe_account_status` |
   |---|---|
   | `charges_enabled && payouts_enabled` | `active` |
   | `details_submitted && !charges_enabled && requirements.disabled_reason` | `restricted` |
   | `details_submitted && !charges_enabled` | `onboarding` (Stripe still verifying) |
   | `!details_submitted` | `onboarding` (operator hasn't completed form) |
   | previously `active`, now `!charges_enabled` | `restricted` (regression — alert) |

5. Write `stripe_charges_enabled`, `stripe_payouts_enabled`, `stripe_account_status`, `stripe_last_account_event_id`.
6. On regression (was `active`, now anything else): email org's `alert_email` so a human knows charges are paused.

**`account.application.deauthorized`** — NEW. Operator clicked "Disconnect from Enrops" in their Express Dashboard.
1. Get `account.id` from the event payload.
2. Find the org by `stripe_account_id`.
3. Set `stripe_account_status = 'disconnected'`, `stripe_charges_enabled = false`, `stripe_payouts_enabled = false`.
4. Email `alert_email`.
5. Do NOT null out `stripe_account_id` — keep it for audit. Future re-connect would create a new acct_ ID anyway.

### Chunk 6 — Express onboarding edge function (was: OAuth callback)

NEW file: `supabase/functions/stripe-connect-onboard/index.ts`.

**Auth:** JWT from authenticated user. Must be an org owner/admin of the org being onboarded (verify via `org_members` and `role IN ('owner', 'admin')`). Reject otherwise.

**Inputs:** `{ org_id, return_url, refresh_url }` (return_url and refresh_url come from the frontend, point back to Finances tab).

**Flow:**
1. Load org by `org_id`. Confirm caller is owner/admin (RLS does this; double-check in code).
2. If `org.stripe_account_id IS NULL`:
   - Call `stripe.accounts.create({ type: 'express', country: 'US', email: org_admin_email, business_type: 'company', capabilities: { card_payments: { requested: true }, transfers: { requested: true } }, metadata: { enrops_org_id: org_id } })`.
   - Write `stripe_account_id` (via service_role; bypasses the trigger) and set `stripe_account_status = 'onboarding'`.
3. Call `stripe.accountLinks.create({ account: org.stripe_account_id, refresh_url, return_url, type: 'account_onboarding' })`.
4. Return `{ url: accountLink.url }` to frontend.

**No OAuth state needed.** Express Account Links carry their own signed session; there is no third-party callback for us to validate. CSRF is a non-issue because the only "callback" is Stripe sending the user back to `return_url` with no parameters — we re-query our own DB for state.

**Idempotency:** if the org already has `stripe_account_id`, do NOT call `accounts.create` again — just generate a new Account Link for the existing account (handles the "tab closed, restart onboarding" case).

### Chunk 7 — Finances tab in admin portal

Route: `/admin/finances` (new).

**Not-connected state** (`stripe_account_id IS NULL`):
- Card: "Get paid through Enrops"
- CTA: "Connect Stripe" button → calls `stripe-connect-onboard` edge fn with `return_url='/admin/finances?onboard=return'` and `refresh_url='/admin/finances?onboard=refresh'`.
- On response, redirect to `accountLink.url`.

**Onboarding state** (`stripe_account_id NOT NULL && !stripe_charges_enabled`):
- Card: "Stripe is verifying your account"
- CTA: "Continue setup" button → calls `stripe-connect-onboard` again (returns a fresh Account Link for the existing account).
- Status helper text.

**Connected state** (`stripe_charges_enabled && stripe_payouts_enabled`):
- Banner: "Connected to Stripe ✓"
- Fee display (read-only): "Platform fee: 2% card, $5 cap. Enrops keeps this; the rest is yours."
- Fee mode toggle:
  - `fee_pass_through = false` (current J2S): "Your organization absorbs the platform fee. Parents see the base price."
  - `fee_pass_through = true`: "Parents see an extra service fee at checkout."
  - Toggle gated to `org_members.role IN ('owner', 'admin')`. Confirmation modal when flipping to pass-through: "Parents will see an extra service fee at checkout."
  - Writes directly to `organizations.fee_pass_through` via supabase-js. RLS allows it; the trigger does not guard it.
- Statement descriptor field (editable, owner/admin only):
  - Input box, 5-22 chars, ASCII validation client-side and via CHECK constraint server-side.
  - Default placeholder: sanitized version of `org.name` uppercased.
  - "What is this?" tooltip: "The text parents see on their bank statement when they pay you. Stripe uppercases this automatically."
- "Open Stripe Dashboard" button → calls a new edge function (Chunk 6b below) that returns an Express login link.

**Restricted state** (`stripe_account_status = 'restricted'`):
- Alert banner: "Stripe paused your account. Click 'Continue setup' to provide more info."
- Same button as onboarding state.

**Disconnected state**:
- Banner: "Stripe is disconnected. Reconnect to start receiving payments again."
- Same as not-connected state (reconnect creates new acct_ ID per Stripe).

Frontend reads org status via existing supabase-js client + RLS (any org member can SELECT the org row).

### Chunk 6b — Operator Express login link

NEW file: `supabase/functions/create-stripe-operator-login-link/index.ts`.

Parallel to the existing `create-stripe-express-login-link` (which is instructor-scoped on a different Stripe account). Uses `STRIPE_SECRET_KEY` and reads `stripe_account_id` from `organizations`. Returns a short-lived login URL.

Auth: org member of the requested org.

### (No Chunk 8)

The v1 "add `STRIPE_CONNECT_CLIENT_ID` Supabase secret" step is gone. Express doesn't need it.

---

## 7. End-to-end flows (every clickable thing)

### Flow A — First-time operator onboarding (J2S dogfood test)

1. Jessica logs in to enrops.com admin (as J2S org).
2. Clicks "Finances" in the admin nav.
3. Sees not-connected state. Clicks "Connect Stripe".
4. Browser POSTs to `stripe-connect-onboard` → receives `{ url }` → `window.location.href = url`.
5. Stripe-hosted Express onboarding loads (Stripe form: business type, identity, bank account).
6. Jessica/Arielle fills it out. Stripe redirects to `/admin/finances?onboard=return`.
7. Finances tab re-renders. Backend webhook fires `account.updated` independently; status flips to `active` within seconds.
8. Tab now shows connected state. Statement descriptor field, fee mode toggle, Stripe Dashboard button all clickable.

### Flow B — Parent registers + pays first installment

1. Parent fills J2S registration form → clicks "Pay".
2. Frontend POSTs to `create-checkout`.
3. Edge fn looks up J2S → sees `stripe_account_id` set, `stripe_charges_enabled = true` → builds Checkout Session with `application_fee_amount = $5` (capped), `transfer_data.destination = J2S_acct_id`, `statement_descriptor_suffix = "JOURNEYTOSTEAM"`.
4. Parent enters card → submits → Stripe redirects to success URL.
5. `stripe-webhook` receives `checkout.session.completed`:
   - Marks `registrations.status = 'confirmed'`, `payment_status = 'paid'` (existing).
   - **Writes fee snapshot** to `platform_fee_rate_at_charge = 0.02`, `platform_fee_cap_cents_at_charge = 500`, `platform_fee_payment_method = 'card'` on each registration in the session.
   - Creates `installments` rows for installments 2 and 3 (existing).
6. Money on Stripe: parent paid $275 → Enrops platform balance shows $5 application fee, J2S connected balance shows $270 (after Stripe's own ~$8 processing fee, which J2S absorbs as the operator).

### Flow C — Daily installment cron

1. Cron fires `process-installments`.
2. For each due group, reads snapshot off one of the registrations: `rate = 0.02`, `cap = 500`.
3. Calls `paymentIntents.create({ amount: sum_of_group, application_fee_amount: min(sum*0.02, 500), transfer_data: { destination: J2S_acct_id }, customer, payment_method, off_session: true, confirm: true, ... })`.
4. Idempotency key unchanged.

### Flow D — Operator disconnects

1. Operator opens their Express Dashboard (from Finances tab "Open Stripe Dashboard" button or from a saved bookmark).
2. Settings → "Disconnect from Enrops".
3. Stripe sends `account.application.deauthorized` to the Enrops webhook.
4. Webhook flips org to `disconnected`, charges_enabled=false.
5. Future checkouts for that org fall through to direct-charge-to-Enrops (fallback path). Email alert fires.

### Flow E — Refund (out of scope, documented gap)

Jessica refunds from the Stripe dashboard. Stripe's default refund leaves the application fee with Enrops but does NOT claw back from the connected account. Result: Enrops eats the refund unless Jessica manually transfers the operator's share back. Acceptable for v1 because refund volume is near-zero for J2S today. Build "real" refund flow when refund volume or operator count makes it worth it.

### Flow F — Plan upgrade (free → growth/scale)

SQL only, performed by Jessica or a future Enrops admin tool. The trigger allows platform admins to change rate columns. No UI in this build.

---

## 8. Testing checklist

### Sandbox

- Unit tests: `computePlatformFee` 6-case table.
- Connect a test Express account via the Finances flow end-to-end.
- Create a test PaymentIntent via `create-checkout` and verify in Stripe dashboard:
  - PaymentIntent has `application_fee_amount = 500` for a $275 charge.
  - PaymentIntent has `transfer_data.destination = <test_acct_id>`.
  - `statement_descriptor_suffix = "JOURNEYTOSTEAM"` (or whatever was set).
- Run a cron pass against a seeded installment. Verify same fields on installment 2's PaymentIntent.
- Refund a Stripe sandbox charge with default flags → verify application_fee stays with Enrops (this just confirms Stripe default behavior; informational).
- Toggle `fee_pass_through` via the UI as a non-admin → should fail.
- Toggle `fee_pass_through` as owner → should succeed.
- Attempt to UPDATE `platform_fee_card_pct` via supabase-js as an org owner → should raise the trigger.
- Attempt to UPDATE `stripe_account_id` via supabase-js as an org owner → should raise the trigger.
- Manually flip a test org to `stripe_charges_enabled = false` (via SQL) → run a checkout → verify fallback to direct charge AND verify warning log fires.
- Trigger `account.updated` via Stripe CLI with `payouts_enabled: true` → verify status flips to `active`.
- Trigger `account.application.deauthorized` via Stripe CLI → verify status flips to `disconnected`, email sends.

### Production cutover

1. Apply the migration (Chunk 1).
2. Deploy edge function changes (Chunks 2/3/4/5/6/6b).
3. Ship the Finances tab (Chunk 7).
4. Jessica goes through the Connect flow as J2S → confirm `stripe_account_id` populated, status `active`.
5. Manual bank transfer of $3,320 from Enrops to J2S (Section 3 step 5).
6. Run one real test registration end-to-end. Confirm fee split correct, snapshot written, Stripe dashboard shows expected balances.
7. Verify J2S Express Dashboard accessible from Finances tab.

---

## 9. Known gaps (documented, not blockers)

These are real issues that v2 explicitly defers. Add them to a follow-up tracker.

1. **Refund flow in product UI.** Today: Stripe dashboard only. When refund volume grows, build an admin button that handles `refund_application_fee=false` + `reverse_transfer=true` so the operator gets debited and Enrops keeps the fee automatically.
2. **Partial refund fee math.** Today: Stripe default (keep full application fee). Reconsider if operators complain.
3. **Pass-through display at checkout.** When the first tenant with `fee_pass_through = true` shows up, design how the parent sees the fee at Checkout: extra line item vs amount inflation. Today no tenant uses pass-through.
4. **Chargeback handling.** Same risk surface as refunds. Today: Enrops eats it. Build claw-back path when chargeback volume warrants.
5. **`platform_fee_cents` / `platform_monthly_cents` / `platform_plan = 'pilot'`** — vestigial columns from the old flat-fee pricing model. Currently unread. Drop in a future cleanup migration once we're sure nothing depends on them.
6. **ACH support.** `platform_fee_ach_pct` is in schema but `payment_method_types` is card-only. When ACH ships, the rate column is ready; checkout config needs updating.
7. **Half-configured org alert.** Chunk 3 logs a WARN; no operator alert yet.
8. **Two-tab race on onboarding.** If two browser tabs hit `stripe-connect-onboard` simultaneously for the same org, the second call generates a second `acct_` ID. Currently mitigated by the "if account exists, reuse it" check in Chunk 6, but a true mutex (`SELECT ... FOR UPDATE` on the org row) would harden it.

---

## 10. Definition of done

- [ ] Migration applied; trigger fires correctly for both rate columns and `stripe_account_id`.
- [ ] J2S connected via Express; `stripe_account_id` populated; `stripe_charges_enabled = true`.
- [ ] A test registration routes correctly: parent pays $275 → Enrops platform balance $5 → J2S connected balance $270 (pre-Stripe-fee).
- [ ] Fee snapshot written to the registration row on first payment.
- [ ] Installment 2 reads snapshot, fires correct `application_fee_amount`.
- [ ] `account.updated` webhook flips status correctly; `account.application.deauthorized` does too.
- [ ] Fallback works: org without Connect → direct charge to Enrops (no error).
- [ ] Finances tab shows correct state in all 5 states (not-connected, onboarding, active, restricted, disconnected).
- [ ] Statement descriptor input enforces shape both client-side and via CHECK.
- [ ] Trigger blocks org-admin writes to `stripe_account_id` and the three rate columns; allows writes to `fee_pass_through` and `statement_descriptor`.
- [ ] $3,320 pre-Connect registrations transferred to J2S out-of-band.

---

## 11. File references

In repo:
- `supabase/migrations/20260527_organizations_stripe_connect_fee_config.sql` — Chunk 1
- `supabase/functions/_shared/computePlatformFee.ts` (new) — Chunk 2
- `supabase/functions/create-checkout/index.ts` — Chunk 3
- `supabase/functions/process-installments/index.ts` — Chunk 4
- `supabase/functions/stripe-webhook/index.ts` — Chunk 5
- `supabase/functions/stripe-connect-onboard/index.ts` (new) — Chunk 6
- `supabase/functions/create-stripe-operator-login-link/index.ts` (new) — Chunk 6b
- `src/pages/admin/finances/FinancesTab.tsx` (new, exact path TBD by frontend conventions) — Chunk 7

Existing patterns to reuse:
- `supabase/functions/_shared/stripeAccountStatus.ts` — instructor status logic, parallel pattern for org
- `supabase/functions/stripe-connect-instructor-webhook/index.ts` — webhook idempotency pattern (`stripe_last_webhook_event_id`)
- `supabase/functions/create-stripe-express-login-link/index.ts` — login-link pattern for operator-Connect's parallel function

---

## 12. What's still mine to decide vs. yours to confirm

**Decided in this spec (defaults I took because you dismissed the questions):**

- Express, not Standard.
- Per-tenant statement descriptor, derived from `org.name` with admin override.
- Fee snapshot at first charge.
- Refunds out of scope (Stripe dashboard only).
- `fee_pass_through` editable by org owner/admin (Chunk 7 wins over Chunk 1's conflicting RLS note).
- `stripe_account_id` added to the trigger's locked-column list.
- Partial refund math: Stripe default (keep full fee).
- Pass-through checkout display: deferred until a tenant needs it.
- `transfer.created` webhook event: dropped.

**Likely fine but flag if you disagree:**

- Status enum: `not_connected`, `onboarding`, `active`, `disconnected`, `restricted`. Five states.
- Statement descriptor character constraint: `^[A-Z0-9 .,\-]+$` after uppercase. Stripe is slightly more permissive; this is a conservative subset.
- `business_type: 'company'` hardcoded in the Express account creation call. Stripe also accepts `'individual'`. If we want operators to pick at onboarding, expose it; otherwise default to company and operators who are sole proprietors will hit a friction point. **Recommended:** leave as company for v1; J2S is a company.
- Edge function naming: `stripe-connect-onboard` for the operator-side onboarding fn. Distinct from the existing instructor-side `create-stripe-connect-account`.
