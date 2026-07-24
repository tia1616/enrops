// process-installments v6 — daily cron worker that charges due installments off-session.
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
// program dates are.
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
// 3. Group by (stripe_customer_id, installment_number).
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
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { buildConnectChargeParams, ConnectOrgConfig } from '../_shared/connectChargeParams.ts';
import { passThroughFeeCents } from '../_shared/passThroughFee.ts';
import { loadOrgBrand, formatFromAddress, OrgBrand } from '../_shared/orgBrand.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
// FROM/reply-to/alert addresses are loaded per-org via loadOrgBrand() with
// Enrops platform defaults baked in. No more J2S-flavored env-var fallback.
const PLATFORM_ALERT_DEFAULT = 'alerts@enrops.com';
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

    // STEP 2: For each (customer_id, installment_number) in the trigger set, pull
    // ALL pending sibling rows from that group — even ones with due_date > today.
    // These get charged together. (v5 earliest-date grouping.)
    const triggerKeys = new Set<string>();
    for (const row of triggerSet as InstallmentRow[]) {
      triggerKeys.add(`${row.stripe_customer_id}__${row.installment_number}`);
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

    // Filter down to only rows whose (customer, instNum) is in triggerKeys
    // (the .in() above is a Cartesian product across customers and inst-nums)
    const dueInstallments = (allCandidateRows as InstallmentRow[]).filter((r) =>
      triggerKeys.has(`${r.stripe_customer_id}__${r.installment_number}`),
    );

    console.log(`Expanded to ${dueInstallments.length} rows including future-dated siblings`);

    const orgIds = [...new Set(dueInstallments.map((r) => r.organization_id))];
    const { data: orgs } = await admin
      .from('organizations')
      .select(`
        id, alert_email, name,
        stripe_account_id, stripe_charges_enabled,
        statement_descriptor_suffix,
        platform_fee_card_pct, platform_fee_ach_pct, platform_fee_cap_cents, platform_fee_floor_cents,
        fee_pass_through, stripe_fee_payer, instructor_pay_model
      `)
      .in('id', orgIds);

    const alertEmailMap = new Map<string, string>();
    const orgConfigMap = new Map<string, ConnectOrgConfig>();
    for (const org of orgs || []) {
      alertEmailMap.set(org.id, org.alert_email || PLATFORM_ALERT_DEFAULT);
      orgConfigMap.set(org.id, {
        stripe_account_id: org.stripe_account_id,
        stripe_charges_enabled: org.stripe_charges_enabled,
        statement_descriptor_suffix: org.statement_descriptor_suffix,
        name: org.name,
        platform_fee_card_pct: org.platform_fee_card_pct,
        platform_fee_ach_pct: org.platform_fee_ach_pct,
        platform_fee_cap_cents: org.platform_fee_cap_cents,
        platform_fee_floor_cents: org.platform_fee_floor_cents,
        fee_pass_through: org.fee_pass_through,
        stripe_fee_payer: org.stripe_fee_payer,
        instructor_pay_model: org.instructor_pay_model,
      });
    }

    // STEP 3: Group by (stripe_customer_id, installment_number) — NOT including due_date.
    // This is the v5 change: rows with different due_dates can land in the same group.
    const groupMap = new Map<string, InstallmentRow[]>();
    for (const row of dueInstallments) {
      const key = `${row.stripe_customer_id}__${row.installment_number}`;
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
      const alertEmail = alertEmailMap.get(orgId) || PLATFORM_ALERT_DEFAULT;
      const orgConfig = orgConfigMap.get(orgId) || null;
      const brand = orgBrandMap.get(orgId) || platformBrand;
      try {
        await processGroup(admin, groupRows, summary, alertEmail, orgConfig, brand);
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
        to: PLATFORM_ALERT_DEFAULT,
        subject: 'Cron worker FATAL error',
        body: `process-installments crashed: ${(err as Error).message}\n\nNo installments were processed today. Manual investigation required.`,
      });
    }
    return jsonResp({ error: (err as Error).message }, 500);
  }
});

async function processGroup(
  admin: ReturnType<typeof createClient>,
  groupRows: InstallmentRow[],
  summary: any,
  alertEmail: string,
  orgConfig: ConnectOrgConfig | null,
  brand: OrgBrand,
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

  // v6: Connect destination charge overlay (application_fee_amount,
  // transfer_data.destination, statement_descriptor_suffix). Spreads into
  // top-level paymentIntents.create params (NOT under payment_intent_data —
  // that nesting only applies to Checkout Sessions). Empty {} when the org
  // is not connected, leaving direct-charge behavior intact.
  const connectParams = buildConnectChargeParams(
    totalAmount,
    'card',
    orgConfig,
    activeRows[0].organization_id,
  );

  // Pass-through: if the operator passes the fee to families, this installment
  // charges its base amount PLUS the proportional 1% (application_fee above is
  // unchanged at 1% of base, so the operator nets the full installment).
  const passFee = orgConfig ? passThroughFeeCents(totalAmount, 'card', orgConfig) : 0;

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
        },
        ...connectParams,
      },
      { idempotencyKey },
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
    }).in('id', sortedRowIds);

    summary.charged_groups++;
    summary.charged_rows += activeRows.length;
    summary.details.push(`PAID group ${idempotencyKey}: ${paymentIntent.id} ($${(totalAmount / 100).toFixed(2)} across ${activeRows.length} rows)`);
    console.log(`Successfully charged group ${idempotencyKey}: ${paymentIntent.id}`);
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
}: {
  rows: InstallmentRow[];
  regDataById: Map<string, any>;
  parent?: ParentRow;
  declineCode: string;
  failureReason: string;
  totalAmount: number;
  customerId: string;
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
    `Customer: https://dashboard.stripe.com/customers/${customerId}`,
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

async function sendOperatorAlert({ brand, to, subject, body }: { brand: OrgBrand; to: string; subject: string; body: string }) {
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
  brand, parent, installmentNumber, regDataById, rows,
}: {
  brand: OrgBrand;
  parent: ParentRow;
  installmentNumber: number;
  regDataById: Map<string, any>;
  rows: InstallmentRow[];
}): Promise<boolean> {
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
    `To update your card on file, reply to this email and we'll send you a secure link.`,
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
  <p>To update your card on file, reply to this email and we'll send you a secure link.</p>
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
