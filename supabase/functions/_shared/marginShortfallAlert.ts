// marginShortfallAlert — tell enrops when we could not return our margin to an
// operator, because on 2026-09-08 nothing did.
//
// Three fee returns failed that day on a low platform balance: $3.71 and $2.40
// to Journey to STEAM, $1.01 to The Ukulele Project. The failure was recorded
// on the refunds row and NOWHERE ELSE. Nothing retries it, so it does not
// self-heal, and nothing announced it, so it sat for two days until somebody
// thought to run a query. Jessica, 2026-09-10: "how can we make sure i receive
// the alert for a failed fee return?"
//
// WHO THIS IS FOR, and it is the whole reason this is a separate channel. The
// OPERATOR is deliberately not told: they cannot refund an application fee,
// only the platform can, and telling them discloses our cash position to a
// customer. That message was removed on 2026-09-08 after Jeff read one. This is
// its replacement, pointed at the one person who can actually act - whoever
// settles the platform Stripe balance.
//
// NOT the refund_watch_alerts channel. That is the refund-RATE flag and it goes
// to Arielle. Different signal, different recipient, different throttle.
//
// THROTTLE IS PER REFUND, not per month like operatorFlagAlert. Each shortfall
// is a discrete debt with its own amount and its own Stripe fee object. Monthly
// throttling would have announced one of that day's three and hidden $3.41.
//
// NEVER THROWS. By the time this runs the family has their money back. An
// internal notification must never be able to affect a refund that already
// happened.
//
// NO EM DASHES.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, formatFromAddress } from './orgBrand.ts';

export interface ShortfallAlertResult {
  sent: boolean;
  reason?: string;
}

export interface ShortfallItem {
  /** The ApplicationFee to refund by hand once the balance covers it. */
  applicationFeeId: string;
  owedCents: number;
  /** Stripe's own words. More use than any sentence we could write over them. */
  reason: string;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Pure so the wording has a runner. The subject leads with the amount and the
 * operator because that is what decides whether this is opened now or later.
 */
export function renderShortfallAlert(args: {
  orgName: string;
  owedCents: number;
  items: ShortfallItem[];
  registrationId: string;
  siteUrl: string;
  /** We know a fee return failed but not how much, nor against which fee. */
  amountUnknown?: boolean;
}): { subject: string; text: string } {
  const { orgName, owedCents, items, registrationId, siteUrl } = args;

  // The unknown-amount variant deliberately does NOT say "$0.00" anywhere. A
  // zero would read as "nothing owed" and get filed, which is worse than the
  // silence it replaces. It asks for a reconciliation instead of naming an
  // amount to refund, because naming one we cannot compute is how somebody
  // refunds the wrong number.
  if (args.amountUnknown === true) {
    return {
      subject: `Action needed: a service fee return failed for ${orgName}, amount unknown`,
      text: [
        `We refunded a family, and returning the enrops service fee to ${orgName} failed.`,
        '',
        'We could NOT read the fee details from Stripe, so we do not know how much is owed',
        'or which application fee it sits on. There may be nothing owed. There may be several dollars.',
        '',
        'This needs a human to reconcile it in the enrops Stripe account:',
        `  find the payment for registration ${registrationId}`,
        '  open its Application fee and compare what was collected against what has been refunded',
        '  if a margin is still held, refund that amount off the APPLICATION FEE, NOT as a transfer',
        '',
        'The family is unaffected. They have their money.',
        '',
        `${siteUrl}/admin/finances`,
        '',
        'The provider has NOT been told, and should not be: they cannot refund an application fee.',
        '',
        'enrops',
      ].join('\n'),
    };
  }

  const lines = [
    `We refunded a family, but could not return ${money(owedCents)} of enrops service fee to ${orgName}.`,
    '',
    'The family is unaffected. They have their money. This is our margin, owed back to the provider,',
    'and NOTHING RETRIES IT. It needs an application-fee refund in Stripe by hand once the platform',
    'balance covers it.',
    '',
    'What to refund:',
  ];
  for (const it of items) {
    lines.push(`  ${money(it.owedCents)} on ${it.applicationFeeId}`);
    lines.push(`    Stripe said: ${it.reason}`);
  }
  lines.push(
    '',
    'Where: the enrops Stripe account, on the payment. Open the Application fee and refund that amount.',
    'Refund the application fee, NOT a transfer. A transfer lands as unattributed money in their balance',
    'and never reconciles against the fee.',
    '',
    `Registration ${registrationId}`,
    `${siteUrl}/admin/finances`,
    '',
    'The provider has NOT been told, and should not be: they cannot refund an application fee.',
    '',
    'enrops',
  );
  return {
    subject: `Action needed: ${money(owedCents)} of service fee not returned to ${orgName}`,
    text: lines.join('\n'),
  };
}

/**
 * Announce a margin we failed to return. Call it from EVERY path that can fail
 * that way; today that is refund-registration and the stripe-webhook's
 * charge.refunded handler.
 */
export async function alertMarginShortfall(
  admin: SupabaseClient,
  args: {
    refundRowId: string;
    organizationId: string;
    registrationId: string;
    items: ShortfallItem[];
    resendApiKey: string;
    siteUrl: string;
    /** Passed in, not imported, so no send path here can quietly skip it. */
    isAllowed: (address: string) => boolean;
    /**
     * True when we could not even READ the fee facts, so a debt may exist and
     * its size is unknown. Distinct from "no fee, nothing owed": that case is
     * items:[] with this false, and correctly sends nothing. Without this flag
     * a Stripe outage during readChargeFeeFacts produced silence, which is the
     * failure this whole module exists to remove.
     */
    amountUnknown?: boolean;
  },
): Promise<ShortfallAlertResult> {
  try {
    const items = args.items.filter((i) => i.owedCents > 0);
    if (items.length === 0 && args.amountUnknown !== true) return { sent: false, reason: 'nothing owed' };
    const owedCents = items.reduce((n, i) => n + i.owedCents, 0);

    const { data: cfgRow } = await admin
      .from('platform_settings').select('value').eq('key', 'margin_shortfall_alerts').maybeSingle();
    const cfg = ((cfgRow as { value?: Record<string, unknown> } | null)?.value ?? {}) as Record<string, unknown>;
    if (cfg.enabled !== true) return { sent: false, reason: 'shortfall alerts are off' };

    // Every way this can be alive and deliver nothing is MISCONFIGURATION, and
    // each is louder than the silence it would otherwise produce. A guard that
    // drops quietly is indistinguishable from a feature that does not work.
    const to = String(cfg.to ?? '').trim();
    if (!to) {
      console.error('[margin alert] MISCONFIGURED: margin_shortfall_alerts is enabled but has no recipient. Money owed to an operator will go unannounced.');
      return { sent: false, reason: 'no recipient configured' };
    }
    // Checked BEFORE the claim. Claiming and then failing to send would burn
    // this refund's only alert for a reason unrelated to the shortfall.
    if (!args.isAllowed(to)) {
      console.warn(`[margin alert] HELD BACK by this environment's email allowlist: ${to}. Expected on staging; on prod it means the alert is dead.`);
      return { sent: false, reason: `recipient not allowed in this environment: ${to}` };
    }

    // Claim the refund FIRST. The unique index is the throttle, so a webhook
    // redelivery or two paths racing cannot both send.
    const { error: claimErr } = await admin
      .from('margin_shortfall_alerts')
      .insert({
        refund_id: args.refundRowId,
        organization_id: args.organizationId,
        owed_cents: owedCents,
        context: {
          registration_id: args.registrationId,
          items: items.map((i) => ({
            application_fee_id: i.applicationFeeId,
            owed_cents: i.owedCents,
            reason: i.reason,
          })),
        },
      });
    if (claimErr) {
      if ((claimErr as { code?: string }).code === '23505') return { sent: false, reason: 'already alerted for this refund' };
      console.error('[margin alert] could not claim:', claimErr);
      return { sent: false, reason: 'claim failed' };
    }

    // FROM HERE THE CLAIM IS A DEBT OF OUR OWN: it says this shortfall has been
    // announced, and UNIQUE(refund_id) means nothing will ever announce it
    // again. So every exit between here and a confirmed send MUST release it.
    //
    // The first version released only on `!resp.ok`, which is an HTTP error
    // RESPONSE. It missed the commonest failure of all: `fetch` REJECTING on a
    // DNS failure, connection reset or timeout. That path skipped the release
    // entirely, and the row was left asserting an email that never went - a
    // silent debt with paperwork, which is the exact thing this module exists
    // to prevent. `finally` covers a throw, an early return and a bad status
    // alike, so the release cannot be missed by adding an exit later.
    let sent = false;
    try {
      const { data: orgRow } = await admin
        .from('organizations').select('name').eq('id', args.organizationId).maybeSingle();
      const orgName = (orgRow as { name?: string } | null)?.name ?? 'an operator';

      const platform = await loadOrgBrand(admin, null);
      const { subject, text } = renderShortfallAlert({
        orgName,
        owedCents,
        items,
        registrationId: args.registrationId,
        siteUrl: args.siteUrl,
        amountUnknown: args.amountUnknown === true,
      });

      const body = JSON.stringify({
        from: formatFromAddress(platform),
        to,
        subject,
        text,
        tags: [{ name: 'type', value: 'margin_shortfall_alert' }],
      });
      const send = () => fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${args.resendApiKey}` },
        body,
      });

      // Retry before giving up, same reasoning as the flag alert: unlike a
      // refund-rate crossing there is no "next refund this month" to try again,
      // so a lost send means the debt is silent. Retries a THROW as well as a
      // 5xx, because a dropped connection is just as transient as a 502.
      let resp: Response;
      try {
        resp = await send();
        if (!resp.ok && resp.status >= 500) {
          console.warn(`[margin alert] resend ${resp.status}, retrying once`);
          await new Promise((r) => setTimeout(r, 1000));
          resp = await send();
        }
      } catch (netErr) {
        console.warn(`[margin alert] resend threw (${(netErr as Error).message}), retrying once`);
        await new Promise((r) => setTimeout(r, 1000));
        resp = await send(); // a second throw falls to the outer catch; finally still releases
      }
      if (!resp.ok) {
        console.error(
          `[margin alert] SEND FAILED after retry (${resp.status}). ${owedCents}c is owed to org ` +
          `${args.organizationId} and NOBODY HAS BEEN TOLD: ${await resp.text()}`,
        );
        return { sent: false, reason: `resend ${resp.status}` };
      }

      sent = true;
      console.log(`[margin alert] ${owedCents}c owed to ${orgName} reported to ${to}`);
      return { sent: true };
    } finally {
      if (!sent) {
        // Release, so a later path can still announce this. Guarded because a
        // throw HERE would replace the real error with a misleading one, and
        // because the shout below is the last line of defence either way.
        try {
          await admin.from('margin_shortfall_alerts').delete().eq('refund_id', args.refundRowId);
        } catch (relErr) {
          console.error('[margin alert] could not release the claim; this shortfall is now permanently unannounceable:', relErr);
        }
        console.error(
          `[margin alert] NOT SENT. ${owedCents}c owed to org ${args.organizationId} on refund ` +
          `${args.refundRowId} and nobody has been told.`,
        );
      }
    }
  } catch (err) {
    console.error('[margin alert] error (the refund itself is unaffected):', err);
    return { sent: false, reason: (err as Error).message };
  }
}
