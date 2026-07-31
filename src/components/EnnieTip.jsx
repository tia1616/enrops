// EnnieTip — the platform's one coaching affordance.
//
// A small "?" beside the thing it explains. Clicking it opens a dialogue bubble
// with a cloud outline, Ennie inside, explaining that one thing in her voice.
//
// The rules this is built to (Jessica, 2026-07-31):
//   - ONE primitive. The "?" IS the Ennie bubble.
//   - It never opens on its own. Anything that interrupts a task gets dismissed,
//     and then the explanation is gone for good. This waits to be asked.
//   - It never blocks the action it sits beside.
//   - One idea per tip, short. More than a short paragraph is documentation.
//   - The TITLE is the question and is the only bold text. The explanation is not
//     bold - which has to be set explicitly, because these tips live inside
//     headings (Discounts card titles are font-weight 700) and body text would
//     otherwise INHERIT the bold. That is exactly what happened on first build.
//
// Placement (Jessica, review pass):
//   - Opens ABOVE the "?" by default, because that is where people expect a
//     bubble to appear relative to what they clicked. Falls back to below only
//     when there is genuinely no room above, and drops the tail in that case
//     rather than drawing one that points at nothing.
//   - Roughly twice the old width.
//   - Real breathing room between the last line of text and the outline.
//
// Usage:
//   <EnnieTip title="Why do families see the fee?">Because…</EnnieTip>

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import Ennie from './Ennie.jsx';
import useViewportClamp, { VIEWPORT_GUTTER } from '../lib/useViewportClamp';

const PURPLE = '#1C004F';
const BRIGHT = '#5847C9';
const INK = '#1a1a1a';
const CLOUD_FILL = '#ffffff';
const CLOUD_LINE = '#CECBF6';

const CONTENT_W = 500;   // ~2x the first build, per review
const PAD = 11;          // room for the scallops to bulge into
const MAX_STEP = 22;     // widest a single scallop may be
const BOTTOM_ROOM = 16;  // space under the last line before the outline
const TAIL_W = 22;
const TAIL_DEPTH = 12;
const TAIL_CX = PAD + 26; // sits under the "?", which the panel is aligned to
const PANEL_W = CONTENT_W + PAD * 2;

// A run of outward semicircular arcs along one edge. Radius is half the step and
// is also how far it bulges, so capping the step at MAX_STEP is what guarantees
// the scallops stay inside PAD and never clip.
function scallops(distance, dx, dy) {
  if (distance <= 0) return '';
  const n = Math.max(1, Math.ceil(distance / MAX_STEP));
  const step = distance / n;
  const r = (step / 2).toFixed(2);
  const sx = (dx ? Math.sign(dx) * step : 0).toFixed(2);
  const sy = (dy ? Math.sign(dy) * step : 0).toFixed(2);
  return Array.from({ length: n }, () => `a ${r} ${r} 0 0 1 ${sx} ${sy}`).join(' ');
}

// Cloud outline around a CONTENT_W x h box, walked clockwise so every arc takes
// sweep-flag 1. When `tail` is true the bottom edge is interrupted by a downward
// point, which is what turns a thought-cloud into a dialogue bubble.
function cloudPath(h, tail) {
  const top = PAD;
  const bottom = PAD + h;
  const right = PAD + CONTENT_W;

  const tailRight = TAIL_CX + TAIL_W / 2;
  const tailLeft = TAIL_CX - TAIL_W / 2;

  const bottomEdge = tail
    ? [
        scallops(right - tailRight, -1, 0),
        `L ${TAIL_CX} ${bottom + TAIL_DEPTH}`,
        `L ${tailLeft} ${bottom}`,
        scallops(tailLeft - PAD, -1, 0),
      ].join(' ')
    : scallops(CONTENT_W, -1, 0);

  return [
    `M ${PAD} ${top}`,
    scallops(CONTENT_W, 1, 0),
    scallops(h, 0, 1),
    bottomEdge,
    scallops(h, 0, -1),
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
  const [placement, setPlacement] = useState('above');
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const contentRef = useRef(null);
  const panelId = useId();

  // Keeps the bubble on screen horizontally. Shared with the share panel, whose
  // clipped QR is why it exists. The correction lands on THIS wrapper, never on
  // the bubble inside it: the entrance animation also writes transform.
  const { ref: panelRef } = useViewportClamp(open);

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

  // Measure the text so the cloud can be drawn around it, and decide which side
  // of the "?" the bubble goes on. ResizeObserver because Ennie's Lottie swaps in
  // after its JSON loads, which can change the height a beat after opening.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const el = contentRef.current;
    if (!el) return undefined;
    const measure = () => {
      const h = el.getBoundingClientRect().height + BOTTOM_ROOM;
      setContentH(h);
      // Above unless it genuinely will not fit, in which case below - with no
      // tail, rather than a tail pointing at nothing.
      const btn = btnRef.current?.getBoundingClientRect();
      if (btn) {
        const needed = PAD + h + PAD + TAIL_DEPTH + 8;
        setPlacement(btn.top >= needed ? 'above' : 'below');
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  const h = Math.max(contentH, 52);
  const showTail = placement === 'above';
  const panelH = PAD + h + Math.max(PAD, showTail ? TAIL_DEPTH : PAD);

  return (
    <span
      ref={wrapRef}
      style={{
        position: 'relative',
        display: 'inline-flex',
        // Sits ON the text baseline with a little air before it, rather than
        // floating mid-line and crowding the word it follows.
        verticalAlign: 'middle',
        marginLeft: 5,
        lineHeight: 1,
      }}
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
            ...(placement === 'above'
              ? { bottom: 'calc(100% + 4px)' }
              : { top: 'calc(100% + 4px)' }),
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
            style={{
              position: 'relative',
              height: panelH,
              transformOrigin: placement === 'above' ? `${TAIL_CX}px 100%` : `${TAIL_CX}px 0`,
            }}
          >
            <svg
              width="100%"
              height={panelH}
              viewBox={`0 0 ${PANEL_W} ${panelH}`}
              preserveAspectRatio="none"
              style={{ position: 'absolute', top: 0, left: 0 }}
              aria-hidden="true"
            >
              <path
                d={cloudPath(h, showTail)}
                fill={CLOUD_FILL}
                stroke={CLOUD_LINE}
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>

            <div
              ref={contentRef}
              style={{
                position: 'absolute',
                left: PAD + 4,
                top: PAD,
                width: CONTENT_W - 8,
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
              }}
            >
              {/* HARD rule (feedback_ennie_no_frame): Ennie is never framed. */}
              <Ennie state="idle" size={40} framed={false} />
              <div style={{ flex: 1, minWidth: 0 }}>
                {title && (
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      color: PURPLE,
                      lineHeight: 1.35,
                      marginBottom: 4,
                    }}
                  >
                    {title}
                  </div>
                )}
                {/* fontWeight 400 EXPLICITLY: these tips sit inside headings that
                    are font-weight 700, and without this the explanation inherits
                    the bold and the whole bubble reads as shouting. */}
                <div style={{ fontSize: 13.5, fontWeight: 400, color: INK, lineHeight: 1.55 }}>
                  {children}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
