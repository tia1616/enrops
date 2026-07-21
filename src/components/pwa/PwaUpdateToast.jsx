// PwaUpdateToast — service-worker update notifier.
//
// vite-plugin-pwa registered with registerType: 'prompt' means the SW
// downloads a new version in the background but does NOT activate until we
// call updateSW(true). This component renders a small bottom toast when a
// new version is ready.
//
// WHY THE COPY MATTERS (2026-07-21). The old subtitle said "Reload to get the
// latest." That is WRONG and it actively trained the wrong reflex: reloading a
// page that has a waiting service worker does NOT apply the update — the waiting
// worker just stays waiting, workbox re-detects it on the fresh load, and the
// toast comes straight back. The ONLY thing that applies the update is clicking
// the button (which sends skipWaiting). So the toast now tells the user to click
// it, not to reload.
//
// We deliberately never auto-reload — an admin filling out a long form would
// lose unsaved input. The update happens only on an explicit click.
//
// On click we also arm a short fallback reload. Normally updateSW(true) →
// skipWaiting → the new worker takes control → vite-plugin-pwa reloads the page
// within ~1s, so the fallback timer never fires. If that controlling-event
// reload ever fails to fire (it is gated on event.isUpdate, which can be
// undefined in edge cases), the fallback guarantees the click still results in a
// reload instead of a dead button. See [[project_enrops_code_split]] item 4 for
// the still-unexplained history of this toast getting stuck.
//
// Mount once at the app root.

import { useEffect, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

const PURPLE = '#1C004F';
const INK = '#1a1a1a';

export default function PwaUpdateToast() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateSW, setUpdateSW] = useState(() => () => {});

  useEffect(() => {
    const update = registerSW({
      onNeedRefresh() {
        setNeedRefresh(true);
      },
      onOfflineReady() {
        // We don't promise offline mode (auth + live schedule data wouldn't
        // work offline anyway). Stay silent on this event.
      },
    });
    setUpdateSW(() => update);
  }, []);

  if (!needRefresh) return null;

  const onUpdate = () => {
    if (updating) return;
    setUpdating(true);
    // Fires skipWaiting; the new worker taking control reloads the page.
    updateSW(true);
    // Belt-and-braces: if the controlling-event reload doesn't fire, force it.
    // In the normal path the page has already reloaded well before this runs.
    setTimeout(() => {
      window.location.reload();
    }, 3000);
  };

  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        bottom: 20,
        left: 16,
        right: 16,
        maxWidth: 420,
        margin: '0 auto',
        background: '#fff',
        border: `1px solid ${PURPLE}`,
        borderRadius: 12,
        padding: '12px 16px',
        boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        zIndex: 9998,
        fontFamily: "'Poppins', system-ui, sans-serif",
      }}
    >
      <div style={{ fontSize: 13, color: INK, lineHeight: 1.4 }}>
        <strong>New version available</strong>
        <div style={{ fontSize: 12, color: '#6b6b6b', marginTop: 2 }}>
          {updating ? 'Loading it now…' : 'Click Update to load it.'}
        </div>
      </div>
      <button
        type="button"
        onClick={onUpdate}
        disabled={updating}
        style={{
          background: updating ? '#9a90d8' : '#5847C9',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          padding: '8px 14px',
          fontSize: 13,
          fontWeight: 600,
          fontFamily: 'inherit',
          cursor: updating ? 'default' : 'pointer',
          flexShrink: 0,
        }}
      >
        {updating ? 'Updating…' : 'Update'}
      </button>
    </div>
  );
}
