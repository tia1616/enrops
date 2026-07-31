// PwaInstallButton — small install button + spotlight overlay.
//
// Drop into any portal header. The component handles four states:
//
//   1. Already installed (display-mode: standalone)         → renders nothing
//   2. Desktop / laptop browser                             → the button reads
//      "Get the phone app" and explains that Enrops is designed for a phone.
//      We deliberately do NOT offer a desktop install even when Chromium
//      would happily give us one.
//   3. Android / Chromium on a phone                        → captures
//      beforeinstallprompt, button click calls prompt(),
//      browser shows its own native install sheet
//   4. iOS Safari                                           → button click
//      opens our own spotlight card with the
//      Share-icon → Add to Home Screen steps
//
// State 2 is why this file looks the way it does. It used to branch only on
// iOS vs "Android fallback", with no notion of a desktop at all — so someone
// on a laptop who clicked Install app was told to "tap the ⋮ menu → Add to
// Home Screen", a phone instruction that cannot be followed on a desktop, from
// a button that renders in the DESKTOP admin shell (AdminLayout). Reported by
// Jessica 2026-07-31 after several people tried it on desktop and nothing
// worked. The button label changes too: a control that says "Install app" and
// then explains you can't is the same lie one step later.
//
// The spotlight uses a dark overlay with a transparent cutout around the
// install button itself (Android variant) OR a card-on-overlay layout (iOS
// variant). Dismissals persist in localStorage so we don't nag — but the
// button stays visible so users can re-trigger.
//
// Visual style matches the Enrops portal (PURPLE/VIOLET/CREAM tokens).

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const PURPLE = '#1C004F';
const VIOLET = '#8C88FF';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const RULE = '#e2dfd5';

const DISMISS_KEY = 'enrops_pwa_install_dismissed_v1';

function isIos() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ identifies as Mac; check for touch support to disambiguate.
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && 'ontouchend' in document);
}

// A phone or tablet, as opposed to a laptop or desktop. This decides whether we
// offer the install at all, so it has to be conservative: when in doubt, treat
// the device as a desktop and explain rather than hand out steps that fail.
//
// Two signals, because neither is reliable alone. The UA string catches Android
// and iOS. A coarse primary pointer catches touch devices whose UA we don't
// recognise. A Windows laptop with a touchscreen still reports a FINE primary
// pointer for its mouse or trackpad, so it correctly stays "desktop".
function isPhone() {
  if (typeof navigator === 'undefined') return false;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true;
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)').matches === true;
}

// On iOS, Add to Home Screen is a SAFARI-ONLY feature. Every iOS browser runs on
// WebKit, but only Safari's share sheet offers the option at all - Chrome,
// Firefox and Edge for iOS cannot do it, and neither can the in-app browsers a
// link opens in from Gmail, Instagram or Facebook. That last case is the common
// one for us: we email operators a link, and the phone opens it in a webview.
//
// Without this check we showed Safari's exact steps to people who had no way to
// follow them - the same defect as the desktop branch, one platform down.
// Verified 2026-07-31.
function isIosSafari() {
  if (typeof navigator === 'undefined') return false;
  // Self-contained: without this, Android Chrome ("... Chrome/125 Mobile
  // Safari/537.36") satisfies the checks below and the function returns true,
  // which is only harmless because today's single caller already knows it is on
  // iOS. Don't leave that trap for the next caller.
  if (!isIos()) return false;
  const ua = navigator.userAgent;
  // Third-party iOS browsers and the common in-app webviews all identify
  // themselves. Anything left that still claims Safari IS Safari. Bare WKWebView
  // usually omits "Safari" entirely, so it fails closed, which is what we want.
  const NOT_SAFARI = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo|FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Snapchat|Pinterest|LinkedInApp/i;
  if (NOT_SAFARI.test(ua)) return false;
  return /Safari/.test(ua);
}

function isStandalone() {
  if (typeof window === 'undefined') return false;
  // matchMedia is the modern API. navigator.standalone is the legacy iOS
  // signal — still required because iOS doesn't expose display-mode in all
  // versions.
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

export default function PwaInstallButton({ variant = 'inline' }) {
  const [installed, setInstalled] = useState(isStandalone);
  const [iosUser, setIosUser] = useState(false);
  const [iosSafari, setIosSafari] = useState(false);
  // Lazy initialiser, same as `installed` above: this is a client-only SPA, so
  // the value is correct on first paint and the button never renders the wrong
  // label for a tick.
  const [phone] = useState(isPhone);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const deferredPromptRef = useRef(null);

  useEffect(() => {
    setIosUser(isIos());
    setIosSafari(isIosSafari());

    // Catch the install prompt on Chromium. Once captured, we hold it until
    // the user taps our button.
    const onBeforeInstallPrompt = (e) => {
      e.preventDefault();
      deferredPromptRef.current = e;
    };
    const onInstalled = () => {
      setInstalled(true);
      deferredPromptRef.current = null;
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed) return null;

  async function handleClick() {
    // Desktop: explain, never install. This returns BEFORE the Chromium path
    // on purpose — desktop Chrome and Edge will happily fire a real install
    // prompt, and taking it just yields the same site in a window with no
    // tabs. The app is a phone experience, so we say where it belongs.
    if (!phone) {
      setOverlayOpen(true);
      return;
    }
    // iOS: we draw our own spotlight card since Safari has no programmatic
    // install API.
    if (iosUser) {
      setOverlayOpen(true);
      return;
    }
    // Chromium path: fire the native install sheet directly. If we never
    // captured the event (e.g., the user dismissed Chrome's own banner
    // earlier in this session, or they're on a desktop browser that doesn't
    // qualify), fall through to a friendly tip.
    const prompt = deferredPromptRef.current;
    if (!prompt) {
      setOverlayOpen(true);
      return;
    }
    prompt.prompt();
    try {
      const choice = await prompt.userChoice;
      if (choice.outcome === 'accepted') {
        setInstalled(true);
      } else {
        // User declined — store dismissal so we surface a gentler tone next
        // time. Button stays available for re-trigger.
        localStorage.setItem(DISMISS_KEY, new Date().toISOString());
      }
    } catch {
      // ignored — prompt() can throw if called twice
    } finally {
      deferredPromptRef.current = null;
    }
  }

  function closeOverlay() {
    setOverlayOpen(false);
  }

  function dismissPermanently() {
    localStorage.setItem(DISMISS_KEY, new Date().toISOString());
    setOverlayOpen(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        style={
          variant === 'inline'
            ? buttonStylesInline
            : buttonStylesSubtle
        }
        title={phone ? 'Install Enrops on your phone' : 'Enrops is designed for your phone'}
      >
        {/* The enrops "e", not a robot emoji — this button offers to put our
            icon on someone's home screen, so it should show the icon they'll
            get. Same path as the brand mark and the generated PWA icons;
            currentColor so it reads correctly on both button styles. */}
        <svg aria-hidden="true" width="13" height="13" viewBox="0 0 77 80" style={{ flexShrink: 0 }}>
          <path fill="currentColor" d="M17.0766 4.11808L16.6572 6.35838C16.157 9.04979 16.3473 11.7643 17.2148 14.3548C26.0612 6.41586 37.0491 2.65761 47.8436 3.97693C49.2817 4.15153 50.7091 4.42156 52.0809 4.7828C61.1553 7.17226 67.1941 13.0557 68.6461 20.9173C69.6782 26.499 68.3162 31.8735 64.708 36.4563C63.7168 37.7184 62.5436 38.9174 61.2215 40.0167C57.8796 42.78 53.7588 44.7486 49.3082 45.7082C43.4944 46.9626 37.0577 46.7379 30.6939 45.066C27.1784 44.1403 23.7257 42.7738 20.5379 41.0538C20.2388 44.8753 20.9753 48.6483 22.7051 51.9382C25.3827 57.0462 29.936 60.6677 35.5164 62.1371C41.5041 63.7138 47.8113 62.5174 52.818 58.8584C56.2277 56.3662 58.7114 52.9726 59.9986 49.0523L60.6216 47.1604L77 48.7142L76.3144 51.4816C73.7904 61.6938 66.8264 70.2985 57.2087 75.0978C49.164 79.1133 39.9589 80.0681 31.2846 77.784C28.2193 76.9768 25.2286 75.7698 22.4015 74.2015C12.8024 68.8772 6.06001 59.1426 4.36044 48.1584C3.36421 41.6866 4.09388 35.1063 6.477 29.0482C0.794723 21.1271 -1.28363 11.5322 0.779132 2.50617L1.3514 0L17.0747 4.12514L17.0766 4.11808ZM52.5661 24.083C52.4639 23.236 51.9798 22.4698 51.216 21.9285C50.2857 21.2678 49.2113 20.7846 47.944 20.4471C47.2724 20.2703 46.547 20.136 45.7322 20.0348C39.4265 19.4137 33.2185 21.7208 27.99 26.5724C30.1149 27.7668 32.5942 28.7711 35.1165 29.4353C42.3546 31.3412 48.5817 30.2561 51.7769 26.5282C52.3949 25.8066 52.6781 24.9363 52.5752 24.0778L52.5661 24.083Z"/>
        </svg>
        {phone ? 'Install app' : 'Get the phone app'}
      </button>

      {/* PORTALLED to document.body. This button renders inside the admin shell
          and the public header, and a position:fixed overlay is only truly fixed
          to the viewport if NO ancestor creates a containing block - any
          transform, filter, backdrop-filter, will-change or contain on any
          ancestor traps it, and z-index then only competes inside that ancestor.
          Jessica hit exactly that: on her phone the card rendered BEHIND the page
          with only its first line showing.
          Rather than hunt the specific ancestor and leave the next one to
          re-break it, the overlay leaves the tree entirely. That is what modals
          are supposed to do. */}
      {overlayOpen && createPortal(
        <div
          onClick={closeOverlay}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            // 100dvh tracks the VISIBLE viewport on iOS, which shrinks and grows
            // as Safari's chrome slides. inset:0 uses the LAYOUT viewport, so the
            // bottom of the overlay - and anything centred in it - can sit below
            // what the phone is actually showing. minHeight is the fallback for
            // anything that does not know dvh; it is ignored where dvh applies.
            minHeight: '100vh',
            height: '100dvh',
            background: 'rgba(0,0,0,0.65)',
            zIndex: 9999,
            display: 'flex',
            // NOT align/justify center. Centring a child that is taller than the
            // overlay pushes its TOP off-screen, and a fixed overlay does not
            // scroll, so there is no way to reach it - Jessica hit this on a
            // laptop and again on an iPhone, landing on step 2 with the heading
            // and step 1 above the top edge. iOS Safari's browser chrome makes
            // the usable height much shorter than the screen suggests, so the
            // card only has to be modestly tall for this to bite.
            //
            // `overflow-y: auto` here plus `margin: auto` on the card is the
            // combination that behaves: the card still centres when there IS
            // room, and when there isn't, the overlay scrolls instead of
            // clipping. (Centring via align-items and then adding overflow does
            // NOT fix it - the overflowing top stays unreachable.)
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
            padding: 16,
            fontFamily: "'Poppins', system-ui, sans-serif",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff',
              borderRadius: 16,
              maxWidth: 360,
              width: '100%',
              margin: 'auto',
              padding: 22,
              boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
              color: INK,
            }}
          >
            <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 700, marginBottom: 6 }}>
              {phone ? 'Install Enrops' : 'Enrops on your phone'}
            </div>
            {/* Four real situations, four true answers. Said out loud:
                  laptop            -> "designed for your phone"      (can't install here)
                  iPhone, Safari    -> Share icon -> Add to Home Screen (works)
                  iPhone, not Safari-> "open it in Safari first"      (Safari-only feature)
                  Android phone     -> browser menu -> Install app    (works) */}
            {!phone
              ? <DesktopNote />
              : iosUser
                ? (iosSafari ? <IosSteps /> : <IosNeedsSafari />)
                : <AndroidFallback />}
            <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              <button
                type="button"
                onClick={dismissPermanently}
                style={{
                  flex: 1,
                  padding: '9px 12px',
                  background: 'transparent',
                  border: `1px solid ${RULE}`,
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 500,
                  color: MUTED,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                Not now
              </button>
              <button
                type="button"
                onClick={closeOverlay}
                style={{
                  flex: 1,
                  padding: '9px 12px',
                  background: '#5847C9',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                Got it
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function IosSteps() {
  return (
    <>
      <h3 style={{ margin: '0 0 14px', fontSize: 18, fontWeight: 700, color: PURPLE, lineHeight: 1.25 }}>
        Two steps — takes about 10 seconds.
      </h3>
      <Step n={1}>
        Tap the <strong>Share icon</strong> <ShareIconInline /> at the bottom (or top) of Safari.
      </Step>
      <Step n={2}>
        Scroll down, tap <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.
      </Step>
      <div
        style={{
          marginTop: 10,
          background: '#f5f3eb',
          border: `1px solid ${RULE}`,
          borderRadius: 8,
          padding: '10px 12px',
          fontSize: 12,
          color: MUTED,
        }}
      >
        The Share menu has icons in a row — look for the box with an arrow pointing up.
      </div>
    </>
  );
}

function AndroidFallback() {
  return (
    <>
      <h3 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 700, color: PURPLE, lineHeight: 1.25 }}>
        Install from your browser menu
      </h3>
      <p style={{ fontSize: 14, color: INK, lineHeight: 1.5, margin: '0 0 12px' }}>
        Your browser didn't offer the one-tap install just now. You can still install Enrops manually:
      </p>
      {/* Do not name one browser's menu position as if it were every browser's.
          This said "the ⋮ menu in the top-right", which is Chrome. In Samsung
          Internet - a large slice of Android - the menu is a ☰ at the BOTTOM
          right and the item is "Add page to" -> "Home screen". Naming both, and
          leading with what they are looking FOR, keeps it true either way.
          Checked 2026-07-31. */}
      <Step n={1}>
        Open your browser&rsquo;s menu &mdash; <strong>⋮</strong> at the top right in
        Chrome, <strong>☰</strong> at the bottom right in Samsung Internet.
      </Step>
      <Step n={2}>
        Tap <strong>Install app</strong>, or <strong>Add page to</strong> &rarr;{' '}
        <strong>Home screen</strong>.
      </Step>
    </>
  );
}

// Shown on a laptop or desktop. Two jobs: stop someone following phone steps
// that cannot work here, and reassure them they are not missing a feature by
// staying in the browser. The installed app IS this site, so "everything works
// the same here" is literally true and worth saying plainly.
function DesktopNote() {
  return (
    <>
      <h3 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 700, color: PURPLE, lineHeight: 1.25 }}>
        Enrops is designed for your phone.
      </h3>
      <p style={{ fontSize: 14, color: INK, lineHeight: 1.5, margin: '0 0 14px' }}>
        The app is for when you&rsquo;re out and about. On a laptop there&rsquo;s
        nothing to install &mdash; everything works the same right here in your
        browser.
      </p>
      <p style={{ fontSize: 14, color: INK, lineHeight: 1.5, margin: '0 0 10px', fontWeight: 600 }}>
        To put it on your phone:
      </p>
      <Step n={1}>
        Open <strong>enrops.com</strong> on your phone and sign in.
      </Step>
      <Step n={2}>
        Tap <strong>Install app</strong> there, and it lands on your home screen.
      </Step>
    </>
  );
}

// iPhone or iPad, but not in Safari. Add to Home Screen simply does not exist in
// Chrome/Firefox/Edge for iOS or in an in-app browser, so there is no set of
// steps that works here - the only honest instruction is "switch to Safari".
// Says so plainly rather than implying they did something wrong.
function IosNeedsSafari() {
  return (
    <>
      <h3 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 700, color: PURPLE, lineHeight: 1.25 }}>
        Open enrops.com in Safari to install it.
      </h3>
      <p style={{ fontSize: 14, color: INK, lineHeight: 1.5, margin: '0 0 14px' }}>
        On iPhone and iPad, only Safari can add an app to your home screen.
        That&rsquo;s an Apple rule, not something you&rsquo;ve missed. Everything here
        keeps working in this browser either way.
      </p>
      <Step n={1}>
        Open <strong>Safari</strong> and go to <strong>enrops.com</strong>.
      </Step>
      <Step n={2}>
        Tap the <strong>Share icon</strong> <ShareIconInline />, then{' '}
        <strong>Add to Home Screen</strong>.
      </Step>
    </>
  );
}

function Step({ n, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
      <div
        style={{
          background: '#5847C9',
          color: '#fff',
          width: 22,
          height: 22,
          minWidth: 22,
          borderRadius: 11,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 700,
          marginTop: 1,
        }}
      >
        {n}
      </div>
      <div style={{ fontSize: 14, color: INK, lineHeight: 1.45 }}>{children}</div>
    </div>
  );
}

function ShareIconInline() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        background: '#f5f3eb',
        border: `1px solid ${RULE}`,
        borderRadius: 4,
        verticalAlign: 'middle',
        margin: '0 2px',
      }}
    >
      <svg width="13" height="14" viewBox="0 0 13 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M6.5 1L6.5 9M6.5 1L3.5 4M6.5 1L9.5 4" stroke="#1a1a1a" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M2 7V12C2 12.5523 2.44772 13 3 13H10C10.5523 13 11 12.5523 11 12V7" stroke="#1a1a1a" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    </span>
  );
}

const buttonStylesInline = {
  background: 'transparent',
  border: `1px solid ${PURPLE}`,
  color: PURPLE,
  borderRadius: 6,
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
};

const buttonStylesSubtle = {
  background: 'transparent',
  border: 'none',
  color: PURPLE,
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
  padding: '4px 8px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
};
