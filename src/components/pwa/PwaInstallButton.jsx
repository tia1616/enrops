// PwaInstallButton — small "Install on phone" button + spotlight overlay.
//
// Drop into any portal header. The component handles three states:
//
//   1. Already installed (display-mode: standalone)         → renders nothing
//   2. Android / Chromium                                   → captures
//      beforeinstallprompt, button click calls prompt(),
//      browser shows its own native install sheet
//   3. iOS Safari                                            → button click
//      opens our own spotlight card with the
//      Share-icon → Add to Home Screen steps
//
// The spotlight uses a dark overlay with a transparent cutout around the
// install button itself (Android variant) OR a card-on-overlay layout (iOS
// variant). Dismissals persist in localStorage so we don't nag — but the
// button stays visible so users can re-trigger.
//
// Visual style matches the Enrops portal (PURPLE/VIOLET/CREAM tokens).

import { useEffect, useRef, useState } from 'react';

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
  const [overlayOpen, setOverlayOpen] = useState(false);
  const deferredPromptRef = useRef(null);

  useEffect(() => {
    setIosUser(isIos());

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
        title="Install Enrops on your phone"
      >
        {/* The enrops "e", not a robot emoji — this button offers to put our
            icon on someone's home screen, so it should show the icon they'll
            get. Same path as the brand mark and the generated PWA icons;
            currentColor so it reads correctly on both button styles. */}
        <svg aria-hidden="true" width="13" height="13" viewBox="0 0 77 80" style={{ flexShrink: 0 }}>
          <path fill="currentColor" d="M17.0766 4.11808L16.6572 6.35838C16.157 9.04979 16.3473 11.7643 17.2148 14.3548C26.0612 6.41586 37.0491 2.65761 47.8436 3.97693C49.2817 4.15153 50.7091 4.42156 52.0809 4.7828C61.1553 7.17226 67.1941 13.0557 68.6461 20.9173C69.6782 26.499 68.3162 31.8735 64.708 36.4563C63.7168 37.7184 62.5436 38.9174 61.2215 40.0167C57.8796 42.78 53.7588 44.7486 49.3082 45.7082C43.4944 46.9626 37.0577 46.7379 30.6939 45.066C27.1784 44.1403 23.7257 42.7738 20.5379 41.0538C20.2388 44.8753 20.9753 48.6483 22.7051 51.9382C25.3827 57.0462 29.936 60.6677 35.5164 62.1371C41.5041 63.7138 47.8113 62.5174 52.818 58.8584C56.2277 56.3662 58.7114 52.9726 59.9986 49.0523L60.6216 47.1604L77 48.7142L76.3144 51.4816C73.7904 61.6938 66.8264 70.2985 57.2087 75.0978C49.164 79.1133 39.9589 80.0681 31.2846 77.784C28.2193 76.9768 25.2286 75.7698 22.4015 74.2015C12.8024 68.8772 6.06001 59.1426 4.36044 48.1584C3.36421 41.6866 4.09388 35.1063 6.477 29.0482C0.794723 21.1271 -1.28363 11.5322 0.779132 2.50617L1.3514 0L17.0747 4.12514L17.0766 4.11808ZM52.5661 24.083C52.4639 23.236 51.9798 22.4698 51.216 21.9285C50.2857 21.2678 49.2113 20.7846 47.944 20.4471C47.2724 20.2703 46.547 20.136 45.7322 20.0348C39.4265 19.4137 33.2185 21.7208 27.99 26.5724C30.1149 27.7668 32.5942 28.7711 35.1165 29.4353C42.3546 31.3412 48.5817 30.2561 51.7769 26.5282C52.3949 25.8066 52.6781 24.9363 52.5752 24.0778L52.5661 24.083Z"/>
        </svg>
        Install app
      </button>

      {overlayOpen && (
        <div
          onClick={closeOverlay}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.65)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
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
              padding: 22,
              boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
              color: INK,
            }}
          >
            <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 700, marginBottom: 6 }}>
              Install Enrops
            </div>
            {iosUser ? <IosSteps /> : <AndroidFallback />}
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
        </div>
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
      <Step n={1}>
        Tap the <strong>⋮</strong> menu in the top-right of your browser.
      </Step>
      <Step n={2}>
        Tap <strong>Install app</strong> or <strong>Add to Home Screen</strong>.
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
