// The admin shell's phone breakpoint, in ONE place.
//
// AdminLayout already switches the whole operator shell to its phone layout
// under 900px - sidebar becomes a menu button, content goes full width, form
// fields go to 16px. Any page that needs to know the same thing in JavaScript
// (because a media query cannot express it - picking WHICH day of a week grid
// to show, say) has to agree with that number, or the shell and the page
// disagree about what a phone is at some width in between.
//
// So the number lives here and both read it: AdminLayout interpolates it into
// its media query, pages call useAdminNarrow().

import { useEffect, useState } from "react";

export const ADMIN_MOBILE_MAX = 900;

const QUERY = `(max-width: ${ADMIN_MOBILE_MAX}px)`;

// True when the operator shell is in its phone layout.
//
// matchMedia rather than innerWidth + a resize listener: it fires on exactly
// the transition we care about instead of on every pixel of a drag, and it is
// the same API PwaInstallButton already uses to ask about the device.
export function useAdminNarrow() {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(QUERY).matches === true
  );

  useEffect(() => {
    const mq = window.matchMedia?.(QUERY);
    if (!mq) return undefined;
    // Always read mq.matches rather than trusting an event's payload, so both
    // signals below agree on one source of truth.
    const sync = () => setNarrow(mq.matches);
    // Re-read on mount: between the useState initialiser and this effect the
    // window can have been resized, and on a miss the page would render its
    // desktop shape inside the phone shell.
    sync();
    mq.addEventListener("change", sync);
    // BOTH, not either/or - the same lesson src/pages/portal/Home.jsx records
    // about ResizeObserver, and it cost a round here too. MEASURED 2026-09-17:
    // the viewport went to 1280 and mq.matches correctly went false, but no
    // change event was ever delivered, so the schedule stayed in its phone
    // layout on a desktop-width window. A resize listener costs one boolean
    // comparison and covers whatever swallowed the event.
    window.addEventListener("resize", sync);
    return () => {
      mq.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, []);

  return narrow;
}
