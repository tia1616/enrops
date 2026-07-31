// refundReceipt — the email a family gets when money goes back to them.
//
// Arielle's v4 section 8: "Refund confirmation email/receipt states the
// breakdown in plain language: 'You paid $X. You get back $X. We refunded our
// own $Y fee since this was requested before day one.' Visible fairness, not a
// policy buried in fine print." Plus: "Add the same 'Powered by enrops' footer
// + 'start your own program free' line ... onto the refund confirmation email
// too."
//
// WHERE THIS DIVERGES FROM HER DRAFT WORDING, AND WHY.
// Her example says "we refunded our own $Y fee". Said to a FAMILY that is
// misleading in our implementation: the platform-fee refund goes to the
// OPERATOR's balance, not to the family. What the family gets back is whatever
// the operator refunded. Those are the same money only when the operator
// refunds the whole charge, because the fee was part of what the family paid.
//
// So this receipt states what is unambiguously true from the family's side:
// the amount coming back, and - only when their refund actually covers the
// whole charge - that it includes the enrops fee they paid. It never claims a
// family received something that went to the operator. A refund email that
// overstates by even a line is worse than a plain one.
//
// RE-EXAMINED 2026-07-31 and deliberately left alone. Arielle cut the two
// OPERATOR-facing asks partly because "we refunded our fee too" is a weak
// pitch; the question was whether the same line should come out of this
// FAMILY-facing receipt. It should not, and the rule here is already the one
// the payments industry uses: a refund receipt itemises exactly what the
// checkout itemised and nothing more. An absorb org's family never saw a fee
// line, so familyFeeCents arrives 0/null and this stays silent - introducing an
// "enrops fee" at refund time would raise a question they cannot act on. A
// pass-through family DID pay a visible "enrops service fee" line, so when they
// get the whole charge back they are told it came back too. On a PARTIAL refund
// we stay silent by design: the fee refund lands in the operator's balance and
// no honest per-line split exists to quote them.
//
// Rendering is a pure function so the wording is testable without sending
// anything. Both refund paths (refund-registration for in-app, stripe-webhook
// for a refund made in the operator's own Stripe) call the same renderer, so a
// family cannot get different copy depending on where the operator clicked.
//
// NO EM DASHES anywhere in this file's copy. Standing rule on anything that
// reaches a family.
//
// The platform attribution line is NOT written here. It comes from
// _shared/platformFooter.ts, which owns the approved wording, the lowercase
// brand, the one-line rule and the `?src=<surface>` vocabulary. This file used
// to hand-roll "Powered by enrops. Start your own program free" with UTM
// parameters; both the copy and the tracking were retired on 2026-07-26.
// A refund receipt is surface 'receipt', same as a payment receipt.

import { renderPlatformFooterHtml, renderPlatformFooterText } from './platformFooter.ts';

export interface RefundReceiptInput {
  /** Family's display name, for the greeting. Falls back to a neutral hello. */
  parentName?: string | null;
  childName?: string | null;
  programName?: string | null;
  orgName: string;
  /** What the family is getting back on this refund, in cents. */
  refundedCents: number;
  /** The full amount originally charged for this registration, in cents. */
  chargedCents?: number | null;
  /** The enrops fee the family paid on that charge, in cents. */
  familyFeeCents?: number | null;
  /**
   * True when the seat was released, false when it was explicitly kept, and
   * NULL when we do not know.
   *
   * Null is the normal case for a refund made in the operator's own Stripe:
   * Stripe tells us money moved, not what the operator decided about the
   * roster. Saying "still on the roster" after a full refund would be a guess,
   * and a wrong one often enough to matter, so the line is simply omitted.
   */
  withdrawn: boolean | null;
  /** Brand accent for the amount, falls back to a neutral ink. */
  accentColor?: string | null;
}

export interface RenderedReceipt {
  subject: string;
  html: string;
  text: string;
}

const money = (cents: number): string =>
  `$${(Math.max(0, Math.round(cents)) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * True when this refund returns the family everything they paid on the charge,
 * which is the only case where we can honestly tell them the enrops fee came
 * back to them too.
 */
export function refundCoversWholeCharge(input: RefundReceiptInput): boolean {
  const charged = input.chargedCents ?? 0;
  if (!(charged > 0)) return false;
  return input.refundedCents >= charged;
}

export function renderRefundReceipt(input: RefundReceiptInput): RenderedReceipt {
  const org = input.orgName || 'your program';
  const accent = input.accentColor || '#1C004F';
  const first = (input.parentName ?? '').trim().split(/\s+/)[0] || '';
  const greeting = first ? `Hi ${first},` : 'Hi there,';

  const child = (input.childName ?? '').trim();
  const program = (input.programName ?? '').trim();

  // What the refund was for, in the family's terms. Kept to one clause so the
  // opening line stays readable when both names are long.
  const forWhat = child && program
    ? `${child}'s spot in ${program}`
    : program || (child ? `${child}'s registration` : 'your registration');

  const wholeCharge = refundCoversWholeCharge(input);
  const fee = input.familyFeeCents ?? 0;

  // The fee sentence. Only appears when the family genuinely got the fee back.
  // When they did not, we say nothing about it rather than explain a number
  // that did not move for them.
  const feeLine = wholeCharge && fee > 0
    ? `That includes the ${money(fee)} enrops service fee you paid, so you are not out of pocket for it.`
    : '';

  // FAMILY WORDS, NOT OPERATOR WORDS (Jessica, 2026-07-28, reading a real
  // receipt on prod). This said "has been taken off the roster and the spot is
  // free for someone else". Two problems: "roster" is operator vocabulary, and
  // what happens to the spot afterwards is the operator's business, not the
  // family's. A parent needs exactly one fact here - is my child still in this
  // class or not - and telling them their place has been handed on reads cold
  // at the moment they have just cancelled.
  const spotLine = input.withdrawn === null || input.withdrawn === undefined
    ? ''
    : input.withdrawn
      ? `${child || 'Your child'} is no longer enrolled in this class.`
      : `${child || 'Your child'} is still enrolled.`;

  const timingLine =
    'Refunds usually land back on your card within 5 to 10 business days, depending on your bank.';

  const subject = `Your ${money(input.refundedCents)} refund from ${org}`;

  const text = [
    greeting,
    '',
    `${org} has refunded ${money(input.refundedCents)} for ${forWhat}.`,
    feeLine,
    '',
    ...(spotLine ? [spotLine] : []),
    timingLine,
    '',
    'Questions about the refund? Just reply to this email and it goes straight to your provider.',
    '',
    `${org}`,
    '',
    renderPlatformFooterText('receipt'),
  ].filter((l) => l !== null && l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');

  const html = `<!-- refund receipt -->
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.6;">
  <p style="margin:0 0 16px;">${escapeHtml(greeting)}</p>

  <p style="margin:0 0 8px;">
    ${escapeHtml(org)} has refunded
    <strong style="color:${escapeHtml(accent)};font-size:20px;">${money(input.refundedCents)}</strong>
    for ${escapeHtml(forWhat)}.
  </p>
  ${feeLine ? `<p style="margin:0 0 16px;color:#555;font-size:14px;">${escapeHtml(feeLine)}</p>` : ''}

  <div style="border:1px solid #e2dfd5;border-radius:8px;padding:14px 16px;margin:16px 0;font-size:14px;color:#444;">
    ${spotLine ? `<div style="margin-bottom:6px;">${escapeHtml(spotLine)}</div>` : ''}
    <div>${escapeHtml(timingLine)}</div>
  </div>

  <p style="margin:16px 0 0;font-size:14px;color:#555;">
    Questions about the refund? Just reply to this email and it goes straight to your provider.
  </p>

  <p style="margin:24px 0 0;font-size:14px;">${escapeHtml(org)}</p>

  <div style="margin:20px 0 0;padding-top:14px;border-top:1px solid #e2dfd5;">
    ${renderPlatformFooterHtml('receipt')}
  </div>
</div>`;

  return { subject, html, text };
}

interface SendArgs extends RefundReceiptInput {
  to: string;
  /** From/reply-to come from loadOrgBrand so the family hears from the PROVIDER. */
  from: string;
  replyTo?: string | null;
  resendApiKey: string;
  /** _shared/emailGuard's isEmailAllowed. Passed in so this stays env-free. */
  isAllowed: (email: string) => boolean;
  /** Distinguishes an in-app refund from one made in the operator's Stripe. */
  origin: 'enrops' | 'stripe_dashboard';
}

/**
 * Send the receipt. Never throws: a refund that already moved money must not be
 * reported as failed because an email bounced. Returns what happened so the
 * caller can log it honestly rather than assume it sent.
 */
export async function sendRefundReceipt(
  args: SendArgs,
): Promise<{ sent: boolean; reason?: string }> {
  const to = (args.to ?? '').trim();
  if (!to) return { sent: false, reason: 'no recipient on file' };

  // Staging allowlist. Without this a test refund on synthetic data can email a
  // real family, and the money has already moved by the time we get here.
  if (!args.isAllowed(to)) {
    console.log(`[refund receipt] suppressed by the staging allowlist: ${to}`);
    return { sent: false, reason: 'blocked by staging allowlist' };
  }
  if (!args.resendApiKey) return { sent: false, reason: 'no RESEND_API_KEY' };

  const { subject, html, text } = renderRefundReceipt(args);

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${args.resendApiKey}` },
      body: JSON.stringify({
        from: args.from,
        to,
        ...(args.replyTo ? { reply_to: args.replyTo } : {}),
        subject,
        html,
        text,
        tags: [
          { name: 'type', value: 'refund_receipt' },
          { name: 'origin', value: args.origin },
        ],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error('[refund receipt] send failed:', resp.status, body);
      return { sent: false, reason: `resend ${resp.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error('[refund receipt] send error:', err);
    return { sent: false, reason: (err as Error).message };
  }
}
