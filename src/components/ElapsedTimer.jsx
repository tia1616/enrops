// Shared elapsed-time display for any AI extract / generate / write step.
//
// Per the project's "AI wait UI" rule (memory feedback_ai_wait_ui): every
// AI surface in Enrops must show a live m:ss counter alongside the
// recommended duration. This component IS that counter — a single visual
// spec used everywhere so the curriculum, marketing, and import wait
// screens all look like they belong to the same product.
//
// Usage:
//   <ElapsedTimer seconds={elapsed} />
//
// Pass seconds from a parent useEffect interval; this component is purely
// presentational.

const INK = '#1a1a1a';
const MUTED = '#6b6b6b';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, "Roboto Mono", monospace';

export default function ElapsedTimer({ seconds = 0 }) {
  const s = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return (
    <span style={{ fontSize: 13, color: MUTED, lineHeight: 1.4 }}>
      <span
        style={{
          fontFamily: MONO,
          fontVariantNumeric: 'tabular-nums',
          color: INK,
          fontWeight: 600,
          marginRight: 4,
        }}
      >
        {mm}:{ss}
      </span>
      elapsed
    </span>
  );
}
