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
import {
  addDaysUtc, chargeIdempotencyKey, declineFollowUp, DeclinePlan, FAMILY_PAY_BY_DAYS, formatRetryDate,
  NOT_CHARGEABLE_REGISTRATION_STATUSES, planDeclineRetry, PROVIDER_FOLLOWUP_DAYS,
} from '../_shared/declineRetry.ts';

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
  /** Automatic-retry bookkeeping - see migration 20261007e and
   *  _shared/declineRetry.ts. Defaults 0 / null on every row. */
  card_decline_count: number | null;
  retry_payment_method_id: string | null;
  card_retries_done: number | null;
  next_retry_on: string | null;
  /** The business's missed-deadline email - migration 20261008a. */
  provider_followup_on: string | null;
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

/**
 * What happened to the family's decline email. The operator's alert tells them
 * to stand down or to step in, and those are opposite instructions, so the
 * reason has to survive as a VALUE rather than be re-derived from `parent` in
 * the message builder - which is how it came to claim an email had gone out
 * when the dedup had silently suppressed it.
 */
type ParentNoticeOutcome = 'sent' | 'already_notified' | 'no_email' | 'send_failed';

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
    retries_rearmed: 0,
    deadline_followups_sent: 0,
    errors: 0,
    details: [] as string[],
  };

  try {
    // STEP 0: Automatic retries that are due today go back in line.
    //
    // A declined row books its retry in next_retry_on (see the decline path in
    // processGroup). Flipping it back to 'pending' here hands it to the SAME
    // path every other charge takes - grouping, fee, routing, idempotency -
    // rather than a second way of charging a card.
    //
    // NEVER A REMOVED OR REFUNDED REGISTRATION. When a business removes a
    // family, refund-registration stops the plan by pausing its PENDING rows; a
    // row already sitting in paused_card_failed is not touched. So a removed
    // registration is never re-armed here, and processGroup refuses to charge
    // one whichever path put it back to 'pending' (see
    // NOT_CHARGEABLE_REGISTRATION_STATUSES there).
    //
    // FAIL DIRECTION: if this read fails we retry nobody today. That charges
    // LESS, never more, and tomorrow's run picks the same rows up because
    // next_retry_on is still in the past.
    let dueRetriesQuery = admin
      .from('installments')
      .select('id, card_retries_done, registrations!inner(status)')
      .eq('status', 'paused_card_failed')
      .lte('next_retry_on', today);
    // One neq per status rather than a hand-built not.in filter STRING, for the
    // reason given at the sibling-stamp below: a mis-quoted filter string does
    // not error, it matches the wrong set.
    for (const s of NOT_CHARGEABLE_REGISTRATION_STATUSES) {
      dueRetriesQuery = dueRetriesQuery.neq('registrations.status', s);
    }
    const { data: dueRetries, error: retryErr } = await dueRetriesQuery;
    if (retryErr) {
      console.error('[process-installments] could not load due retries; none attempted today:', retryErr.message);
      summary.errors++;
      summary.details.push(`RETRY LOOKUP FAILED: ${retryErr.message}`);
    }
    for (const r of ((dueRetries ?? []) as unknown) as Array<{ id: string; card_retries_done: number | null }>) {
      // Conditional on the row STILL being booked for a retry, so two runs at
      // once cannot both count it: the second matches nothing. The count is
      // taken from what we read, and this run is the only writer of it.
      const { data: rearmed, error: rearmErr } = await admin
        .from('installments')
        .update({
          status: 'pending',
          next_retry_on: null,
          card_retries_done: (r.card_retries_done ?? 0) + 1,
        })
        .eq('id', r.id)
        .eq('status', 'paused_card_failed')
        .lte('next_retry_on', today)
        .select('id');
      if (rearmErr) {
        console.error(`[process-installments] could not re-arm retry for ${r.id}:`, rearmErr.message);
        summary.errors++;
        summary.details.push(`RETRY REARM FAILED ${r.id}: ${rearmErr.message}`);
      } else if (rearmed && rearmed.length) {
        summary.retries_rearmed++;
        summary.details.push(`RETRY ${r.id}: attempt ${(r.card_retries_done ?? 0) + 1}`);
      }
    }

    // STEP 0b: the business's missed-deadline emails.
    //
    // When the last retry fails the family is emailed a deadline, and only
    // once that email has actually gone out is provider_followup_on booked
    // (see the decline path). Today is that day for these rows: the deadline
    // was yesterday, the plan is still paused, so tell the business it can
    // decide about the spot. Never for a removed registration - same list the
    // retry re-arm uses.
    //
    // A family who put a new card on in the meantime is no longer
    // paused_card_failed (the card-update webhook re-pends the row), so they
    // drop out of this query and the business is not told to remove a family
    // that has fixed it. It runs BEFORE the charges so it can never be skipped
    // by the "nothing due today" early return below.
    let followUpsQuery = admin
      .from('installments')
      .select(`id, organization_id, stripe_customer_id, installment_number, amount_cents, provider_followup_on,
        stripe_payment_method_id, retry_payment_method_id,
        registrations!inner(status, students(first_name, last_name), programs(curriculum), parents(email, first_name, last_name))`)
      .eq('status', 'paused_card_failed')
      .lte('provider_followup_on', today);
    for (const s of NOT_CHARGEABLE_REGISTRATION_STATUSES) {
      followUpsQuery = followUpsQuery.neq('registrations.status', s);
    }
    const { data: dueFollowUps, error: followUpErr } = await followUpsQuery;
    if (followUpErr) {
      // Fail direction: nobody is emailed today, and the rows are still booked
      // for tomorrow's run. Nothing is charged by this step either way.
      console.error('[process-installments] could not load missed-deadline follow-ups:', followUpErr.message);
      summary.errors++;
      summary.details.push(`FOLLOW-UP LOOKUP FAILED: ${followUpErr.message}`);
    }
    await sendMissedDeadlineFollowUps(admin, ((dueFollowUps ?? []) as unknown) as FollowUpRow[], today, summary);

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
        await processGroup(admin, groupRows, summary, alertEmail, orgConfig, brand, orgSlugMap.get(orgId) ?? null, today);
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
  // The run's own calendar day (UTC), so a retry is booked from the same
  // "today" the run selected its rows by.
  today: string,
) {
  // Fetch registration + program + parent data for all rows in the group
  const regIds = groupRows.map((r) => r.registration_id);
  const { data: regsData } = await admin
    .from('registrations')
    .select('id, status, program_id, parent_id, students(first_name, last_name), programs(id, curriculum, status), parents(email, first_name, last_name)')
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
    // A REMOVED OR REFUNDED REGISTRATION IS NEVER CHARGED, whatever put its row
    // back to 'pending'. refund-registration pauses only a plan's PENDING rows
    // when a business removes a family, so a row that was already paused after
    // a decline survives it - and the card-update webhook re-pends every paused
    // row for that Stripe customer, which includes a removed sibling's. The
    // retry re-arm skips these too, but the guard has to live here, where
    // every path meets. Parked exactly as refund-registration parks its own.
    if (NOT_CHARGEABLE_REGISTRATION_STATUSES.includes(regData.status)) {
      const { error: parkErr } = await admin.from('installments').update({
        status: 'paused_program_cancelled',
        next_retry_on: null,
        last_attempt_at: new Date().toISOString(),
      }).eq('id', row.id);
      summary.paused_cancelled++;
      summary.details.push(
        `SKIPPED ${row.id}: registration is ${regData.status}`
          + (parkErr ? ` (could not park it: ${parkErr.message})` : ''),
      );
      if (parkErr) summary.errors++;
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
  // After a decline it gains a suffix (chargeIdempotencyKey says why), so the
  // retry, or a charge on a card the family just replaced, reaches the bank
  // instead of being answered with the saved decline.
  const sortedRowIds = activeRows.map((r) => r.id).sort();
  const priorDeclines = Math.max(0, ...activeRows.map((r) => r.card_decline_count ?? 0));
  const idempotencyKey = chargeIdempotencyKey(sortedRowIds, priorDeclines);

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

    // WHAT HAPPENS NEXT - the failed-payment policy in _shared/declineRetry.ts.
    //
    // isCardDecline is the family's bank saying no: money definitely did not
    // move, so a retry is safe. Anything else (a timeout, a Stripe outage) has
    // an UNKNOWN outcome and is never retried automatically - a retry on a new
    // key after a charge that secretly succeeded is how a family pays twice.
    const errType = (stripeErr as { type?: string }).type;
    const isCardDecline = errType === 'StripeCardError';

    // AN IDEMPOTENCY REFUSAL TOUCHES NOTHING BUT THE KEY. Stripe refused the
    // request before running it, so nothing was charged, and there are two
    // ways to get here:
    //   - another run is charging this same group right now (a double
    //     invocation). That run owns the outcome and writes it; pausing the
    //     rows or emailing from here would overwrite its booked retry with
    //     "no retry" and send a second, contradictory alert.
    //   - the card on the rows changed since this key was first used - a
    //     family replaced their card within 24h of a decline on a row from
    //     before card_decline_count existed. Proven in Stripe test mode: the
    //     old key plus the new card is a flat 400.
    // Either way: move the key on, leave the row as it is, tell nobody. In the
    // second case the row is still 'pending', so the next run charges the new
    // card on a fresh key instead of stranding a family whose card is fine.
    if (errType === 'StripeIdempotencyError') {
      const { error: keyErr } = await admin.from('installments')
        .update({ card_decline_count: priorDeclines + 1 })
        .in('id', sortedRowIds)
        .eq('card_decline_count', priorDeclines);
      summary.errors++;
      summary.details.push(
        `IDEMPOTENCY REFUSED group ${idempotencyKey}: ${failureReason}`
          + (keyErr ? ` (could not move the key on: ${keyErr.message})` : ' - key moved on, rows left as they were'),
      );
      return;
    }

    // A retry cycle belongs to ONE card, and its count is read only from rows
    // that carry that card. A sibling that joined the group later (another
    // child, same plan payment) has no cycle of its own yet and must not reset
    // this one - with `every` it did, restarting the retries and re-sending the
    // first email. A card the family has just put on matches no row, so it
    // starts at 0 and gets its own retries.
    const retriesDone = Math.max(
      0,
      ...activeRows
        .filter((r) => r.retry_payment_method_id === paymentMethodId)
        .map((r) => r.card_retries_done ?? 0),
    );
    const plan = planDeclineRetry({
      isCardDecline,
      codes: [(stripeErr as any).decline_code, stripeErr.code],
      retriesDone,
      today,
    });

    // Mark ALL active rows in this group as failed. next_retry_on is written on
    // every failure - null when nothing is booked - so a stale date from an
    // earlier cycle can never survive onto a row that should not be retried.
    const { error: failWriteErr } = await admin.from('installments').update({
      status: 'paused_card_failed',
      failure_reason: `${declineCode}: ${failureReason}`,
      last_attempt_at: new Date().toISOString(),
      next_retry_on: plan.nextRetryOn,
      // Cleared on EVERY failure and booked only after the final email is
      // confirmed sent (below), so a date left over from an earlier cycle can
      // never fire a "they missed the deadline" email nobody was given.
      provider_followup_on: null,
      ...(isCardDecline
        ? {
          card_decline_count: priorDeclines + 1,
          retry_payment_method_id: paymentMethodId,
          card_retries_done: retriesDone,
        }
        : {}),
    }).in('id', sortedRowIds);

    summary.paused_card_failed_groups++;
    summary.paused_card_failed_rows += activeRows.length;
    summary.details.push(
      `FAILED group ${idempotencyKey}: ${declineCode} (${activeRows.length} rows) -> ${plan.outcome}`
        + (plan.nextRetryOn ? ` ${plan.nextRetryOn}` : ''),
    );

    // If that write failed the rows are still 'pending', so the next run tries
    // the same dead card again - daily, unpaused, until someone notices. Say so
    // to someone who can act on the database. Row ids only: this goes to the
    // platform, not the tenant, so it must not name a family.
    if (failWriteErr) {
      summary.errors++;
      summary.details.push(`DECLINE NOT RECORDED group ${idempotencyKey}: ${failWriteErr.message}`);
      await alertPlatform(
        admin,
        'Installment decline could not be recorded',
        `A card was declined but the rows could not be marked as failed, so they are still pending and will be tried again on the next run.\n\nError: ${failWriteErr.message}\n\nRow IDs: ${sortedRowIds.join(', ')}`,
      );
    }

    const followUp = declineFollowUp({
      plan,
      retriesDone,
      familyAlreadyTold: activeRows.some((r) => !!r.parent_notified_failed_at),
      hasEmail: !!parent?.email,
    });
    // A failed retry with another one still booked is quiet. The family was
    // told on the first decline and the business was told the retry dates;
    // a second pair of emails three days later says nothing new to either.
    if (!followUp.alertBusiness && !followUp.familyEmail) {
      return;
    }

    // THE FAMILY IS EMAILED FIRST, AND THE OPERATOR'S ALERT REPORTS WHAT
    // ACTUALLY HAPPENED. The order is the point.
    //
    // The alert used to be built first and state "The parent has been
    // auto-notified by email" unconditionally, while the send was gated on the
    // dedup flag below. On a REPEAT decline no email goes out at all, so the
    // alert told the operator to stand down at precisely the moment they were
    // the only one who could help - and the same for a family with no address,
    // or a send that Resend rejected. Reporting an outcome we had not observed
    // yet is what made it wrong; so observe it, then report it.
    //
    // Safe to reorder: sendParentDeclineNotice catches everything and returns a
    // boolean, so it cannot throw past this point and cost the operator their
    // alert.
    //
    // notifiableParent carries the PARENT rather than a boolean so the one
    // value both decides the outcome and narrows the type at the send. A bare
    // boolean type-checks here and then loses `parent` to "possibly undefined"
    // three lines down, which is how a second spelling of the rule gets
    // reintroduced to appease the compiler.
    //
    // THE LAST RETRY IS THE EXCEPTION TO THE DEDUP. parent_notified_failed_at
    // stops us repeating the FIRST email; the final one says something new (we
    // have stopped trying), so it goes out whenever the family has an address.
    // declineFollowUp owns that rule.
    const isFinalNotice = plan.outcome === 'retries_exhausted';
    const notifiableParent: ParentRow | null =
      parent?.email && followUp.familyEmail ? parent : null;

    // Set only when the business's missed-deadline email is really booked; the
    // final alert promises that email only when this is non-null.
    let followUpBookedOn: string | null = null;
    let parentNotice: ParentNoticeOutcome = notifiableParent
      ? 'send_failed'
      : parent?.email
      ? 'already_notified'
      : 'no_email';

    if (notifiableParent) {
      const sent = await sendParentDeclineNotice({
        brand,
        parent: notifiableParent,
        installmentNumber,
        regDataById,
        rows: activeRows,
        orgSlug,
        variant: followUp.familyEmail === 'final' ? 'final' : 'first',
        retryOn: plan.nextRetryOn,
        payBy: plan.payBy,
      });
      if (sent) {
        parentNotice = 'sent';
        // The business's missed-deadline email is booked ONLY now, once the
        // family has actually been given the deadline - its whole text is "we
        // told them". A family with no address, or a send that bounced, never
        // gets one booked, and the final alert below says so instead.
        if (followUp.familyEmail === 'final' && plan.providerFollowUpOn) {
          const { error: bookErr } = await admin.from('installments')
            .update({ provider_followup_on: plan.providerFollowUpOn })
            .in('id', sortedRowIds);
          if (bookErr) {
            summary.errors++;
            summary.details.push(`FOLLOW-UP NOT BOOKED group ${idempotencyKey}: ${bookErr.message}`);
          } else {
            followUpBookedOn = plan.providerFollowUpOn;
          }
        }
        // Stamp ALL rows in the group so we don't re-notify
        await admin.from('installments').update({
          parent_notified_failed_at: new Date().toISOString(),
        }).in('id', sortedRowIds);
        summary.parents_notified++;
        summary.details.push(`PARENT_NOTIFIED group ${idempotencyKey}: ${notifiableParent.email}`);
      }
    }

    // Operator alert (one per group, not per row), now that the outcome is known
    if (!followUp.alertBusiness) return;
    await sendOperatorAlert({
      brand,
      to: alertEmail,
      subject: `Card declined for ${parent?.first_name || ''} ${parent?.last_name || ''} — installment ${installmentNumber}`
        + (isFinalNotice ? ' (automatic retries finished)' : ''),
      body: buildDeclineAlertBody({
        plan,
        rows: activeRows,
        regDataById,
        parent,
        declineCode,
        failureReason,
        totalAmount,
        customerId,
        connectedAccountId: routing.direct ? (orgConfig?.stripe_account_id ?? null) : null,
        parentNotice,
        // The operator needs the link in their own hands on every branch where
        // the family was NOT emailed, because they have no other lever: no
        // admin screen reads or writes paused_card_failed.
        fixUrl: portalDashboardUrl(orgSlug),
        followUpBookedOn,
      }),
    });
    return;
  }

  if (paymentIntent.status === 'succeeded') {
    // Mark all active rows as paid against this single PaymentIntent.
    //
    // The error is READ. If this write fails the family has paid but the rows
    // still say 'pending', and the next run charges them again on a key Stripe
    // may already have forgotten - so it is a double charge waiting to happen,
    // and someone who can fix the rows must hear about it today.
    const { error: paidWriteErr } = await admin.from('installments').update({
      status: 'paid',
      stripe_payment_intent_id: paymentIntent.id,
      paid_at: new Date().toISOString(),
      last_attempt_at: new Date().toISOString(),
      // A row paid by its retry, or by a card the family replaced mid-cycle,
      // must not keep a booked retry date or deadline email on it.
      next_retry_on: null,
      provider_followup_on: null,
      // Re-stamp where this PI actually landed, so a refund of installment 2 or
      // 3 scopes itself correctly without consulting the org's current model.
      stripe_charge_account_id: recordedAcct,
      // Record the transfer destination this charge ACTUALLY used. See the
      // sibling stamp below for why this alone is not enough.
      stripe_transfer_destination_id: builtDest,
    }).in('id', sortedRowIds);
    if (paidWriteErr) {
      summary.errors++;
      summary.details.push(`PAID BUT NOT RECORDED ${paymentIntent.id}: ${paidWriteErr.message}`);
      await alertPlatform(
        admin,
        'URGENT: installment charged but not marked paid',
        `PaymentIntent ${paymentIntent.id} succeeded, but the rows could not be marked paid, so they are still pending and the next run will try to charge them again. Mark them paid before the next run.\n\nError: ${paidWriteErr.message}\n\nRow IDs: ${sortedRowIds.join(', ')}`,
      );
    }

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
  plan, rows, regDataById, parent, declineCode, failureReason, totalAmount, customerId,
  connectedAccountId, parentNotice, fixUrl, followUpBookedOn,
}: {
  /** What the failed-payment policy decided for this decline. */
  plan: DeclinePlan;
  /** The day the business's missed-deadline email is actually booked for, or
   *  null when it is not (the family was never given the deadline). */
  followUpBookedOn: string | null;
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
  /** What ACTUALLY happened to the family's decline email, observed by the
   *  caller before this body is built, so the two cannot disagree. */
  parentNotice: ParentNoticeOutcome;
  /** The family's portal link, for the operator to send by hand when we are
   *  not emailing. null when the tenant has no slug. */
  fixUrl: string | null;
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
    // ONE SENTENCE PER OUTCOME, each true in the state that selects it. The
    // old single line ("nothing further will be charged automatically") is
    // false the moment a retry is booked.
    plan.outcome === 'retry_scheduled' && plan.nextRetryOn
      ? `We'll try the same card again automatically on ${formatRetryDate(plan.nextRetryOn)}`
        + ` (retry ${plan.retryNumber} of ${plan.totalRetries}). Most declines like this are a temporary hold and clear on their own.`
      : plan.outcome === 'retries_exhausted'
      ? `That was the last automatic retry. We tried this card ${plan.totalRetries + 1} times and have stopped, so the payment plan stays paused until a working card is on it.`
      : plan.outcome === 'hard_decline'
      ? `The bank's answer means this card can't be charged again, so we won't retry it automatically. The payment plan stays paused until a working card is on it.`
      : `This payment plan is paused, so nothing further will be charged automatically until a working card is on it.`,
    ``,
    // Keyed on what was OBSERVED, not on what we were about to try. The two
    // shapes ask for opposite things from the operator - stand down, or you are
    // the only one who can move this - which is why getting it wrong mattered.
    ...(parentNotice === 'sent' && plan.outcome === 'retries_exhausted'
      ? [
        // "with a link" only when the email really carried one: a tenant with
        // no portal slug gets the reply-to-us sentence instead.
        `${parent?.first_name || 'The family'} has been emailed to say we've stopped retrying, `
          + (fixUrl ? `with a link to put a new card on file` : `and asked to reply for a link to put a new card on file`)
          + (plan.payBy ? ` by ${formatRetryDate(plan.payBy)} to keep the spot` : '')
          + `. Once a new card is on, the plan un-pauses on its own and the next daily run collects the payment.`,
        ``,
        followUpBookedOn
          ? `If it's still unpaid, we'll email you again on ${formatRetryDate(followUpBookedOn)} so you can decide whether to release the spot. We never remove a child or add a late fee on our own.`
          : `From here it's yours: a nudge from you is what moves it. We never remove a child or add a late fee on our own.`,
      ]
      : parentNotice === 'sent'
      ? [
        `You do not need to do anything right now. ${parent?.first_name || 'The family'} has been emailed a link to put a new card on file, and the moment they do, the plan un-pauses on its own and the next daily run collects the payment.`,
        ``,
        plan.outcome === 'retry_scheduled'
          ? `We'll let you know if the retries don't work.`
          : `If nothing has changed in a few days, a nudge from you is what helps.`,
      ]
      : [
        plan.outcome === 'retry_scheduled'
          ? `THE FAMILY HAS NOT BEEN EMAILED ABOUT THIS. The retry may still go through, but if it doesn't, reaching out to them is the only thing that will move it.`
          : `THE FAMILY HAS NOT BEEN EMAILED ABOUT THIS, so reaching out to them is the only thing that will move it.`,
        ``,
        parentNotice === 'already_notified'
          ? `They were already told about an earlier failed payment on this plan, and we do not email them about it twice, so this one is silent to them.`
          : parentNotice === 'send_failed'
          ? `We tried to email them and it did not go through. Their address on file may be wrong.`
          : `We have no email address on file for them.`,
        ``,
        ...(fixUrl
          ? [`Send them this link and they can put a new card on themselves, which un-pauses the plan automatically:`, fixUrl]
          : [`Once they have given you a new card, contact Enrops to get the plan restarted.`]),
      ]),
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
): Promise<'sent' | 'no_inbox' | 'failed'> {
  // Returns what happened rather than throwing, so every existing caller can
  // keep ignoring it; the missed-deadline sender reads it, because it has
  // already claimed its row and must know whether to put the booking back.
  if (!to) {
    console.error('[process-installments] operator alert NOT sent - org has no inbox of its own', {
      organization_id: brand.org_id,
      subject,
    });
    return 'no_inbox';
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
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.error('Operator alert failed:', err);
    return 'failed';
  }
}

interface FollowUpRow {
  id: string;
  organization_id: string;
  stripe_customer_id: string;
  installment_number: number;
  amount_cents: number;
  provider_followup_on: string;
  stripe_payment_method_id: string | null;
  retry_payment_method_id: string | null;
  registrations: {
    status: string;
    students: { first_name?: string; last_name?: string } | null;
    programs: { curriculum?: string } | null;
    parents: { email?: string; first_name?: string; last_name?: string } | null;
  };
}

/**
 * STEP 0b's sender: one email per family payment, to the business's own inbox.
 *
 * Each group is CLAIMED before it is sent - provider_followup_on is cleared by a
 * conditional update, and only the run that clears it sends. Two runs at once
 * therefore cannot email the business twice. A send that Resend rejects puts
 * the booking back for tomorrow's run; a business with no inbox at all is
 * logged and not re-booked, since tomorrow would be no different.
 */
async function sendMissedDeadlineFollowUps(
  admin: AdminClient,
  rows: FollowUpRow[],
  today: string,
  summary: any,
) {
  // STILL THE SAME DEAD CARD, or the email is a lie. The card-update webhook
  // re-pends a row but does not know about this booking, so a family who put a
  // new card on and whose new charge was then paused for some OTHER reason (a
  // "charge blocked" pause) would still carry the date - and the business would
  // be told to release the spot of a family who did exactly what was asked. The
  // new card is on the row as stripe_payment_method_id; the card the retries
  // gave up on is retry_payment_method_id. Different = they acted. Those rows
  // lose the stale booking and are never emailed about.
  const stale = rows.filter((r) => r.stripe_payment_method_id !== r.retry_payment_method_id);
  if (stale.length) {
    const { error: staleErr } = await admin.from('installments')
      .update({ provider_followup_on: null })
      .in('id', stale.map((r) => r.id).sort());
    summary.details.push(
      `FOLLOW-UP DROPPED (family changed card) ${stale.map((r) => r.id).join(',')}`
        + (staleErr ? ` - could not clear: ${staleErr.message}` : ''),
    );
  }
  const due = rows.filter((r) => r.stripe_payment_method_id === r.retry_payment_method_id);

  // Grouped the way the charge was: one family payment, one email.
  const groups = new Map<string, FollowUpRow[]>();
  for (const r of due) {
    const key = `${r.organization_id}__${r.stripe_customer_id}__${r.installment_number}__${r.provider_followup_on}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  for (const groupRows of groups.values()) {
    const ids = groupRows.map((r) => r.id).sort();
    const { data: claimed, error: claimErr } = await admin
      .from('installments')
      .update({ provider_followup_on: null })
      .in('id', ids)
      .eq('status', 'paused_card_failed')
      .lte('provider_followup_on', today)
      .select('id');
    if (claimErr) {
      console.error('[process-installments] could not claim a missed-deadline follow-up:', claimErr.message);
      summary.errors++;
      summary.details.push(`FOLLOW-UP CLAIM FAILED ${ids.join(',')}: ${claimErr.message}`);
      continue;
    }
    const claimedIds = new Set(((claimed ?? []) as Array<{ id: string }>).map((c) => c.id));
    const mine = groupRows.filter((r) => claimedIds.has(r.id));
    if (!mine.length) continue; // another run took it

    const orgId = mine[0].organization_id;
    const brand = await loadOrgBrand(admin, orgId);
    const parent = mine[0].registrations.parents;
    const parentName = [parent?.first_name, parent?.last_name].filter(Boolean).join(' ') || 'A family';
    const children = mine.map((r) => {
      const stu = r.registrations.students;
      const prog = r.registrations.programs;
      return `${stu?.first_name || 'their child'} in ${prog?.curriculum || 'their class'}`;
    });
    const total = mine.reduce((s, r) => s + (r.amount_cents || 0), 0);
    const followUpOn = mine[0].provider_followup_on;
    const finalNoticeOn = addDaysUtc(followUpOn, -PROVIDER_FOLLOWUP_DAYS);
    const payBy = addDaysUtc(finalNoticeOn, FAMILY_PAY_BY_DAYS);

    const outcome = await sendOperatorAlert({
      brand,
      to: brand.tenant_alert_email,
      subject: `Unpaid after the deadline: ${parentName}, installment ${mine[0].installment_number}`,
      body: [
        `${parentName}${parent?.email ? ` (${parent.email})` : ''} has not paid installment ${mine[0].installment_number} of 3`
          + ` for ${children.join(' and ')}: $${(total / 100).toFixed(2)}.`,
        ``,
        `Their card was declined and our automatic retries didn't go through. On ${formatRetryDate(finalNoticeOn)} we emailed them`
          + ` that they needed to put a new card on by ${formatRetryDate(payBy)} to keep the spot. That date has passed and the payment still hasn't been collected.`,
        ``,
        `What you can do:`,
        `- Release the spot: use Refund / remove next to their child on the Rosters page. That also stops any payments left on their plan.`,
        `- Give them more time: do nothing. If they put a new card on later, we'll still collect the payment automatically.`,
        ``,
        `This is the last automatic email about this payment.`,
      ].join('\n'),
    });
    const mineIds = mine.map((r) => r.id).sort();
    if (outcome === 'sent') {
      summary.deadline_followups_sent++;
      summary.details.push(`DEADLINE FOLLOW-UP ${mineIds.join(',')}`);
    } else if (outcome === 'failed') {
      // Put the booking back so tomorrow's run tries again. Only onto rows
      // still paused with nothing booked, so it cannot resurrect a row that was
      // paid or re-pended in the meantime.
      const { error: rebookErr } = await admin.from('installments')
        .update({ provider_followup_on: followUpOn })
        .in('id', mineIds)
        .eq('status', 'paused_card_failed')
        .is('provider_followup_on', null);
      summary.errors++;
      summary.details.push(
        `DEADLINE FOLLOW-UP SEND FAILED ${mineIds.join(',')}`
          + (rebookErr ? ` - could not re-book: ${rebookErr.message}` : ' - re-booked for the next run'),
      );
    } else {
      summary.errors++;
      summary.details.push(`DEADLINE FOLLOW-UP NOT SENT (business has no inbox) ${mineIds.join(',')}`);
    }
  }
}

/**
 * A notice for Enrops itself, for a failure only someone with database access
 * can fix (a row write that did not land). Goes to the PLATFORM brand's own
 * alert address - the same one the fatal-crash notice uses - and so must carry
 * no family data: row and PaymentIntent ids only, never a name or an email.
 */
async function alertPlatform(admin: AdminClient, subject: string, body: string) {
  const platformBrand = await loadOrgBrand(admin, null).catch(() => null);
  if (!platformBrand) {
    console.error('[process-installments] platform alert NOT sent - no platform brand', { subject, body });
    return;
  }
  await sendOperatorAlert({ brand: platformBrand, to: platformBrand.alert_email, subject, body });
}

async function sendParentDeclineNotice({
  brand, parent, installmentNumber, regDataById, rows, orgSlug, variant, retryOn, payBy,
}: {
  /** 'final' only: the date to have a new card on by ('YYYY-MM-DD'). */
  payBy: string | null;
  brand: OrgBrand;
  parent: ParentRow;
  installmentNumber: number;
  regDataById: Map<string, any>;
  rows: InstallmentRow[];
  /** 'first' = the first decline on this card; 'final' = the last automatic
   *  retry just failed and we have stopped trying. */
  variant: 'first' | 'final';
  /** The day we will try the same card again ('YYYY-MM-DD'), or null when no
   *  retry is booked. Only ever said to the family when it is real. */
  retryOn: string | null;
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
  const fixUrl = portalDashboardUrl(orgSlug);
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

  const isFinal = variant === 'final';
  // Only the first notice ever mentions a retry, and only when one is booked.
  const retryLine = !isFinal && retryOn
    ? `If it was just a temporary hold, you don't need to do anything: we'll try the same card again on ${formatRetryDate(retryOn)}.`
    : null;
  const opening = isFinal
    ? `We tried your card again for the ${installmentLabel} installment for ${summary}, and it still didn't go through, so we've stopped trying it automatically.`
    : `A quick note — the ${installmentLabel} installment for ${summary} didn't go through this morning. Cards sometimes decline for routine reasons (expired, new card issued, bank flagging an unusual charge), so this is usually a quick fix.`;
  // THE SPOT LINE. The first notice promises the spot is held while we sort it
  // out. The final one may not: from 2026-10-08 a family that misses the
  // deadline can have their spot released by the business, so the final email
  // names the date instead of promising to hold it forever (Jessica approved
  // the wording). A final email without a deadline - which the policy never
  // produces, but the type allows - keeps the old sentence rather than invent
  // a date.
  const single = childPrograms.length === 1;
  const spotLine = isFinal && payBy
    ? `Please put a new card on file by ${formatRetryDate(payBy)} to keep ${single ? `${childPrograms[0].name}'s spot` : 'their spots'}.`
      + ` If we can't collect the payment by then, ${single ? 'the spot' : 'the spots'} will be released.`
    : `${single ? `${childPrograms[0].name}'s spot is` : 'Their spots are'} still held — we won't drop the registration${single ? '' : 's'} while we sort this out.`;
  const spotLineHtml = isFinal && payBy
    ? `<strong>${escapeHtml(`Please put a new card on file by ${formatRetryDate(payBy)} to keep ${single ? `${childPrograms[0].name}'s spot` : 'their spots'}.`)}</strong>`
      + ` ${escapeHtml(`If we can't collect the payment by then, ${single ? 'the spot' : 'the spots'} will be released.`)}`
    : `<strong>${single ? `${escapeHtml(childPrograms[0].name)}'s spot is` : 'Their spots are'} still held</strong> — we won't drop the registration${single ? '' : 's'} while we sort this out.`;
  const heading = isFinal ? "Your payment still didn't go through" : 'Quick heads-up about your payment';
  const subject = isFinal
    ? `Your payment for ${childPrograms[0].program}${childPrograms.length > 1 ? ' & more' : ''} still didn't go through`
    : `Quick heads-up about your payment for ${childPrograms[0].program}${childPrograms.length > 1 ? ' & more' : ''}`;

  const text = [
    `Hi ${parent.first_name},`,
    ``,
    opening,
    ``,
    spotLine,
    ``,
    fixUrl
      ? `${isFinal ? 'Please put a new card on file here' : 'You can put a new card on file here'}, and we'll take the payment automatically:\n${fixUrl}`
      : `To update your card on file, reply to this email and we'll send you a secure link.`,
    ...(retryLine ? [``, retryLine] : []),
    ``,
    `Thanks for your patience,`,
    senderFirst,
    brand.org_name,
    brand.reply_to,
  ].join('\n');

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px;line-height:1.6;">
  <div style="color:${brand.accent_color};font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">${escapeHtml(brand.org_name)}</div>
  <h2 style="font-size:20px;margin:0 0 16px 0;color:#1a1a1a;">${escapeHtml(heading)}</h2>
  <p>Hi ${escapeHtml(parent.first_name)},</p>
  <p>${isFinal
    ? `We tried your card again for the ${installmentLabel} installment for <strong>${escapeHtml(summary)}</strong>, and it still didn't go through, so we've stopped trying it automatically.`
    : `A quick note — the ${installmentLabel} installment for <strong>${escapeHtml(summary)}</strong> didn't go through this morning. Cards sometimes decline for routine reasons (expired, new card issued, bank flagging an unusual charge), so this is usually a quick fix.`}</p>
  <p>${spotLineHtml}</p>
  ${fixUrl
    ? `<p>${isFinal ? 'Please put a new card on file' : 'You can put a new card on file in a couple of minutes'}, and we'll take the payment automatically.</p>
  <p style="margin:20px 0;"><a href="${escapeHtml(fixUrl)}" style="background:${brand.primary_color};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;display:inline-block;">Update your card</a></p>
  <p style="font-size:13px;color:#666;">If the button doesn't work, paste this into your browser:<br/><a href="${escapeHtml(fixUrl)}" style="color:${brand.primary_color};">${escapeHtml(fixUrl)}</a></p>`
    : `<p>To update your card on file, reply to this email and we'll send you a secure link.</p>`}
  ${retryLine ? `<p>${escapeHtml(retryLine)}</p>` : ''}
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
        subject,
        text,
        html,
        tags: [
          { name: 'type', value: isFinal ? 'parent_decline_final_notice' : 'parent_decline_notice' },
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

/**
 * Where a family goes to put a new card on: the tenant-scoped parent portal at
 * /{slug}/dashboard - the same path parent-update-card returns them to, and the
 * banner there carries the button.
 *
 * ONE spelling, because two callers need it now: the family's decline email and
 * the operator's alert, which has to hand the operator a link to send by hand
 * on the branch where we are not emailing the family. A second copy of this URL
 * is a future divergence on the one link whose entire job is to work.
 *
 * null is a legitimate answer and both callers drop the link rather than invent
 * a URL: a half-built address on the message that is supposed to solve the
 * problem is worse than no address at all.
 */
function portalDashboardUrl(orgSlug: string | null): string | null {
  if (!orgSlug) return null;
  const base = (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com').replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(orgSlug)}/dashboard`;
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
