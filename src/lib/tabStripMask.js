// The fade logic for TabStrip (src/components/TabStrip.jsx), kept as a plain
// module so it can be tested. The component itself is JSX and the test runner is
// node, which cannot parse it - and a fade on the WRONG side is exactly the kind
// of defect that builds clean, type-checks clean and is invisible until someone
// looks at a phone.
//
// Read it as: fade the side that has something hidden behind it, and only that
// side. A strip scrolled to the middle fades both ends; a strip that fits fades
// neither, and returns null so the component can skip the mask entirely.

// Width of the fade. Wide enough to read as a fade rather than a clipped edge.
export const FADE_PX = 24;

export function maskFor(atStart, atEnd) {
  if (atStart && atEnd) return null;
  const from = atStart ? "#000 0" : `transparent 0, #000 ${FADE_PX}px`;
  const to = atEnd ? "#000 100%" : `#000 calc(100% - ${FADE_PX}px), transparent 100%`;
  return `linear-gradient(to right, ${from}, ${to})`;
}

// Where a scroller currently sits. Split out with the maths visible because the
// 1px of slack is load-bearing: sub-pixel layout means scrollLeft rarely lands
// exactly on 0 or exactly on max, and without the slack the fade flickers on and
// off at both ends of every scroll.
export function edgesOf({ scrollLeft, scrollWidth, clientWidth }) {
  const max = scrollWidth - clientWidth;
  return {
    atStart: scrollLeft <= 1,
    atEnd: scrollLeft >= max - 1,
  };
}
