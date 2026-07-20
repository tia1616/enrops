// Catches the one failure mode that code-splitting introduces.
//
// THE PROBLEM: route chunks are content-hashed (index-gKGy8UMA.js). When we
// deploy, every hash changes. A user who loaded the app BEFORE the deploy is
// holding an old index.html that points at chunk filenames the new deploy no
// longer serves. The moment they navigate to a route they haven't visited yet,
// the dynamic import 404s and React throws:
//
//     TypeError: Failed to fetch dynamically imported module
//
// Without a boundary that is a blank white screen with a console error nobody
// sees — an admin clicks "Payroll" mid-session and the app appears to die. Our
// PWA makes this MORE likely, not less: the service worker serves the cached
// index.html to open clients until they accept the update toast, so the window
// where old-html-meets-new-assets is as long as the user's session.
//
// THE FIX: a chunk-load failure is not a real error, it's a staleness signal.
// Reload once and the browser picks up the new index.html with valid hashes.
// We guard with sessionStorage so a genuinely-broken chunk (a real build bug,
// an offline user) can't put us in an infinite reload loop — the second failure
// in a row shows a real message instead.

import { Component } from 'react';

const RELOAD_FLAG = 'enrops:chunk-reload-attempted';

// Matches what the major browsers throw for a failed dynamic import. Chrome and
// Edge say "Failed to fetch dynamically imported module", Firefox "error
// loading dynamically imported module", Safari "Importing a module script
// failed". We also catch the older CSS-chunk variant.
function isChunkLoadError(error) {
  const msg = String(error?.message || error || '');
  return (
    /dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /Loading chunk \d+ failed/i.test(msg) ||
    /Loading CSS chunk/i.test(msg)
  );
}

export default class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(error) {
    if (!isChunkLoadError(error)) throw error; // not ours — let it bubble
    return { failed: true };
  }

  componentDidMount() {
    // Retire the guard once the app has been up and stable for a while.
    //
    // The guard has to survive a reload to do its job, but it must not be
    // permanent: without this, the FIRST recovered chunk error would burn the
    // one free retry for the rest of the session, and a second deploy during a
    // long admin session would dead-end on the error screen instead of quietly
    // reloading.
    //
    // Clearing it on mount would be wrong in the opposite direction — a chunk
    // that fails every time would clear the flag, reload, fail, clear, reload,
    // forever. The delay is what distinguishes "the reload worked" from "we
    // are looping": a failure within 10s of boot is the loop, and keeps the
    // flag; surviving 10s means the reload genuinely fixed it.
    this.guardTimer = setTimeout(() => {
      try {
        sessionStorage.removeItem(RELOAD_FLAG);
      } catch {
        // Private-mode Safari can throw on sessionStorage; non-fatal.
      }
    }, 10000);
  }

  componentWillUnmount() {
    clearTimeout(this.guardTimer);
  }

  componentDidCatch(error) {
    if (!isChunkLoadError(error)) return;

    // A chunk 404'd. Almost always: a deploy rotated the hashes out from under
    // an already-open tab. Reload once to pick up the fresh index.html.
    let alreadyTried = false;
    try {
      alreadyTried = sessionStorage.getItem(RELOAD_FLAG) === '1';
      if (!alreadyTried) sessionStorage.setItem(RELOAD_FLAG, '1');
    } catch {
      // sessionStorage unavailable (private mode). Without somewhere to record
      // the attempt we cannot detect a loop, so do NOT auto-reload — show the
      // manual Reload button instead. A dead end the user can click out of
      // beats an infinite refresh they cannot.
      return;
    }

    // Cancel the retirement timer: we are mid-recovery, and the reload is
    // about to tear this instance down anyway.
    clearTimeout(this.guardTimer);

    if (!alreadyTried) window.location.reload();
    // Already tried: reloading did not help (offline, or a chunk that really
    // is gone). Fall through to the message with the manual Reload button.
  }

  render() {
    if (!this.state.failed) return this.props.children;

    // Only reached when a reload already failed to fix it.
    return (
      <div style={{ padding: '64px 24px', textAlign: 'center', color: '#3b3546' }}>
        <p style={{ fontSize: 16, marginBottom: 8 }}>This page didn&rsquo;t finish loading.</p>
        <p style={{ fontSize: 14, color: '#6b6577', marginBottom: 20 }}>
          Check your connection, then try again.
        </p>
        <button
          type="button"
          onClick={() => {
            sessionStorage.removeItem(RELOAD_FLAG);
            window.location.reload();
          }}
          style={{
            padding: '8px 18px',
            borderRadius: 8,
            border: '1px solid #1C004F',
            background: '#1C004F',
            color: '#fff',
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
