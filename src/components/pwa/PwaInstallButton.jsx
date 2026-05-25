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
// Visual style matches the Enrops portal (PLUM/GOLD/CHALK tokens).

import { useEffect, useRef, useState } from 'react';

const PLUM = '#691D39';
const GOLD = '#CFB12F';
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
        <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 1 }}>🤖</span>
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
            fontFamily: "'Space Grotesk', system-ui, sans-serif",
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
                  background: PLUM,
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
      <h3 style={{ margin: '0 0 14px', fontSize: 18, fontWeight: 700, color: PLUM, lineHeight: 1.25 }}>
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
      <h3 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 700, color: PLUM, lineHeight: 1.25 }}>
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
          background: PLUM,
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
  border: `1px solid ${PLUM}`,
  color: PLUM,
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
  color: PLUM,
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
  padding: '4px 8px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
};
