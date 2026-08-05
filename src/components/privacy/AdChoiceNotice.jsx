// The advertising notice bar.
//
// Shown once, until answered. Our published Cookie Disclosure says advertising
// and measurement cookies "run unless you tell us not to" and that the person
// can decline - so something has to actually offer that, and it has to appear
// before they have answered rather than only on a page they might never visit.
//
// NOT a consent gate. The US is an opt-out regime, so measurement is already
// running by the time this renders; the bar exists to make declining easy and
// visible, not to block the page. That is why there is no overlay, nothing is
// disabled behind it, and dismissing without choosing is impossible - the two
// buttons ARE the two answers.
//
// It renders NOTHING when:
//   - no dataset id is configured (nothing to consent to, so asking would be a
//     lie - this is the state on staging and on every dev machine);
//   - the browser sends Global Privacy Control (already answered, legally);
//   - a choice is already stored;
//   - the visitor is inside /admin, i.e. they have an account already. The
//     opt-out still reaches them through the admin footer; see the guard below.

import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { capture } from '../../lib/analytics.js';
import {
  isPixelConfigured,
  hasGpcSignal,
  hasMadeAdChoice,
  optOutOfPixel,
  optInToPixel,
} from '../../lib/metaPixel.js';
import { useAdChoiceSignal } from '../../lib/useAdChoice.js';

/** The choice page asks the same question with more room; never do both at once. */
const CHOICE_PAGE = '/do-not-sell';

/**
 * The operator sign-in screen. App.jsx serves the SAME AdminLogin component at
 * both of these paths, so they have to behave identically here - /admin/login
 * would otherwise be silently covered by the /admin prefix below while /login
 * was not, and one screen would show the notice or not depending purely on which
 * URL you arrived through.
 *
 * Listed rather than inferred: /admin/login is already inside the /admin prefix,
 * and naming it anyway means this still holds if that prefix rule ever changes.
 *
 * NOT included: /{slug}/login, the family sign-in inside a tenant's own tree.
 * That is a different component on a public, tenant-branded surface where
 * ordinary visitors are, and folding it in would be extending the rule rather
 * than fixing the inconsistency this list exists for.
 */
const SIGN_IN_PATHS = ['/login', '/admin/login'];

const DEEP = '#1C004F';
const MINT = '#26D687';

export default function AdChoiceNotice() {
  const location = useLocation();
  // This component is mounted OUTSIDE the route tree, so it is created once for
  // the app's whole lifetime and navigation never remounts it. Reading the
  // stored choice only at mount meant that answering anywhere else - the
  // /do-not-sell page reachable from the footer link right next to this bar -
  // left the bar on screen, still asking, with its buttons ready to overwrite
  // the answer just given.
  useAdChoiceSignal();

  // `dismissed` covers only THIS tab's click. The stored value is re-read on
  // every render (cheap, and it is the single source of truth), so a choice made
  // on the /do-not-sell page or in another tab hides the bar without needing its
  // own state.
  const [dismissed, setDismissed] = useState(false);

  // ONE definition of "is this the operator app", used by both the visibility
  // rule and the analytics dimension below, so the two can never disagree about
  // which surface a given render is on.
  const inOperatorApp = location.pathname.startsWith('/admin');
  const onSignIn = SIGN_IN_PATHS.includes(location.pathname);

  // Visibility computed BEFORE any early return, so the effect below obeys the
  // rules of hooks. Same conditions as before, just named.
  const visible =
    !dismissed &&
    !hasMadeAdChoice() &&
    isPixelConfigured() &&
    !hasGpcSignal() &&
    // NEVER inside the operator's own dashboard.
    //
    // Someone in /admin has an account. Interrupting their work to ask about
    // advertising measurement is the objection Darren raised: it reads as a
    // choice about whether we track you, when the honest answer is that using
    // the product means being measured, and this bar only ever governed what
    // goes to an ad network. Asking there implies a control we are not offering.
    //
    // This does NOT remove their opt-out, which is the part the law requires:
    // AdminLayout carries PLATFORM_LEGAL_LINKS, so Do Not Sell or Share sits in
    // the footer of every admin page. Verified present on main before this
    // guard was added - if that footer is ever removed, this suppression has to
    // go with it or operators lose the route entirely.
    //
    // Public pages keep the bar. A visitor who has not signed up is being shared
    // with Meta while having no relationship with us at all, which is precisely
    // the case the notice exists for.
    !inOperatorApp &&
    // Nor on the operator sign-in screen. Nobody reaches it without an account,
    // so it is the same population as the dashboard, and App.jsx serves it at
    // two URLs - one of which the /admin prefix above already caught. Treating
    // them differently made one screen behave two ways.
    !onSignIn &&
    // Never alongside the fuller control. Two things asking the same question on
    // one screen is worse than either alone.
    location.pathname !== CHOICE_PAGE;

  // How many people actually ANSWER this, and where they see it.
  //
  // The choice itself lives only in the visitor's own localStorage, so until now
  // there was no way to know whether anyone engages with the bar at all - and a
  // non-blocking bar is precisely the design people ignore. Without an impression
  // there is no denominator, so this records the showing as well as the answer.
  //
  // `surface` is a coarse public/admin bucket rather than the path, because the
  // question it settles is "does this follow operators into their own dashboard"
  // and a raw pathname would carry tenant slugs into analytics for no extra
  // insight.
  //
  // READ THIS BEFORE INTERPRETING THE ADMIN BUCKET: since the guard above,
  // surface='admin' is unreachable and should always be zero. That zero is BY
  // DESIGN, not evidence that the bar naturally stays out of the dashboard. It
  // was briefly read as such - the admin count was zero before the guard existed
  // too, simply because no operator had yet signed up and left the bar
  // unanswered, and an absent scenario was mistaken for a working one.
  //
  // Keeping the dimension anyway: it is now a regression canary. If admin
  // impressions ever appear, the guard has been removed or routed around.
  //
  // This component mounts once for the app's lifetime and re-renders on every
  // navigation, hence the ref: one impression per visit, not one per render.
  const surface = inOperatorApp ? 'admin' : 'public';
  const shownRef = useRef(false);
  useEffect(() => {
    if (!visible || shownRef.current) return;
    shownRef.current = true;
    capture('ad_notice_shown', { surface });
  }, [visible, surface]);

  if (!visible) return null;

  function answer(accepted) {
    capture('ad_notice_answered', { choice: accepted ? 'ok' : 'decline', surface });
    if (accepted) optInToPixel();
    else optOutOfPixel();
    // Belt and braces. Both calls dispatch the event that re-renders this
    // component, and hasMadeAdChoice() would then be true anyway - but if
    // localStorage is unavailable the write is silently dropped, and without
    // this the bar would sit there ignoring a click that genuinely did take
    // effect for the session.
    setDismissed(true);
  }

  return (
    <div
      role="region"
      aria-label="Advertising measurement choice"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        background: DEEP,
        color: '#fff',
        padding: '14px 18px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        fontSize: 13.5,
        lineHeight: 1.5,
        fontFamily: "'Poppins', system-ui, sans-serif",
        boxShadow: '0 -2px 16px rgba(0,0,0,0.18)',
      }}
    >
      {/* CATEGORIES here, VENDORS in the policy - the ordinary convention, and
          what a visitor expects a cookie bar to say. An earlier version named
          Meta in the bar itself, which reads as unusual and invites the question
          "why is this site telling me about Meta" rather than answering the one
          being asked. The Cookie Disclosure behind Details names Meta, says what
          it receives, and repeats the children and families commitment; the Do
          Not Sell page states it too. Moved, not dropped.

          "how enrops is used" covers the privacy-respecting product analytics
          that run everywhere; "how people find us" covers the advertising
          measurement. Both halves are true.

          It said "to measure our own advertising" until 2026-07-31. Jessica's
          call, and the reasoning is worth keeping: the word "advertising" makes
          an ordinary bar read as a bigger deal than it is, and what we actually
          do with it is attribution - working out how somebody arrived. "How
          people find us" says that in words a provider would use.
          What it must NOT become is the vaguer "improve your experience": there
          is a Decline button sitting next to this sentence, and a bar that no
          longer names what is being declined is the start of a dark pattern.
          The purpose has to stay recognisable in the bar even when the vendor
          lives in the policy. */}
      <span style={{ maxWidth: 620 }}>
        We use cookies to understand how enrops is used and how people find us.{' '}
        <Link to="/cookies" style={{ color: '#C9C5FF' }}>
          Details
        </Link>
        .
      </span>
      <span style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => answer(false)}
          style={{
            padding: '9px 16px',
            background: 'transparent',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.45)',
            borderRadius: 8,
            fontSize: 13.5,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Decline
        </button>
        <button
          type="button"
          onClick={() => answer(true)}
          style={{
            padding: '9px 16px',
            background: MINT,
            color: DEEP,
            border: 'none',
            borderRadius: 8,
            fontSize: 13.5,
            fontWeight: 700,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          OK
        </button>
      </span>
    </div>
  );
}
