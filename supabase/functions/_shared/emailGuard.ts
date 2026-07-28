// emailGuard — staging-only recipient allowlist.
//
// Staging sends from a verified domain (so email flows are testable), but we
// don't want a manual invite — or any feature — delivering to synthetic or real
// families, or hurting the prod domain's sender reputation with bounces. The
// STAGING_EMAIL_ALLOWLIST secret, set on STAGING ONLY, restricts who actually
// receives: comma-separated exact emails (jess@x.com) and/or @domain suffixes
// (@journeytosteam.com). When unset (prod), the guard is off and everyone is
// allowed. Functions that send email should filter recipients through this.

const RAW = Deno.env.get('STAGING_EMAIL_ALLOWLIST') ?? '';
const ALLOW = RAW.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/** True when an allowlist is configured (i.e. we're on a guarded/staging env). */
export function emailGuardActive(): boolean {
  return ALLOW.length > 0;
}

/**
 * Strip a plus-tag from the local part: tia1616+onboard@gmail.com -> tia1616@gmail.com.
 *
 * Gmail (and every other provider that supports the convention) delivers
 * BOTH to the same inbox, so an allowlist entry for the base address already
 * grants access to every tag. Comparing the raw strings did not know that, and
 * the effect was silent: staging test inboxes are written as
 * tia1616+<tag>@gmail.com by convention, the allowlist holds the untagged
 * tia1616@gmail.com, and so every test email was dropped while the code looked
 * correct. Found 2026-07-28 when a refund receipt never arrived.
 */
function stripPlusTag(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const plus = local.indexOf('+');
  return plus > 0 ? local.slice(0, plus) + domain : email;
}

/**
 * Whether this address may actually be sent to. No allowlist (prod) → always true.
 *
 * Plus-tags are normalised before comparison. That WIDENS the guard, so it is
 * worth being explicit about why it is still safe: a tagged address can only
 * match when its BASE address is already on the allowlist, and mail to
 * base+anything@ is delivered to the owner of base@. So this can never reach
 * anyone the allowlist did not already permit - it just stops silently
 * dropping mail to an inbox we deliberately allowed.
 */
export function isEmailAllowed(email: string): boolean {
  if (ALLOW.length === 0) return true;
  const e = (email ?? '').trim().toLowerCase();
  if (!e) return false;
  const bare = stripPlusTag(e);
  return ALLOW.some((a) => (a.startsWith('@') ? e.endsWith(a) : e === a || bare === a));
}
