// The waitlist confirmation a family gets when they join a full class.
//
// SEPARATE MODULE, not inlined in join-waitlist, because chunk 2's seat-opened invite and
// chunk 3's expiry nudge are the same voice, the same brand furniture and the same
// footer/signature assembly. Three copies of that is how two of them drift.
//
// TWO REAL HALVES. The text/plain part is written here as prose, NOT derived by stripping
// tags off the HTML. A generated plaintext half is how "read body_text, not the preview"
// became a standing rule: the HTML looks right in a preview pane and the text half - which
// is what a plain-text client, a screen reader in text mode, and most spam filters actually
// read - comes out as run-together fragments. Both halves say the same things in the same
// order so a reply-quoting client cannot make them disagree.
//
// NO EM DASHES anywhere in family-facing copy. Standing rule.

import { esc } from './escapeHtml.ts';
import type { OrgBrand } from './orgBrand.ts';
import { renderSignatureBlock } from './orgBrand.ts';
import { renderPlatformFooterHtml, renderPlatformFooterText } from './platformFooter.ts';

export interface WaitlistConfirmationArgs {
  brand: OrgBrand;
  childFirstName: string;
  programName: string;
  siteName?: string | null;
  /** Day + time as already-formatted text, e.g. "Wednesdays 4:00 PM". Optional. */
  whenText?: string | null;
  position: number;
}

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * ORDINAL, spelled the way a parent reads it.
 * "You are number 1" is clear; "1st in line" invites the question "of how many?".
 * We deliberately do NOT tell them the length of the list: it changes without them
 * doing anything, it is another provider's business when a class is shared, and a
 * number that moves for reasons a family cannot see reads as a broken promise.
 */
function positionSentence(childFirst: string, position: number): string {
  const who = childFirst || 'Your child';
  if (position === 1) {
    return `${who} is first in line, so if a place opens up we will offer it to you before anyone else.`;
  }
  return `${who} is number ${position} on the list.`;
}

export function buildWaitlistConfirmation(args: WaitlistConfirmationArgs): BuiltEmail {
  const { brand, childFirstName, programName, siteName, whenText, position } = args;

  const childFirst = (childFirstName || '').trim();
  const where = (siteName || '').trim();
  const when = (whenText || '').trim();

  const classLine = where ? `${programName} at ${where}` : programName;

  const subject = `You are on the waitlist for ${programName}`;

  const posSentence = positionSentence(childFirst, position);

  // What happens next, in the order it will happen. This is the part a family actually
  // needs, and it is written to be true TODAY: it promises an email when a place opens
  // and it promises nothing about how long that takes, because nobody knows.
  const nextSteps = [
    'If a place opens up we will email you a link to register.',
    'The link is just for you and it will be time limited, so keep an eye on your inbox.',
    'Nothing has been charged and there is nothing to pay while you are on the list.',
  ];

  const signature = renderSignatureBlock(brand);
  const footerHtml = renderPlatformFooterHtml('waitlist');
  const footerText = renderPlatformFooterText('waitlist');

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:${esc(brand.page_bg_color)};">
  <div style="max-width:560px;margin:0 auto;padding:24px 20px;font-family:${esc(brand.font_family)};color:#1a1a1a;">
    ${brand.logo_url
      ? `<img src="${esc(brand.logo_url)}" alt="${esc(brand.org_name)}" style="max-height:56px;margin-bottom:18px;" />`
      : `<div style="font-size:18px;font-weight:700;margin-bottom:18px;">${esc(brand.org_name)}</div>`}

    <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${esc(brand.primary_color)};">
      You are on the waitlist
    </h1>

    <p style="margin:0 0 14px;font-size:16px;line-height:1.55;">
      ${esc(classLine)} is full, so we have put ${esc(childFirst || 'your child')} on the waitlist.
      ${esc(posSentence)}
    </p>

    ${when ? `<p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#444;">The class runs ${esc(when)}.</p>` : ''}

    <p style="margin:18px 0 8px;font-size:15px;font-weight:700;">What happens next</p>
    <ul style="margin:0 0 18px;padding-left:20px;font-size:15px;line-height:1.6;color:#333;">
      ${nextSteps.map((s) => `<li style="margin-bottom:6px;">${esc(s)}</li>`).join('')}
    </ul>

    <p style="margin:0 0 18px;font-size:15px;line-height:1.55;">
      If your plans change and you would rather come off the list, just reply to this email
      and we will take care of it.
    </p>

    ${signature}
    ${footerHtml}
  </div>
</body></html>`;

  // Written as prose, in the same order as the HTML. Line breaks are deliberate: a plain
  // text client will not reflow this for us.
  const textLines = [
    `You are on the waitlist`,
    ``,
    `${classLine} is full, so we have put ${childFirst || 'your child'} on the waitlist.`,
    posSentence,
  ];
  if (when) {
    textLines.push(``, `The class runs ${when}.`);
  }
  textLines.push(
    ``,
    `What happens next`,
    ...nextSteps.map((s) => `- ${s}`),
    ``,
    `If your plans change and you would rather come off the list, just reply to this email and we will take care of it.`,
    ``,
    brand.org_name,
  );
  if (footerText) textLines.push(``, footerText);

  return { subject, html, text: textLines.join('\n') };
}
