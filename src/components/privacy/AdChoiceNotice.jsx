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
//   - a choice is already stored.

import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
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

  if (dismissed || hasMadeAdChoice()) return null;
  if (!isPixelConfigured() || hasGpcSignal()) return null;
  // Never alongside the fuller control. Two things asking the same question on
  // one screen is worse than either alone.
  if (location.pathname === CHOICE_PAGE) return null;

  function answer(accepted) {
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
      <span style={{ maxWidth: 620 }}>
        We use measurement from Meta to see which of our own ads bring businesses to enrops. We
        never share information about children or families.{' '}
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
