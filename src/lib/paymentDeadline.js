// The family's card deadline after a final payment notice, for the browser.
//
// The charger (supabase/functions/_shared/declineRetry.ts) emails the family
// "put a new card on by <payBy>" and books the business's follow-up email for
// the morning AFTER that deadline, in installments.provider_followup_on. The
// row stores only the follow-up day, so the portal derives the family's
// deadline from it: one day earlier. The browser cannot import the Deno
// module, so this is a twin, and
// supabase/functions/_shared/tests/paymentDeadlineTwinParity.test.ts runs the
// charger's own plan through this file to prove the two still agree. If that
// test fails, make them agree - never loosen it.
//
// Plain ESM with no imports, so Deno can load it directly.

/**
 * Registration states whose payment plan is over: the business removed the
 * family, or refunded them. The charger never charges these
 * (NOT_CHARGEABLE_REGISTRATION_STATUSES in declineRetry.ts - the twin test pins
 * the two lists together), so the portal must never ask such a family for a
 * card either. refund-registration leaves an already-paused row paused when it
 * removes a family, which is why this cannot be read off the row's own status.
 */
export const NOT_CHARGEABLE_REGISTRATION_STATUSES = ['cancelled', 'refunded'];

/** Days between the family's deadline and the business's follow-up email. */
export const DEADLINE_DAYS_BEFORE_FOLLOWUP = 1;

/** 'YYYY-MM-DD' follow-up day -> 'YYYY-MM-DD' family deadline, in UTC. */
export function payByFromFollowUp(followUpIso) {
  if (!followUpIso || !/^\d{4}-\d{2}-\d{2}$/.test(followUpIso)) return null;
  const d = new Date(`${followUpIso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - DEADLINE_DAYS_BEFORE_FOLLOWUP);
  return d.toISOString().slice(0, 10);
}

/**
 * The family's deadline across their stalled payments, or null when none has
 * one. The EARLIEST wins: if two plans are on a final notice, the sooner date
 * is the one that can cost them a spot first.
 */
export function earliestPayBy(rows) {
  const dates = (rows ?? [])
    .map((r) => payByFromFollowUp(r?.provider_followup_on))
    .filter(Boolean)
    .sort();
  return dates[0] ?? null;
}

/** "Sunday, October 18" for a 'YYYY-MM-DD' date, read as a calendar date -
 *  the same wording the charger's emails use. */
export function formatDeadline(isoDate) {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}
