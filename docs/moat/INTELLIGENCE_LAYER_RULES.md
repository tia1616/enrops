# Intelligence Layer — Rules & Seam

**Created 2026-06-04.** The "future intelligence" half of the Enrops database: append-only telemetry that fuels predictive enrollment and data-backed recommendations (e.g. *"70% of providers see a 50% increase in summer-camp enrollment when they set an early-bird deadline"*).

This doc is the contract. Read it before adding any event, table, or read path.

---

## The seam (operational vs intelligence)

Two halves of one database, two different jobs, two different risk profiles. They never bleed into each other except through one doorway.

| | Operational (`public`) | Intelligence (`intelligence`) |
|---|---|---|
| Job | Runs the business — registrations, payments, payroll, rosters | Records what happened, forever |
| If a row is wrong | A kid misses a class / someone isn't paid | A recommendation is slightly off |
| Access | Strict per-tenant RLS | Sealed; written only via the doorway |
| Mutability | Read/write as the app needs | **Append-only — no UPDATE/DELETE** |
| Tenancy | Strict per-tenant isolation | **Deliberately cross-tenant** (benchmarks = the moat) |

**The doorway:** operational code reaches intelligence *only* through `public.log_enrollment_event(...)` — a `SECURITY DEFINER` function, `service_role` EXECUTE only. The `intelligence` schema is never exposed to the REST API and grants no UPDATE/DELETE to anyone, so history is immutable even to the code that writes it.

Built by migration `20260604_intelligence_schema.sql`.

---

## The rules (settled 2026-06-04 guardrail run)

1. **Fail-safe wiring (NON-NEGOTIABLE, #1 rule).** Every `log_enrollment_event` call wraps in try/catch and swallows errors. A failed event log must NEVER break a registration, payment, or any operational path. Worst case is a missing event, never a broken transaction.

2. **Centralized `action_type` constants.** The DB has no enum on purpose (new signals need no migration), so discipline lives in code. All action types come from one shared constants module — never a string literal at the call site. A typo (`payment_complete` vs `payment_completed`) silently fragments the data.

3. **Idempotency.** Stripe retries webhooks; `payment_completed`/`refunded` can fire 2+ times. Events that can repeat carry a `dedupe_key` (e.g. the Stripe event id) and the doorway no-ops on conflict.

4. **PII / children's data (COPPA-adjacent).** Events reference `parent_id`/`student_id` by ID. `metadata` holds IDs and facts ONLY — never raw names, emails, or phone numbers. Set/honor a retention stance.

5. **Cross-tenant read rule.** Aggregating across operators is the whole point (the moat). But **no operator may ever see another operator's raw events.** Any future reporting must aggregate/anonymize before it reaches an operator's eyes.

6. **No FKs on the log.** `enrollment_events` stores IDs as plain `uuid` columns — no foreign keys. It's an immutable log, not relational operational data, and it must survive operational deletes.

7. **Naming reconciliation.** The log uses `site_id`; operational naming is `program_location_id`. Treat them as the same thing; reconcile if it ever causes confusion.

---

## Decision: what to capture

- **v1 starting scope** = the parent enrollment funnel: `initiated`, `payment_completed`, `waitlist_added`, `waitlist_converted`, `cancelled`, `refunded`.
- **Jessica owns the event list.** An audit sweep (her todo) decides what else to log — likely instructor/payroll actions, marketing touch responses, schedule changes. Add events through the same doorway + constants module; no schema change needed.
- **Backfill (open).** Existing confirmed registrations could be seeded as historical `payment_completed` events from their timestamps so the dataset doesn't start empty. Decide yes/no during the sweep.

---

## v2 (2026-07-02): capture the FAILURE half + the metrics layer

The v1 sweep only logged the happy path (`initiated`, `payment_completed`). You cannot answer *"what's not working and why"* from success events alone, and you can never backfill a failure you never recorded. v2 adds:

**New failure events** (open vocabulary, no migration; constants in `_shared/logEnrollmentEvent.ts`):
- `payment_failed` — a charge did not clear (ACH/bank transfer bounce). Logged in `stripe-webhook` `checkout.session.async_payment_failed`, alongside the existing operator alert. metadata: `{ payment_method, reason, amount_total_cents }`.
- `checkout_failed` — the checkout could not be set up (installment schedule failed to persist; the reg never reached Stripe). Logged in `create-checkout`. metadata: `{ stage, use_installments }`.

**Why is answerable, not guessed:** failure events carry a structured `reason`/`stage` in metadata (Stripe decline codes etc.). Decline codes and payment-method type are facts, NOT PII — Rule 4 still holds (no names/emails/phones).

**Abandonment is derived, not logged.** You can't know at initiation that a checkout will be abandoned — it's the *absence* of a follow-up event. So it's a query (`intelligence.abandoned_registrations`), not an event.

**Metrics layer (single source of the funnel definition).** `20260702_intelligence_funnel_views.sql` adds sealed rollup views: `registration_funnel` (base, one row per reg), `enrollment_funnel_by_org`, `abandoned_registrations`, `action_volume` (drift/typo visibility). No surface hand-rolls funnel math against raw events. Conversion = `initiated_and_paid / initiated` (≤100%, instrumented window only — `initiated` capture began 2026-06-05; earlier `payment_completed` rows were backfilled without a matching `initiated`).

**Known deferrals (reasoned, not silent):** the top-level `create-checkout` catch and the post-payment parent-account-provision failure are NOT logged — neither has clean org/registration attribution without refactoring the money path, and the account-provision case is post-payment (already alerted, not a conversion signal). Fast-follow if provisioning-reliability metrics are wanted.

**Boundary with PostHog (no double-instrumentation):** money/enrollment funnel → `intelligence.enrollment_events` (first-party, exact, server-side). Behavioral operator usage ("what features do they use") → PostHog (`AnalyticsBridge`, operator app only, privacy-masked). Same event never goes to both. **No child PII ever goes to PostHog** (third-party) — only org_id + anonymized IDs.

## Readout = the next chunk (Ennie-led, not a BI wall)

The per-operator readout (their own funnel + drop-off + what Ennie says about it) is a separate chunk with real UX decisions — deliberately NOT built blind. It reaches an operator only via a SECURITY DEFINER RPC that scopes to their own org and aggregates (Rule 5: never another operator's raw rows). Keep it a few high-signal numbers + Ennie narration, not a 40-widget dashboard.

## Recommendation engine = later

The *capture* starts now (every uncaptured week is data we can never backfill). The *recommendation engine* that turns events into "70% of providers…" advice is a post–July-3 / August+ platform capability. Don't conflate the two.
