// create-checkout v14 — creates a Stripe Checkout session for already-written registrations.
//
// PATCH 9 (2026-07-27): Stripe direct charges (migration Phase 2).
//   Charge routing now comes from buildChargeRouting(), which reads
//   organizations.stripe_charge_model:
//     'destination' (J2S + every pre-existing org) — UNCHANGED. Session is
//        created on the platform with transfer_data/on_behalf_of/uplift exactly
//        as before, and NO request-options argument at all (undefined — passing
//        {} makes stripe-node throw "Unknown arguments").
//     'direct' — the Session is created ON the connected account (Stripe-Account
//        header), application_fee_amount is clean Enrops margin with no Stripe-fee
//        uplift (the operator's account pays Stripe natively), and no transfer_data
//        / on_behalf_of / statement_descriptor_suffix is sent.
//   The installments branch also moved its org lookup ABOVE Customer creation:
//   on a direct charge the Customer and its saved card must live on the SAME
//   connected account that will re-charge them off-session.
//
// PATCH 8 (2026-07-03): pay-in-full is now a SINGLE payment method per session,
//   chosen by the family up front (request `payment_method`: 'card' |
//   'us_bank_account', default card). Fixes over-collection: a Checkout Session
//   sets application_fee_amount once, before the family picks, and card vs ACH
//   carry different Stripe-fee recovery when stripe_fee_payer='tenant'. The fee
//   (application_fee_amount + any pass-through line) is now computed for the
//   selected method, so it always matches what Stripe charges. Bank transfer is
//   still offered — just as its own session. Installments remain card-only.
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
import { buildChargeRouting, ConnectOrgConfig } from '../_shared/connectChargeParams.ts';
import { passThroughLineItem, passThroughLineItemForAmount } from '../_shared/passThroughFee.ts';
import { computePlatformFee } from '../_shared/computePlatformFee.ts';
import { allocateFeeAcrossInstallments } from '../_shared/feeAllocation.ts';
import { logEnrollmentEvent, ENROLLMENT_ACTIONS } from '../_shared/logEnrollmentEvent.ts';
import { validateGift, scholarshipLineItem, ScholarshipFundConfig } from '../_shared/scholarshipFund.ts';

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
      payment_method,
      // Scholarship fund. `donation_cents` is the gift the family chose; the fee
      // cover and the charged total are computed HERE from the org's own config
      // row, never accepted from the browser. This is the one number in the
      // whole flow that cannot be reloaded from a server row before the charge -
      // a family invents it at checkout - so bounds are the only guard, and they
      // are the operator's, not the client's.
      donation_cents,
      donation_cover_fee,
    } = await req.json();

    if (!registration_ids?.length || !line_items?.length) {
      return json({ error: 'Missing registration_ids or line_items' }, 400);
    }

    // --- Server-authoritative charge guard (chunk 6) ---
    // create-registration wrote the true per-line amounts to the DB. Re-derive the
    // total from those rows; the browser's numbers are only honored if they match.
    // A tampered total (or a stale cart) is rejected, never charged.
    const guardAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: regAmtRows, error: regAmtErr } = await guardAdmin
      .from('registrations')
      // organization_id rides along so the scholarship-fund config can be read
      // from the SAME rows the total is derived from - the gift is bounded by
      // the org that owns these registrations, never by an org the client names.
      .select('amount_cents, organization_id')
      .in('id', registration_ids);
    if (regAmtErr) return json({ error: 'Could not verify the order total. Please try again.' }, 500);
    const serverSum = (regAmtRows || []).reduce((s, r) => s + (r.amount_cents || 0), 0);

    // --- Scholarship fund gift ------------------------------------------------
    // Validated BEFORE the comp branch below, so a gift can never be silently
    // dropped by an early return.
    const giftOrgId = (regAmtRows || [])[0]?.organization_id ?? null;
    let giftCfg: ScholarshipFundConfig | null = null;
    if (donation_cents) {
      const { data: fundRow, error: fundErr } = await guardAdmin
        .from('org_scholarship_fund')
        .select('enabled, headline, blurb, preset_amounts_cents, min_cents, max_cents, cover_fee_default, cover_fee_pct')
        .eq('organization_id', giftOrgId)
        .maybeSingle();
      // Fail CLOSED on a lookup error: without the config there are no bounds,
      // and an unbounded client-supplied amount is exactly what this gate exists
      // to prevent. Refusing costs one retry; guessing charges a real card.
      if (fundErr) {
        console.error('[create-checkout] scholarship fund lookup failed:', fundErr.message);
        return json({ error: 'Could not add your donation right now. Please try again.' }, 500);
      }
      giftCfg = (fundRow as ScholarshipFundConfig | null) ?? null;
    }
    const gift = validateGift(donation_cents, !!donation_cover_fee, giftCfg);
    if (!gift.ok) {
      // The reason names amounts and config, so it goes to the log, not to the
      // family. They get a plain instruction they can act on.
      console.warn(`[create-checkout] refused donation for org ${giftOrgId ?? '(unknown)'}: ${gift.reason}`);
      return json({ error: 'That donation amount is not available. Please adjust it and try again.', donation_rejected: true }, 400);
    }

    if (serverSum <= 0) {
      // A gift cannot ride on a comp order: this branch deliberately creates NO
      // Stripe session, so there is nothing to attach it to. Refuse rather than
      // enroll-and-drop, which would take the family's intent and no money and
      // tell them nothing. StepPay does not show the ask at a $0 total, so this
      // is a tamper/stale-cart guard, not a path a family walks.
      if (gift.chargedCents > 0) {
        console.warn(`[create-checkout] donation on a $0 comp order refused (org ${giftOrgId ?? '(unknown)'})`);
        return json({
          error: 'Your registration is fully covered, so there is nothing to check out. Please remove the donation to finish, and thank you for offering.',
          donation_rejected: true,
        }, 400);
      }
      // $0 comp / scholarship order — a 100%-off (or fully-covering) code. There is
      // no Stripe charge: enroll the family, count the redemption, and send them to
      // the success page where they get parent-portal access (magic link). We reuse
      // registration_ids[0] as the idempotency key since there's no payment intent.
      const { error: paidErr } = await guardAdmin
        .from('registrations')
        .update({ status: 'confirmed', payment_status: 'paid' })
        .in('id', registration_ids);
      if (paidErr) return json({ error: 'Could not confirm your free registration. Please try again.' }, 500);

      const { data: compRegRows } = await guardAdmin
        .from('registrations')
        .select('promo_code_used, parent_id, organization_id')
        .in('id', registration_ids);
      const compOrgId = (compRegRows || [])[0]?.organization_id ?? null;

      try {
        const code = (compRegRows || []).find((r) => r.promo_code_used)?.promo_code_used;
        if (code && compOrgId) {
          const parentId = (compRegRows || []).find((r) => r.parent_id)?.parent_id ?? null;
          const { data: codeRow } = await guardAdmin
            .from('promo_codes').select('id')
            .eq('organization_id', compOrgId).eq('code', code).maybeSingle();
          if (codeRow) {
            const { error: insErr } = await guardAdmin.from('promo_redemptions').insert({
              organization_id: compOrgId,
              promo_code_id: codeRow.id,
              parent_id: parentId,
              redemption_key: `comp:${registration_ids[0]}`,
            });
            if (!insErr) {
              await guardAdmin.rpc('increment_promo_used_count', { p_code_id: codeRow.id });
            } else if (!/duplicate key|unique/i.test(insErr.message || '')) {
              console.warn('comp redemption insert failed:', insErr.message);
            }
          }
        }
      } catch (e) {
        console.warn('comp redemption counting failed (non-fatal):', (e as Error).message);
      }

      // intelligence: log completion (fail-safe) so a $0 enrollment still shows up.
      for (const regId of registration_ids) {
        await logEnrollmentEvent(guardAdmin, {
          actionType: ENROLLMENT_ACTIONS.PAYMENT_COMPLETED,
          organizationId: compOrgId,
          registrationId: regId,
          metadata: { amount_total_cents: 0, comp: true },
          dedupeKey: `payment_completed:comp:${regId}`,
        });
      }
      return json({ comp: true, registration_ids });
    }
    {
      const clientTotal = Number(total_cents) || 0;
      const lineSum = (line_items as Array<{ amount_cents?: number }>).reduce((s, l) => s + (l.amount_cents || 0), 0);
      if (Math.abs(clientTotal - serverSum) > 1 || Math.abs(lineSum - serverSum) > 1) {
        return json({ error: 'That price is out of date — please refresh your cart and try again.', price_mismatch: true }, 409);
      }
    }

    let aggregated: AggregatedEntry[] | null = null;
    let perLine: PerLineEntry[] | null = null;

    // A gift is not financed. The installments machinery splits a total across
    // three dated charges, caps the platform fee across the whole registration
    // and reconciles per-line schedules against it - a $25 gift entering that
    // would be spread into three charges of $8.33, would distort the aggregated
    // totals the schedule validation compares, and would leave two thirds of it
    // outstanding for months. Refused server-side as well as hidden on StepPay,
    // because a UI-only rule is not a rule.
    if (use_installments && gift.chargedCents > 0) {
      console.warn(`[create-checkout] donation on an installment plan refused (org ${giftOrgId ?? '(unknown)'})`);
      return json({
        error: 'Donations cannot be added to a payment plan yet. Please remove the donation, or pay in full to include it.',
        donation_rejected: true,
      }, 400);
    }

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

      // v14 (Phase 2): the org lookup + charge routing must happen BEFORE the
      // Customer is created. On a direct charge the Customer, its saved payment
      // method, and the PaymentIntent all have to live on the SAME connected
      // account — a platform Customer cannot be used in a direct charge, and
      // installments 2 and 3 later re-charge that saved method off-session.
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
            platform_fee_cap_cents,
            platform_fee_floor_cents,
            fee_pass_through,
            stripe_fee_payer,
            active_registration_term,
            instructor_pay_model,
            stripe_charge_model
          )
        `)
        .eq('id', registration_ids[0])
        .single();
      const orgId = regForOrg?.organization_id || null;
      const orgConfig = (regForOrg?.organizations ?? null) as ConnectOrgConfig | null;
      const orgTerm = (regForOrg?.organizations as { active_registration_term?: string | null } | null)?.active_registration_term ?? '';

      // Same payment gate as the one-time path below. The installments branch
      // returns EARLY, so without this it would be a way around the block —
      // and it's worse here: it also schedules two future off-session charges
      // that would keep landing in the platform balance.
      if (!orgConfig?.stripe_charges_enabled) {
        console.warn(
          `[create-checkout] BLOCKED (installments): org ${orgId ?? '(unknown)'} has no Stripe account accepting charges.`,
        );
        return json({
          error: 'This provider is not set up to take payments yet. Please contact them directly.',
          code: 'stripe_not_connected',
        }, 409);
      }

      // The platform fee is capped PER REGISTRATION, not per charge: compute it
      // once against the whole total, then split it across the three
      // installments. Otherwise a $500 program split three ways costs the
      // family 3 x the per-charge fee while paying up front hits the single
      // $7.99 cap — penalising exactly the families who need the plan.
      // Below the cap this changes nothing (3% of $240 = 3 x 3% of $80).
      const installmentFeeShares = orgConfig
        ? allocateFeeAcrossInstallments(
          computePlatformFee(total_cents, 'card', orgConfig),
          [c1.amount_cents, c2.amount_cents, c3.amount_cents],
        )
        : [0, 0, 0];
      const firstFeeShare = installmentFeeShares[0];

      // Connect overlay + which account the API calls are made against. The
      // margin is installment 1's SHARE of the registration-level fee;
      // installments 2 and 3 take theirs when process-installments fires.
      const routing = buildChargeRouting(firstAmount, 'card', orgConfig, orgId, firstFeeShare);
      if (routing.blocked) {
        console.warn(`[create-checkout] BLOCKED (installments, direct): ${routing.blocked}`);
        return json({
          error: 'This provider is not set up to take payments yet. Please contact them directly.',
          code: 'stripe_not_connected',
        }, 409);
      }
      const connectParams = routing.params;
      // Every Stripe call in this branch is scoped by this. On a destination org
      // it is UNDEFINED — the exact platform-scoped call this function always
      // made. It must not be {}: stripe-node identifies an options object by its
      // known keys, so an empty one is read as a stray argument and the call
      // throws "Unknown arguments ([object Object])".
      const acct = routing.requestOptions;

      // Customer lookup/creation is scoped to `acct`, so a direct org's families
      // are Customers on THAT operator's account and never on the platform.
      let customerId: string;
      const existingCustomers = await stripe.customers.list({ email: parent_email, limit: 1 }, acct);
      if (existingCustomers.data.length > 0) {
        customerId = existingCustomers.data[0].id;
      } else {
        const customer = await stripe.customers.create({
          email: parent_email,
          name: parent_name || undefined,
          metadata: { source: 'enrops-installments' },
        }, acct);
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

      // Pass-through: installment 1's SHARE of the registration-level fee as a
      // visible line. Uses the same allocated share as application_fee_amount
      // above, so what the family is charged and what the platform keeps always
      // agree. Installments 2 & 3 take their shares in process-installments.
      const feeLineInst = orgConfig?.fee_pass_through && firstFeeShare > 0
        ? passThroughLineItemForAmount(firstFeeShare)
        : null;
      const installmentLineItems = feeLineInst
        ? [installmentLineItem, feeLineInst]
        : [installmentLineItem];

      // Create the Stripe Checkout session FIRST so we have the session_id to key on
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: installmentLineItems,
        mode: 'payment',
        customer: customerId,
        payment_intent_data: {
          setup_future_usage: 'off_session',
          metadata: {
            registration_ids: registration_ids.join(','),
            installment_number: '1',
            total_amount_cents: String(total_cents),
            // C1 accounting-sync standard keys (read by external Stripe→QBO connectors)
            enrops_org_id: orgId ?? '',
            enrops_record_type: 'registration',
            enrops_term: orgTerm,
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
      }, acct);

      // Record WHERE this charge lives, before the family is redirected.
      // stripe_charge_account_id is NULL for a destination org (the charge is on
      // the platform) and the connected account id for a direct org. Written now
      // rather than derived later from the org's CURRENT stripe_charge_model,
      // because an org that moves to direct charges gets a brand-new connected
      // account and its older sessions/PIs stay on the platform forever.
      // Non-fatal: the session is already live, and every reader falls back to
      // platform scope, which is what a missing row would have meant anyway.
      const { error: chargeRefErr } = await admin
        .from('registrations')
        .update({
          stripe_checkout_session_id: session.id,
          stripe_charge_account_id: acct?.stripeAccount ?? null,
        })
        .in('id', registration_ids);
      if (chargeRefErr) {
        // Do NOT let the family pay against a session we failed to record.
        // For a direct org this row is the only thing checkout-session-status
        // can use to scope its Stripe lookup, and its catch-all fails OPEN to
        // paid:true — so proceeding means an ACH payer whose transfer is still
        // clearing gets shown a settled success page. Expire the session and
        // make them retry, exactly as the schedule-persist failure below does.
        console.error('[create-checkout] failed to record charge account (installments):', chargeRefErr);
        try {
          await stripe.checkout.sessions.expire(session.id, acct);
        } catch (expireErr) {
          console.error('Failed to expire unrecorded session:', expireErr);
        }
        return json({ error: 'Could not start checkout. Please try again.' }, 500);
      }

      // Persist the per-line schedule to checkout_schedules — webhook reads it after payment
      const { error: scheduleErr } = await admin.from('checkout_schedules').insert({
        stripe_session_id: session.id,
        organization_id: orgId,
        schedule: { aggregated, per_line: perLine },
        // Freeze the fee decision the family is agreeing to RIGHT NOW, on the
        // same orgConfig that priced the fee line in this very session (see
        // feeLineInst above) — so the snapshot and what they were shown at
        // checkout can never be two different answers. The webhook copies it
        // onto every installments row; process-installments honours it over
        // live config, which is what stops a later toggle from repricing
        // charges 2 and 3 on a card they have already saved.
        fee_pass_through: !!orgConfig?.fee_pass_through,
      });

      if (scheduleErr) {
        // Schedule write failed but Stripe session was created. Expire the Stripe
        // session and return an error so the frontend can retry safely.
        console.error('Failed to persist checkout schedule:', scheduleErr);
        try {
          await stripe.checkout.sessions.expire(session.id, acct);
        } catch (expireErr) {
          console.error('Failed to expire orphaned session:', expireErr);
        }
        // intelligence: log the checkout setup failure (fail-safe; IDs/facts only, no PII)
        for (const regId of registration_ids) {
          await logEnrollmentEvent(admin, {
            actionType: ENROLLMENT_ACTIONS.CHECKOUT_FAILED,
            organizationId: orgId,
            registrationId: regId,
            metadata: { stage: 'installment_schedule_persist', use_installments: true },
            dedupeKey: `checkout_failed:${session.id}:${regId}`,
          });
        }
        return json({ error: 'Could not persist installment schedule. Please try again.' }, 500);
      }

      // intelligence: log enrollment initiated (one per registration; fail-safe, never blocks)
      for (const regId of registration_ids) {
        await logEnrollmentEvent(admin, {
          actionType: ENROLLMENT_ACTIONS.INITIATED,
          organizationId: orgId,
          registrationId: regId,
          metadata: { total_cents, use_installments: true, line_item_count: line_items.length },
          dedupeKey: `initiated:${session.id}:${regId}`,
        });
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
          platform_fee_cap_cents,
          platform_fee_floor_cents,
          fee_pass_through,
          stripe_fee_payer,
          active_registration_term,
          instructor_pay_model,
          stripe_charge_model
        )
      `)
      .eq('id', registration_ids[0])
      .single();
    const orgIdStd = regForOrgStd?.organization_id || null;
    const orgConfigStd = (regForOrgStd?.organizations ?? null) as ConnectOrgConfig | null;
    const orgTermStd = (regForOrgStd?.organizations as { active_registration_term?: string | null } | null)?.active_registration_term ?? '';

    // ── PAYMENT GATE: no Stripe, no charge ────────────────────────────────
    // Without a connected account buildConnectChargeParams returns {}, which is
    // a PLAIN PLATFORM CHARGE — the family pays successfully and the money lands
    // in the ENROPS balance, not the provider's, with no transfer and nothing
    // linking it back to them. That is a silent mis-routing of someone else's
    // revenue, so it is refused here rather than nudged.
    //
    // This is the AUTHORITATIVE check (the UI block is only a courtesy). It runs
    // AFTER the org row is reloaded server-side, so a tampered client can't
    // bypass it. Connected orgs (J2S and every live provider) are unaffected.
    if (!orgConfigStd?.stripe_charges_enabled) {
      console.warn(
        `[create-checkout] BLOCKED: org ${orgIdStd ?? '(unknown)'} has no Stripe account accepting charges. ` +
        `Refusing to route this payment to the platform balance.`,
      );
      return json({
        error: 'This provider is not set up to take payments yet. Please contact them directly.',
        code: 'stripe_not_connected',
      }, 409);
    }

    // The family picks card vs bank transfer BEFORE redirecting (passed as
    // payment_method), so we build a SINGLE-method Checkout Session and compute
    // the fee for exactly that method. This is required for correctness: a Session
    // sets application_fee_amount ONCE, before the customer chooses, and card vs
    // ACH carry very different Stripe-fee recovery (card ~2.9%+30¢ vs ACH ~0.8%,
    // $5 cap). Offering both in one session would over- or under-collect on the
    // method that wasn't used to compute the fee. Default to card; installments
    // are always card-only (handled above, off-session ACH debits out of scope).
    const selectedMethod: 'card' | 'us_bank_account' =
      payment_method === 'us_bank_account' ? 'us_bank_account' : 'card';

    // THE TWO FEE BASES ARE DIFFERENT, DELIBERATELY (Jessica, 2026-09-08):
    //
    //   enrops margin      -> total_cents ONLY. Enrops takes nothing off a gift.
    //   Stripe-fee uplift  -> total_cents + the gift. Stripe charges its fee on
    //                         the WHOLE charge; leaving the gift out of the base
    //                         would make Enrops eat ~2.9% of every donation on a
    //                         destination charge (which is what J2S is).
    //
    // buildChargeRouting already has the lever for exactly this shape:
    // marginOverrideCents replaces the margin component and leaves the uplift
    // computed on the amount passed in. Using it, rather than a second fee
    // calculation here, is what keeps the rule in ONE place.
    //
    // With no gift, chargeBase === total_cents and the override equals what the
    // function would have computed anyway, so every existing charge is
    // byte-for-byte unchanged.
    const chargeBaseStd = total_cents + gift.chargedCents;
    const marginBaseStd = gift.chargedCents > 0 && orgConfigStd
      ? computePlatformFee(total_cents, selectedMethod, orgConfigStd)
      : undefined;
    const routingStd = buildChargeRouting(chargeBaseStd, selectedMethod, orgConfigStd, orgIdStd, marginBaseStd);
    if (routingStd.blocked) {
      console.warn(`[create-checkout] BLOCKED (direct): ${routingStd.blocked}`);
      return json({
        error: 'This provider is not set up to take payments yet. Please contact them directly.',
        code: 'stripe_not_connected',
      }, 409);
    }
    const connectParamsStd = routingStd.params;
    // undefined (never {}) for a destination org — the platform-scoped call
    // this always made. See the installments branch above for why {} breaks.
    const acctStd = routingStd.requestOptions;

    // Pass-through: when the operator opts in (fee_pass_through), add the platform
    // fee as a visible "Platform fee" line so the family covers it — computed for
    // the SAME method as application_fee_amount above, so the two always agree.
    if (orgConfigStd) {
      // total_cents, NOT chargeBaseStd. A pass-through org's families must not
      // be charged an enrops service fee on top of their own donation - the
      // margin base and this line are the same number by construction.
      const feeLineStd = passThroughLineItem(total_cents, selectedMethod, orgConfigStd);
      if (feeLineStd) stripeLineItems.push(feeLineStd);
    }

    // The gift line goes on LAST, after the price guard has already compared
    // line_items against the registration rows and after the fee line is placed,
    // so it reads at the bottom of the Stripe page the way it reads on StepPay.
    const giftLine = scholarshipLineItem(gift, orgConfigStd?.name ?? null);
    if (giftLine) stripeLineItems.push(giftLine);

    // C1: every charge carries accounting-sync metadata so external Stripe→QBO
    // connectors can categorize it. Metadata lands on payment_intent_data so it
    // reaches the CHARGE (what connectors read), not just the session. Session
    // metadata below is unchanged (the webhook reads that). Metadata is always
    // present, so payment_intent_data is always non-empty (no empty-object risk).
    const piData = {
      ...connectParamsStd,
      metadata: {
        registration_ids: registration_ids.join(','),
        enrops_org_id: orgIdStd ?? '',
        enrops_record_type: 'registration',
        enrops_term: orgTermStd,
      },
    };

    const session = await stripe.checkout.sessions.create({
      // Single method, chosen by the family up front, so application_fee_amount
      // (set above with selectedMethod) matches what Stripe actually charges.
      // us_bank_account requires a Customer to store the debit mandate, so
      // customer_creation:'always' below covers the ACH case.
      payment_method_types: [selectedMethod],
      line_items: stripeLineItems,
      mode: 'payment',
      customer_email: parent_email,
      customer_creation: 'always',
      success_url: `${base}${successPath}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}${cancelPath}`,
      metadata: {
        registration_ids: registration_ids.join(','),
        parent_email,
        parent_name: parent_name || '',
        // Read by stripe-webhook to decide whether to look for a donation row
        // at all, and by the receipt so its line items add up to the total.
        // Empty string (not '0') when there is no gift, so the webhook's
        // existing metadata parsing sees nothing new.
        donation_gift_cents: gift.giftCents > 0 ? String(gift.giftCents) : '',
        donation_covered_fee_cents: gift.coveredFeeCents > 0 ? String(gift.coveredFeeCents) : '',
      },
      payment_intent_data: piData,
    }, acctStd);

    // Record WHERE this charge lives, before the family is redirected. See the
    // installments branch above for why this is written now instead of being
    // derived later from the org's current stripe_charge_model.
    const { error: chargeRefErrStd } = await adminStd
      .from('registrations')
      .update({
        stripe_checkout_session_id: session.id,
        stripe_charge_account_id: acctStd?.stripeAccount ?? null,
      })
      .in('id', registration_ids);
    if (chargeRefErrStd) {
      // Same reasoning as the installments branch: an unrecorded session leaves
      // checkout-session-status unable to scope a direct org's lookup, and it
      // fails OPEN to paid:true. Expire and make them retry.
      console.error('[create-checkout] failed to record charge account:', chargeRefErrStd);
      try {
        await stripe.checkout.sessions.expire(session.id, acctStd);
      } catch (expireErr) {
        console.error('Failed to expire unrecorded session:', expireErr);
      }
      return json({ error: 'Could not start checkout. Please try again.' }, 500);
    }

    // The gift's ledger row, written BEFORE the family reaches Stripe and
    // settled by the webhook. Pending, because nothing has been paid yet.
    //
    // A failed insert EXPIRES the session rather than letting the charge go
    // ahead. That is the safe direction: an unrecorded gift is money taken with
    // no row to credit the fund, findable afterwards only by reading Stripe by
    // hand. Blocking costs the family one retry.
    if (gift.chargedCents > 0) {
      const { error: giftErr } = await adminStd.from('donations').insert({
        organization_id: orgIdStd,
        gift_cents: gift.giftCents,
        covered_fee_cents: gift.coveredFeeCents,
        status: 'pending',
        source: 'checkout',
        donor_email: parent_email || null,
        donor_name: parent_name || null,
        registration_ids,
        stripe_checkout_session_id: session.id,
        stripe_charge_account_id: acctStd?.stripeAccount ?? null,
      });
      if (giftErr) {
        console.error('[create-checkout] failed to record donation:', giftErr);
        try {
          await stripe.checkout.sessions.expire(session.id, acctStd);
        } catch (expireErr) {
          console.error('Failed to expire session after donation insert failure:', expireErr);
        }
        return json({ error: 'Could not add your donation right now. Please try again.' }, 500);
      }
    }

    // intelligence: log enrollment initiated (one per registration; fail-safe, never blocks)
    for (const regId of registration_ids) {
      await logEnrollmentEvent(adminStd, {
        actionType: ENROLLMENT_ACTIONS.INITIATED,
        organizationId: orgIdStd,
        registrationId: regId,
        metadata: { total_cents, use_installments: false, line_item_count: line_items.length },
        dedupeKey: `initiated:${session.id}:${regId}`,
      });
    }

    return json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('create-checkout error:', err);
    return json({ error: (err as Error).message }, 500);
  }
});
