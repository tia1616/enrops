// The confirmation-page provider box, styled from the operator's OWN brand colour.
//
// WHY ONE FILE. The live page and the admin "What families will see" preview are two
// renderings of the same box, and they had already drifted: the page used the public
// CSS tokens (.brand-enrops-public -> Enrops purple, or :root -> J2S purple) while the
// preview used org_branding.primary_color. So an operator who saved a burgundy brand
// saw burgundy in the editor and their families got purple. A code review caught it.
// Both callers now import from here, so the only way to make them disagree again is to
// deliberately stop using this.
//
// Jessica, 2026-08-11, chose the box following the provider's colour rather than the
// shell's - the same source the confirmation EMAIL already uses (orgBrand.ts). It is
// the one block on that page that belongs to the provider, so it reads as an accent
// against the rest of the page, deliberately.

// Alpha suffixes on a 6-digit hex. Kept here rather than inline in either caller so
// "more noticeable" is tuned in one place.
const BG_ALPHA = "14";     // ~8%  — tint, still readable behind body text
const BORDER_ALPHA = "4D"; // ~30% — visible frame without competing with the button

/** True only for a plain 6-digit hex. Anything else (empty, rgb(), a nonsense value
 *  hand-written into the column) means fall back to the stylesheet, never concatenate
 *  alpha onto a string that isn't hex. */
export function isBrandHex(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || "").trim());
}

/** Inline style for the box, or null when there is no usable brand colour. */
export function confirmationBoxStyle(primaryColor) {
  if (!isBrandHex(primaryColor)) return null;
  const hex = String(primaryColor).trim();
  return { background: `${hex}${BG_ALPHA}`, borderColor: `${hex}${BORDER_ALPHA}` };
}

/** Inline style for the button, or null when there is no usable brand colour. */
export function confirmationButtonStyle(primaryColor) {
  if (!isBrandHex(primaryColor)) return null;
  return { backgroundColor: String(primaryColor).trim() };
}
