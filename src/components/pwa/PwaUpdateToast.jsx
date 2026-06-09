// PwaUpdateToast — service-worker update notifier.
//
// vite-plugin-pwa registered with registerType: 'prompt' means the SW
// downloads a new version in the background but does NOT activate until we
// call updateSW(true). This component renders a small bottom toast when a
// new version is ready: "New version available — Tap to update."
//
// One tap reloads with the fresh assets. We deliberately never auto-reload
// — an admin filling out a long form would lose their unsaved input.
//
// Mount once at the app root.

import { useEffect, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

const PURPLE = '#1C004F';
const INK = '#1a1a1a';

export default function PwaUpdateToast() {
  const [needRefresh, setNeedRefresh] = useState(false);
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
          Reload to get the latest.
        </div>
      </div>
      <button
        type="button"
        onClick={() => updateSW(true)}
        style={{
          background: '#5847C9',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          padding: '8px 14px',
          fontSize: 13,
          fontWeight: 600,
          fontFamily: 'inherit',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        Update
      </button>
    </div>
  );
}
