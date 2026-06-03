// create-checkout v13 — creates a Stripe Checkout session for already-written registrations.
//
// PATCH 7 (2026-05-27): Stripe Connect destination charges.
//   Looks up the registration's org and, if it has an active connected
//   account (stripe_account_id + stripe_charges_enabled), adds:
//     - application_fee_amount  (computed via shared helper)
//     - transfer_data.destination = org.stripe_account_id
//     - statement_descriptor_suffix (from org config; defaults to org.name)
//   Fallback: orgs without active Connect keep the current direct-charge
//   behavior. Half-configured orgs (account_id set, charges_enabled=false)
//   log a WARN and fall through. Both installments and standard paths
//   covered.
//
// PATCH 6 (2026-05-01): Bug A fix — per-child installment attribution.
//   Schedule shape changed: now accepts { aggregated: [...], per_line: [...] }
//   where per_line has N×3 entries (N = registrations). Persists schedule to
//   checkout_schedules table keyed by stripe_session_id; webhook reads back.
//   Backwards compatible: still accepts old { installments: [...] } shape and
//   adapts to the new model internally.
//
// PATCH 5 (2026-04-27): Added installments support.
//
// INPUT: registration_ids, parent contact info, line items, total, optional installments config.
// OUTPUT: { url, sessionId } — hosted Stripe Checkout URL for frontend to redirect to.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { buildConnectChargeParams, ConnectOrgConfig } from '../_shared/connectChargeParams.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

interface AggregatedEntry {
  installment_number: number;
  amount_cents: number;
  due_date: string;
}

interface PerLineEntry {
  installment_number: number;
  registration_id: string;
  amount_cents: number;
  due_date: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const {
      registration_ids,
      parent_email,
      parent_name,
      line_items,
      total_cents,
      origin,
      success_path,
      cancel_path,
      use_installments,
      installment_schedule,
    } = await req.json();

    if (!registration_ids?.length || !line_items?.length) {
      return json({ error: 'Missing registration_ids or line_items' }, 400);
    }

    let aggregated: AggregatedEntry[] | null = null;
    let perLine: PerLineEntry[] | null = null;

    if (use_installments) {
      // Accept new shape (aggregated + per_line) OR legacy shape (installments)
      if (installment_schedule?.aggregated && installment_schedule?.per_line) {
        // NEW shape (v12+)
        aggregated = installment_schedule.aggregated;
        perLine = installment_schedule.per_line;

        if (!aggregated || aggregated.length !== 3) {
          return json({ error: 'aggregated schedule must contain exactly 3 entries' }, 400);
        }
        if (!perLine || perLine.length === 0) {
          return json({ error: 'per_line schedule must contain at least one entry' }, 400);
        }
        // Validate per_line totals match aggregated totals
        for (const agg of aggregated) {
          const perLineSum = perLine
            .filter((p) => p.installment_number === agg.installment_number)
            .reduce((s, p) => s + p.amount_cents, 0);
          if (Math.abs(perLineSum - agg.amount_cents) > 1) {
            return json({
              error: `installment ${agg.installment_number}: per_line sum ${perLineSum} != aggregated ${agg.amount_cents}`,
            }, 400);
          }
        }
        // Validate aggregated total matches total_cents
        const aggregatedTotal = aggregated.reduce((s, a) => s + a.amount_cents, 0);
        if (Math.abs(aggregatedTotal - total_cents) > 1) {
          return json({ error: `aggregated total ${aggregatedTotal} != total_cents ${total_cents}` }, 400);
        }
      } else if (installment_schedule?.installments?.length) {
        // LEGACY shape — convert to new internal format
        const sched = installment_schedule.installments;
        if (sched.length !== 3) {
          return json({ error: 'legacy installment_schedule must contain exactly 3 installments' }, 400);
        }
        aggregated = sched.map((s: any) => ({
          installment_number: s.number || s.installment_number,
          amount_cents: s.amount_cents,
          due_date: s.due_date,
        }));
        // Legacy: all installments under registration_ids[0]
        perLine = sched.map((s: any) => ({
          installment_number: s.number || s.installment_number,
          registration_id: s.registration_id || registration_ids[0],
          amount_cents: s.amount_cents,
          due_date: s.due_date,
        }));
      } else {
        return json({ error: 'use_installments=true requires installment_schedule' }, 400);
      }

      // Validate dates: charges 2 and 3 must be in the future
      const today = new Date().toISOString().slice(0, 10);
      const c2 = aggregated!.find((a) => a.installment_number === 2);
      const c3 = aggregated!.find((a) => a.installment_number === 3);
      if (!c2 || !c3 || c2.due_date <= today || c3.due_date <= today) {
        return json({ error: 'Installments 2 and 3 must be due in the future' }, 400);
      }
    }

    const base = origin || 'https://enrops.com';
    if (!success_path) return json({ error: 'success_path is required (tenant-scoped, e.g., /{slug}/register/success)' }, 400);
    if (!cancel_path) return json({ error: 'cancel_path is required (tenant-scoped, e.g., /{slug}/register)' }, 400);
    const successPath = success_path;
    const cancelPath = cancel_path;

    if (use_installments && aggregated && perLine) {
      const c1 = aggregated.find((a) => a.installment_number === 1)!;
      const c2 = aggregated.find((a) => a.installment_number === 2)!;
      const c3 = aggregated.find((a) => a.installment_number === 3)!;
      const firstAmount = c1.amount_cents;

      let customerId: string;
      const existingCustomers = await stripe.customers.list({ email: parent_email, limit: 1 });
      if (existingCustomers.data.length > 0) {
        customerId = existingCustomers.data[0].id;
      } else {
        const customer = await stripe.customers.create({
          email: parent_email,
          name: parent_name || undefined,
          metadata: { source: 'enrops-installments' },
        });
        customerId = customer.id;
      }

      const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
      const fmtDate = (iso: string) =>
        new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const programNames = line_items.map((l: any) => l.program_name).join(', ');
      const scheduleDescription = `Installment 1 of 3 today (${fmt(firstAmount)}). ` +
        `Then ${fmt(c2.amount_cents)} on ${fmtDate(c2.due_date)} and ` +
        `${fmt(c3.amount_cents)} on ${fmtDate(c3.due_date)}. ` +
        `Card on file will be charged automatically.`;

      const installmentLineItem = {
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${programNames} — Installment 1 of 3`,
            description: scheduleDescription,
          },
          unit_amount: firstAmount,
        },
        quantity: 1,
      };

      // Look up organization_id + Connect config for the first registration.
      // Connect overlay (application_fee_amount + transfer_data + descriptor
      // suffix) is computed against installment 1's amount only — installments
      // 2 and 3 compute their own fees when process-installments fires.
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: regForOrg } = await admin
        .from('registrations')
        .select(`
          organization_id,
          organizations:organization_id (
            stripe_account_id,
            stripe_charges_enabled,
            statement_descriptor_suffix,
            name,
            platform_fee_card_pct,
            platform_fee_ach_pct,
            platform_fee_cap_cents
          )
        `)
        .eq('id', registration_ids[0])
        .single();
      const orgId = regForOrg?.organization_id || null;
      const orgConfig = (regForOrg?.organizations ?? null) as ConnectOrgConfig | null;
      const connectParams = buildConnectChargeParams(firstAmount, 'card', orgConfig, orgId);

      // Create the Stripe Checkout session FIRST so we have the session_id to key on
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [installmentLineItem],
        mode: 'payment',
        customer: customerId,
        payment_intent_data: {
          setup_future_usage: 'off_session',
          metadata: {
            registration_ids: registration_ids.join(','),
            installment_number: '1',
            total_amount_cents: String(total_cents),
          },
          ...connectParams,
        },
        success_url: `${base}${successPath}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}${cancelPath}`,
        metadata: {
          registration_ids: registration_ids.join(','),
          parent_email,
          parent_name: parent_name || '',
          use_installments: 'true',
          schedule_source: 'checkout_schedules',
          installment_2_due_date: c2.due_date,
          installment_3_due_date: c3.due_date,
        },
      });

      // Persist the per-line schedule to checkout_schedules — webhook reads it after payment
      const { error: scheduleErr } = await admin.from('checkout_schedules').insert({
        stripe_session_id: session.id,
        organization_id: orgId,
        schedule: { aggregated, per_line: perLine },
      });

      if (scheduleErr) {
        // Schedule write failed but Stripe session was created. Expire the Stripe
        // session and return an error so the frontend can retry safely.
        console.error('Failed to persist checkout schedule:', scheduleErr);
        try {
          await stripe.checkout.sessions.expire(session.id);
        } catch (expireErr) {
          console.error('Failed to expire orphaned session:', expireErr);
        }
        return json({ error: 'Could not persist installment schedule. Please try again.' }, 500);
      }

      return json({ url: session.url, sessionId: session.id });
    }

    // STANDARD (NON-INSTALLMENTS) PATH
    const stripeLineItems = line_items.map((l: any) => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: l.program_name,
          description: [
            l.school_name,
            l.day_of_week ? `${l.day_of_week}s` : null,
            l.start_time,
            l.child_label,
          ]
            .filter(Boolean)
            .join(' — '),
        },
        unit_amount: l.amount_cents,
      },
      quantity: 1,
    }));

    // v13: Look up the org's Connect config so we can route the destination
    // charge correctly. Fee is computed against total_cents (the full cart).
    const adminStd = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: regForOrgStd } = await adminStd
      .from('registrations')
      .select(`
        organization_id,
        organizations:organization_id (
          stripe_account_id,
          stripe_charges_enabled,
          statement_descriptor_suffix,
          name,
          platform_fee_card_pct,
          platform_fee_ach_pct,
          platform_fee_cap_cents
        )
      `)
      .eq('id', registration_ids[0])
      .single();
    const orgIdStd = regForOrgStd?.organization_id || null;
    const orgConfigStd = (regForOrgStd?.organizations ?? null) as ConnectOrgConfig | null;
    const connectParamsStd = buildConnectChargeParams(total_cents, 'card', orgConfigStd, orgIdStd);

    // Only attach payment_intent_data if we actually have Connect fields to
    // set. Stripe rejects an empty payment_intent_data object on Checkout
    // Sessions; passing it conditionally keeps the no-Connect fallback clean.
    const piData = Object.keys(connectParamsStd).length > 0 ? connectParamsStd : undefined;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: stripeLineItems,
      mode: 'payment',
      customer_email: parent_email,
      success_url: `${base}${successPath}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}${cancelPath}`,
      metadata: {
        registration_ids: registration_ids.join(','),
        parent_email,
        parent_name: parent_name || '',
      },
      ...(piData ? { payment_intent_data: piData } : {}),
    });

    return json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('create-checkout error:', err);
    return json({ error: (err as Error).message }, 500);
  }
});
