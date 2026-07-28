// operatorFlagAlert — tell the platform team when an operator crosses the
// refund-rate threshold from Arielle's v4 section 4.
//
// We had built the flag and the screen but nothing that ANNOUNCED a crossing,
// so the only way to learn about one was to remember to open a page. A flag
// nobody is told about is a flag nobody sees. Jessica, 2026-07-28: "the flag
// has to be linked to an actual flag. email to arielle."
//
// WHAT THIS IS NOT. Section 4 is explicit: "This never blocks or delays any
// individual refund - it's a dashboard flag for us, not a gate on the
// transaction." Nothing here touches a refund, and the operator is never told
// they were flagged. It is an internal heads-up, not an accusation.
//
// THROTTLE. At most one alert per operator per calendar month, enforced by a
// unique index rather than remembered in code. A refund-rate crossing is sticky
// - an operator over the line stays over it for days - so alerting per refund
// would turn a signal into noise and get the whole thing muted.
//
// NO EM DASHES.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, formatFromAddress } from './orgBrand.ts';

export interface FlagAlertResult {
  sent: boolean;
  reason?: string;
}

/** YYYY-MM in UTC. Only used as a throttle key, never displayed. */
function periodKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function renderFlagAlert(args: {
  orgName: string;
  ratePct: number;
  threshold: number;
  transactions: number;
  refunded: number;
  windowDays: number;
  siteUrl: string;
}): { subject: string; text: string } {
  const { orgName, ratePct, threshold, transactions, refunded, windowDays, siteUrl } = args;
  return {
    subject: `Refund watch: ${orgName} is at ${ratePct}%`,
    text: [
      `${orgName} has refunded ${refunded} of their last ${transactions} charges over the past ${windowDays} days.`,
      `That is ${ratePct}%, against a review threshold of ${threshold}%.`,
      '',
      'Nothing has been blocked and nothing has been said to them. This is only a prompt to take a look.',
      '',
      'A high rate is often innocent: a cancelled class, a season ending, a single family with several children.',
      'It is worth a look either way.',
      '',
      `${siteUrl}/admin/dev/refund-watch`,
      '',
      'enrops',
    ].join('\n'),
  };
}

/**
 * Alert if this operator is over the threshold and has not been alerted about
 * this month. Never throws: a refund has already moved money by the time this
 * runs, and an internal notification must never be able to affect it.
 */
export async function maybeAlertOperatorFlagged(
  admin: SupabaseClient,
  args: {
    organizationId: string;
    resendApiKey: string;
    siteUrl: string;
    // Same environment guard every other send path uses. Passed in rather than
    // imported so this module stays testable, and so there is no way to add a
    // send path here that quietly skips it.
    isAllowed: (address: string) => boolean;
    now?: Date;
  },
): Promise<FlagAlertResult> {
  try {
    const { data: cfgRow } = await admin
      .from('platform_settings').select('value').eq('key', 'refund_watch_alerts').maybeSingle();
    const cfg = ((cfgRow as { value?: Record<string, unknown> } | null)?.value ?? {}) as Record<string, unknown>;
    if (cfg.enabled !== true) return { sent: false, reason: 'flag alerts are off' };

    // The three ways this feature can be alive but deliver nothing are all
    // MISCONFIGURATION, and each one is louder than the silence it would
    // otherwise produce. A guard that drops quietly is indistinguishable from a
    // feature that does not work: that is exactly how the staging allowlist ate
    // every refund receipt while the code, the tests and the logs looked fine.
    // "Not flagged" is deliberately NOT logged - that is the normal case.
    const to = String(cfg.to ?? '').trim();
    if (!to) {
      console.error('[flag alert] MISCONFIGURED: refund_watch_alerts is enabled but has no recipient. No alert will ever send.');
      return { sent: false, reason: 'no recipient configured' };
    }
    // Checked BEFORE the claim below. If we claimed the month and then found we
    // could not send, this operator would go unalerted until next month for a
    // reason that has nothing to do with their refund rate.
    if (!args.isAllowed(to)) {
      console.warn(`[flag alert] HELD BACK by this environment's email allowlist: ${to}. Expected on staging; on prod it means the alert is dead.`);
      return { sent: false, reason: `recipient not allowed in this environment: ${to}` };
    }

    // ONE source for the numbers. This module used to recompute the rate in
    // TypeScript, and it got a different answer than the flag did: for j2s on
    // staging the database saw 2 of 9 (22.2%) while this code saw 2 of 2 (100%),
    // because it counted only installments and missed registrations paid in one
    // go. An alert whose numbers contradict the screen it links to is worse than
    // no alert. Whatever decides the flag also supplies the numbers.
    const { data: rateRaw, error: rateErr } = await admin
      .rpc('operator_refund_rate', { p_org: args.organizationId });
    if (rateErr || !rateRaw) {
      console.error('[flag alert] could not read the rate:', rateErr);
      return { sent: false, reason: 'rate unavailable' };
    }
    const rate = rateRaw as {
      transactions: number; refunded: number; rate_pct: number;
      window_days: number; rate_threshold_pct: number; flagged: boolean;
    };
    if (rate.flagged !== true) return { sent: false, reason: 'not over the threshold' };

    // Claim the month FIRST. The unique index is the throttle, so two refunds
    // landing at once cannot produce two emails.
    //
    // `context` records WHY we alerted, at the moment we decided to. The rate is
    // a rolling window, so by the time anyone opens Refund Watch to investigate,
    // the refunds that triggered this may have aged out and the screen will read
    // lower. Without this the alert becomes unfalsifiable after a few weeks.
    const now = args.now ?? new Date();
    const { error: claimErr } = await admin
      .from('operator_flag_alerts')
      .insert({
        organization_id: args.organizationId,
        period: periodKey(now),
        context: {
          transactions: Number(rate.transactions),
          refunded: Number(rate.refunded),
          rate_pct: Number(rate.rate_pct),
          rate_threshold_pct: Number(rate.rate_threshold_pct),
          window_days: Number(rate.window_days),
        },
      });
    if (claimErr) {
      if ((claimErr as { code?: string }).code === '23505') return { sent: false, reason: 'already alerted this month' };
      console.error('[flag alert] could not claim:', claimErr);
      return { sent: false, reason: 'claim failed' };
    }

    const { data: orgRow } = await admin
      .from('organizations').select('name').eq('id', args.organizationId).maybeSingle();
    const orgName = (orgRow as { name?: string } | null)?.name ?? 'An operator';

    const platform = await loadOrgBrand(admin, null);
    const { subject, text } = renderFlagAlert({
      orgName,
      ratePct: Number(rate.rate_pct),
      threshold: Number(rate.rate_threshold_pct),
      transactions: Number(rate.transactions),
      refunded: Number(rate.refunded),
      windowDays: Number(rate.window_days),
      siteUrl: args.siteUrl,
    });

    const body = JSON.stringify({
      from: formatFromAddress(platform),
      to,
      subject,
      text,
      tags: [{ name: 'type', value: 'refund_watch_alert' }],
    });
    const send = () => fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${args.resendApiKey}` },
      body,
    });

    // RETRY BEFORE RELEASING, because releasing does not undo the damage. A
    // concurrent invocation that already bounced off the unique index returned
    // "already alerted this month" and will not try again, so by the time we
    // release, its chance is gone. If this was the operator's last refund of the
    // month, the crossing is simply never announced. One inline retry turns a
    // transient blip from "no alert at all" into "a slightly slower alert".
    let resp = await send();
    if (!resp.ok && resp.status >= 500) {
      console.warn(`[flag alert] resend ${resp.status}, retrying once before giving up the month`);
      await new Promise((r) => setTimeout(r, 1000));
      resp = await send();
    }
    if (!resp.ok) {
      // Release the month so the NEXT refund can try again. Strictly better than
      // holding a claim we never honoured, even though it cannot help an
      // operator who has no next refund this month.
      await admin.from('operator_flag_alerts')
        .delete().eq('organization_id', args.organizationId).eq('period', periodKey(now));
      console.error('[flag alert] send failed after retry:', resp.status, await resp.text());
      return { sent: false, reason: `resend ${resp.status}` };
    }

    console.log(`[flag alert] ${orgName} at ${rate.rate_pct}% (threshold ${rate.rate_threshold_pct}%) reported to ${to}`);
    return { sent: true };
  } catch (err) {
    console.error('[flag alert] error (refund is unaffected):', err);
    return { sent: false, reason: (err as Error).message };
  }
}
