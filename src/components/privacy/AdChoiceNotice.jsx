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
//   - the visitor is SIGNED IN. Someone with an account is being measured as a
//     condition of using the product, and this bar only ever governed what goes
//     to an ad network - so asking a logged-in person implies a control we do
//     not offer. Their opt-out still lives in the admin footer (Do Not Sell or
//     Share, via PLATFORM_LEGAL_LINKS). Auth state, NOT the URL, is the signal:
//     a logged-in operator sitting on a public page must not see it either.

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
import { useAuth } from '../../context/AuthContext.jsx';

/** The choice page asks the same question with more room; never do both at once. */
const CHOICE_PAGE = '/do-not-sell';

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

  // The rule: never show the bar to someone who is signed in. `loading` guards
  // the brief window before the session resolves, so we never FLASH the bar at
  // a logged-in visitor and then yank it. Auth state, not the pathname, is the
  // signal - it catches a logged-in operator on a public page too, which a
  // path check could not.
  const { user, loading: authLoading } = useAuth();

  // Visibility computed BEFORE any early return, so the effect below obeys the
  // rules of hooks.
  const visible =
    !dismissed &&
    // Not until we know whether they're signed in (avoids a flash), and never
    // once they are. A signed-in person's opt-out lives in the admin footer
    // (Do Not Sell or Share, via PLATFORM_LEGAL_LINKS) - nothing legally
    // required is removed by hiding the bar for them.
    !authLoading &&
    !user &&
    !hasMadeAdChoice() &&
    isPixelConfigured() &&
    !hasGpcSignal() &&
    // Never alongside the fuller control on /do-not-sell. Two things asking the
    // same question on one screen is worse than either alone.
    location.pathname !== CHOICE_PAGE;

  // How many people actually ANSWER this, and where they see it.
  //
  // The choice itself lives only in the visitor's own localStorage, so until now
  // there was no way to know whether anyone engages with the bar at all - and a
  // non-blocking bar is precisely the design people ignore. Without an impression
  // there is no denominator, so this records the showing as well as the answer.
  //
  // `surface` is a coarse public/admin bucket rather than the raw path, which
  // would carry tenant slugs into analytics for no extra insight. Because the
  // bar now hides for anyone signed in, this only ever fires for LOGGED-OUT
  // visitors - so 'admin' here means a logged-out visitor sitting on an operator
  // screen (the sign-in page), worth seeing apart from a public marketing or
  // registration page.
  //
  // This component mounts once for the app's lifetime and re-renders on every
  // navigation, hence the ref: one impression per visit, not one per render.
  const surface = location.pathname.startsWith('/admin') ? 'admin' : 'public';
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
