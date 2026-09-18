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

// THE PHONE CARD, in one place because two screens now use it.
//
// A wide admin table cannot be read on a phone: the after-school staffing list
// was 636px of table in 346px with three columns off the right edge, and Comms
// Contacts was 908px in 247px. The standard fix, and the one every tool our
// operators already use makes, is that below the breakpoint the ROW stops being
// a row and becomes a card - each field on its own full-width line.
//
// Mechanically that means setting display:block on the table, tbody, tr and td,
// which is what these three objects do. They are here rather than copied into
// each screen so a third table cannot invent a fourth spelling of the same
// card - and so the padding and the rule colour only have to be corrected once.
//
// Colours are the literal tokens rather than an import: RULE and MUTED are
// declared separately in AfterschoolSchedule.jsx and in marketing/tokens.jsx and
// are the same values in both (checked), so taking either as the source would
// make this module depend on one screen's copy of a shared constant.
const RULE = "#e2dfd5";
const MUTED = "#6b6b6b";

// The <tr>. Margins apply because it is display:block - on a real table row
// they would be ignored.
export const cardRow = {
  display: "block",
  border: `1px solid ${RULE}`,
  borderRadius: 10,
  padding: "12px 14px",
  margin: "10px 14px",
};

// The <td>. No cell border (the card's own border is the boundary now) and no
// side padding (the card supplies it once, for every line).
export const cardCell = {
  display: "block",
  padding: "2px 0",
  borderBottom: "none",
  whiteSpace: "normal",
};

// For a field that stops making sense once its column header is gone - a bare
// name, or "12 / 20". Not for fields that say what they are on their own.
export const cardLabel = { color: MUTED };

// THE PAGE WRAPPER'S OWN PADDING, which is a desktop number on every screen.
//
// The Comms pages each open with padding "24px 32px". On a desktop that is
// breathing room. On a 375px phone it is a QUARTER OF THE SCREEN: measured on
// Contacts, main gives 14px a side, this wrapper adds 32 more, an inner box
// adds 16, and 375px of phone became 247px of usable width before a single
// contact was drawn.
//
// The shell already owns the side gutter on a phone (AdminLayout's mobile block
// sets main to 16px 14px), so the page must not add a second one. Vertical
// padding is kept - that is spacing between things, not a gutter.
export function pagePad(narrow) {
  return narrow ? "16px 0" : "24px 32px";
}

// A CONTROL BIG ENOUGH TO HIT WITH A THUMB.
//
// 44px is the comfortable minimum, and it is the floor the shell's own menu
// button already uses. Admin controls are sized for a mouse: measured on
// Offerings at 375px, one card carried "Upload doc" at 34px, "Edit details" at
// 36px, and a DELETE at 28px - a destructive action two-thirds of safe size,
// sitting between two links, to be hit with a thumb.
//
// Spread this AFTER the control's own style so it wins on padding, and let the
// desktop styling through untouched when narrow is false.
export function tapTarget(narrow) {
  if (!narrow) return null;
  return {
    minHeight: 44,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 10,
    paddingBottom: 10,
  };
}
