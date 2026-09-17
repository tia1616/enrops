// TabStrip - the scrolling container every admin tab row sits in.
//
// WHY THIS EXISTS. Both admin tab rows (the shell's section strip in
// AdminLayout, and Comms' own strip in FamilyCommsTabs) were plain flex rows.
// On a 375px phone they are wider than the screen, so the last one or two tabs
// sat off the right edge with NOTHING to say they were there. Measured on
// staging at 375px: the Programs strip on a tenant with five section tabs was
// 369px of tabs in a 347px box ("Locations" invisible), and Comms was 314px in
// a 283px box ("Templates" invisible) - so opening Templates lit a tab the
// operator could not see. A tab you cannot see is a page you cannot reach,
// which is why this is the first mobile fix rather than a cosmetic one.
//
// Three things make an overflowing strip usable, and they are what every tool
// our operators already use does (Stripe, Mailchimp, Material's scrollable
// tabs):
//   1. It scrolls sideways on its own instead of stretching the page.
//   2. A fade at whichever edge has more behind it - the "there is more this
//      way" cue. Done with mask-image, NOT a gradient overlay, so it needs no
//      knowledge of the page background and cannot go stale when a background
//      colour changes.
//   3. The ACTIVE tab is scrolled into view, so landing on a page whose own tab
//      is off-screen still shows you where you are.
//
// The caller keeps ownership of the tabs themselves - their links, gating and
// styling all differ between the two strips. This component owns only the box
// they scroll in. Mark the current tab with data-tab-active="true" and it will
// be scrolled into view.
//
// No media query: the fade and the scroll appear only when the content actually
// overflows, so a desktop strip that fits is untouched by this.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { maskFor, edgesOf } from "../lib/tabStripMask.js";

// How much breathing room to leave beside a tab we scroll into view, so the
// active tab never ends up flush against the fade and looking half-cut.
const SCROLL_MARGIN = 16;

// `role`/`label` are passed straight through rather than hardcoded to
// "tablist". Only the Comms strip gives its children role="tab", and a tablist
// whose children are not tabs is invalid ARIA - worse for a screen reader than
// the plain links AdminLayout's strip has always been.
export default function TabStrip({ children, role, label, style }) {
  const scrollerRef = useRef(null);
  // Start as "fits" so the very first paint has no fade. If it turns out to
  // overflow, the layout effect below corrects it before the browser paints.
  const [edges, setEdges] = useState({ atStart: true, atEnd: true });

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = edgesOf(el);
    // Return the SAME object when nothing changed. This fires on every scroll
    // frame, and setState with a fresh object is never equal by Object.is - so
    // without this guard, dragging the strip re-rendered the component about
    // sixty times a second to arrive at the identical mask.
    setEdges((prev) =>
      prev.atStart === next.atStart && prev.atEnd === next.atEnd ? prev : next
    );
  }, []);

  // Bring the active tab into view. Deliberately NOT scrollIntoView(): that
  // walks up and scrolls ancestors too, which on these pages yanks the whole
  // page vertically on every route change. Rect maths touches scrollLeft only.
  const revealActive = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const tab = el.querySelector('[data-tab-active="true"]');
    if (!tab) return;
    const box = el.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    if (t.left < box.left) {
      el.scrollLeft -= box.left - t.left + SCROLL_MARGIN;
    } else if (t.right > box.right) {
      el.scrollLeft += t.right - box.right + SCROLL_MARGIN;
    }
  }, []);

  // Before paint, so the first frame already shows the right fade and the right
  // scroll position rather than jumping a frame later.
  useLayoutEffect(() => {
    revealActive();
    measure();
  }, [children, revealActive, measure]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    // ResizeObserver rather than a window resize listener: the strip also
    // changes width when the sidebar opens or a tab is gated in or out, and
    // neither of those resizes the window.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [measure]);

  const mask = maskFor(edges.atStart, edges.atEnd);

  return (
    <div
      ref={scrollerRef}
      onScroll={measure}
      className="tab-strip-scroller"
      role={role}
      aria-label={label}
      style={{
        display: "flex",
        overflowX: "auto",
        // Tabs must keep their natural width - letting them squash is how you
        // get five tabs all reading "Class..." instead of one honest scroll.
        flexWrap: "nowrap",
        WebkitOverflowScrolling: "touch",
        ...(mask ? { maskImage: mask, WebkitMaskImage: mask } : null),
        ...style,
      }}
    >
      {children}
    </div>
  );
}
