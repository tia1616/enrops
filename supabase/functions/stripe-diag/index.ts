// stripe-diag — TEMPORARY staging-only Stripe inspector. DELETE AT CLOSE-OUT.
//
// WHY IT EXISTS. Money work at Enrops is only allowed to be called done when it
// has been verified by WHOSE BALANCE ACTUALLY MOVED, not by a green build or a
// passing unit test. Nothing else in the repo can read a Stripe balance
// transaction, so without this there is no way to prove that a refund moved the
// money it claims to have moved. It was built for the Phase 2 charge-model work,
// deleted at that close-out (629537a), and rebuilt here for the v4 refund
// verification. Delete it again when this build closes.
//
// IT IS NOT A PRODUCT SURFACE. Three independent gates, all fail-closed:
//   1. DIAG_TOKEN must be set as a secret AND matched by the caller. Prod has no
//      DIAG_TOKEN, so on prod every request 403s before doing anything.
//   2. The Stripe key must be a TEST key. A live key aborts the request outright,
//      so even if this were deployed to prod by accident it cannot touch real
//      money.
//   3. No account creation, ever - controller.fees.payer is irreversible and a
//      stray account would be permanent.
//
// verify_jwt is intentionally FALSE (it is called with a bearer token of its own),
// which is exactly why gates 1 and 2 have to be airtight.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { isEmailAllowed, emailGuardActive } from '../_shared/emailGuard.ts';
import { maybeAlertOperatorFlagged } from '../_shared/operatorFlagAlert.ts';

const KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const DIAG_TOKEN = Deno.env.get('DIAG_TOKEN') ?? '';

const stripe = new Stripe(KEY, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

serve(async (req: Request) => {
  // Gate 1 — no token configured (prod) or wrong token: refuse, say nothing.
  if (!DIAG_TOKEN) return json({ error: 'diag_disabled' }, 403);
  const auth = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (auth !== DIAG_TOKEN) return json({ error: 'forbidden' }, 403);

  // Gate 2 — refuse to run against live money under any circumstances.
  if (!KEY.startsWith('sk_test')) return json({ error: 'refusing_to_run_in_live_mode' }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* action may take no args */ }
  const action = String(body.action ?? '');
  const acct = body.account ? String(body.account) : null;
  const scope = acct ? { stripeAccount: acct } : undefined;

  try {
    switch (action) {
      case 'whoami': {
        const a = await stripe.accounts.retrieve();
        return json({ account: a.id, livemode: (a as { livemode?: boolean }).livemode, key: KEY.slice(0, 8) });
      }

      // ── webhook destinations: what do they actually subscribe to? ─────────
      case 'webhooks_list': {
        const eps = await stripe.webhookEndpoints.list({ limit: 100 });
        return json(eps.data.map((e: Stripe.WebhookEndpoint) => ({
          id: e.id,
          url: e.url,
          status: e.status,
          // application: ca_... => the Connect (connected-accounts) destination.
          // null => platform-scoped.
          application: (e as { application?: string | null }).application ?? null,
          enabled_events: e.enabled_events,
        })));
      }

      case 'webhook_add_events': {
        const id = String(body.endpoint);
        const add = (body.events as string[]) ?? [];
        const ep = await stripe.webhookEndpoints.retrieve(id);
        const merged = Array.from(new Set([...(ep.enabled_events ?? []), ...add]));
        const updated = await stripe.webhookEndpoints.update(id, { enabled_events: merged });
        return json({ id: updated.id, url: updated.url, enabled_events: updated.enabled_events });
      }

      // ── the money reads ──────────────────────────────────────────────────
      case 'pi': {
        const pi = await stripe.paymentIntents.retrieve(
          String(body.id),
          { expand: ['latest_charge.balance_transaction'] },
          scope,
        );
        const ch = (pi as unknown as { latest_charge?: Record<string, unknown> }).latest_charge ?? null;
        return json({ payment_intent: pi.id, amount: pi.amount, charge: ch });
      }

      case 'app_fee': {
        // Always platform-scoped: ApplicationFee is a platform object on BOTH
        // charge models.
        const fee = await stripe.applicationFees.retrieve(String(body.id), { expand: ['refunds'] });
        return json(fee);
      }

      case 'balance_txns': {
        const txns = await stripe.balanceTransactions.list(
          { limit: Number(body.limit ?? 15) },
          scope,
        );
        return json(txns.data.map((t: Stripe.BalanceTransaction) => ({
          id: t.id, type: t.type, amount: t.amount, fee: t.fee, net: t.net,
          created: t.created, source: t.source, description: t.description,
        })));
      }

      case 'refunds_list': {
        const rs = await stripe.refunds.list({ charge: String(body.charge), limit: 100 }, scope);
        return json(rs.data.map((r: Stripe.Refund) => ({ id: r.id, amount: r.amount, status: r.status, reason: r.reason })));
      }

      // ── the one write that verification needs ────────────────────────────
      // Simulates an operator refunding inside their OWN Stripe dashboard: a
      // plain refund with NO application-fee flag and no Enrops metadata, which
      // is exactly what the dashboard button produces. This is the input to
      // v4 section 3 / section 7's "most likely to be missed" test.
      case 'refund_like_dashboard': {
        const r = await stripe.refunds.create(
          {
            charge: String(body.charge),
            ...(body.amount ? { amount: Number(body.amount) } : {}),
            reason: 'requested_by_customer',
          },
          scope,
        );
        return json({ id: r.id, amount: r.amount, status: r.status, charge: r.charge });
      }

      // Stripe test mode ships payment methods that force a dispute the moment
      // the charge settles (pm_card_createDispute). That is the ONLY way to
      // exercise the charge.dispute.* path without waiting for a real
      // chargeback, which in production takes days and cannot be summoned.
      // Creates a direct charge on the connected account, matching how a real
      // operator's charge is made.
      case 'create_disputed_charge': {
        const pi = await stripe.paymentIntents.create(
          {
            amount: Number(body.amount ?? 2500),
            currency: 'usd',
            payment_method: String(body.pm ?? 'pm_card_createDispute'),
            confirm: true,
            ...(body.application_fee ? { application_fee_amount: Number(body.application_fee) } : {}),
            automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
            description: 'stripe-diag dispute test',
          },
          scope,
        );
        return json({ payment_intent: pi.id, status: pi.status, amount: pi.amount });
      }

      case 'disputes_list': {
        const d = await stripe.disputes.list({ limit: Number(body.limit ?? 5) }, scope);
        return json(d.data.map((x: Stripe.Dispute) => ({
          id: x.id, status: x.status, amount: x.amount, reason: x.reason, charge: x.charge,
        })));
      }

      // Why did an email not arrive? Two candidates and no way to tell them
      // apart from the outside: the staging recipient allowlist silently
      // dropping it, or Resend rejecting the send. This answers the first
      // without exposing the allowlist's contents.
      case 'email_guard': {
        const addr = String(body.email ?? '');
        return json({
          guard_active: emailGuardActive(),
          address: addr,
          allowed: isEmailAllowed(addr),
          resend_key_present: (Deno.env.get('RESEND_API_KEY') ?? '').length > 0,
        });
      }

      // v4 section 4. The alert only fires from inside a refund, so the only
      // other way to prove it works would be to move money again just to watch
      // an email leave. This calls the real module against the real database
      // and the real Resend key: same code path, no synthetic refund.
      case 'flag_alert': {
        const admin = createClient(
          Deno.env.get('SUPABASE_URL') ?? '',
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        );
        const res = await maybeAlertOperatorFlagged(admin, {
          organizationId: String(body.org),
          resendApiKey: Deno.env.get('RESEND_API_KEY') ?? '',
          // SAME fallback as the two real call sites. A verification tool whose
          // only job is to prove what production sends must not be able to
          // produce a different email than production would: falling back to ''
          // here would emit a host-less, unclickable link and still report sent.
          siteUrl: (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com').replace(/\/+$/, ''),
          isAllowed: isEmailAllowed,
        });
        return json(res);
      }

      default:
        return json({ error: 'unknown_action', allowed: [
          'whoami', 'webhooks_list', 'webhook_add_events', 'pi', 'app_fee',
          'balance_txns', 'refunds_list', 'refund_like_dashboard',
        ] }, 400);
    }
  } catch (err) {
    const e = err as { raw?: { message?: string; code?: string }; message?: string };
    return json({ error: 'stripe_error', code: e.raw?.code ?? null, message: e.raw?.message ?? e.message }, 502);
  }
});
