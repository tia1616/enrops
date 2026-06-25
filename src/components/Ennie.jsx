// Shared Ennie character — the single face of the platform's AI agent.
//
// Ennie has three animated states, each a vector Lottie exported from After
// Effects (source archived in docs/Ennie animations/, shipped JSON lives in
// public/ennie/):
//
//   idle      — calm greeting loop; the resting avatar
//   thinking  — working loop; pair with <ElapsedTimer> on every AI op
//                (per memory feedback_ai_wait_ui)
//   celebrate — one-shot reaction for a completed/“win” moment
//
// This is the ONE place Ennie is defined, replacing per-page static avatars
// so curriculum, marketing, import, and onboarding all render the same
// character. Presentational only — the parent decides which state to show.
//
// Usage:
//   <Ennie state="thinking" size={54} />
//   <Ennie state="celebrate" size={72} onComplete={() => ...} />
//
// If the Lottie fails to load (slow network, bad fetch) it silently falls
// back to the static /ennie-full.jpg so a surface is never blank.

import { useEffect, useRef, useState } from 'react';
import Lottie from 'lottie-react';

const SOURCES = {
  idle: '/ennie/ennie-idle.json',
  thinking: '/ennie/ennie-thinking.json',
  celebrate: '/ennie/ennie-celebrate.json',
};

// celebrate is a one-shot; the loops run continuously.
const LOOPS = { idle: true, thinking: true, celebrate: false };

// Source clips are 1920x1080 with the character in a small region, so we crop the
// SVG viewBox to her. idle/thinking share a transform; celebrate she leaps upward
// so it's framed higher + wider to hold the jump. (idle tuned by Jessica 2026-06-25.)
const VIEWBOX = {
  idle: '859 439 175 175',
  thinking: '859 439 175 175',
  // Celebrate: she bounces both up and down past idle's frame, so it's enlarged to
  // hold the whole bounce (top headroom for the jump, bottom room for the dip).
  celebrate: '826 385 240 240',
};

const GOLD_BORDER = '#e7d9a8';
const RULE = '#ece9e0';
const FRAME_BG = '#fafaf3';

// Module-level cache so each animation JSON is fetched at most once per session.
const cache = new Map();

function useAnimationData(state) {
  const [data, setData] = useState(() => cache.get(state) || null);

  useEffect(() => {
    let cancelled = false;
    const cached = cache.get(state);
    if (cached) {
      setData(cached);
      return;
    }
    const url = SOURCES[state] || SOURCES.idle;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json) => {
        cache.set(state, json);
        if (!cancelled) setData(json);
      })
      .catch((e) => {
        // Non-fatal: the static fallback covers this.
        console.warn(`Ennie "${state}" animation failed to load:`, e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [state]);

  return data;
}

export default function Ennie({
  state = 'idle',
  size = 38,
  framed = true,
  calm = false,
  loop,
  onComplete,
  className = '',
}) {
  const animationData = useAnimationData(state);
  const lottieRef = useRef(null);
  const shouldLoop = loop ?? LOOPS[state] ?? true;

  const visual = animationData ? (
    <Lottie
      key={state}
      lottieRef={lottieRef}
      animationData={animationData}
      loop={shouldLoop}
      autoplay
      onComplete={onComplete}
      rendererSettings={{ viewBoxSize: VIEWBOX[state] || VIEWBOX.idle }}
      style={{ width: '100%', height: '100%' }}
      aria-hidden="true"
    />
  ) : null; // nothing while the (fast, same-origin) Lottie loads — avoids a flash of the old static portrait

  if (!framed) {
    return (
      <div
        className={className}
        style={{
          width: size,
          height: size,
          flexShrink: 0,
          opacity: calm ? 0.75 : 1,
          filter: calm ? 'grayscale(0.65)' : 'none',
        }}
      >
        {visual}
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        overflow: 'hidden',
        background: FRAME_BG,
        flexShrink: 0,
        border: `1px solid ${calm ? RULE : GOLD_BORDER}`,
        opacity: calm ? 0.75 : 1,
        filter: calm ? 'grayscale(0.65)' : 'none',
      }}
    >
      {visual}
    </div>
  );
}
