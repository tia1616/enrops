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
  //
  // WHAT IT MUST NOT DO is fight the operator. The layout effect below runs on
  // every parent render, and AdminLayout re-renders for reasons that have
  // nothing to do with navigation - so an unconditional reveal threw away a
  // scroll made by hand: measured on staging, scrolling the Programs strip to
  // 151 to read "Offerings" and then tapping Menu (which only toggles navOpen)
  // snapped it straight back to 0.
  //
  // But "reveal once per active tab" is NOT the fix, and the first attempt at
  // this shipped that and broke the feature: the first reveal happens against a
  // layout that has not settled (the fallback font is still in), so landing on
  // Offerings scrolled to 108 instead of 151 and, having already fired, never
  // corrected. So both things have to be tracked separately - which tab we are
  // revealing, and whether the OPERATOR has since moved the strip themselves.
  // A layout change re-reveals; a human scroll is left alone until the active
  // tab changes again.
  const lastActive = useRef(null);
  const userScrolled = useRef(false);
  // Set immediately before we move the strip ourselves, so the scroll event it
  // fires is not mistaken for the operator scrolling.
  const programmatic = useRef(false);

  const revealActive = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const tab = el.querySelector('[data-tab-active="true"]');
    if (!tab) return;
    if (tab !== lastActive.current) {
      // A new tab is active - navigation. Start listening for a human scroll
      // again; whatever they did on the previous page no longer applies.
      lastActive.current = tab;
      userScrolled.current = false;
    } else if (userScrolled.current) {
      return;
    }
    const box = el.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    let target = el.scrollLeft;
    if (t.left < box.left) target -= box.left - t.left + SCROLL_MARGIN;
    else if (t.right > box.right) target += t.right - box.right + SCROLL_MARGIN;
    const clamped = Math.max(0, Math.min(target, el.scrollWidth - el.clientWidth));
    // Only flag, and only write, if this actually moves. A no-op write fires no
    // scroll event, which would leave the flag set and make us misread the
    // operator's very next scroll as our own.
    if (clamped !== el.scrollLeft) {
      programmatic.current = true;
      el.scrollLeft = clamped;
    }
  }, []);

  const onScroll = useCallback(() => {
    if (programmatic.current) programmatic.current = false;
    else userScrolled.current = true;
    measure();
  }, [measure]);

  // Before paint, so the first frame already shows the right fade and the right
  // scroll position rather than jumping a frame later.
  useLayoutEffect(() => {
    revealActive();
    measure();
  }, [children, revealActive, measure]);

  // Re-measure when the WIDTH OF THE CONTENT changes, which is a different
  // question from the width of the box. This matches the pattern in
  // src/pages/portal/Home.jsx, which a /code-review found the same gap in on
  // 2026-08-17; the reasoning there applies here unchanged, so it is copied
  // rather than reinvented.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    // fonts.ready can settle after unmount; without this we setState on a dead
    // component.
    let alive = true;
    // Re-reveal as well as re-measure. The layout the first reveal ran against
    // may have been the fallback font's, so the active tab can be half off the
    // edge until this corrects it - revealActive declines if the operator has
    // scrolled since, so correcting cannot become fighting them.
    const remeasure = () => {
      if (!alive) return;
      revealActive();
      measure();
    };

    // Observe the CHILDREN as well as the box. The scroller's own border box is
    // set by its parent and never changes when the tabs inside it get wider, so
    // an observer on `el` alone misses every content-width change. Proven on
    // the deployed build: shrinking the Comms tabs until they fitted (scrollWidth
    // 499 -> 283) left the fade still drawn, because nothing re-measured.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(remeasure) : null;
    if (ro) {
      ro.observe(el);
      for (const child of el.children) ro.observe(child);
    }

    // BOTH, not either/or - see Home.jsx: ResizeObserver is delivered on the
    // rendering lifecycle, so a document that is not compositing gets no
    // callbacks at all, not even the initial one observe() is supposed to
    // guarantee.
    window.addEventListener("resize", remeasure);

    // THE FONT SWAP, which is the one that actually bites here. Poppins arrives
    // with display=swap, so the fallback face paints first. Its metrics are
    // narrower, so a strip can MEASURE AS FITTING on the first paint, get no
    // fade, and then overflow the moment Poppins lands - leaving exactly the
    // invisible-tab defect this component exists to prevent, on a cold cache,
    // which is every operator's first load.
    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready.then(remeasure).catch(() => {});
    }

    return () => {
      alive = false;
      ro?.disconnect();
      window.removeEventListener("resize", remeasure);
    };
  }, [children, measure, revealActive]);

  const mask = maskFor(edges.atStart, edges.atEnd);

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      className="tab-strip-scroller"
      role={role}
      aria-label={label}
      style={{
        display: "flex",
        overflowX: "auto",
        // Setting overflow-x alone is not enough: per spec a computed `visible`
        // beside a non-visible value resolves to `auto`, so overflow-y becomes
        // auto too. Measured on the deployed build, the strip then had 1px of
        // real vertical overflow (clientHeight 38, scrollHeight 39) because
        // AdminLayout's tabs carry position:relative + top:1, which contributes
        // to scrollable overflow without changing layout size. That made the
        // tab row a vertically scrollable box lying across the top of the page,
        // so a swipe beginning on it scrolled the strip 1px before chaining -
        // a stutter with no visible cause, the scrollbar being hidden.
        overflowY: "hidden",
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
