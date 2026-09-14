// WHO A FAMILY EMAILS WHEN THEY NEED HELP. One rule, one spelling.
//
// It is the PROVIDER, never the platform. That sounds obvious and it was wrong
// in production until 2026-09-14: the parent portal read its support address
// from the hardcoded TENANTS map in lib/tenants.js, which holds exactly one key
// (j2s), so getTenant() returned null for every other provider and Dashboard.jsx
// fell through to a literal 'jessica@enrops.com'. Every other provider's
// families were being told, in three places, to email the platform owner.
//
// It cost a real family a real morning. A Ukulele Project parent needed her
// daughter's room number the night before the first class, opened her portal,
// was told to email jessica@enrops.com, and did - apologising for not finding
// "the right email". The same thing happened on 2026-08-19 to another parent of
// the same provider and was investigated and left unexplained, because the
// investigation looked at the email reply-to cascade (which was correct) and
// never at the portal.
//
// THE CASCADE LIVES IN SQL, NOT HERE. public_org_directory.support_email is
// org_branding.email_reply_to, else organizations.email - the same order
// _shared/orgBrand.ts already uses to answer this question for outgoing email,
// so the address a family reads in the portal and the address they reach by
// hitting reply are the same inbox. Re-deriving that order in JavaScript is how
// two surfaces drift apart; this file only normalises what the view returns.
//
// NULL IS A REAL ANSWER AND MUST STAY ONE. A provider with neither address gets
// null, and callers must then drop the contact clause rather than substitute
// anything. There is deliberately no platform fallback here - that fallback IS
// the bug above. The sibling precedent is RegisterSuccess.jsx, which faced this
// exact gap and chose to print no address: "inventing one risks a bounce".
// Both states exist on staging today (demo-chess-center and ukulele-mirror
// resolve to null), so the empty branch is reachable, not theoretical.

/**
 * The provider's own support address, or null when they have not set one.
 *
 * Takes the whole org row (from PublicLayout's Outlet context) rather than a
 * string, so a caller cannot accidentally pass the platform's address in.
 *
 * @param {{ support_email?: string|null }|null|undefined} org
 * @returns {string|null}
 */
export function supportEmailOf(org) {
  const value = org?.support_email;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
