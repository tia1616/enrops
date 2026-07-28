// operatorGrowthAsks — the two enrops-to-OPERATOR asks from Arielle's v4
// section 8, items 3 and 4:
//
//   "Fire the existing founding-operator review-ask (Capterra/G2 'Best Customer
//    Support' prompt) after a fast, clean refund."
//   "Fire the existing operator referral-ask ('refer one operator you know')
//    after an operator's first smooth refund cycle."
//
// NEITHER ASK EXISTED. Her section opens with "Nothing here is a new system",
// which holds for the receipt and the footer but not for these: every row in
// automation_templates has audience 'families', 'instructors' or 'partners',
// because that system is a per-tenant tool for an OPERATOR to email THEIR OWN
// families. There is no enrops-to-operator channel to hook into. So this is a
// small new mechanism, deliberately kept to one table and one file.
//
// FOUR RULES, all from the checklist:
//   - Section 4: "Flagged accounts are excluded from the growth triggers in
//     Section 8 (no referral or review ask fires on a flagged account)." That is
//     enforced here by calling is_operator_refund_flagged, so the rule lives in
//     one place instead of being re-derived.
//   - Only a CLEAN refund counts. A refund whose platform-fee return failed is
//     recorded with a failure_reason, and asking someone to praise us off the
//     back of a refund that half worked is the opposite of the intent.
//   - At most once per operator per ask, forever. UNIQUE(organization_id,
//     ask_key) makes that structural rather than a thing this code remembers.
//   - Off by default. `enabled` starts false so nothing reaches a real operator
//     until Jessica turns it on.
//
// NO EM DASHES. Standing rule on anything Jessica's name goes out on.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, formatFromAddress } from './orgBrand.ts';
import { renderPlatformFooterHtml, renderPlatformFooterText } from './platformFooter.ts';

export type AskKey = 'review' | 'referral';

export interface GrowthAskResult {
  sent: boolean;
  ask?: AskKey;
  reason?: string;
}

interface AskCopy {
  subject: string;
  html: string;
  text: string;
}

/**
 * The copy. Pure so it can be tested without a database or an outbound send.
 *
 * Voice: warm, specific, lowercase enrops, no em dashes, and it leads with what
 * the operator just did rather than with what we want.
 */
export function renderAsk(ask: AskKey, orgName: string, cleanRefunds: number): AskCopy {
  const who = orgName || 'there';

  if (ask === 'review') {
    const lines = [
      `Hi ${who},`,
      '',
      'You just refunded a family through enrops, and it went through cleanly: they got their money back, and we returned our own fee on top.',
      '',
      'That is the part of the software nobody thinks about until it goes wrong, so if it felt easy, would you tell someone? A short review is the single most useful thing you can do for us right now.',
      '',
      'Leave a review: https://www.capterra.com/',
      '',
      'And if any of it felt clunky, reply to this instead. That is worth more to us than the review.',
      '',
      'Jessica',
      'enrops',
    ];
    return {
      subject: 'That refund went through cleanly',
      text: `${lines.join('\n')}\n\n${renderPlatformFooterText('welcome')}`,
      html: wrap(
        `<p>Hi ${esc(who)},</p>
         <p>You just refunded a family through enrops, and it went through cleanly: they got their money back, and we returned our own fee on top.</p>
         <p>That is the part of the software nobody thinks about until it goes wrong, so if it felt easy, would you tell someone? A short review is the single most useful thing you can do for us right now.</p>
         <p><a href="https://www.capterra.com/" style="color:#674EE8;font-weight:600;">Leave a review</a></p>
         <p>And if any of it felt clunky, reply to this instead. That is worth more to us than the review.</p>
         <p>Jessica<br>enrops</p>`,
      ),
    };
  }

  const lines = [
    `Hi ${who},`,
    '',
    `You have now run ${cleanRefunds} refunds through enrops and every one of them settled cleanly, including our fee coming back to you.`,
    '',
    'If you know another program owner still doing refunds by hand, would you point them at us? One introduction from someone already using it is worth more than anything we could write ourselves.',
    '',
    'Forward this, or send them to https://getenrops.com',
    '',
    'Thank you for building this with us.',
    '',
    'Jessica',
    'enrops',
  ];
  return {
    subject: 'Know another program owner?',
    text: `${lines.join('\n')}\n\n${renderPlatformFooterText('welcome')}`,
    html: wrap(
      `<p>Hi ${esc(who)},</p>
       <p>You have now run ${cleanRefunds} refunds through enrops and every one of them settled cleanly, including our fee coming back to you.</p>
       <p>If you know another program owner still doing refunds by hand, would you point them at us? One introduction from someone already using it is worth more than anything we could write ourselves.</p>
       <p>Forward this, or send them to <a href="https://getenrops.com" style="color:#674EE8;font-weight:600;">getenrops.com</a></p>
       <p>Thank you for building this with us.</p>
       <p>Jessica<br>enrops</p>`,
    ),
  };
}

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wrap(inner: string): string {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.6;">
${inner}
<div style="margin-top:20px;padding-top:14px;border-top:1px solid #e2dfd5;">${renderPlatformFooterHtml('welcome')}</div>
</div>`;
}

/**
 * Decide which ask (if any) is due, then send it at most once.
 *
 * Never throws and never blocks a refund: the money has already moved by the
 * time this runs. Returns why nothing was sent so a caller can log it honestly.
 */
export async function maybeSendOperatorGrowthAsk(
  admin: SupabaseClient,
  args: { organizationId: string; resendApiKey: string; isAllowed: (email: string) => boolean },
): Promise<GrowthAskResult> {
  try {
    const { data: cfgRow } = await admin
      .from('platform_settings').select('value').eq('key', 'operator_growth_asks').maybeSingle();
    const cfg = ((cfgRow as { value?: Record<string, unknown> } | null)?.value ?? {}) as Record<string, unknown>;
    if (cfg.enabled !== true) return { sent: false, reason: 'growth asks are off' };

    const reviewAt = Number(cfg.review_after_clean_refunds ?? 1);
    const referralAt = Number(cfg.referral_after_clean_refunds ?? 3);

    // Section 4: never ask an operator we have flagged for review.
    const { data: flagged } = await admin.rpc('is_operator_refund_flagged', { p_org: args.organizationId });
    if (flagged === true) return { sent: false, reason: 'operator is flagged for review' };

    // CLEAN refunds only: succeeded, and the platform fee actually settled.
    // failure_reason is set whenever returning our fee did not complete.
    const { data: refundRows } = await admin
      .from('refunds')
      .select('id, failure_reason, platform_fee_refunded_cents')
      .eq('organization_id', args.organizationId)
      .eq('status', 'succeeded');
    const clean = ((refundRows ?? []) as Array<{ failure_reason: string | null; platform_fee_refunded_cents: number | null }>)
      .filter((r) => !r.failure_reason && r.platform_fee_refunded_cents !== null).length;
    if (clean === 0) return { sent: false, reason: 'no clean refunds yet' };

    // Referral is checked first: an operator who crosses both thresholds at once
    // should get the later, warmer ask rather than the introductory one.
    const due: AskKey | null = clean >= referralAt ? 'referral' : clean >= reviewAt ? 'review' : null;
    if (!due) return { sent: false, reason: `only ${clean} clean refunds` };

    // CLAIM FIRST. The insert is the lock: a redelivered webhook racing this
    // hits the unique index and stops here rather than sending a second email.
    const { data: claimRow, error: claimErr } = await admin
      .from('operator_growth_asks')
      .insert({
        organization_id: args.organizationId,
        ask_key: due,
        trigger_context: { clean_refunds: clean },
      })
      .select('id')
      .single();
    if (claimErr) {
      if ((claimErr as { code?: string }).code === '23505') return { sent: false, reason: 'already asked' };
      console.error('[growth ask] could not claim:', claimErr);
      return { sent: false, reason: 'claim failed' };
    }
    const claimId = (claimRow as { id: string }).id;

    // Release the claim if we cannot actually send, so it can be retried later.
    // Holding a claim we never delivered would silently retire the ask forever.
    const release = async (why: string) => {
      await admin.from('operator_growth_asks').delete().eq('id', claimId);
      return { sent: false, reason: why } as GrowthAskResult;
    };

    const { data: orgRow } = await admin
      .from('organizations').select('name').eq('id', args.organizationId).maybeSingle();
    const orgName = (orgRow as { name?: string } | null)?.name ?? '';

    // The operator's own inbox. From is ENROPS, not their brand: this is us
    // writing to them, not them writing to a family.
    const theirBrand = await loadOrgBrand(admin, args.organizationId);
    const to = theirBrand.alert_email;
    if (!to) return await release('operator has no contact email');
    if (!args.isAllowed(to)) return await release('blocked by staging allowlist');
    if (!args.resendApiKey) return await release('no RESEND_API_KEY');

    const platform = await loadOrgBrand(admin, null);
    const copy = renderAsk(due, orgName, clean);

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${args.resendApiKey}` },
      body: JSON.stringify({
        from: formatFromAddress(platform),
        to,
        reply_to: platform.reply_to,
        subject: copy.subject,
        html: copy.html,
        text: copy.text,
        tags: [{ name: 'type', value: `operator_${due}_ask` }],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error('[growth ask] send failed:', resp.status, body);
      return await release(`resend ${resp.status}`);
    }

    console.log(`[growth ask] sent the ${due} ask to ${orgName} after ${clean} clean refunds`);
    return { sent: true, ask: due };
  } catch (err) {
    console.error('[growth ask] error (refund is unaffected):', err);
    return { sent: false, reason: (err as Error).message };
  }
}
