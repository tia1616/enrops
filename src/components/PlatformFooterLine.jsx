import React from 'react';
import { capture } from '../lib/analytics.js';

// The enrops platform attribution line. ONE definition, every parent- and
// partner-facing surface (Jessica's footer copy checklist, 2026-07-26).
//
// Why a component and not copy pasted per page: the line had drifted into five
// different wordings across the app and two edge functions, and every new
// surface re-invented it. Having it here is what makes "and every surface going
// forward" automatic instead of a recurring ask.
//
// RULES (from the checklist - do not "improve" these without Jessica's go):
//   - The operator's branding is ALWAYS primary. This line sits BELOW the
//     operator's own footer content, smaller and quieter. It never competes
//     with the operator's business name.
//   - One line only. No logo lockup, no second sentence, no badge graphic.
//   - "enrops" is lowercase everywhere, including at the start of a sentence.
//   - Never removable on Free, Pro-Lite, or Pro. There is deliberately NO prop
//     to hide this - if a future tier is allowed to remove it, that gate goes
//     in one place, here, and not as a `hidden` prop sprinkled per call site.
//
// EDGE-FUNCTION TWIN: supabase/functions/_shared/platformFooter.ts carries the
// same copy for emails. The Vite app and the Deno edge runtime cannot import
// across each other's bundle roots, so that file is the one unavoidable mirror.
// Change one, change the other - both files say so, and platformFooter.test.ts
// pins the string so a one-sided edit fails CI.

// Marketing-brand palette. Mirrors the constants in PublicLayout.jsx, which is
// where they were first defined.
const ENROPS_VIOLET = '#8C88FF';
const ENROPS_PURPLE = '#5847C9';

/** The line, exactly as written in the checklist. Do not reword. */
export const PLATFORM_FOOTER_TEXT = 'Run kids enrichment programs? enrops is free for businesses';

/**
 * Canonical surface identifiers. The key is what call sites pass; the value is
 * the `src` parameter that lands on getenrops.com. Adding a surface? Add it
 * here first - that keeps the analytics vocabulary closed instead of letting
 * each page invent its own string.
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
  // Not in the checklist's table: the embed had no row. Added per Jessica's
  // call to keep the line in embedded widgets (industry norm on free tiers).
  embed: 'embed',
  // Also not in the table: the "your account is ready" email. Kept separate
  // from `welcome` (the program welcome automation) so clicks-by-source can
  // tell the two apart. Email-only today, but the vocabulary is shared.
  accountReady: 'account-ready',
};

/**
 * Which surface (if any) a lifecycle automation reports as. MUST stay identical
 * to surfaceForAutomation in supabase/functions/_shared/platformFooter.ts —
 * the admin preview uses this one and the cron uses that one, and a preview
 * that disagrees with the real send is worse than no preview.
 *
 * Returns null when NO line should render: the checklist scopes the line to
 * parents and school partners, so instructors are excluded. The per-recipient
 * role wins over the template-level audience, because a two-audience
 * automation (no_school_day) is stored as 'families' but also sends an
 * instructor copy.
 */
export function surfaceForAutomation(key, audience, recipientRole) {
  if (recipientRole === 'instructor') return null;
  if (audience === 'instructors') return null;
  if (audience === 'partners') return 'partnerRecap';
  const k = (key ?? '').toLowerCase();
  if (k.startsWith('welcome') || k === 'thank_you') return 'welcome';
  if (k === 'no_school_day') return 'schedule';
  return 'reminder';
}

/** The canonical src values, for validating a caller that passes one directly. */
const VALID_SRC_VALUES = new Set(Object.values(PLATFORM_FOOTER_SURFACES));

/**
 * Build the destination URL for a surface.
 *
 * Accepts either a KEY of PLATFORM_FOOTER_SURFACES ('parentPortal') or its
 * canonical VALUE ('parent-portal'). Anything else is a typo, and it used to
 * pass straight through: `surface="parentportal"` silently produced
 * ?src=parentportal, splitting the metric this whole change exists to produce.
 * A wrong analytics label that looks right is the silent-failure class.
 *
 * Unknown values now resolve to 'unknown' and shout in the console, so a typo
 * shows up as one obvious bucket instead of masquerading as a real surface.
 * Deliberately does NOT throw — a bad analytics label must never blank a
 * parent-facing page.
 */
export function platformFooterUrl(surface) {
  const mapped = PLATFORM_FOOTER_SURFACES[surface];
  let src;
  if (mapped) {
    src = mapped;
  } else if (VALID_SRC_VALUES.has(surface)) {
    src = surface;
  } else {
    // eslint-disable-next-line no-console
    console.error(
      `[PlatformFooterLine] unknown surface ${JSON.stringify(surface)} — add it to ` +
      'PLATFORM_FOOTER_SURFACES. Reporting as "unknown" so it does not pollute a real surface.',
    );
    src = 'unknown';
  }
  return `https://getenrops.com?src=${encodeURIComponent(src)}`;
}

/**
 * Resolve the src value WITHOUT building a URL, for the analytics property, so
 * the number in PostHog and the parameter on the link can never disagree —
 * both read the same resolver.
 */
function srcFor(surface) {
  return new URL(platformFooterUrl(surface)).searchParams.get('src');
}

/**
 * @param {object}  props
 * @param {string}  props.surface  key of PLATFORM_FOOTER_SURFACES (or a raw src string)
 * @param {'light'|'dark'} [props.tone]  'dark' for placement on the deep-purple footer
 * @param {object}  [props.style]  spacing overrides only - not colour or size
 */
export default function PlatformFooterLine({ surface, tone = 'light', style }) {
  const onDark = tone === 'dark';

  // Clicks-by-source (footer checklist build item 6). getenrops.com sees the
  // ?src= parameter, but that is a different site — this is the OUR-side half,
  // so we can tell how often each surface is clicked even before the marketing
  // site's analytics are joined up.
  //
  // Fire-and-forget: capture() already no-ops when PostHog has no key (local
  // dev), and nothing here is awaited, so a blocked or slow analytics call can
  // never delay or prevent the navigation.
  //
  // No PII: the surface, the resolved src, and the tenant slug from the first
  // path segment. The slug is a public business identifier, and it is the
  // dimension that makes the number useful — which operator's page drove it.
  const handleClick = () => {
    try {
      const slug = typeof window !== 'undefined'
        ? (window.location.pathname.split('/').filter(Boolean)[0] ?? null)
        : null;
      capture('platform_footer_click', { surface, src: srcFor(surface), org_slug: slug });
    } catch (_) {
      // Analytics must never break an outbound link.
    }
  };

  return (
    <p
      style={{
        textAlign: 'center',
        fontSize: 12,
        lineHeight: 1.5,
        margin: 0,
        color: onDark ? 'rgba(255,255,255,0.55)' : '#9B9FBB',
        ...style,
      }}
    >
      <a
        href={platformFooterUrl(surface)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleClick}
        style={{
          color: onDark ? ENROPS_VIOLET : ENROPS_PURPLE,
          textDecoration: 'none',
          fontWeight: 600,
        }}
      >
        {PLATFORM_FOOTER_TEXT} &rarr;
      </a>
    </p>
  );
}
