// stripe-diag — TEMPORARY, STAGING ONLY. DELETE AFTER THE PHASE 2 VERIFICATION.
//
// Why this exists: verifying a money change means proving WHOSE BALANCE MOVES,
// and that requires Stripe API access. STRIPE_SECRET_KEY lives only in Supabase
// function secrets, so this runs the reads inside the function where the key
// already is — nobody has to copy a live key onto a laptop to check a number.
//
// Every action is a READ against the Stripe API, with ONE exception:
// 'make_test_account' creates a throwaway TEST-MODE connected account and fills
// it with Stripe's documented test values so it becomes chargeable. It refuses
// to run against a live-mode key. Nothing here can refund, transfer, or delete.
//
// Why a fixture instead of the hosted flow: Phase 1's real accounts use
// requirement_collection='stripe', so Stripe (not the platform) gathers the
// onboarding data and the API cannot fill it. The fixture uses
// requirement_collection='application' — the ONLY field that differs from the
// production shape, and one that has no bearing on charge mechanics. The fields
// that DO decide who pays what (controller.fees.payer='account',
// controller.losses.payments='stripe') are identical to Phase 1.
//
// verify_jwt defaults to true AND a dedicated X-Diag-Token is required, so this
// is not reachable by a family, an operator, or an anon caller.
//
// DELETE ME: `supabase functions delete stripe-diag --project-ref <staging>`.
// Tracked in the Phase 2 close-out. Do not deploy to prod.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

// A dedicated secret set only on staging for this verification. Not the service
// role key: this function must be callable by exactly one person for one job,
// and the service key is used by half the platform.
const DIAG_TOKEN = Deno.env.get('DIAG_TOKEN') || '';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const tok = (req.headers.get('X-Diag-Token') || '').trim();
  if (!DIAG_TOKEN || tok !== DIAG_TOKEN) return json({ error: 'forbidden' }, 403);

  try {
    const { action, account, id, limit } = await req.json();
    // Scope every read to a connected account when one is supplied.
    // undefined, never {} — stripe-node rejects an empty options object with
    // "Unknown arguments". (This diag hit that bug itself, which is a decent
    // demonstration of how easy it is to get wrong.)
    const scope: { stripeAccount: string } | undefined = account ? { stripeAccount: account } : undefined;

    switch (action) {
      case 'whoami': {
        // Which Stripe account is this key? Confirms test vs live mode.
        const acct = await stripe.accounts.retrieve();
        return json({ platform_account: acct.id, livemode: (acct as unknown as { livemode?: boolean }).livemode });
      }

      case 'account': {
        // The Phase 1 controller shape, read back rather than assumed.
        const acct = await stripe.accounts.retrieve(id);
        return json({
          id: acct.id,
          type: acct.type,
          controller: (acct as unknown as { controller?: unknown }).controller,
          charges_enabled: acct.charges_enabled,
          payouts_enabled: acct.payouts_enabled,
          details_submitted: acct.details_submitted,
          requirements_currently_due: acct.requirements?.currently_due,
          requirements_disabled_reason: acct.requirements?.disabled_reason,
        });
      }

      case 'balance': {
        // scope={} → the PLATFORM balance. scope={stripeAccount} → the operator's.
        const bal = await stripe.balance.retrieve(scope);
        return json({ scope: account ?? 'PLATFORM', available: bal.available, pending: bal.pending });
      }

      case 'balance_transactions': {
        // The authoritative "who paid what" record: fee and net PER ACCOUNT.
        const txns = await stripe.balanceTransactions.list({ limit: limit ?? 10 }, scope);
        return json({
          scope: account ?? 'PLATFORM',
          txns: txns.data.map((t) => ({
            id: t.id, type: t.type, amount: t.amount, fee: t.fee, net: t.net,
            currency: t.currency, source: t.source, created: t.created,
            description: t.description,
          })),
        });
      }

      case 'payment_intent': {
        const pi = await stripe.paymentIntents.retrieve(id, scope);
        return json({
          id: pi.id, amount: pi.amount, status: pi.status,
          application_fee_amount: (pi as unknown as { application_fee_amount?: number }).application_fee_amount,
          transfer_data: (pi as unknown as { transfer_data?: unknown }).transfer_data,
          on_behalf_of: (pi as unknown as { on_behalf_of?: string }).on_behalf_of,
          customer: pi.customer, latest_charge: pi.latest_charge, metadata: pi.metadata,
        });
      }

      case 'charge': {
        const ch = await stripe.charges.retrieve(id, scope);
        return json({
          id: ch.id, amount: ch.amount, paid: ch.paid, currency: ch.currency,
          application_fee_amount: (ch as unknown as { application_fee_amount?: number }).application_fee_amount,
          balance_transaction: ch.balance_transaction,
          transfer_data: (ch as unknown as { transfer_data?: unknown }).transfer_data,
          on_behalf_of: (ch as unknown as { on_behalf_of?: string }).on_behalf_of,
          destination: (ch as unknown as { destination?: string }).destination,
          statement_descriptor_suffix: ch.statement_descriptor_suffix,
        });
      }

      case 'session': {
        const s = await stripe.checkout.sessions.retrieve(id, scope);
        return json({
          id: s.id, status: s.status, payment_status: s.payment_status,
          amount_total: s.amount_total, customer: s.customer,
          payment_intent: s.payment_intent, metadata: s.metadata,
        });
      }

      case 'webhook_endpoints': {
        // THE config question Phase 2 turns on: does the connected-accounts
        // destination actually subscribe to checkout.session.completed? If it
        // doesn't, a direct org's payments are never recorded by stripe-webhook.
        const eps = await stripe.webhookEndpoints.list({ limit: 30 });
        return json({
          endpoints: eps.data.map((e) => ({
            id: e.id, url: e.url, status: e.status,
            // Dump every non-event field raw: the typed `connect` accessor came
            // back undefined, and guessing which destination is Connect-scoped
            // is exactly the thing that would silently lose a direct org's
            // checkout.session.completed.
            raw: Object.fromEntries(
              Object.entries(e as unknown as Record<string, unknown>)
                .filter(([k]) => k !== 'enabled_events'),
            ),
            has_checkout_session_completed:
              e.enabled_events.includes('checkout.session.completed') ||
              e.enabled_events.includes('*'),
            event_count: e.enabled_events.length,
          })),
        });
      }

      case 'make_test_account': {
        // Hard stop: never in live mode. A live controller account cannot be
        // deleted and its fee payer can never be changed.
        const platform = await stripe.accounts.retrieve();
        if ((platform as unknown as { livemode?: boolean }).livemode) {
          return json({ error: 'refusing_to_create_account_in_live_mode' }, 400);
        }

        const acct = await stripe.accounts.create({
          country: 'US',
          email: 'tia1616+directtest@gmail.com',
          business_type: 'individual',
          controller: {
            fees: { payer: 'account' },          // identical to Phase 1
            losses: { payments: 'stripe' },      // identical to Phase 1
            stripe_dashboard: { type: 'full' },  // identical to Phase 1
            requirement_collection: 'application', // fixture-only difference
          },
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          business_profile: { url: 'https://enrops.com', mcc: '8299' },
          individual: {
            first_name: 'Direct', last_name: 'Testerson',
            email: 'tia1616+directtest@gmail.com',
            phone: '+15555555555',
            dob: { day: 1, month: 1, year: 1990 },
            address: { line1: 'address_full_match', city: 'Portland', state: 'OR', postal_code: '97201', country: 'US' },
            ssn_last_4: '0000', id_number: '000000000',
          },
          external_account: {
            object: 'bank_account', country: 'US', currency: 'usd',
            routing_number: '110000000', account_number: '000123456789',
          },
          tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: '8.8.8.8' },
        } as unknown as Stripe.AccountCreateParams);

        const fresh = await stripe.accounts.retrieve(acct.id);
        return json({
          id: fresh.id,
          controller: (fresh as unknown as { controller?: unknown }).controller,
          charges_enabled: fresh.charges_enabled,
          payouts_enabled: fresh.payouts_enabled,
          requirements_currently_due: fresh.requirements?.currently_due,
          requirements_disabled_reason: fresh.requirements?.disabled_reason,
        });
      }

      default:
        return json({ error: 'unknown_action' }, 400);
    }
  } catch (err) {
    const e = err as { message?: string; raw?: { message?: string; code?: string } };
    return json({ error: e.raw?.message ?? e.message ?? 'unknown', code: e.raw?.code }, 500);
  }
});
