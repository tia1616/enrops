// useViewportClamp — keeps an absolutely-positioned popover inside the screen.
//
// Any panel positioned against its own trigger runs off the edge on a narrow
// screen: anchored right it overflows to the left, anchored left it overflows to
// the right. CSS alone cannot fix this, because the element has no idea where it
// sits in the viewport. So measure after layout and nudge it back.
//
// Written first for the share panel, where the QR sat at the panel's leading edge
// and was therefore the first thing to disappear — measured 109px off the left of
// a 375px phone, which is the bug Jessica reported on 2026-07-31. Extracted here
// so the next popover someone builds cannot quietly repeat it.
//
// Usage:
//   const { ref } = useViewportClamp(open);
//   <div ref={ref} style={{ position: 'absolute', left: 0, width: PANEL_W }}>
//
// The hook writes the correction straight onto the node's transform, and also
// returns shiftX so a caller can mirror it into React-managed styles if it
// re-renders the element for other reasons.

import { useLayoutEffect, useRef, useState } from 'react';

// Breathing room between a popover and the edge of the screen.
export const VIEWPORT_GUTTER = 8;

export default function useViewportClamp(open) {
  const ref = useRef(null);
  const [shiftX, setShiftX] = useState(0);

  useLayoutEffect(() => {
    if (!open) {
      setShiftX(0);
      return undefined;
    }

    function clamp() {
      const el = ref.current;
      if (!el) return;

      // Measure the NATURAL position by clearing any correction first.
      //
      // The obvious alternative — measure the corrected box and subtract the
      // previous shift inside a functional setState — is wrong under rapid
      // resize. Two clamp() calls can measure the same painted box, because
      // React has not re-rendered between them, while the second updater
      // receives the FIRST one's result as its previous value. It then subtracts
      // a shift the DOM never applied and the panel jumps sideways. This runs in
      // a layout effect, before paint, so the reset is never visible.
      el.style.transform = 'none';
      const rect = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;

      let next = 0;
      if (rect.right > vw - VIEWPORT_GUTTER) next = vw - VIEWPORT_GUTTER - rect.right;
      // Pulling it in from the right can push it off the left. Left wins: a
      // panel whose start is off-screen is unreadable, and the leading edge is
      // where the thing people opened it for tends to sit.
      if (rect.left + next < VIEWPORT_GUTTER) next = VIEWPORT_GUTTER - rect.left;

      // Apply immediately so the corrected position is what paints, then mirror
      // it into state so an unrelated re-render cannot drop the correction.
      el.style.transform = next ? `translateX(${next}px)` : '';
      setShiftX(next);
    }

    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [open]);

  return { ref, shiftX };
}
