// Canonical builder for a tenant's public registration links.
// ONE source of truth so admin "Share" surfaces and marketing email templates
// never drift. Two link levels, both tenant-scoped by slug:
//   - program deep link → families land directly on one class
//   - catalog link      → families browse all open programs for the org
//
// Multi-tenant: takes the org slug as an argument; never hardcodes a tenant.
// `enrops.com` is the platform domain (every tenant lives at /<slug>), not a
// tenant identifier.

// The absolute public site. Used where the link is persisted for later (e.g.
// marketing emails sent from a cron) and must NOT inherit a staging origin.
export const PUBLIC_SITE = "https://enrops.com";

// Resolve the origin to build against. In-app surfaces default to the current
// origin so links are correct on whatever environment the operator is in
// (staging links on staging, prod links on prod). Pass an explicit origin to
// force one (marketing passes PUBLIC_SITE).
export function regOrigin(explicit) {
  if (explicit) return explicit.replace(/\/+$/, "");
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return PUBLIC_SITE;
}

// All open programs for the tenant (the public catalog / home).
export function buildCatalogUrl(slug, origin) {
  return `${regOrigin(origin)}/${slug}`;
}

// One specific program's registration. Without a programId, falls back to the
// registration page (which lists open programs). Used by marketing emails for
// the general "register" link.
export function buildRegUrl(slug, programId, origin) {
  const base = `${regOrigin(origin)}/${slug}/register`;
  return programId ? `${base}?program=${encodeURIComponent(programId)}` : base;
}

// SHARE target for one class: the public catalog page with the program
// pre-selected. The catalog auto-picks the class's school, scrolls to its card,
// and highlights it — so a family who scans/clicks lands on the class (name,
// schedule, price, Register button) with full context, not a bare form.
export function buildProgramShareUrl(slug, programId, origin) {
  const base = buildCatalogUrl(slug, origin);
  return programId ? `${base}?program=${encodeURIComponent(programId)}` : base;
}
