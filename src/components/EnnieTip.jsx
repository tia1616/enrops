// EnnieTip — the platform's one coaching affordance.
//
// A small "?" beside a control. Tapping it opens a cloud-outline thought bubble
// with Ennie in it, explaining that one thing in her voice.
//
// The rules this is built to (Jessica, 2026-07-31):
//   - ONE primitive, not two. The "?" IS the Ennie bubble. Somewhere to learn
//     once, not a tooltip here and a coach mark there.
//   - It never opens on its own. Anything that interrupts a task gets dismissed,
//     and then the explanation is gone for good. This waits to be asked, and is
//     still there the tenth time.
//   - It never blocks the action. The tip sits beside the control; it does not
//     gate it.
//   - One idea per tip. If it needs more than a short paragraph it is
//     documentation, not coaching, and belongs somewhere else.
//   - Lead with what the operator is trying to do, not with our feature.
//   - When we don't have data, say so rather than reaching for a number.
//
// Usage:
//   <EnnieTip title="Why families see the fee">
//     Showing the fee up front costs you nothing…
//   </EnnieTip>

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import Ennie from './Ennie.jsx';
import useViewportClamp, { VIEWPORT_GUTTER } from '../lib/useViewportClamp';

const PURPLE = '#1C004F';
const BRIGHT = '#5847C9';
const INK = '#1a1a1a';
const CLOUD_FILL = '#ffffff';
const CLOUD_LINE = '#CECBF6';

const CONTENT_W = 262;  // the text column inside the cloud
const PAD = 11;         // room for the scallops to bulge into
const TAIL_H = 24;      // reserved band above the cloud for the thought-puffs
const MAX_STEP = 22;    // widest a single scallop may be
const PANEL_W = CONTENT_W + PAD * 2;

// Build a cloud outline around a CONTENT_W x h content box.
//
// Each edge is a run of semicircular arcs bulging outward, walked clockwise, so
// every arc takes sweep-flag 1: going right along the top bulges up, down the
// right side bulges right, and so on. Arc radius is half the step, which is also
// how far it bulges — so capping the step at MAX_STEP is what guarantees the
// scallops stay inside PAD and never clip.
function cloudPath(h) {
  const nx = Math.max(2, Math.ceil(CONTENT_W / MAX_STEP));
  const ny = Math.max(2, Math.ceil(h / MAX_STEP));
  const sx = CONTENT_W / nx;
  const sy = h / ny;
  const run = (n, dx, dy, r) =>
    Array.from({ length: n }, () => `a ${r} ${r} 0 0 1 ${dx} ${dy}`).join(' ');
  return [
    `M ${PAD} ${PAD + TAIL_H}`,
    run(nx, sx.toFixed(2), 0, (sx / 2).toFixed(2)),
    run(ny, 0, sy.toFixed(2), (sy / 2).toFixed(2)),
    run(nx, (-sx).toFixed(2), 0, (sx / 2).toFixed(2)),
    run(ny, 0, (-sy).toFixed(2), (sy / 2).toFixed(2)),
    'Z',
  ].join(' ');
}

export default function EnnieTip({
  title,
  children,
  label = 'Why this matters',
  align = 'left',
}) {
  const [open, setOpen] = useState(false);
  const [contentH, setContentH] = useState(0);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const contentRef = useRef(null);
  const panelId = useId();

  // Keeps the bubble on screen on a phone. Shared with the share panel, whose
  // clipped QR is why this exists — a popover anchored to its trigger runs off
  // the edge, and this one would have done exactly the same thing.
  //
  // The correction lands on THIS wrapper, never on the bubble inside it: the
  // entrance animation also writes transform, and the two would overwrite each
  // other.
  const { ref: panelRef } = useViewportClamp(open);

  // Close on an outside click or Escape. Escape returns focus to the "?" so a
  // keyboard user isn't dropped at the top of the document.
  useEffect(() => {
    if (!open) return undefined;
    function onPointer(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // The cloud is drawn around the text, so it has to know how tall the text is.
  // ResizeObserver rather than a one-off measure because the Lottie swaps in
  // after its JSON loads, which can change the height a beat after open.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const el = contentRef.current;
    if (!el) return undefined;
    const measure = () => setContentH(el.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  // Floor it so the very first paint (before measurement) is still a cloud
  // rather than a collapsed line.
  const h = Math.max(contentH, 44);
  const panelH = PAD + TAIL_H + h + PAD;

  return (
    <span
      ref={wrapRef}
      style={{ position: 'relative', display: 'inline-flex', verticalAlign: 'middle' }}
    >
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={title ? `${label}: ${title}` : label}
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          padding: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'inherit',
          fontSize: 11,
          fontWeight: 700,
          lineHeight: 1,
          cursor: 'pointer',
          background: open ? BRIGHT : 'transparent',
          color: open ? '#fff' : BRIGHT,
          border: `1.5px solid ${BRIGHT}`,
          transition: 'background 120ms ease, color 120ms ease',
        }}
      >
        ?
      </button>

      {open && (
        <div
          ref={panelRef}
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            [align]: -PAD,
            zIndex: 60,
            width: PANEL_W,
            maxWidth: `calc(100vw - ${VIEWPORT_GUTTER * 2}px)`,
          }}
        >
          <div
            id={panelId}
            role="dialog"
            aria-label={title || label}
            className="ennie-tip-bubble"
            style={{ position: 'relative', height: panelH }}
          >
            <svg
              width={PANEL_W}
              height={panelH}
              viewBox={`0 0 ${PANEL_W} ${panelH}`}
              style={{ position: 'absolute', top: 0, left: 0 }}
              aria-hidden="true"
            >
              <path
                d={cloudPath(h)}
                fill={CLOUD_FILL}
                stroke={CLOUD_LINE}
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              {/* Two puffs rising toward the "?", biggest first. */}
              <circle
                className="ennie-tip-puff ennie-tip-puff-1"
                cx={PAD + 26}
                cy={PAD + 9}
                r="4"
                fill={CLOUD_FILL}
                stroke={CLOUD_LINE}
                strokeWidth="1.5"
              />
              <circle
                className="ennie-tip-puff ennie-tip-puff-2"
                cx={PAD + 15}
                cy={PAD + 2.5}
                r="2.5"
                fill={CLOUD_FILL}
                stroke={CLOUD_LINE}
                strokeWidth="1.5"
              />
            </svg>

            <div
              ref={contentRef}
              style={{
                position: 'absolute',
                left: PAD,
                top: PAD + TAIL_H,
                width: CONTENT_W,
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
                padding: '2px 4px 2px 0',
              }}
            >
              {/* HARD rule (feedback_ennie_no_frame): Ennie is never framed. */}
              <Ennie state="idle" size={38} framed={false} />
              <div style={{ flex: 1, minWidth: 0 }}>
                {title && (
                  <div
                    style={{
                      fontSize: 13.5,
                      fontWeight: 700,
                      color: PURPLE,
                      lineHeight: 1.35,
                      marginBottom: 3,
                    }}
                  >
                    {title}
                  </div>
                )}
                <div style={{ fontSize: 13, color: INK, lineHeight: 1.5 }}>{children}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
