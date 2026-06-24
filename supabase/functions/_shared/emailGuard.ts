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

/** Whether this address may actually be sent to. No allowlist (prod) → always true. */
export function isEmailAllowed(email: string): boolean {
  if (ALLOW.length === 0) return true;
  const e = (email ?? '').trim().toLowerCase();
  if (!e) return false;
  return ALLOW.some((a) => (a.startsWith('@') ? e.endsWith(a) : e === a));
}
