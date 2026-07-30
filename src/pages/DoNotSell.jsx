// /do-not-sell — the "Do Not Sell or Share My Personal Information" control.
//
// Required, not decoration. Loading a Meta pixel counts as "sharing" for
// cross-context behavioral advertising under CCPA/CPRA, and once you share you
// must offer a clear way to stop. Our published Cookie Disclosure and Privacy
// Policy both now point at "the link on our site" - this is that link, so it
// has to exist before the pixel is ever switched on.
//
// A ROUTE rather than a modal, on purpose: policy text can link to it, it can
// be bookmarked and cited, and it works from any surface without every layout
// having to host a dialog.

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import EnropsWordmark from '../components/EnropsWordmark.jsx';
import {
  isPixelConfigured,
  hasGpcSignal,
  hasOptedOut,
  optOutOfPixel,
  optInToPixel,
} from '../lib/metaPixel.js';
import { useAdChoiceSignal } from '../lib/useAdChoice.js';

const DEEP = '#1C004F';
const MINT = '#26D687';
const MUTED = '#5b5f7a';

/**
 * FOUR states, four sentences, each true in the state that selects it. Said out
 * loud before writing:
 *   not configured -> "nothing is running here"           . true: no dataset id.
 *   GPC            -> "your browser already declined"     . true: we never load.
 *   opted out      -> "you have declined"                 . true: '1' stored.
 *   running        -> "measurement is on, you can stop it" . true: it is on.
 * The fallback is the RUNNING case deliberately - it is the only one that is
 * true when nothing more specific applies, and it is the one that must never be
 * understated.
 */
function describe({ configured, gpc, optedOut }) {
  if (!configured) {
    return {
      heading: 'Advertising measurement is not running',
      body:
        'This site is not currently configured with any advertising measurement, so there is nothing to opt out of here.',
      action: null,
    };
  }
  if (gpc) {
    return {
      heading: 'Your browser has already opted you out',
      body:
        'Your browser is sending a Global Privacy Control signal. We honour it automatically, so advertising measurement is not loaded at all and there is nothing further for you to do.',
      action: null,
    };
  }
  if (optedOut) {
    return {
      heading: 'You have opted out',
      body:
        'We are not loading advertising measurement, and we are not sharing information about your visit with Meta for advertising. We also cleared the advertising identifiers that had been set.',
      action: { label: 'Allow advertising measurement', kind: 'in' },
    };
  }
  // ONE sentence, because one is all we can honestly say.
  //
  // A previous revision split this on isPixelActive() to add an "allowed, but
  // not currently loaded" state for ad-blocked browsers. That was wrong twice
  // over: bootstrap() sets `loaded` immediately after fbq('init'), which
  // succeeds against the queue stub whether or not fbevents.js ever arrives, so
  // isPixelActive() means "we started it" and the branch was UNREACHABLE - and
  // even reachable, whether a blocker eats the request is not something we can
  // observe or should claim. What we can state is our own posture: we have it
  // enabled and we are sending. That is what this says.
  return {
    heading: 'Advertising measurement is on',
    body:
      'We use measurement from Meta to see which of our own advertisements bring enrichment businesses to enrops. Under California and Oregon law this counts as sharing personal information for advertising. You can stop it at any time, and nothing about your account or your programs changes if you do.',
    action: { label: 'Do not sell or share my personal information', kind: 'out' },
  };
}

export default function DoNotSell() {
  // Read once per render pass rather than held in state, so the page cannot
  // disagree with the module about what is actually happening.
  const [, force] = useState(0);
  // Re-render when the choice changes ANYWHERE - most importantly in another
  // tab. Without this, opting out elsewhere left this page still reading
  // "Advertising measurement is on" and still offering to opt you out, which is
  // the one thing the page that owns this setting must never do.
  useAdChoiceSignal();
  const configured = isPixelConfigured();
  const gpc = hasGpcSignal();
  const optedOut = hasOptedOut();
  const { heading, body, action } = describe({ configured, gpc, optedOut });

  function run(kind) {
    if (kind === 'out') optOutOfPixel();
    else optInToPixel();
    force((n) => n + 1);
  }

  return (
    <div style={{ minHeight: '100vh', background: '#fff', color: INKISH }}>
      <div style={{ maxWidth: 680, margin: '0 auto', padding: '48px 24px' }}>
        <Link to="/" aria-label="enrops home" style={{ display: 'inline-block', marginBottom: 32 }}>
          <EnropsWordmark height={26} color={DEEP} />
        </Link>

        <h1 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 12px', color: DEEP }}>
          Do Not Sell or Share My Personal Information
        </h1>

        <div
          style={{
            border: '1px solid #e6e4f2',
            borderRadius: 12,
            padding: '20px 22px',
            margin: '24px 0',
          }}
        >
          <p style={{ fontWeight: 600, margin: '0 0 8px', fontSize: 16 }}>{heading}</p>
          <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.65, color: MUTED }}>{body}</p>

          {action && (
            <button
              type="button"
              onClick={() => run(action.kind)}
              style={{
                marginTop: 18,
                padding: '11px 18px',
                background: action.kind === 'out' ? DEEP : MINT,
                color: action.kind === 'out' ? '#fff' : DEEP,
                border: 'none',
                borderRadius: 9,
                fontSize: 14.5,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {action.label}
            </button>
          )}
        </div>

        <p style={{ fontSize: 13.5, lineHeight: 1.65, color: MUTED }}>
          This choice is remembered in this browser. If you use another browser or device, set it
          there too. We never share information an operator has entrusted to us, and we never use
          advertising technology to target children or build profiles of minors.
        </p>

        <p style={{ fontSize: 13.5, marginTop: 24 }}>
          <Link to="/cookies" style={{ color: '#5847C9' }}>Cookie &amp; Tracking Disclosure</Link>
          {'  ·  '}
          <Link to="/privacy" style={{ color: '#5847C9' }}>Privacy Policy</Link>
        </p>
      </div>
    </div>
  );
}

const INKISH = '#1a1a1a';
