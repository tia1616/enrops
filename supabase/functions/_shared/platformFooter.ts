// platformFooter — the enrops attribution line for EMAIL surfaces.
//
// TWIN FILE: src/components/PlatformFooterLine.jsx carries the same copy for
// the web surfaces. The Vite app and the Deno edge runtime cannot import across
// each other's bundle roots, so this is the one unavoidable mirror. Change one,
// change the other. tests/platformFooter.test.ts pins the string so a one-sided
// edit fails the test run.
//
// RULES (from Jessica's footer copy checklist, 2026-07-26):
//   - The operator's branding is ALWAYS primary. This line sits BELOW the
//     operator's own footer content, smaller and quieter.
//   - One line only. No logo lockup, no second sentence, no badge graphic.
//   - "enrops" is lowercase everywhere, including at the start of a sentence.
//   - Never removable on Free, Pro-Lite, or Pro.

/** The line, exactly as written in the checklist. Do not reword. */
export const PLATFORM_FOOTER_TEXT =
  'Run kids enrichment programs? enrops is free for businesses';

/**
 * Canonical surface identifiers -> the `src` parameter on getenrops.com.
 * Closed vocabulary: adding a surface means adding it here, so the analytics
 * set stays comparable instead of each sender inventing its own string.
 */
export const PLATFORM_FOOTER_SURFACES = {
  regPage: 'reg-page',
  regConfirm: 'reg-confirm',
  receipt: 'receipt',
  welcome: 'welcome',
  waitlist: 'waitlist',
  schedule: 'schedule',
  reminder: 'reminder',
  parentPortal: 'parent-portal',
  partnerInvoice: 'partner-invoice',
  partnerRecap: 'partner-recap',
  partnerPortal: 'partner-portal',
  embed: 'embed',
  // The "your account is ready" email sent when a parent account is auto-created
  // at registration. Kept separate from `welcome` (the program welcome
  // automation) on purpose: they are different messages, sent at different
  // moments, for different reasons. Pooling them would make clicks-by-source
  // unable to tell which one earned the signup. Not in the checklist's table —
  // that table has no row for this email; flagged to Arielle.
  accountReady: 'account-ready',
} as const;

export type PlatformFooterSurface = keyof typeof PLATFORM_FOOTER_SURFACES;

/** Build the destination URL for a surface. */
export function platformFooterUrl(surface: string): string {
  const src = (PLATFORM_FOOTER_SURFACES as Record<string, string>)[surface] ?? surface;
  return `https://getenrops.com?src=${encodeURIComponent(src)}`;
}

/**
 * Which surface (if any) a lifecycle automation should report as.
 *
 * Returns null when the line must NOT be rendered. The checklist scopes the
 * line to "every surface a parent or a school partner sees" — instructors are
 * deliberately excluded, so instructor-audience automations get no line.
 *
 * Keyed off the automation_templates.audience column, never off a tenant, so a
 * new tenant's automations inherit the same behaviour with no code change.
 */
export function surfaceForAutomation(
  key: string | null | undefined,
  audience: string | null | undefined,
  recipientRole?: string | null,
): string | null {
  // The PER-RECIPIENT role wins over the template-level audience column.
  // A two-audience automation (no_school_day) is stored with audience
  // 'families' but also sends a tailored instructor copy, so keying off the
  // column alone would put the acquisition line in front of instructors.
  if (recipientRole === 'instructor') return null;
  if (audience === 'instructors') return null;
  if (audience === 'partners') return 'partnerRecap';
  const k = (key ?? '').toLowerCase();
  if (k.startsWith('welcome') || k === 'thank_you') return 'welcome';
  if (k === 'no_school_day') return 'schedule';
  return 'reminder';
}

/** Escape a string for safe use in HTML text/attribute position. */
function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Link colour by background. This file previously hardcoded the DARK-background
 * violet (#8C88FF) for every email, but every email footer that consumes it
 * renders on a white card — measured at 2.97:1, well under the 4.5:1 AA needs
 * for 11px text. The web twin always had two tones and picked by context; this
 * one only had the dark value.
 *
 *   #5847C9 on #ffffff  = 6.65:1
 *   #8C88FF on #1A1530  = 5.93:1
 */
const LINK_COLOR = {
  light: '#5847C9', // on a white/cream email card — the default
  dark: '#8C88FF',  // on a deep-purple footer band
} as const;

/**
 * The line as an HTML fragment for an email footer. Returns '' when surface is
 * null, so a caller can pass through an out-of-scope surface unchanged and the
 * email is byte-for-byte what it was before.
 *
 * `tone` describes the BACKGROUND the line sits on, and defaults to 'light'
 * because every current consumer renders on a white card. Pass 'dark' only for
 * a dark footer band.
 *
 * Caution for callers: CSS `opacity` on a parent applies to the whole subtree,
 * so putting this inside a dimmed container silently undoes the contrast — that
 * is a real bug this module cannot defend against from in here.
 */
export function renderPlatformFooterHtml(
  surface: string | null,
  opts: { tone?: 'light' | 'dark' } = {},
): string {
  if (!surface) return '';
  const color = LINK_COLOR[opts.tone === 'dark' ? 'dark' : 'light'];
  return `<div style="margin-top:10px;font-size:11px;line-height:1.5;"><a href="${esc(platformFooterUrl(surface))}" style="color:${color};text-decoration:none;">${esc(PLATFORM_FOOTER_TEXT)} &rarr;</a></div>`;
}

/** The line for the text/plain MIME part. '' when out of scope. */
export function renderPlatformFooterText(surface: string | null): string {
  if (!surface) return '';
  return `${PLATFORM_FOOTER_TEXT} -> ${platformFooterUrl(surface)}`;
}
