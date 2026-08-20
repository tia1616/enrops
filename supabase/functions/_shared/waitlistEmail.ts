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

// ---------------------------------------------------------------------------
// THE LAPSE. The hold ran out, the place went to somebody else, and this family
// is no longer on the list.
//
// EVERY COMPARABLE PLATFORM SENDS THIS (checked 2026-08-19: Jackrabbit, Sawyer,
// iClassPro, and university registrars all notify on expiry, several with 12h and 6h
// reminders before it). Not sending it was the outlier, not the restrained choice: a
// family whose invite went to spam would otherwise lose their place and never learn
// that anything had happened.
//
// THE HARD PART IS TONE. This message carries bad news the family may feel is unfair,
// and it must not imply they did something wrong: the invite may never have reached
// them. So it states what happened, never why, and it leads with the way back in
// rather than burying it under an apology.
// ---------------------------------------------------------------------------

export interface WaitlistLapsedArgs {
  brand: OrgBrand;
  childFirstName: string;
  programName: string;
  siteName?: string | null;
  /** Where to go to rejoin or find another class. */
  catalogUrl: string;
  /**
   * Is there actually another family behind them?
   *
   * THIS EXISTS BECAUSE THE FIRST VERSION LIED. It said flatly "it has now gone to the
   * next family on the list", which is false whenever the lapsed family was the LAST
   * one waiting - and that is the common case on a short list. The place did not go to
   * anybody; it went back on sale. Telling a family their spot was given away, when it
   * is sitting there available, is the worst possible version of this message.
   */
  nextInLine: boolean;
}

export function buildWaitlistLapsed(args: WaitlistLapsedArgs): BuiltEmail {
  const { brand, childFirstName, programName, siteName, catalogUrl, nextInLine } = args;

  const childFirst = (childFirstName || '').trim();
  const who = childFirst || 'your child';
  const where = (siteName || '').trim();
  const classLine = where ? `${programName} at ${where}` : programName;

  // Names the class, so a family on several lists knows which one this is about.
  const subject = nextInLine
    ? `The place in ${programName} has been passed on`
    : `Your held place in ${programName} has been released`;

  // "We did not hear back" and NOT "you did not respond": we genuinely do not know
  // that they saw it. Blaming a family for an email that may have gone to spam is
  // both unkind and probably wrong.
  const leadIn = nextInLine
    ? `We held a place in ${classLine} for ${who}, and as we did not hear back by the deadline it has now gone to the next family on the list.`
    // "may still be" and not "is": this is true at the moment of sending, and a class
    // that is open now can be booked by anyone before they finish reading.
    : `We held a place in ${classLine} for ${who}, and as we did not hear back by the deadline we have released it. Nobody else was waiting, so it has gone back into general registration and may still be available.`;
  const statusLine = `${who} is no longer on the waitlist for this class.`;
  const wayBack = nextInLine
    ? `If you would still like a place, you can join the waitlist again or see what else has room.`
    : `If you still want the place, you can register for it now.`;

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
      ${esc(nextInLine ? 'That place has been passed on' : 'That place has been released')}
    </h1>

    <p style="margin:0 0 14px;font-size:16px;line-height:1.55;">${esc(leadIn)}</p>
    <p style="margin:0 0 18px;font-size:16px;line-height:1.55;">${esc(statusLine)}</p>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.55;">${esc(wayBack)}</p>

    <p style="margin:0 0 18px;">
      <a href="${esc(catalogUrl)}"
         style="display:inline-block;padding:13px 22px;border-radius:10px;background:${esc(brand.primary_color)};color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;">
        ${esc(nextInLine ? 'See what is open' : 'Register now')}
      </a>
    </p>

    <p style="margin:0 0 18px;font-size:15px;line-height:1.55;">
      If you think this is a mistake, or the invitation never reached you, just reply to
      this email and we will look into it.
    </p>

    ${signature}
    ${footerHtml}
  </div>
</body></html>`;

  const textLines = [
    nextInLine ? `That place has been passed on` : `That place has been released`,
    ``,
    leadIn,
    ``,
    statusLine,
    ``,
    wayBack,
    ``,
    catalogUrl,
    ``,
    `If you think this is a mistake, or the invitation never reached you, just reply to this email and we will look into it.`,
    ``,
    brand.org_name,
  ];
  if (footerText) textLines.push(``, footerText);

  return { subject, html, text: textLines.join('\n') };
}

// ---------------------------------------------------------------------------
// THE INVITE. A place has opened and it is being offered to this family.
// ---------------------------------------------------------------------------

export interface WaitlistInviteArgs {
  brand: OrgBrand;
  childFirstName: string;
  programName: string;
  siteName?: string | null;
  whenText?: string | null;
  /** Fully-formed single-use registration link. Built by the caller, never here. */
  inviteUrl: string;
  /** When the offer lapses, as an ISO timestamp. */
  expiresAtIso: string;
  /** IANA zone from organizations.timezone. The deadline is meaningless without it. */
  timezone: string;
}

/**
 * THE DEADLINE IS THE WHOLE EMAIL, so it is written out in the family's own local time
 * with the zone named, not as "24 hours" or a bare UTC stamp.
 *
 * "You have 24 hours" forces a parent to do arithmetic against a send time they cannot
 * see, and it drifts the moment the email sits in a queue. An absolute local time does
 * not: "Thursday 20 August at 4:12 PM (PDT)" means the same thing whenever it is read.
 *
 * Falls back to the raw ISO string rather than throwing. An invite that says something
 * awkward still lets a family claim their place; an invite that fails to render does not.
 */
function formatDeadline(iso: string, timezone: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      weekday: 'long', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(d);
  } catch {
    return iso;
  }
}

export function buildWaitlistInvite(args: WaitlistInviteArgs): BuiltEmail {
  const { brand, childFirstName, programName, siteName, whenText, inviteUrl, expiresAtIso, timezone } = args;

  const childFirst = (childFirstName || '').trim();
  const who = childFirst || 'your child';
  const where = (siteName || '').trim();
  const when = (whenText || '').trim();
  const classLine = where ? `${programName} at ${where}` : programName;
  const deadline = formatDeadline(expiresAtIso, timezone);

  // Says the ONE thing that has changed, so it survives a lock-screen preview.
  const subject = `A place has opened up in ${programName}`;

  // WHAT THIS EMAIL MUST NOT DO: imply the place is already theirs. It is held, not
  // given, and it is given by completing registration. Every line below is written so
  // that a family who reads only the first sentence still understands they must act.
  const leadIn = `A place has opened up in ${classLine}, and because ${who} is at the top of the waitlist we are offering it to you first.`;
  const holdLine = `The place is held for ${who} until ${deadline}. After that we offer it to the next family on the list.`;
  const actionLine = `To take it, finish registering with the link below. That is when the place becomes yours.`;
  const linkOnceLine = `This link works once and only for you, so please do not forward it.`;

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
      A place has opened up
    </h1>

    <p style="margin:0 0 14px;font-size:16px;line-height:1.55;">${esc(leadIn)}</p>

    ${when ? `<p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#444;">The class runs ${esc(when)}.</p>` : ''}

    <p style="margin:0 0 6px;font-size:16px;line-height:1.55;"><strong>${esc(holdLine)}</strong></p>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.55;">${esc(actionLine)}</p>

    <p style="margin:0 0 18px;">
      <a href="${esc(inviteUrl)}"
         style="display:inline-block;padding:13px 22px;border-radius:10px;background:${esc(brand.primary_color)};color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;">
        Register ${esc(who)}
      </a>
    </p>

    <p style="margin:0 0 18px;font-size:13px;line-height:1.5;color:#666;">
      ${esc(linkOnceLine)} If the button does not work, copy this address into your browser:<br />
      <span style="word-break:break-all;">${esc(inviteUrl)}</span>
    </p>

    <p style="margin:0 0 18px;font-size:15px;line-height:1.55;">
      If you no longer need the place, just reply to this email and we will offer it to the
      next family.
    </p>

    ${signature}
    ${footerHtml}
  </div>
</body></html>`;

  // Same things, same order, written as prose. The URL sits on its own line so no client
  // wraps it into something unclickable.
  const textLines = [
    `A place has opened up`,
    ``,
    leadIn,
  ];
  if (when) textLines.push(``, `The class runs ${when}.`);
  textLines.push(
    ``,
    holdLine,
    ``,
    actionLine,
    ``,
    inviteUrl,
    ``,
    linkOnceLine,
    ``,
    `If you no longer need the place, just reply to this email and we will offer it to the next family.`,
    ``,
    brand.org_name,
  );
  if (footerText) textLines.push(``, footerText);

  return { subject, html, text: textLines.join('\n') };
}
