// Early fraud warning -> same-day operator alert.
//
// An early fraud warning (Stripe event radar.early_fraud_warning.created) means
// the CARDHOLDER'S BANK reported a charge as fraud. It is not Radar's opinion:
// the three Radar scores on the payment can all read "Normal" while the warning
// exists. It is the step before a chargeback - on the Hen charge (Oct 2026) the
// 10.4 dispute followed 5.4 hours after the warning - and until a dispute is
// filed the charge can still be refunded. Most of these are a family that did
// not recognise the charge on their statement, and a call the same day settles
// it. So the only job here is to get the family's details to the operator fast.
//
// ALERT ONLY. Nothing here refunds, blocks or changes a registration; the
// operator decides. Recipient is the tenant's own inbox (brand.tenant_alert_email),
// never the platform: the body names the family, as every operator alert does.
//
// SENDS ONCE. public.fraud_warnings.stripe_warning_id is UNIQUE and the row is
// claimed BEFORE the send (Stripe retries, and two endpoints point at
// stripe-webhook). If the send fails the claim is released and the caller
// returns 500, so Stripe's retry gets another go rather than the alert vanishing.

// deno-lint-ignore-file no-explicit-any

export interface ChargeOwner {
  organizationId: string | null;
  registrationId: string | null;
  /** True when a lookup ERRORED (as opposed to finding nothing). */
  lookupFailed: boolean;
}

// Map a charge to the org (and one registration) that owns it. The one place
// this lookup is spelled: handleDispute and the fraud-warning handler both call
// it. Order: installments by PaymentIntent, then registrations by
// PaymentIntent, then the connected account the event came from.
//
// lookupFailed separates "the database errored" from "no such charge". The
// dispute mirror ignores it (unchanged behaviour); the fraud-warning path fails
// the webhook on it, because an alert silently dropped is exactly the failure
// this feature exists to prevent.
export async function resolveChargeOwner(
  admin: any,
  piId: string | null,
  chargeAccountId: string | null,
): Promise<ChargeOwner> {
  let lookupFailed = false;
  if (piId) {
    const { data: instRow, error: instErr } = await admin
      .from('installments').select('organization_id, registration_id')
      .eq('stripe_payment_intent_id', piId).limit(1).maybeSingle();
    if (instErr) lookupFailed = true;
    const inst = instRow as { organization_id: string; registration_id: string } | null;
    if (inst) return { organizationId: inst.organization_id, registrationId: inst.registration_id, lookupFailed };

    const { data: regRow, error: regErr } = await admin
      .from('registrations').select('id, organization_id')
      .eq('stripe_payment_intent_id', piId).limit(1).maybeSingle();
    if (regErr) lookupFailed = true;
    const reg = regRow as { id: string; organization_id: string } | null;
    if (reg) return { organizationId: reg.organization_id, registrationId: reg.id, lookupFailed };
  }
  // Fall back to the connected account when the charge predates our records.
  if (chargeAccountId) {
    const { data: orgRow, error: orgErr } = await admin
      .from('organizations').select('id').eq('stripe_account_id', chargeAccountId).maybeSingle();
    if (orgErr) lookupFailed = true;
    const id = (orgRow as { id: string } | null)?.id ?? null;
    if (id) return { organizationId: id, registrationId: null, lookupFailed };
  }
  return { organizationId: null, registrationId: null, lookupFailed };
}

// Stripe's fraud_type values, in words an operator reads. Unknown values fall
// through to a generic phrase rather than printing a code.
const FRAUD_TYPE_WORDS: Record<string, string> = {
  unauthorized_use_of_card: 'a charge the cardholder did not authorize',
  card_never_received: 'a charge on a card the cardholder never received',
  fraudulent_card_application: 'a charge on a fraudulently opened card',
  made_with_counterfeit_card: 'a charge made with a counterfeit card',
  made_with_lost_card: 'a charge made with a lost card',
  made_with_stolen_card: 'a charge made with a stolen card',
};

export function describeFraudType(t: string | null | undefined): string {
  return (t && FRAUD_TYPE_WORDS[t]) || 'a fraudulent charge';
}

export interface AlertChild {
  childFirstName: string;
  programName: string;
  siteName: string | null;
}

export interface FraudAlertInput {
  parentName: string | null;
  parentEmail: string | null;
  parentPhone: string | null;
  children: AlertChild[];
  /** Charge amount in cents, or null when the charge could not be read. */
  amountCents: number | null;
  /** When the family paid, already formatted in the org's timezone, or null. */
  paidOn: string | null;
  /** What the family sees on their card statement, or null when unknown. */
  statementDescriptor: string | null;
  fraudType: string | null;
}

export function renderFraudWarningAlert(i: FraudAlertInput): { subject: string; body: string } {
  const who = i.parentName?.trim() || 'a family';
  const subject = `Fraud warning on a payment from ${who}: contact them today`;

  const lines: string[] = [];
  lines.push(
    `The bank for ${who} has reported a payment to you as ${describeFraudType(i.fraudType)}. `
      + `This usually means they did not recognize the charge on their card statement. `
      + `Banks often turn these into chargebacks within hours, so please contact the family today.`,
  );

  lines.push('');
  lines.push('FAMILY');
  lines.push(`- ${i.parentName?.trim() || 'Name not on file'}`);
  if (i.parentPhone) lines.push(`- Phone: ${i.parentPhone}`);
  if (i.parentEmail) lines.push(`- Email: ${i.parentEmail}`);

  lines.push('');
  lines.push('PAYMENT');
  if (i.amountCents != null) {
    lines.push(`- $${(i.amountCents / 100).toFixed(2)}${i.paidOn ? `, paid ${i.paidOn}` : ''}`);
  } else if (i.paidOn) {
    lines.push(`- Paid ${i.paidOn}`);
  }
  if (i.statementDescriptor) lines.push(`- On their card statement: ${i.statementDescriptor}`);
  for (const c of i.children) {
    lines.push(`- ${c.childFirstName}: ${c.programName}${c.siteName ? ` at ${c.siteName}` : ''}`);
  }
  if (i.amountCents == null && !i.paidOn && !i.statementDescriptor && i.children.length === 0) {
    lines.push('- We could not load the payment details. Search for the family in Registrations.');
  }

  lines.push('');
  lines.push('WHAT TO DO');
  lines.push('- If they made the payment: ask them to tell their bank the charge is theirs.');
  lines.push(
    '- If they did not: refund it in enrops right away. Once the bank opens a dispute, '
      + 'the payment can no longer be refunded.',
  );

  return { subject, body: lines.join('\n') };
}

// ── The handler ─────────────────────────────────────────────────────────────
//
// Lives here, not inline in stripe-webhook, so it can be run against a real
// database with the Stripe read and the email send stubbed (see the staging
// harness in scripts/) and so prod's composed stripe-webhook carries only a
// one-line dispatch for it.

export interface FraudWarningDeps {
  /** Read a charge: { amount, created, calculated_statement_descriptor }. */
  retrieveCharge: (chargeId: string, stripeAccount: string | null) => Promise<{
    amount?: number | null; created?: number | null; calculated_statement_descriptor?: string | null;
  }>;
  /** Loads the org's brand; only tenant_alert_email is read from it here. */
  loadBrand: (orgId: string) => Promise<{ tenant_alert_email: string | null }>;
  /** Sends to the tenant inbox; true when the email was accepted. */
  sendAlert: (brand: any, to: string | null, subject: string, body: string) => Promise<boolean>;
}

export interface FraudWarningEvent {
  account?: string | null;
  data: { object: unknown };
}

// Returns 'retry' when the webhook should answer 500: the charge could not be
// mapped because the database errored, the claim insert errored, or the alert
// email failed (the claim is released first so the retry can send).
export async function handleEarlyFraudWarning(
  admin: any,
  event: FraudWarningEvent,
  deps: FraudWarningDeps,
): Promise<'done' | 'retry'> {
  const efw = event.data.object as {
    id: string; charge: string | { id: string } | null;
    payment_intent?: string | { id: string } | null;
    fraud_type?: string | null; created?: number;
  };
  const chargeAccountId = event.account ?? null;
  const chargeId = typeof efw.charge === 'string' ? efw.charge : efw.charge?.id ?? null;
  const piId = typeof efw.payment_intent === 'string'
    ? efw.payment_intent
    : efw.payment_intent?.id ?? null;

  const owner = await resolveChargeOwner(admin, piId, chargeAccountId);
  if (!owner.organizationId) {
    if (owner.lookupFailed) {
      console.error(`[fraud warning] ${efw.id}: charge lookup errored (pi=${piId}); asking Stripe to retry`);
      return 'retry';
    }
    console.error(
      `[fraud warning] ${efw.id} could not be mapped to an org (pi=${piId}, acct=${chargeAccountId}); no alert`,
    );
    return 'done';
  }
  const orgId = owner.organizationId;

  // Claim FIRST: the unique stripe_warning_id is what makes this send once.
  const { error: claimErr } = await admin.from('fraud_warnings').insert({
    organization_id: orgId,
    stripe_warning_id: efw.id,
    stripe_charge_id: chargeId,
    stripe_payment_intent_id: piId,
    stripe_charge_account_id: chargeAccountId,
    registration_id: owner.registrationId,
    fraud_type: efw.fraud_type ?? null,
    warned_at: efw.created ? new Date(efw.created * 1000).toISOString() : null,
  });
  if (claimErr) {
    if ((claimErr as { code?: string }).code === '23505') {
      console.log(`[fraud warning] ${efw.id} already alerted; skipping redelivery`);
      return 'done';
    }
    console.error(`[fraud warning] ${efw.id} could not be claimed:`, claimErr.message);
    return 'retry';
  }

  // DETAILS ARE BEST-EFFORT. Every read below degrades to a shorter email
  // rather than no email: a partial alert the same day beats a perfect one never.

  // Every registration this charge paid for (one checkout can cover siblings;
  // an instalment charge is found through its installments rows).
  const regIds = new Set<string>();
  if (owner.registrationId) regIds.add(owner.registrationId);
  if (piId) {
    const [{ data: regRows, error: regErr }, { data: instRows, error: instErr }] = await Promise.all([
      admin.from('registrations').select('id').eq('stripe_payment_intent_id', piId).eq('organization_id', orgId),
      admin.from('installments').select('registration_id').eq('stripe_payment_intent_id', piId).eq('organization_id', orgId),
    ]);
    if (regErr || instErr) console.error('[fraud warning] registration lookup errored:', regErr?.message ?? instErr?.message);
    for (const r of (regRows ?? []) as { id: string }[]) regIds.add(r.id);
    for (const r of (instRows ?? []) as { registration_id: string }[]) if (r.registration_id) regIds.add(r.registration_id);
  }

  let parentId: string | null = null;
  const children: AlertChild[] = [];
  if (regIds.size > 0) {
    const { data: regs, error: regsErr } = await admin
      .from('registrations')
      .select('id, parent_id, students(first_name), programs(curriculum, program_locations(name))')
      .in('id', [...regIds])
      .eq('organization_id', orgId);
    if (regsErr) console.error('[fraud warning] registration details errored:', regsErr.message);
    for (const r of (regs ?? []) as any[]) {
      parentId = parentId ?? r.parent_id ?? null;
      children.push({
        childFirstName: r.students?.first_name ?? 'Child',
        programName: r.programs?.curriculum ?? 'Program',
        siteName: r.programs?.program_locations?.name ?? null,
      });
    }
  }

  type ParentContact = { first_name?: string; last_name?: string; email?: string; phone?: string };
  let parent: ParentContact | null = null;
  if (parentId) {
    const { data, error } = await admin
      .from('parents').select('first_name, last_name, email, phone').eq('id', parentId).maybeSingle();
    if (error) console.error('[fraud warning] parent lookup errored:', error.message);
    parent = (data as ParentContact | null) ?? null;
  }

  const { data: orgRow } = await admin
    .from('organizations').select('timezone').eq('id', orgId).maybeSingle();
  const timeZone = (orgRow as { timezone?: string } | null)?.timezone ?? null;

  // Amount, date and statement text come from the charge itself.
  let amountCents: number | null = null;
  let paidOn: string | null = null;
  let statementDescriptor: string | null = null;
  if (chargeId) {
    try {
      const charge = await deps.retrieveCharge(chargeId, chargeAccountId);
      amountCents = charge.amount ?? null;
      paidOn = formatPaidOn(charge.created, timeZone);
      statementDescriptor = charge.calculated_statement_descriptor ?? null;
    } catch (err) {
      console.error(`[fraud warning] could not read charge ${chargeId}:`, (err as Error).message);
    }
  }

  const parentName = parent ? [parent.first_name, parent.last_name].filter(Boolean).join(' ') || null : null;
  const { subject, body } = renderFraudWarningAlert({
    parentName,
    parentEmail: parent?.email ?? null,
    parentPhone: parent?.phone ?? null,
    children,
    amountCents,
    paidOn,
    statementDescriptor,
    fraudType: efw.fraud_type ?? null,
  });

  const brand = await deps.loadBrand(orgId);
  const sent = await deps.sendAlert(brand, brand.tenant_alert_email, subject, body);
  if (!sent) {
    // No inbox at all is permanent: retrying cannot fix it, and the sender has
    // already logged it. Keep the claim so redeliveries stop here.
    if (!brand.tenant_alert_email) return 'done';
    // A failed send is transient: release the claim so Stripe's retry can send.
    const { error: relErr } = await admin.from('fraud_warnings').delete().eq('stripe_warning_id', efw.id);
    if (relErr) console.error(`[fraud warning] ${efw.id} claim could not be released:`, relErr.message);
    return 'retry';
  }
  console.log(`[fraud warning] ${efw.id} alerted org ${orgId} (${children.length} registration(s))`);
  return 'done';
}

export function formatPaidOn(unixSeconds: number | null | undefined, timeZone: string | null | undefined): string | null {
  if (!unixSeconds) return null;
  const opts: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric', year: 'numeric' };
  try {
    return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { ...opts, timeZone: timeZone || 'UTC' });
  } catch {
    // An unrecognised timezone string must not cost the alert its date.
    return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
  }
}
