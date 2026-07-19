// Shown while a lazily-loaded route chunk is downloading.
//
// Deliberately quiet: admin pages sit inside AdminLayout, so the nav chrome is
// already on screen and this only fills the content area. A big branded splash
// here would read as "the app restarted" every time you click a nav item.
//
// The 150ms delay means a fast chunk load (cached, or a good connection) shows
// NOTHING at all — a spinner that flashes for 40ms is visual noise that makes
// the app feel slower than a brief blank does.

import { useEffect, useState } from 'react';

export default function RouteFallback({ label = 'Loading' }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(t);
  }, []);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: '64px 24px',
        color: '#6b6577',
        fontSize: 14,
      }}
    >
      <span
        className="enrops-route-spinner"
        aria-hidden="true"
        style={{
          width: 16,
          height: 16,
          borderRadius: '50%',
          border: '2px solid #e7d9a8',
          borderTopColor: '#1C004F',
          flexShrink: 0,
        }}
      />
      {label}
      {/* Scoped to .enrops-route-spinner on purpose. An earlier version keyed
          the reduced-motion rule off `[role="status"] > span`, which would
          have reached into any other component using that ARIA role. */}
      <style>{`
        @keyframes enrops-route-spin { to { transform: rotate(360deg); } }
        .enrops-route-spinner { animation: enrops-route-spin 0.7s linear infinite; }
        @media (prefers-reduced-motion: reduce) {
          .enrops-route-spinner { animation-duration: 2.5s; }
        }
      `}</style>
    </div>
  );
}
