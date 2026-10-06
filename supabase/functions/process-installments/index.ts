// process-installments v8 — daily cron worker that charges due installments off-session.
//
// v8 CHANGE (2026-07-27): organization_id is part of the grouping key.
//   A Stripe Customer is NOT unique per org — for destination orgs
//   create-checkout dedupes customers platform-wide by email, so one parent
//   using the same email with two operators gets the SAME cus_... on both orgs'
//   installment rows. The old (customer, installment_number) key merged them
//   into one group and charged the total with groupRows[0]'s Connect routing,
//   sending the second operator's revenue to the first operator's account.
//   Verified 2026-07-27 that NO such rows exist in staging or prod, so this is
//   preventative, not a repair. A parent enrolled with two operators now sees
//   one charge per operator per installment, which is correct — they are two
//   different merchants.
//
// v7 CHANGE (2026-07-27): Stripe direct charges (migration Phase 2).
//   Routing now comes from buildChargeRouting(organizations.stripe_charge_model):
//     'destination' (J2S + every pre-existing org) — UNCHANGED: same overlay,
//        same platform-scoped paymentIntents.create.
//     'direct' — the PaymentIntent is created ON the connected account, which is
//        where the saved Customer + card live (create-checkout put them there),
//        and application_fee_amount is margin only with no Stripe-fee uplift.
//   A direct org whose account isn't chargeable now PAUSES the rows and alerts,
//   instead of falling through to a platform charge.
//
// v6 CHANGE (2026-05-27): Stripe Connect destination charges.
//   When the org has an active connected account, each PaymentIntent now
//   includes application_fee_amount, transfer_data.destination, and
//   statement_descriptor_suffix (via shared buildConnectChargeParams helper).
//   Fee is computed at charge time against current org rate config — NO
//   snapshot. A rate change between installments will change the parent's
//   net fee on the remaining installments. Documented v1 risk.
//
//   Idempotency note: the idempotency key is unchanged
//   (installment_group_<sorted_row_ids>). If the cron retries a failed
//   group AND Jessica changes the platform fee rate between attempts,
//   Stripe will reject the retry because the amount/fee differs from the
//   first attempt with the same key. Accept this risk for v1; fix with a
//   per-charge snapshot if rate changes become common.
//
// v5 CHANGE (2026-05-01): Earliest-date grouping. When pending installments span
// different due_dates within the same parent + installment_number (e.g., 2-child
// cart with different program start dates), we now group them by
// (stripe_customer_id, installment_number) — IGNORING due_date — and charge them
// together on the earliest due_date in the group. This means parents always see
// exactly 3 charges total regardless of how many children or how staggered their
// program dates are. (v8 narrows this to 3 charges PER OPERATOR: the key now
// includes organization_id, because two operators are two merchants.)
//
// Trigger logic: when ANY row in a group has due_date <= today, the WHOLE group
// is charged together. We collect slightly earlier than the latest published
// per-row due_date (acceptable: contractual schedule was "3 installments by
// [latest_date]"; collecting earlier than that is fine).
//
// v4 CHANGE: Option X aggregation (group by exact (customer, due_date, installment#)).
// v3 CHANGE: Parent decline notice emails. Dedup via parent_notified_failed_at.
// v2 CHANGE: Multi-tenant alert email lookup.
//
// FLOW:
// 1. Find pending installments with due_date <= today (the "trigger set").
// 2. For each row in the trigger set, pull ALL pending sibling rows from the
//    same parent + same installment_number (across all due_dates) — these are
//    the rows that will be charged TOGETHER.
// 3. Group by (organization_id, stripe_customer_id, installment_number).
// 4. For each group:
//    a. Fetch program statuses for all rows. Pause any rows whose program is cancelled.
//    b. If the active subset is empty, skip. Otherwise charge the SUM of active rows
//       in one Stripe paymentIntent (idempotency key = group ID).
//    c. On success: mark all active rows paid, store same payment_intent_id on each.
//    d. On failure: mark all active rows paused_card_failed, notify parent once.
//
// AUTH: invoked from pg_cron via pg_net. JWT not required.
// IDEMPOTENCY: Group ID = `installment_group_<sorted_row_ids_joined>` to prevent
// double-charging if the cron retries.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { buildChargeRouting, ConnectOrgConfig, resolvePlanRouting } from '../_shared/connectChargeParams.ts';
import { runUpliftTrueUp } from '../_shared/upliftTrueUp.ts';
import { UPLIFT_METADATA_KEY } from '../_shared/chargeFeeFacts.ts';
import { allocateCartFeeByLine } from '../_shared/cartFee.ts';
import { withResolvedFee, loadPlatformFeeDefaults } from '../_shared/feeConfig.ts';
import { loadOrgBrand, formatFromAddress, OrgBrand } from '../_shared/orgBrand.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
// FROM/reply-to addresses are loaded per-org via loadOrgBrand() with Enrops
// platform defaults baked in. No more J2S-flavored env-var fallback.
//
// Alert RECIPIENTS are a different question and deliberately do NOT work that
// way: every per-org alert in this file names a family (their card decline,
// their payment plan, their email address), so it routes to that tenant's own
// inbox - brand.tenant_alert_email, which has no platform step - or is refused
// by sendOperatorAlert. The only thing still addressed to the platform is the
// top-level crash notice, which carries no tenant at all, and it now uses the
// platform brand's own alert address rather than a hardcoded literal so it
// reaches a mailbox that exists.
const CRON_SECRET = Deno.env.get('CRON_SECRET');

interface InstallmentRow {
  id: string;
  registration_id: string;
  installment_number: number;
  amount_cents: number;
  due_date: string;
  status: string;
  stripe_customer_id: string;
  stripe_payment_method_id: string;
  organization_id: string;
  parent_notified_failed_at: string | null;
  /** Stripe account this plan's charges live on. null = the platform. */
  stripe_charge_account_id: string | null;
  /**
   * For a plan on the platform, the connected account its charges transfer TO,
   * frozen at checkout. Routing reads this instead of the org's current account,
   * so changing how an org takes payments cannot redirect or strand a plan a
   * family already authorised.
   * null = not recorded (a row from before this shipped); falls back to the
   * org's current account, which is the behaviour those rows already had.
   */
  stripe_transfer_destination_id: string | null;
  /**
   * What the FAMILY agreed to at checkout, not the org's setting today. Honoured
   * over live config so a later toggle cannot reprice a plan in flight.
   * null = not recorded (a row from before the snapshot shipped); falls back to
   * live config, which is the behaviour those rows already had.
   */
  fee_pass_through: boolean | null;
}

interface ProgramRow {
  id: string;
  curriculum: string;
  status: string;
}

interface ParentRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
}

serve(async (req) => {
  if (CRON_SECRET) {
    const headerSecret = req.headers.get('X-Cron-Secret');
    if (headerSecret !== CRON_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const today = new Date().toISOString().slice(0, 10);
  const summary = {
    found: 0,
    groups: 0,
    charged_groups: 0,
    charged_rows: 0,
    paused_cancelled: 0,
    paused_card_failed_groups: 0,
    paused_card_failed_rows: 0,
    parents_notified: 0,
    errors: 0,
    details: [] as string[],
  };

  try {
    // STEP 1: Find the "trigger set" — pending rows with due_date <= today.
    // These are the rows that ARE due. We use them to identify which (customer,
    // installment_number) groups need processing today.
    const { data: triggerSet, error: queryErr } = await admin
      .from('installments')
      .select('*')
      .eq('status', 'pending')
      .lte('due_date', today);

    if (queryErr) {
      console.error('Failed to query due installments:', queryErr);
      return jsonResp({ error: queryErr.message }, 500);
    }

    summary.found = triggerSet?.length || 0;
    console.log(`Found ${summary.found} due installments (trigger set) for ${today}`);

    if (!triggerSet || triggerSet.length === 0) {
      return jsonResp({ ok: true, summary });
    }

    // STEP 2: For each (org, customer_id, installment_number) in the trigger set,
    // pull ALL pending sibling rows from that group — even ones with
    // due_date > today. These get charged together. (v5 earliest-date grouping.)
    //
    // v8: organization_id is part of the key. It has to be, because a Stripe
    // Customer is NOT unique per org: for destination orgs create-checkout
    // dedupes customers PLATFORM-WIDE by email (stripe.customers.list({email})
    // with no account scope), so one parent registering the same email with two
    // different operators gets the SAME cus_... written into both orgs'
    // installment rows. Without organization_id in the key those rows merged
    // into a single group and were charged as ONE PaymentIntent using
    // groupRows[0]'s org config — routing the second operator's revenue into
    // the first operator's connected account. A group must never span orgs.
    //
    // Consequence, and it is the correct one: a parent enrolled with two
    // operators now sees one charge per operator per installment. They are two
    // different merchants; a single combined charge was never right.
    // ROUTING IS PART OF THE KEY FOR THE SAME REASON THE ORG IS. A group is
    // charged as ONE PaymentIntent, and a PaymentIntent has exactly one
    // transfer destination - so two plans that recorded DIFFERENT accounts can
    // no more share a charge than two operators can. A returning parent whose
    // operator changed connected accounts between their two registrations has
    // exactly that: plan 1 recorded the old account, plan 2 the new one, and
    // both are individually perfectly chargeable.
    //
    // Splitting them is the fix; demanding they agree is not. This file already
    // learned that once - see the fee-snapshot comment in processGroup, where
    // an earlier group-wide agreement check "deadlocked on exactly the action
    // this feature exists to make safe" and paused rows that were not even due.
    // Keying on the routing charges each plan correctly instead of charging
    // neither.
    //
    // Consequence, and it is the correct one: such a parent sees one charge per
    // destination per installment. The money is going to two different places.
    const installmentGroupKey = (r: InstallmentRow) => {
      const route = resolvePlanRouting(r.stripe_charge_account_id, r.stripe_transfer_destination_id);
      return `${r.organization_id}__${r.stripe_customer_id}__${r.installment_number}`
        + `__${route.model ?? 'unrecorded'}:${route.accountId ?? 'none'}`;
    };

    const triggerKeys = new Set<string>();
    for (const row of triggerSet as InstallmentRow[]) {
      triggerKeys.add(installmentGroupKey(row));
    }

    // Build OR filter to fetch all sibling rows — pull rows whose
    // (customer_id, installment_number) matches any trigger key.
    const triggerCustomers = [...new Set((triggerSet as InstallmentRow[]).map((r) => r.stripe_customer_id))];
    const triggerInstNums = [...new Set((triggerSet as InstallmentRow[]).map((r) => r.installment_number))];

    const { data: allCandidateRows, error: candidateErr } = await admin
      .from('installments')
      .select('*')
      .eq('status', 'pending')
      .in('stripe_customer_id', triggerCustomers)
      .in('installment_number', triggerInstNums);

    if (candidateErr) {
      console.error('Failed to fetch candidate sibling rows:', candidateErr);
      return jsonResp({ error: candidateErr.message }, 500);
    }

    // Filter down to only rows whose (org, customer, instNum) is in triggerKeys
    // (the .in() above is a Cartesian product across customers and inst-nums).
    // This is also what keeps another org's rows out: the .in() query is not
    // org-scoped, so a shared platform customer id pulls in the sibling org's
    // pending rows, and only this filter drops them.
    const dueInstallments = (allCandidateRows as InstallmentRow[]).filter((r) =>
      triggerKeys.has(installmentGroupKey(r)),
    );

    console.log(`Expanded to ${dueInstallments.length} rows including future-dated siblings`);

    const orgIds = [...new Set(dueInstallments.map((r) => r.organization_id))];
    const { data: orgs } = await admin
      .from('organizations')
      // alert_email is deliberately NOT selected here any more. Nothing in this
      // query's consumers may route an alert by it - the tenant inbox comes off
      // the loaded brand (brand.tenant_alert_email) instead. Leaving the column
      // in the select left `org.alert_email` sitting in scope as an inviting,
      // wrong answer for the next person editing this block.
      .select(`
        id, name, slug,
        stripe_account_id, stripe_charges_enabled,
        statement_descriptor_suffix,
        platform_fee_card_pct, platform_fee_ach_pct, platform_fee_cap_cents, platform_fee_ach_cap_cents,
        platform_fee_override_until, platform_fee_floor_cents,
        fee_pass_through, stripe_fee_payer, instructor_pay_model, stripe_charge_model
      `)
      .in('id', orgIds);

    // Kept OUT of ConnectOrgConfig deliberately. That type is shared with
    // connectChargeParams and every charge path that imports it; the slug is a
    // URL-building detail this file needs for one email, not a fact about how a
    // charge is routed. A second map costs nothing and keeps the shared type
    // about charging.
    const orgSlugMap = new Map<string, string | null>();
    const orgConfigMap = new Map<string, ConnectOrgConfig>();
    for (const org of orgs || []) {
      orgSlugMap.set(org.id, (org as { slug?: string | null }).slug ?? null);
      orgConfigMap.set(org.id, {
        stripe_account_id: org.stripe_account_id,
        stripe_charges_enabled: org.stripe_charges_enabled,
        statement_descriptor_suffix: org.statement_descriptor_suffix,
        name: org.name,
        platform_fee_card_pct: org.platform_fee_card_pct,
        platform_fee_ach_pct: org.platform_fee_ach_pct,
        platform_fee_cap_cents: org.platform_fee_cap_cents,
        platform_fee_ach_cap_cents: org.platform_fee_ach_cap_cents,
        platform_fee_override_until: org.platform_fee_override_until,
        platform_fee_floor_cents: org.platform_fee_floor_cents,
        fee_pass_through: org.fee_pass_through,
        stripe_fee_payer: org.stripe_fee_payer,
        instructor_pay_model: org.instructor_pay_model,
        stripe_charge_model: org.stripe_charge_model,
      });
    }

    // STEP 3: Group by (organization_id, stripe_customer_id, installment_number)
    // — NOT including due_date. That is the v5 change: rows with different
    // due_dates can land in the same group. The org component is v8 (see the
    // installmentGroupKey comment above): every row in a group must belong to ONE org,
    // because the whole group is charged with that org's Connect routing.
    const groupMap = new Map<string, InstallmentRow[]>();
    for (const row of dueInstallments) {
      const key = installmentGroupKey(row);
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(row);
    }

    summary.groups = groupMap.size;
    console.log(`Grouped into ${summary.groups} aggregated charges (v5 earliest-date grouping)`);

    // Pre-load brand for every org touched by this cron pass. Cheap (one
    // pair of queries per org) and lets each group's outgoing emails come
    // from the right tenant or fall back to Enrops platform defaults.
    const orgBrandMap = new Map<string, OrgBrand>();
    for (const oid of orgIds) {
      orgBrandMap.set(oid, await loadOrgBrand(admin, oid));
    }
    // Brand to use when we don't know which org caused a problem (top-level
    // crash). Loads Enrops defaults via slug='enrops' / hardcoded fallback.
    const platformBrand = await loadOrgBrand(admin, null);

    for (const [groupKey, groupRows] of groupMap.entries()) {
      const orgId = groupRows[0].organization_id;
      const orgConfig = orgConfigMap.get(orgId) || null;
      const brand = orgBrandMap.get(orgId) || platformBrand;
      // The tenant's own inbox, or null. Read off the brand we already loaded
      // rather than re-deriving the tenant -> org.email chain from a second
      // query: two implementations of one address is how they drift apart.
      // Null means "this provider has no inbox"; sendOperatorAlert refuses.
      //
      // NOTE the `|| platformBrand` above: when an org's brand is missing we
      // fall back to the PLATFORM brand for FROM/colors, whose
      // tenant_alert_email is null - so the alert is refused rather than
      // addressed to Enrops. That is the intended reading, not an accident.
      const alertEmail = brand.tenant_alert_email;
      try {
        await processGroup(admin, groupRows, summary, alertEmail, orgConfig, brand, orgSlugMap.get(orgId) ?? null);
      } catch (err) {
        console.error(`Unhandled error for group ${groupKey}:`, err);
        summary.errors++;
        summary.details.push(`ERR group ${groupKey}: ${(err as Error).message}`);
        await sendOperatorAlert({
          brand,
          to: alertEmail,
          subject: `Cron worker error on installment group`,
          body: `Unhandled error processing group ${groupKey} (${groupRows.length} rows): ${(err as Error).message}\n\nRow IDs: ${groupRows.map((r) => r.id).join(', ')}\n\nGroup will be retried tomorrow.`,
        });
      }
    }

    return jsonResp({ ok: true, summary });
  } catch (err) {
    console.error('process-installments fatal error:', err);
    // No org context at top-level crash — use Enrops platform defaults.
    const fatalBrand = await loadOrgBrand(admin, null).catch(() => null);
    if (fatalBrand) {
      await sendOperatorAlert({
        brand: fatalBrand,
        // The one genuinely PLATFORM-owned notice in this file: the worker
        // crashed before it knew which org it was working on, so the body
        // contains no tenant data - just our own stack message. It therefore
        // uses the cascading alert_email, which is the correct address for a
        // platform notice. It was a hardcoded 'alerts@enrops.com', a mailbox
        // never confirmed to exist, so our own crash alert may have been going
        // nowhere; the cascade resolves to a real one.
        to: fatalBrand.alert_email,
        subject: 'Cron worker FATAL error',
        body: `process-installments crashed: ${(err as Error).message}\n\nNo installments were processed today. Manual investigation required.`,
      });
    }
    return jsonResp({ error: (err as Error).message }, 500);
  }
});

// `ReturnType<typeof createClient>` picks up createClient's DEFAULT generics
// (<unknown, never, GenericSchema>), NOT the <any, 'public', any> the caller at
// line ~289 actually has. The two are not assignable, so the parameter type
// collapsed and every .select() inside this function came back as
// SelectQueryError - which is why `r.id` below was reported as not existing.
// Pinning the param to the schema the caller really has fixes both errors at
// the root instead of casting each read. Same defect and same fix as
// stripe-connect-instructor-webhook.
type AdminClient = SupabaseClient<any, 'public', any>;

async function processGroup(
  admin: AdminClient,
  groupRows: InstallmentRow[],
  summary: any,
  // The tenant's own inbox, or null when this provider has none. Passed down
  // rather than re-derived so every alert in this group agrees on where it goes.
  alertEmail: string | null,
  orgConfig: ConnectOrgConfig | null,
  brand: OrgBrand,
  // The tenant's portal slug, for the card-update link in the parent's decline
  // email. Passed down for the same reason alertEmail is: derived once, so
  // every message about this group points at the same place.
  orgSlug: string | null,
) {
  // Fetch registration + program + parent data for all rows in the group
  const regIds = groupRows.map((r) => r.registration_id);
  const { data: regsData } = await admin
    .from('registrations')
    .select('id, program_id, parent_id, students(first_name, last_name), programs(id, curriculum, status), parents(email, first_name, last_name)')
    .in('id', regIds);

  if (!regsData || regsData.length === 0) {
    console.error(`No registrations found for group rows ${regIds.join(', ')}`);
    for (const row of groupRows) {
      await admin.from('installments').update({
        status: 'paused_card_failed',
        failure_reason: 'Linked registration not found',
        last_attempt_at: new Date().toISOString(),
      }).eq('id', row.id);
      summary.errors++;
      summary.details.push(`ERR ${row.id}: missing registration`);
    }
    return;
  }

  // Map registration_id → program/parent data for lookup
  const regDataById = new Map<string, any>();
  for (const r of regsData) regDataById.set(r.id, r);

  // Partition rows: those whose program is cancelled vs active
  const activeRows: InstallmentRow[] = [];
  const cancelledRows: InstallmentRow[] = [];
  let parent: ParentRow | undefined;

  for (const row of groupRows) {
    const regData = regDataById.get(row.registration_id);
    if (!regData) {
      // Treat as error per row
      await admin.from('installments').update({
        status: 'paused_card_failed',
        failure_reason: 'Linked registration not found',
        last_attempt_at: new Date().toISOString(),
      }).eq('id', row.id);
      summary.errors++;
      summary.details.push(`ERR ${row.id}: missing registration`);
      continue;
    }
    parent = parent || (regData.parents as ParentRow);
    const program = regData.programs as ProgramRow;
    if (program?.status === 'cancelled') {
      cancelledRows.push(row);
    } else {
      activeRows.push(row);
    }
  }

  // Pause cancelled rows + alert operator
  for (const row of cancelledRows) {
    const regData = regDataById.get(row.registration_id);
    const program = regData.programs as ProgramRow;
    await admin.from('installments').update({
      status: 'paused_program_cancelled',
      last_attempt_at: new Date().toISOString(),
    }).eq('id', row.id);
    summary.paused_cancelled++;
    summary.details.push(`PAUSED ${row.id}: program ${program.curriculum} cancelled`);
    await sendOperatorAlert({
      brand,
      to: alertEmail,
      subject: `Installment paused — ${program.curriculum} cancelled`,
      body: buildCancelledAlertBody({ row, program, parent }),
    });
  }

  // If no active rows remain in the group, skip the charge entirely
  if (activeRows.length === 0) {
    return;
  }

  // Aggregate: one Stripe charge for the sum of active rows
  const totalAmount = activeRows.reduce((s, r) => s + r.amount_cents, 0);
  const customerId = activeRows[0].stripe_customer_id;
  const paymentMethodId = activeRows[0].stripe_payment_method_id;
  const installmentNumber = activeRows[0].installment_number;

  // Idempotency key: stable across cron retries.
  // Sort row IDs to ensure consistent ordering even if query order changes.
  const sortedRowIds = activeRows.map((r) => r.id).sort();
  const idempotencyKey = `installment_group_${sortedRowIds.join('_')}`;

  // Description: name all the children/programs aggregated in this charge
  const desc = activeRows.map((r) => {
    const rd = regDataById.get(r.registration_id);
    const prog = rd?.programs as ProgramRow | undefined;
    const stu = rd?.students as { first_name?: string } | undefined;
    return `${stu?.first_name || 'child'} (${prog?.curriculum || 'program'})`;
  }).join(', ');

  // v7 (Phase 2): charge routing. Spreads into top-level paymentIntents.create
  // params (NOT under payment_intent_data — that nesting only applies to
  // Checkout Sessions).
  //   destination org (J2S + all pre-existing): the same overlay as v6
  //     (application_fee_amount + transfer_data + descriptor suffix), and
  //     `acct` is undefined (never {}) — the platform-scoped call this cron
  //     always made.
  //   direct org: margin-only fee, and the PaymentIntent is created ON the
  //     connected account, where the saved Customer + payment method live.
  // ── cart-level fee, split across installments ───────────────────────────
  // The platform fee is capped once per checkout, not per charge (Jessica
  // 2026-07-27: "$7.99 per reg"). Recomputing it from THIS charge's amount
  // would let a $500 program collect the cap three times. So rebuild the full
  // schedule, apply the org's rate/floor/cap ONCE to the total, and take this
  // installment's share. Below the cap the numbers are identical to before.
  const groupRegIds = [...new Set(activeRows.map((r) => r.registration_id))];

  // The cart is every registration that went through the SAME checkout session,
  // not just the ones with a row due today. Deriving it from activeRows alone
  // made the cap base shrink whenever part of a cart stopped being chargeable
  // (a cancelled sibling program), so charges 2/3 capped over a smaller total
  // than charge 1 was quoted against. registrations.stripe_checkout_session_id
  // is the authoritative link. Legacy rows predate that column and fall back to
  // the group, which is what they always were.
  const { data: sessionRows, error: sessionErr } = await admin
    .from('registrations')
    .select('stripe_checkout_session_id')
    .in('id', groupRegIds);
  const sessionIds = [...new Set(
    (((sessionRows ?? []) as unknown) as Array<{ stripe_checkout_session_id: string | null }>)
      .map((r) => r.stripe_checkout_session_id)
      .filter((s): s is string => !!s),
  )];

  let cartRegIds = groupRegIds;
  let siblingErr: unknown = null;
  if (sessionIds.length) {
    const { data: siblingRows, error: sErr } = await admin
      .from('registrations')
      .select('id')
      .in('stripe_checkout_session_id', sessionIds);
    siblingErr = sErr;
    cartRegIds = [...new Set([
      ...groupRegIds,
      ...(((siblingRows ?? []) as unknown) as Array<{ id: string }>).map((r) => r.id),
    ])];
  }

  const { data: allInstRows, error: instErr } = await admin
    .from('installments')
    .select('id, registration_id, installment_number, amount_cents, created_at')
    .in('registration_id', cartRegIds);

  // Fail CLOSED on any of the three reads. Without them the fee can only be
  // rebuilt from this charge's own amount, which is exactly the per-charge
  // clamping this design removed - a $500 plan would quietly bill $5.00 instead
  // of its allocated ~$2.67, and pass it on to the family. A paused row that a
  // human retries beats a silent overcharge.
  if (sessionErr || siblingErr || instErr || !allInstRows) {
    const why = `could not rebuild the fee schedule (${(instErr as { message?: string } | null)?.message ?? (sessionErr as { message?: string } | null)?.message ?? (siblingErr as { message?: string } | null)?.message ?? 'no rows returned'})`;
    console.error(`[process-installments] BLOCKED: ${why}`);
    await admin.from('installments').update({
      status: 'paused_card_failed',
      failure_reason: `charge blocked: ${why}`,
      last_attempt_at: new Date().toISOString(),
    }).in('id', activeRows.map((r) => r.id).sort());
    summary.paused_card_failed_groups++;
    summary.paused_card_failed_rows += activeRows.length;
    summary.errors++;
    summary.details.push(`BLOCKED group (fee schedule unreadable): ${activeRows.length} rows`);
    await sendOperatorAlert({
      brand,
      to: alertEmail,
      subject: 'Installment charge held — could not confirm the fee',
      body: `${activeRows.length} installment row(s) were NOT charged and are now paused.\n\nWe could not read the full payment plan to work out the correct service fee, and we will not guess at a number a family already agreed to. Nothing was charged.\n\nThis is usually temporary — set the rows back to pending to retry.\n\nRow IDs: ${activeRows.map((r) => r.id).join(', ')}`,
    });
    return;
  }

  // The fee is PER REGISTRATION LINE, split across that registration's own
  // installments. Money layer section 4: "applied to the line, not the cart"
  // and "No cart-level maximum."
  //
  // THIS REVERSES WHAT WAS HERE, and the old comment's worry is worth keeping
  // in view rather than deleting. It said capping per registration would make
  // charge 1 and charges 2/3 disagree on a multi-child cart. That was true of
  // the shape it had - a cart fee split across a flat list of every row - but
  // it is not true of this one. Each registration's fee is split across only
  // its own charges, so charge 1 and charges 2/3 of a given registration agree
  // by construction, and neither of them depends on what else was in the cart.
  // The agreement problem did not move; it went away.
  //
  // A cart's registrations share a Stripe Customer, so they land in this same
  // group; groupRegIds IS the cart. Ordering within a registration is by
  // installment number so the leftover cent lands on charge 1, matching
  // checkout - allocateCartFeeByLine owns that rule now.
  type FeeRow = {
    id: string; registration_id: string; installment_number: number;
    amount_cents: number; created_at?: string | null;
  };
  const cartRows = ((allInstRows ?? []) as unknown) as FeeRow[];

  // AS OF THE PLAN'S START, NOT TODAY. Money layer section 4: "Existing plans
  // finish as agreed", and section 11: "Nothing changes on an existing payment
  // plan."
  //
  // This matters now in a way it did not before. The fee has always been
  // computed against LIVE org config at charge time - documented at the top of
  // this file as a v1 risk, and harmless while nobody ever edited a rate. An
  // END DATE makes that edit happen by itself, on a schedule: the day an
  // organisation's negotiated terms lapse, a family already two charges into a
  // three-charge plan would be billed the new rate for the rest of it, having
  // agreed to the old one on screen.
  //
  // A plan's three rows are written together at checkout - verified on prod,
  // where one plan's rows share a created_at to the microsecond - so the
  // earliest of them IS when the family agreed. Resolving the expiry against
  // that date means an expiry can never land mid-plan.
  //
  // WHAT THIS DOES NOT FIX, so nobody reads more into it: only the end DATE is
  // evaluated as of the plan's start. The org's own columns are still read
  // live, so somebody editing a rate by hand today still reprices charges 2
  // and 3 - exactly the v1 risk noted at the top of this file. That needs a
  // per-plan snapshot of the numbers and is a bigger change than this one. The
  // end date is handled because the end date is the part that now moves on its
  // own, with nobody watching.
  //
  // Falls back to now() when created_at is missing, which is the old behaviour.
  const planStartedAt = cartRows
    .map((r) => (r.created_at ? Date.parse(r.created_at) : NaN))
    .filter((t) => Number.isFinite(t))
    .reduce((min, t) => (t < min ? t : min), Infinity);
  const feeAsOf = Number.isFinite(planStartedAt) ? new Date(planStartedAt) : new Date();
  const orgFeeConfig = orgConfig
    ? withResolvedFee(orgConfig, await loadPlatformFeeDefaults(admin), feeAsOf)
    : null;

  const shareByRow = orgFeeConfig
    ? allocateCartFeeByLine(
      cartRows.map((r) => ({
        id: r.id,
        registrationId: r.registration_id,
        installmentNumber: r.installment_number,
        amountCents: r.amount_cents,
      })),
      'card',
      orgFeeConfig,
    )
    : new Map<string, number>(cartRows.map((r) => [r.id, 0]));

  // This charge's margin = the sum of the shares of the rows it covers. Every
  // active row MUST be in shareByRow: the reload selected by registration id,
  // and these rows have those ids. There is deliberately NO per-row fallback —
  // the obvious one (recompute on this row's amount) is the per-charge clamping
  // this design exists to remove, so it would silently reintroduce the bug.
  const missingShare = activeRows.filter((r) => !shareByRow.has(r.id));
  if (missingShare.length) {
    const why = `fee schedule is missing ${missingShare.length} of the ${activeRows.length} row(s) being charged`;
    console.error(`[process-installments] BLOCKED: ${why}`, missingShare.map((r) => r.id));
    await admin.from('installments').update({
      status: 'paused_card_failed',
      failure_reason: `charge blocked: ${why}`,
      last_attempt_at: new Date().toISOString(),
    }).in('id', activeRows.map((r) => r.id).sort());
    summary.paused_card_failed_groups++;
    summary.paused_card_failed_rows += activeRows.length;
    summary.errors++;
    summary.details.push(`BLOCKED group (incomplete fee schedule): ${activeRows.length} rows`);
    await sendOperatorAlert({
      brand,
      to: alertEmail,
      subject: 'Installment charge held — could not confirm the fee',
      body: `${activeRows.length} installment row(s) were NOT charged and are now paused.\n\nWe could not work out the correct service fee for part of this payment plan, and we will not guess at a number a family already agreed to. Nothing was charged.\n\nRow IDs: ${activeRows.map((r) => r.id).join(', ')}`,
    });
    return;
  }

  const groupMargin = activeRows.reduce((s, r) => s + (shareByRow.get(r.id) as number), 0);

  // A GROUP IS NOT A CART. installmentGroupKey is
  // organization_id__stripe_customer_id__installment_number, and create-checkout
  // dedupes the Stripe Customer platform-wide by email — so one parent who
  // registers twice has BOTH plans in the same group, from two separate
  // checkouts, and their snapshots legitimately differ if the operator flipped
  // the toggle in between.
  //
  // An earlier version of this demanded group-wide agreement and paused the
  // group when it did not find it. That deadlocked on exactly the action this
  // feature exists to make safe: flip the toggle, take a second registration
  // from a returning parent, and both plans stop charging forever, retry after
  // retry. It also paused a row that was not even due yet.
  //
  // Per row is both simpler and more correct. Each row already has its own share
  // of the cart fee in shareByRow (every active row is guaranteed present — the
  // missingShare block above returns otherwise), so each one contributes its own
  // share only if ITS family agreed to pay the fee. Mixed groups now charge each
  // family exactly what they signed up for instead of charging nobody.
  //
  // `?? orgConfig` covers rows written before the snapshot shipped: they behave
  // as they did, rather than defaulting to "no fee" and quietly paying the
  // operator less than the family agreed to.
  const passFeeForRow = (r: InstallmentRow) =>
    (r.fee_pass_through ?? orgConfig?.fee_pass_through ?? false)
      ? (shareByRow.get(r.id) as number)
      : 0;

  // The PLAN's own history wins over the org's CURRENT stripe_charge_model.
  // This matters because the saved Customer and card are on whichever account
  // charge 1 used, and an operator who moves to direct charges gets a BRAND NEW
  // connected account (controller.fees.payer can never be changed on an
  // existing one). Routing charges 2 and 3 by the org's current model would aim
  // them at an account that has never seen this card.
  //
  // TWO facts are stamped at checkout, and they are not interchangeable:
  //   stripe_charge_account_id        the account a DIRECT charge was created
  //                                   ON. The saved card lives there.
  //   stripe_transfer_destination_id  the account a PLATFORM charge transferred
  //                                   TO. The card is on the platform; only the
  //                                   money moves.
  // A row carrying neither predates both columns, and only then is the plan's
  // routing genuinely unknown. resolvePlanRouting owns that meaning so this
  // file and any future caller cannot spell it differently; it is unit-tested
  // in connectChargeParams.test.ts.
  const planRouting = resolvePlanRouting(
    activeRows[0].stripe_charge_account_id,
    activeRows[0].stripe_transfer_destination_id,
  );
  const recordedAcct = planRouting.model === 'direct' ? planRouting.accountId : null;
  const orgIsDirect = orgConfig?.stripe_charge_model === 'direct';

  if (orgIsDirect && planRouting.model === null) {
    // The org is on direct charges and this plan recorded NEITHER routing fact,
    // so it predates both columns and we cannot safely guess: charging it as
    // 'direct' would use the new account (no card there), and charging it as
    // 'destination' would transfer to the new account rather than wherever the
    // original charge settled. A human has to decide. Fail closed.
    //
    // A plan that recorded a transfer destination does NOT land here - it knows
    // exactly where its money goes and finishes as the family authorised.
    const why = `org ${activeRows[0].organization_id} is now stripe_charge_model=direct but this installment plan recorded no routing (neither stripe_charge_account_id nor stripe_transfer_destination_id) - it predates the switch`;
    console.error(`[process-installments] BLOCKED: ${why}`);
    await admin.from('installments').update({
      status: 'paused_card_failed',
      failure_reason: `charge blocked: ${why}`,
      last_attempt_at: new Date().toISOString(),
    }).in('id', activeRows.map((r) => r.id).sort());
    summary.paused_card_failed_groups++;
    summary.paused_card_failed_rows += activeRows.length;
    summary.details.push(`BLOCKED group (pre-switch plan): ${activeRows.length} rows`);
    await sendOperatorAlert({
      brand,
      to: alertEmail,
      subject: `Installment charge needs review — payment setup changed mid-plan`,
      body: `${activeRows.length} installment row(s) were NOT charged and are now paused.\n\nThis family's payment plan was set up before this provider's Stripe payment setup changed, so their saved card is on the previous account. Charging it automatically could send the money to the wrong place, so we stopped and are asking a human.\n\nRow IDs: ${activeRows.map((r) => r.id).join(', ')}`,
    });
    return;
  }

  // Route by the recorded account, not the org's current model. For a plan on
  // the platform this is byte-for-byte the destination path (J2S included).
  // orgFeeConfig, not orgConfig: buildChargeRouting computes the Stripe-fee
  // uplift from these same numbers, so routing and the margin above must be
  // built from ONE config or the application fee and the shares disagree.
  //
  // The account is taken from the plan whenever the plan recorded one, and only
  // falls through to orgFeeConfig's own stripe_account_id for rows written
  // before this column existed - which is the old behaviour, unchanged, for
  // exactly the rows that used to get it.
  const routingOrg: ConnectOrgConfig | null = orgFeeConfig
    ? {
      ...orgFeeConfig,
      // An unrecorded plan falls back to 'destination', which is what it has
      // always been treated as - the direct case above already returned.
      stripe_charge_model: planRouting.model ?? 'destination',
      ...(planRouting.accountId ? { stripe_account_id: planRouting.accountId } : {}),
      // stripe_charges_enabled describes the org's CURRENT account. Once a plan
      // names its own destination, that flag is about a DIFFERENT account and
      // must not decide this charge.
      //
      // Leaving it alone looks conservative and is the opposite. When an org
      // moves to direct it mints a new account and the account.updated webhook
      // writes stripe_charges_enabled=false on the org row while that new
      // account onboards - even though the plan's OLD account is connected and
      // perfectly able to receive a transfer. buildConnectChargeParams would
      // then return {} for every one of those plans, which is how the first
      // version of this fix managed to strand the exact 163 rows the work
      // exists to save.
      //
      // So: trust the plan's account, and let Stripe be the authority on
      // whether it can still receive money. If it cannot, the transfer is
      // rejected and the charge fails loudly into the existing failure path -
      // which is strictly better than the alternative it replaces, where an
      // empty params object silently became a plain platform charge that took
      // the family's money into the Enrops balance and marked it paid.
      ...(planRouting.model === 'destination' && planRouting.accountId
        ? { stripe_charges_enabled: true }
        : {}),
    }
    : null;

  const routing = buildChargeRouting(
    totalAmount,
    'card',
    routingOrg,
    activeRows[0].organization_id,
    groupMargin,
  );

  // A plan that recorded where its money goes must actually send it there.
  //
  // buildConnectChargeParams returns {} - no transfer_data, no application fee -
  // whenever stripe_charges_enabled is false, and that flag is read from the
  // ORG row, never from the plan. Before a plan recorded its own destination,
  // such a row was caught by the pre-switch guard above and paused. Now that the
  // guard only fires for a plan with NO recorded routing, the same row would
  // sail through and create a PLAIN PLATFORM CHARGE: the family's card is
  // debited in full, every cent lands in the Enrops balance, the rows are marked
  // paid, and the only trace is a console.warn nobody reads.
  //
  // It is reachable on exactly the path this work exists to enable. Moving an
  // org to direct charges mints a new account and writes charge_model='direct'
  // BEFORE onboarding finishes, and the account.updated webhook then sets
  // stripe_charges_enabled=false on the org row - so the flip itself opens the
  // window. A verification hold or a dashboard deauthorisation does the same to
  // an org that never flipped.
  //
  // With stripe_charges_enabled forced true above for a plan that names its own
  // destination, this should now be unreachable - it is kept as a last assertion
  // that we never send a charge somewhere other than where the plan says, no
  // matter what a future edit to buildConnectChargeParams does. Compare what was
  // BUILT against what the plan RECORDED rather than re-deriving the condition,
  // so it keeps working without this file knowing why params came back empty.
  const plannedDest = planRouting.model === 'destination' ? planRouting.accountId : null;
  const builtDest = routing.params.transfer_data?.destination ?? null;
  const destinationUnmet = plannedDest && builtDest !== plannedDest
    ? `installment plan is recorded against ${plannedDest} but this charge was built to transfer to `
      + `${builtDest ?? 'nowhere (no transfer_data)'} (org ${activeRows[0].organization_id}); `
      + `charging anyway would put the family's money in the platform balance`
    : null;

  // Reading routing from activeRows[0] is safe BECAUSE routing is part of
  // installmentGroupKey: every row in this group resolved to the same account,
  // or they would not be in the same group. Do not add a group-wide agreement
  // check here - that shape is what deadlocked the fee snapshot.

  // Fail closed for direct orgs with no usable account. Charging anyway would
  // create a plain platform PaymentIntent against a customer id that doesn't
  // exist on the platform — it would fail confusingly, or worse, succeed and
  // put the operator's money in the Enrops balance. Pause and alert instead.
  const blocked = routing.blocked ?? destinationUnmet;
  if (blocked) {
    console.error(`[process-installments] BLOCKED: ${blocked}`);
    await admin.from('installments').update({
      status: 'paused_card_failed',
      failure_reason: `charge blocked: ${blocked}`,
      last_attempt_at: new Date().toISOString(),
    }).in('id', activeRows.map((r) => r.id).sort());
    summary.paused_card_failed_groups++;
    summary.paused_card_failed_rows += activeRows.length;
    summary.details.push(`BLOCKED group: ${blocked}`);
    await sendOperatorAlert({
      brand,
      to: alertEmail,
      subject: `Installment charge blocked — Stripe account not ready`,
      body: `${blocked}\n\n${activeRows.length} installment row(s) were NOT charged and are now paused. Finish Stripe onboarding, then flip the rows back to status=pending to retry.\n\nRow IDs: ${activeRows.map((r) => r.id).join(', ')}`,
    });
    return;
  }

  const connectParams = routing.params;
  const acct = routing.requestOptions;

  // Pass-through: if the family agreed to pay the fee, this installment charges
  // its base amount PLUS this charge's SHARE of the registration-level fee — the
  // exact same groupMargin used for application_fee_amount above, so what the
  // family pays and what the platform keeps always agree, and the three
  // installments together never exceed the org's per-registration cap.
  //
  // THE SNAPSHOT WINS OVER LIVE CONFIG, and that is the whole point. This used
  // to read orgConfig.fee_pass_through, so an operator flipping the toggle
  // mid-plan charged a saved card MORE than the family authorised, with no fee
  // line and no fresh consent, while their confirmation email still quoted the
  // old figure. The rows now carry what was agreed at checkout, so the toggle
  // only affects NEW registrations.
  //
  // Summed PER ROW (see passFeeForRow): when a group spans two checkouts by the
  // same parent, each plan contributes only its own agreed share. For the
  // ordinary single-plan group every row shares one snapshot, so this is exactly
  // groupMargin or exactly zero, unchanged.
  const passFee = activeRows.reduce((s, r) => s + passFeeForRow(r), 0);

  let paymentIntent: Stripe.PaymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create(
      {
        amount: totalAmount + passFee,
        currency: 'usd',
        customer: customerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description: `Installment ${installmentNumber} of 3 — ${desc}`,
        metadata: {
          installment_number: String(installmentNumber),
          installment_row_ids: sortedRowIds.join(','),
          row_count: String(activeRows.length),
          // What this charge's application fee recovered towards Stripe's
          // processing cost. Recorded because it cannot be recomputed later:
          // the uplift is sized on totalAmount, while the charge is
          // totalAmount + passFee. Read back by _shared/upliftTrueUp.ts.
          [UPLIFT_METADATA_KEY]: String(routing.upliftCents),
        },
        ...connectParams,
      },
      // acct is UNDEFINED for destination orgs (never {} — stripe-node throws
      // "Unknown arguments" on an empty options object), so spreading it here
      // leaves the unchanged platform-scoped call. Idempotency keys are scoped
      // per account, which is what we want: a direct org's retry key can't
      // collide with a platform-scoped one.
      { idempotencyKey, ...acct },
    );
  } catch (err) {
    const stripeErr = err as Stripe.errors.StripeError;
    const failureReason = stripeErr.message || 'unknown error';
    const declineCode = (stripeErr as any).decline_code || stripeErr.code || 'unknown';

    console.error(`Charge failed for group ${idempotencyKey}:`, failureReason);

    // Mark ALL active rows in this group as failed
    await admin.from('installments').update({
      status: 'paused_card_failed',
      failure_reason: `${declineCode}: ${failureReason}`,
      last_attempt_at: new Date().toISOString(),
    }).in('id', sortedRowIds);

    summary.paused_card_failed_groups++;
    summary.paused_card_failed_rows += activeRows.length;
    summary.details.push(`FAILED group ${idempotencyKey}: ${declineCode} (${activeRows.length} rows)`);

    // Operator alert (one per group, not per row)
    await sendOperatorAlert({
      brand,
      to: alertEmail,
      subject: `Card declined for ${parent?.first_name || ''} ${parent?.last_name || ''} — installment ${installmentNumber}`,
      body: buildDeclineAlertBody({
        rows: activeRows,
        regDataById,
        parent,
        declineCode,
        failureReason,
        totalAmount,
        customerId,
        connectedAccountId: routing.direct ? (orgConfig?.stripe_account_id ?? null) : null,
      }),
    });

    // Parent decline notice — only once per parent per failure (use first row's flag)
    const firstRow = activeRows[0];
    if (parent?.email && !firstRow.parent_notified_failed_at) {
      const sent = await sendParentDeclineNotice({
        brand,
        parent,
        installmentNumber,
        regDataById,
        rows: activeRows,
        orgSlug,
      });
      if (sent) {
        // Stamp ALL rows in the group so we don't re-notify
        await admin.from('installments').update({
          parent_notified_failed_at: new Date().toISOString(),
        }).in('id', sortedRowIds);
        summary.parents_notified++;
        summary.details.push(`PARENT_NOTIFIED group ${idempotencyKey}: ${parent.email}`);
      }
    }
    return;
  }

  if (paymentIntent.status === 'succeeded') {
    // Mark all active rows as paid against this single PaymentIntent
    await admin.from('installments').update({
      status: 'paid',
      stripe_payment_intent_id: paymentIntent.id,
      paid_at: new Date().toISOString(),
      last_attempt_at: new Date().toISOString(),
      // Re-stamp where this PI actually landed, so a refund of installment 2 or
      // 3 scopes itself correctly without consulting the org's current model.
      stripe_charge_account_id: recordedAcct,
      // Record the transfer destination this charge ACTUALLY used. See the
      // sibling stamp below for why this alone is not enough.
      stripe_transfer_destination_id: builtDest,
    }).in('id', sortedRowIds);

    // Money doc item 14: what enrops actually earned on THIS charge, per row,
    // using the SAME shareByRow allocation that sized application_fee_amount
    // above — not recomputed, and margin only (never the uplift a
    // pass-through org's family also covers). Per-row updates, not one
    // upsert: installments has NOT NULL columns (amount_cents, due_date,
    // installment_number) with no default, so an upsert built from only
    // {id, platform_fee_charged_cents} would fail even though every row
    // already exists and only the UPDATE half would ever run.
    for (const row of activeRows) {
      const { error: feeStampErr } = await admin
        .from('installments')
        .update({ platform_fee_charged_cents: shareByRow.get(row.id) ?? null })
        .eq('id', row.id);
      if (feeStampErr) {
        console.error('[process-installments] could not stamp platform_fee_charged_cents:', feeStampErr.message);
      }
    }

    // ...and on the REST of each plan, not only the rows we just charged.
    //
    // sortedRowIds is THIS instalment number only. Stamping there alone leaves
    // instalment 3 unrecorded and free to follow the org's account wherever it
    // moves next - so a plan that recorded nothing would still pay acct_A for
    // charge 2 and acct_B for charge 3, which is the exact split this column
    // exists to stop. The fact we just observed is true of the whole plan: same
    // registration, same saved card, same destination.
    //
    // Deliberately narrow. It fills BLANKS only (`is null`), so it can never
    // overwrite a destination somebody else observed, and it skips the two
    // terminal states, so it cannot rewrite history onto a paid or refunded row
    // whose routing we never saw. Terminal is spelled as a DENY-list for the
    // reason 20260810g gives: 'failed' and 'paused_program_cancelled' are
    // resurrectable, and an allow-list forgets them.
    //
    // Best-effort by design. A failure here leaves the siblings exactly as they
    // are today and the next instalment stamps them again, so it must never
    // fail a charge that already succeeded - but it is logged, because silence
    // is how this class of gap survives.
    if (builtDest) {
      const planRegIds = [...new Set(activeRows.map((r) => r.registration_id))].sort();
      const { error: siblingStampErr } = await admin
        .from('installments')
        .update({ stripe_transfer_destination_id: builtDest })
        .in('registration_id', planRegIds)
        .is('stripe_transfer_destination_id', null)
        // Two neq filters rather than a hand-built `not(... in ...)` tuple: the
        // tuple is a filter STRING, and a mis-quoted one does not error, it
        // just matches the wrong set - silently stamping paid history, or
        // silently nothing. These AND together and cannot be mis-parsed.
        //
        // KNOWN DIVERGENCE from the migration's predicate, which wraps the same
        // test in coalesce(status,'pending'). status is nullable, and `status <>
        // 'paid'` is NULL - not true - for a NULL status, so a null-status row
        // is skipped here and stamped there. Accepted deliberately: the miss
        // direction is safe (that row keeps today's behaviour and the next
        // instalment tries again), both databases hold zero null-status rows,
        // and the alternative is an .or() filter STRING - reintroducing exactly
        // the mis-quote hazard the two neqs exist to avoid, to cover a row that
        // does not exist. If null statuses ever become real, fix it by making
        // the column NOT NULL rather than by growing this filter.
        .neq('status', 'paid')
        .neq('status', 'refunded');
      if (siblingStampErr) {
        console.error(
          `[process-installments] could not record the destination on the rest of `
          + `${planRegIds.length} plan(s) (charge ${paymentIntent.id} already succeeded): `
          + siblingStampErr.message,
        );
      }
    }

    summary.charged_groups++;
    summary.charged_rows += activeRows.length;
    summary.details.push(`PAID group ${idempotencyKey}: ${paymentIntent.id} ($${(totalAmount / 100).toFixed(2)} across ${activeRows.length} rows)`);
    console.log(`Successfully charged group ${idempotencyKey}: ${paymentIntent.id}`);

    // Installments 2 and 3 carry the same Stripe-fee uplift as the first
    // charge, sized from the same estimate, so they can over-recover in the
    // same way - a card on file can be a Link credential funded by a bank.
    // Same helper as the checkout path; never throws, so it cannot turn a
    // collected installment into a failed one.
    await runUpliftTrueUp(stripe, {
      paymentIntentId: paymentIntent.id,
      chargeAccountId: recordedAcct,
      orgBearsStripeFee: orgConfig?.stripe_fee_payer === 'tenant',
      label: `installment ${installmentNumber}`,
    });
  } else {
    console.warn(`PaymentIntent ${paymentIntent.id} status=${paymentIntent.status} for group ${idempotencyKey}`);
    await admin.from('installments').update({
      status: 'paused_card_failed',
      failure_reason: `Unexpected status: ${paymentIntent.status}`,
      stripe_payment_intent_id: paymentIntent.id,
      last_attempt_at: new Date().toISOString(),
    }).in('id', sortedRowIds);

    summary.paused_card_failed_groups++;
    summary.paused_card_failed_rows += activeRows.length;
    summary.details.push(`UNUSUAL group ${idempotencyKey}: ${paymentIntent.status}`);

    await sendOperatorAlert({
      brand,
      to: alertEmail,
      subject: `Unusual charge state — installment ${installmentNumber}`,
      body: `Group ${idempotencyKey} (${parent?.email || 'unknown parent'}) returned status="${paymentIntent.status}" instead of "succeeded". Manual review needed. PaymentIntent: ${paymentIntent.id}`,
    });
  }
}

function buildDeclineAlertBody({
  rows, regDataById, parent, declineCode, failureReason, totalAmount, customerId,
  connectedAccountId,
}: {
  rows: InstallmentRow[];
  regDataById: Map<string, any>;
  parent?: ParentRow;
  declineCode: string;
  failureReason: string;
  totalAmount: number;
  customerId: string;
  /** Set only for direct-charge orgs, whose Customers live on the connected
   *  account — a platform dashboard URL would 404 for them. */
  connectedAccountId?: string | null;
}) {
  const parentName = parent ? `${parent.first_name} ${parent.last_name}` : 'parent';
  const parentEmail = parent?.email || 'unknown email';
  const allDates = [...new Set(rows.map((r) => r.due_date))].sort();
  const dateLabel = allDates.length === 1
    ? `Due: ${allDates[0]}`
    : `Due dates: earliest ${allDates[0]} (charged today), latest ${allDates[allDates.length - 1]}`;
  const lines = [
    `${parentName} (${parentEmail})`,
    `Installment ${rows[0].installment_number} of 3`,
    `Total amount: $${(totalAmount / 100).toFixed(2)} (across ${rows.length} child${rows.length > 1 ? 'ren' : ''}/program${rows.length > 1 ? 's' : ''})`,
    dateLabel,
    ``,
    `Per-row breakdown:`,
  ];
  for (const r of rows) {
    const rd = regDataById.get(r.registration_id);
    const prog = rd?.programs as ProgramRow | undefined;
    const stu = rd?.students as { first_name?: string; last_name?: string } | undefined;
    lines.push(`  - ${stu?.first_name || ''} ${stu?.last_name || ''} | ${prog?.curriculum || 'unknown'} | due ${r.due_date} | $${(r.amount_cents / 100).toFixed(2)}`);
  }
  lines.push(
    ``,
    `Decline reason: ${declineCode}`,
    `Stripe message: ${failureReason}`,
    ``,
    `Customer: ${connectedAccountId
      ? `https://dashboard.stripe.com/${connectedAccountId}/customers/${customerId}`
      : `https://dashboard.stripe.com/customers/${customerId}`}`,
    ``,
    `All ${rows.length} installment row${rows.length > 1 ? 's are' : ' is'} now status=paused_card_failed. Future charges will not be retried automatically. Reach out to the parent to update their card, then manually flip rows back to status=pending if you want to re-attempt.`,
    ``,
    `NOTE: The parent has been auto-notified by email about the decline.`,
  );
  return lines.join('\n');
}

function buildCancelledAlertBody({
  row, program, parent,
}: { row: InstallmentRow; program?: ProgramRow; parent?: ParentRow }) {
  const amount = `$${(row.amount_cents / 100).toFixed(2)}`;
  const parentName = parent ? `${parent.first_name} ${parent.last_name}` : 'parent';
  const parentEmail = parent?.email || 'unknown email';
  return [
    `Installment skipped because the program was cancelled.`,
    ``,
    `Parent: ${parentName} (${parentEmail})`,
    `Program: ${program?.curriculum || 'unknown'} (status=cancelled)`,
    `Installment ${row.installment_number} of 3`,
    `Amount NOT charged: ${amount}`,
    `Was due: ${row.due_date}`,
    ``,
    `No action needed for this charge. Refunds for already-paid installments are still handled manually per the cancellation SOP.`,
  ].join('\n');
}

// All nine alert sites in this file funnel through here, which is why the
// no-recipient check lives here rather than being repeated at each one.
// `to` is nullable ON PURPOSE - it is the tenant's own inbox and a provider
// may not have one. Every per-org body below names a family: a card decline
// carries their first and last name in the SUBJECT, the unusual-charge-state
// alert quotes their email address, and the paused-plan alerts list the
// registration rows behind their payment plan. There is no version of "send it
// to Enrops instead" that is acceptable for any of them.
async function sendOperatorAlert(
  { brand, to, subject, body }: { brand: OrgBrand; to: string | null; subject: string; body: string },
) {
  if (!to) {
    console.error('[process-installments] operator alert NOT sent - org has no inbox of its own', {
      organization_id: brand.org_id,
      subject,
    });
    return;
  }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: formatFromAddress(brand),
        to,
        subject: `[Enrops Alert] ${subject}`,
        text: body,
        tags: [{ name: 'type', value: 'cron_alert' }],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Resend send failed:', resp.status, errText);
    }
  } catch (err) {
    console.error('Operator alert failed:', err);
  }
}

async function sendParentDeclineNotice({
  brand, parent, installmentNumber, regDataById, rows, orgSlug,
}: {
  brand: OrgBrand;
  parent: ParentRow;
  installmentNumber: number;
  regDataById: Map<string, any>;
  rows: InstallmentRow[];
  /**
   * The tenant's portal slug, for the fix-it link. NULL is a legitimate answer
   * and the email drops the link rather than inventing a URL: a half-built
   * address on the one email that is supposed to solve the family's problem is
   * worse than the old "reply to this email" sentence, which still works.
   */
  orgSlug: string | null;
}): Promise<boolean> {
  // Where the family goes to fix it. The portal is tenant-scoped, so this is
  // /{slug}/dashboard - the same path parent-update-card returns them to - and
  // the banner there carries the button.
  // Escaped at every use below, like every other value in this template.
  // organizations.slug carries no CHECK constraint, so it is unconstrained text
  // as far as the database is concerned, and an unescaped one in an href would
  // break the button on the one email whose whole job is to carry a working
  // link.
  const fixUrl = orgSlug
    ? `${(Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com').replace(/\/+$/, '')}/${encodeURIComponent(orgSlug)}/dashboard`
    : null;
  const installmentLabel = installmentNumber === 1 ? 'first' : installmentNumber === 2 ? 'second' : 'third';

  // For multi-child: combine child names + program names. Single-child: same shape, just one line.
  const childPrograms = rows.map((r) => {
    const rd = regDataById.get(r.registration_id);
    const stu = rd?.students as { first_name?: string } | undefined;
    const prog = rd?.programs as ProgramRow | undefined;
    return { name: stu?.first_name || 'your child', program: prog?.curriculum || 'their class' };
  });

  // Combine for display: "Aiden's Pokémon LEGO and Lila's Mario Coding"
  let summary: string;
  if (childPrograms.length === 1) {
    summary = `${childPrograms[0].name}'s ${childPrograms[0].program}`;
  } else if (childPrograms.length === 2) {
    summary = `${childPrograms[0].name}'s ${childPrograms[0].program} and ${childPrograms[1].name}'s ${childPrograms[1].program}`;
  } else {
    const all = childPrograms.map((c) => `${c.name}'s ${c.program}`);
    summary = all.slice(0, -1).join(', ') + ', and ' + all[all.length - 1];
  }

  // Sender-name shorthand for the email signoff — strip "Org Name" suffix when
  // present so we get just the human's first name (e.g. "Jessica @ Journey to
  // STEAM" -> "Jessica"). Fallback to the full sender_name if no @ separator.
  const senderFirst = brand.sender_name.includes('@')
    ? brand.sender_name.split('@')[0].trim()
    : brand.sender_name;

  const text = [
    `Hi ${parent.first_name},`,
    ``,
    `A quick note — the ${installmentLabel} installment for ${summary} didn't go through this morning. Cards sometimes decline for routine reasons (expired, new card issued, bank flagging an unusual charge), so this is usually a quick fix.`,
    ``,
    `${childPrograms.length === 1 ? `${childPrograms[0].name}'s spot is` : 'Their spots are'} still held — we won't drop the registration${childPrograms.length === 1 ? '' : 's'} while we sort this out.`,
    ``,
    fixUrl
      ? `You can put a new card on file here, and we'll take the payment automatically:\n${fixUrl}`
      : `To update your card on file, reply to this email and we'll send you a secure link.`,
    ``,
    `Thanks for your patience,`,
    senderFirst,
    brand.org_name,
    brand.reply_to,
  ].join('\n');

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px;line-height:1.6;">
  <div style="color:${brand.accent_color};font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">${escapeHtml(brand.org_name)}</div>
  <h2 style="font-size:20px;margin:0 0 16px 0;color:#1a1a1a;">Quick heads-up about your payment</h2>
  <p>Hi ${escapeHtml(parent.first_name)},</p>
  <p>A quick note — the ${installmentLabel} installment for <strong>${escapeHtml(summary)}</strong> didn't go through this morning. Cards sometimes decline for routine reasons (expired, new card issued, bank flagging an unusual charge), so this is usually a quick fix.</p>
  <p><strong>${childPrograms.length === 1 ? `${escapeHtml(childPrograms[0].name)}'s spot is` : 'Their spots are'} still held</strong> — we won't drop the registration${childPrograms.length === 1 ? '' : 's'} while we sort this out.</p>
  ${fixUrl
    ? `<p>You can put a new card on file in a couple of minutes, and we'll take the payment automatically.</p>
  <p style="margin:20px 0;"><a href="${escapeHtml(fixUrl)}" style="background:${brand.primary_color};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;display:inline-block;">Update your card</a></p>
  <p style="font-size:13px;color:#666;">If the button doesn't work, paste this into your browser:<br/><a href="${escapeHtml(fixUrl)}" style="color:${brand.primary_color};">${escapeHtml(fixUrl)}</a></p>`
    : `<p>To update your card on file, reply to this email and we'll send you a secure link.</p>`}
  <p>Thanks for your patience,<br/>${escapeHtml(senderFirst)}<br/><span style="color:#666;">${escapeHtml(brand.org_name)}</span><br/><a href="mailto:${brand.reply_to}" style="color:${brand.primary_color};">${brand.reply_to}</a></p>
</div>`.trim();

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: formatFromAddress(brand),
        to: parent.email,
        reply_to: brand.reply_to,
        subject: `Quick heads-up about your payment for ${childPrograms[0].program}${childPrograms.length > 1 ? ' & more' : ''}`,
        text,
        html,
        tags: [
          { name: 'type', value: 'parent_decline_notice' },
          { name: 'installment_number', value: String(installmentNumber) },
        ],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`Parent decline notice send failed for ${parent.email}:`, resp.status, errText);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Parent decline notice exception for ${parent.email}:`, err);
    return false;
  }
}

function escapeHtml(s: string | undefined | null): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
