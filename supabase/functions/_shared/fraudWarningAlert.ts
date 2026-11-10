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
// If the run dies between claim and send, the unsent claim goes stale and the
// next redelivery takes it over (alerted_at stays NULL until the send succeeds).

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
  let organizationId: string | null = null;
  let registrationId: string | null = null;
  if (piId) {
    const { data: instRow, error: instErr } = await admin
      .from('installments').select('organization_id, registration_id')
      .eq('stripe_payment_intent_id', piId).limit(1).maybeSingle();
    if (instErr) lookupFailed = true;
    const inst = instRow as { organization_id: string | null; registration_id: string | null } | null;
    if (inst) {
      // installments.organization_id is NULLABLE (20260806b). A found row with
      // no org still owns the registration and still skips the registrations
      // lookup - exactly as handleDispute always did - and falls through to
      // the connected-account fallback below.
      organizationId = inst.organization_id ?? null;
      registrationId = inst.registration_id ?? null;
    } else {
      const { data: regRow, error: regErr } = await admin
        .from('registrations').select('id, organization_id')
        .eq('stripe_payment_intent_id', piId).limit(1).maybeSingle();
      if (regErr) lookupFailed = true;
      const reg = regRow as { id: string; organization_id: string } | null;
      if (reg) {
        organizationId = reg.organization_id;
        registrationId = reg.id;
      }
    }
  }
  // Fall back to the connected account when the charge predates our records.
  if (!organizationId && chargeAccountId) {
    const { data: orgRow, error: orgErr } = await admin
      .from('organizations').select('id').eq('stripe_account_id', chargeAccountId).maybeSingle();
    if (orgErr) lookupFailed = true;
    organizationId = (orgRow as { id: string } | null)?.id ?? null;
  }
  return { organizationId, registrationId, lookupFailed };
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
  /** Stripe's `actionable`. False = already refunded or disputed. Defaults true. */
  actionable?: boolean;
  /**
   * Whether the charge resolved to a registration in enrops, even if its
   * details could not be loaded. Defaults to "children were loaded".
   */
  matchedRegistration?: boolean;
}

// Fraud types where the card itself was misused (stolen, lost, counterfeit,
// never received, opened fraudulently). For these the cardholder is, by the
// bank's account, NOT the person who registered - so "they did not recognize
// the charge" and "ask them to tell their bank" are the wrong story.
const CARD_MISUSE_TYPES = new Set([
  'card_never_received',
  'fraudulent_card_application',
  'made_with_counterfeit_card',
  'made_with_lost_card',
  'made_with_stolen_card',
]);

export function renderFraudWarningAlert(i: FraudAlertInput): { subject: string; body: string } {
  const who = i.parentName?.trim() || 'a family';
  const actionable = i.actionable !== false;
  const cardMisuse = !!i.fraudType && CARD_MISUSE_TYPES.has(i.fraudType);
  const matched = i.matchedRegistration ?? i.children.length > 0;

  const subject = actionable
    ? `Fraud warning on a payment from ${who}: contact them today`
    : `Fraud warning on a payment from ${who}: no action needed`;

  const lines: string[] = [];
  // Each opening sentence is said against the state that selects it:
  //   not actionable -> already refunded or disputed; nothing to do here.
  //   card misuse    -> the card was reported misused; the payer may not be the cardholder.
  //   otherwise      -> the cardholder says they did not authorize it; usually unrecognized.
  if (!actionable) {
    lines.push(
      `The cardholder's bank has reported a payment to you as ${describeFraudType(i.fraudType)}. `
        + `Stripe says this payment has already been refunded or disputed, so there is nothing to do here. `
        + `If it was disputed, you will see it under Disputes in Finances.`,
    );
  } else if (cardMisuse) {
    lines.push(
      `The cardholder's bank has reported a payment to you as ${describeFraudType(i.fraudType)}. `
        + `The person who registered may not be the cardholder. `
        + `A bank can turn this into a chargeback within hours, so please contact the family today.`,
    );
  } else {
    lines.push(
      `The cardholder's bank has reported a payment from ${who} as ${describeFraudType(i.fraudType)}. `
        + `This usually means they did not recognize the charge on their card statement. `
        + `A bank can turn this into a chargeback within hours, so please contact the family today.`,
    );
  }

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
  // Any time the registration could not be matched, say so - even when the
  // amount loaded - because the refund advice below depends on that match.
  if (!matched) {
    lines.push('- We could not match this payment to a registration in enrops.');
  }

  if (!actionable) return { subject, body: lines.join('\n') };

  lines.push('');
  lines.push('WHAT TO DO');
  // Unmatched: there is no registration to refund from, and on a destination
  // charge the operator has no Stripe dashboard view of the payment either.
  const refundWhere = matched
    ? 'refund it in enrops right away'
    : 'contact enrops support right away to have it refunded';
  if (cardMisuse) {
    lines.push('- Ask the family how they paid and whether the card was theirs.');
    lines.push(
      `- If it was not their card, or you cannot reach them: ${refundWhere}. `
        + 'Once the bank opens a dispute, the payment can no longer be refunded.',
    );
  } else {
    lines.push('- If they made the payment: ask them to tell their bank the charge is theirs.');
    lines.push(
      `- If they did not: ${refundWhere}. Once the bank opens a dispute, `
        + 'the payment can no longer be refunded.',
    );
  }

  return { subject, body: lines.join('\n') };
}

// ── The handler ─────────────────────────────────────────────────────────────
//
// Lives here, not inline in stripe-webhook, so it can be run against a real
// database with the Stripe read and the email send stubbed, and so prod's
// composed stripe-webhook carries only a small dispatch for it.

export interface FraudWarningDeps {
  /** Read a charge: { amount, created, calculated_statement_descriptor }. */
  retrieveCharge: (chargeId: string, stripeAccount: string | null) => Promise<{
    amount?: number | null; created?: number | null; calculated_statement_descriptor?: string | null;
  }>;
  /** Loads the org's brand; only tenant_alert_email is read from it here. */
  loadBrand: (orgId: string) => Promise<{ tenant_alert_email: string | null }>;
  /** Sends to the tenant inbox; true when the email was accepted. */
  sendAlert: (brand: any, to: string | null, subject: string, body: string, idempotencyKey: string) => Promise<boolean>;
  /** Clock, for tests. Defaults to Date.now. */
  now?: () => number;
}

// A claim older than this with no alerted_at is treated as a run that died
// mid-send. It only has to be longer than one webhook run (Stripe stops
// waiting after about 20 seconds). Correctness does not depend on Stripe's
// retry timing: a delivery that finds a fresh unsent claim answers 500, so
// Stripe keeps retrying until the claim is either sent or stale.
const STALE_CLAIM_MS = 5 * 60 * 1000;

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
    fraud_type?: string | null; created?: number; actionable?: boolean;
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
  // created_at is stamped from THIS clock (not the DB default) because the
  // stale-claim check below compares against this clock too; mixing the two
  // would let clock skew shrink the window and take over a live claim.
  const { error: claimErr } = await admin.from('fraud_warnings').insert({
    created_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
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
    if ((claimErr as { code?: string }).code !== '23505') {
      console.error(`[fraud warning] ${efw.id} could not be claimed:`, claimErr.message);
      return 'retry';
    }
    // Someone holds the claim. Normally that delivery sent (or is sending) the
    // alert and this one stops. But if that run died between claim and send,
    // the row sits there unsent and every retry would skip it forever - the
    // silently-lost alert this feature exists to prevent. So a claim that is
    // STALE and was NEVER SENT is taken over, in one conditional UPDATE so two
    // redeliveries cannot both take it.
    const staleBefore = new Date((deps.now?.() ?? Date.now()) - STALE_CLAIM_MS).toISOString();
    const { data: taken, error: takeErr } = await admin
      .from('fraud_warnings')
      .update({ created_at: new Date(deps.now?.() ?? Date.now()).toISOString() })
      .eq('stripe_warning_id', efw.id)
      .is('alerted_at', null)
      .lt('created_at', staleBefore)
      .select('id');
    if (takeErr) {
      console.error(`[fraud warning] ${efw.id} stale-claim check failed:`, takeErr.message);
      return 'retry';
    }
    if (!taken || taken.length === 0) {
      // Not stale enough to take. If that claim was already SENT, we are done.
      // If it is fresh and unsent, its holder is mid-send - or died. Answer
      // 'retry' so Stripe comes back: by then the holder has either stamped
      // alerted_at (-> done) or released the claim / gone stale (-> we send).
      // A 200 here would end Stripe's retries for this endpoint and, if the
      // holder had died, lose the alert.
      const { data: held, error: heldErr } = await admin
        .from('fraud_warnings').select('alerted_at').eq('stripe_warning_id', efw.id).maybeSingle();
      if (heldErr) {
        console.error(`[fraud warning] ${efw.id} could not read the held claim:`, heldErr.message);
        return 'retry';
      }
      if ((held as { alerted_at: string | null } | null)?.alerted_at) {
        console.log(`[fraud warning] ${efw.id} already alerted; skipping redelivery`);
        return 'done';
      }
      console.log(`[fraud warning] ${efw.id} held by an in-flight delivery; asking Stripe to retry`);
      return 'retry';
    }
    console.warn(`[fraud warning] ${efw.id} took over a stale unsent claim`);
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
    // "Matched" means the charge resolved to a registration - NOT that the
    // detail read succeeded. A timed-out detail read must not tell the
    // operator to go through enrops support for a payment they can refund.
    matchedRegistration: regIds.size > 0,
    // Stripe sets actionable=false when the charge is already refunded or
    // disputed, so "refund it now" would be advice that cannot be followed.
    actionable: efw.actionable !== false,
  });

  const brand = await deps.loadBrand(orgId);
  // The idempotency key makes a retry after "Resend accepted it but the
  // connection dropped" a no-op at Resend instead of a second email.
  const sent = await deps.sendAlert(brand, brand.tenant_alert_email, subject, body, `efw-${efw.id}`);
  if (!sent) {
    // ANY failed send releases the claim and asks Stripe to retry - including
    // "no inbox". loadOrgBrand swallows its own read error, so a database blip
    // looks exactly like an org with no alert address; treating that as
    // permanent would answer 200 and lose the alert. A genuinely inbox-less org
    // costs Stripe some retries and sends nothing, which is the honest outcome.
    const { error: relErr } = await admin.from('fraud_warnings').delete().eq('stripe_warning_id', efw.id);
    if (relErr) console.error(`[fraud warning] ${efw.id} claim could not be released:`, relErr.message);
    return 'retry';
  }
  // Mark it sent. If this write fails the email still went; the only cost is
  // that a redelivery >5 minutes later could send a second copy - a duplicate
  // alert, never a missing one, so it is logged and not retried.
  const { error: markErr } = await admin
    .from('fraud_warnings').update({ alerted_at: new Date(deps.now?.() ?? Date.now()).toISOString() })
    .eq('stripe_warning_id', efw.id);
  if (markErr) console.error(`[fraud warning] ${efw.id} sent but could not be marked sent:`, markErr.message);
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
