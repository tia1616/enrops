// abandonedResumeUrl.ts — where "Finish registering →" actually sends a family.
//
// Extracted so it has a test instead of a hope, the same way abandonedSuppression
// is. It shipped wrong and stayed wrong for three months precisely because an
// inline template string in the middle of a 2000-line resolver is not something
// anyone re-reads.
//
// WHAT WAS WRONG. The link was `/register?resume_reg=<registration id>`. Nothing
// reads `resume_reg` — the resume route the old comment promised was never built —
// and Register.jsx bounces any visit without `?program=` back to the catalog,
// deliberately, because browser-back from Stripe strips the query string. So the
// one email whose entire job is recovering an abandoned checkout dropped the
// family at the top of the class list with nothing filled in. 36 went out that
// way between 2026-06-07 and 2026-09-01.
//
// WHY NOT ACTUALLY RESUME. Rehydrating the attempt means restoring a child's
// name, birth date, allergies and emergency contacts, so a bare row id in an
// email link would hand that to whoever holds the URL. The waitlist flow mints
// waitlist_invite_token rather than passing its row id, for exactly this reason.
// Real resume is a token feature; this is not it.

export interface AbandonedRow {
  programs?: { id?: unknown } | null;
  camp_sessions?: { id?: unknown } | null;
}

/**
 * PROGRAMS get the deep link — the same URL the catalog's own register button
 * builds (Home.jsx startRegistration) — so the family lands on the right class.
 *
 * CAMPS get the catalog. Register.jsx has no camp branch at all, so
 * `?program=<camp session id>` would ask the wizard to load a program that does
 * not exist. Anything without a usable program id lands here too: a bare catalog
 * page is a worse link than a deep one and a far better one than a broken one.
 */
export function abandonedResumeUrl(
  siteUrl: string,
  orgSlug: string,
  row: AbandonedRow | null | undefined,
): string {
  const base = `${siteUrl}/${orgSlug}`;
  const programId = row?.programs?.id;
  // Guard the SHAPE, not just presence: PostgREST hands back whatever the row
  // holds, and a non-string id interpolated into a URL yields "[object Object]"
  // or "undefined" as a query value - a link that looks fine and resolves to a
  // class that does not exist.
  if (typeof programId === 'string' && programId.length > 0) {
    return `${base}/register?program=${encodeURIComponent(programId)}`;
  }
  return base;
}
