// How often one family may be marketed to. ONE rule, ONE place.
//
// `organizations.email_throttle_days` has always existed (default 10) and the
// standing marketing rules call it "the central rule", but nothing enforced it:
// the send function wrote `suppressed_by_throttle: false` on every row. Measured
// on prod for 1 Jun - 13 Oct 2026, 469 of 1,479 emailed parents got three or more
// campaign emails inside a single 7-day window, 167 got four or more, and one got
// eight.
//
// The rule is a MINIMUM GAP between marketing emails to the same address, across
// every campaign for the org. Not a count per window: a gap is one number an
// operator can reason about, and a 3-day gap already caps a family at three a
// week.
//
// SLACK: a 3-day gap measured to the minute would drop a Tuesday-10:00 send that
// followed a Saturday-10:05 one, because the 5-minute cron fires each touchpoint
// a few minutes late and not by the same amount. The gap is shortened by a few
// hours so "every 3 days" means what an operator means by it.

export const DEFAULT_THROTTLE_DAYS = 3;
export const THROTTLE_SLACK_HOURS = 6;

/** The throttle's gap in DAYS, with the same fallback rule as throttleGapHours.
 *  The campaign drafter reads this too, so the number it tells the model and the
 *  number the send enforces cannot drift. */
export function throttleDays(days: unknown): number {
  const n = typeof days === "number" && Number.isFinite(days) ? Math.floor(days) : DEFAULT_THROTTLE_DAYS;
  return Math.max(0, n);
}

/** Deadline reminders are EXEMPT from the gap. The standing rule is that every
 *  deadline-driven campaign carries a 48-hour and a 24-hour reminder, one day
 *  apart, and the drafter plans exactly that. A 3-day gap would drop the 24-hour
 *  one for everybody who got the 48-hour one - the "last chance" email, lost for
 *  the families it exists for. They go only to a campaign's own audience, which
 *  already excludes anyone who has registered.
 *
 *  Matched on the drafter's label vocabulary (marketing-draft-campaign:
 *  48h-promo | 24h-promo | 48h-reg-close | 24h-reg-close | final-call). */
export function isDeadlineReminderLabel(label: unknown): boolean {
  return typeof label === "string" && /^(48h|24h)-|^final-call$/i.test(label.trim());
}

/** Hours a family must have gone without a marketing email. 0 = throttle off
 *  (an operator who sets the days to 0 has chosen that). An unreadable value
 *  falls back to the default rather than to "off": a missing setting must never
 *  turn the protection off. */
export function throttleGapHours(days: unknown): number {
  const n = throttleDays(days);
  if (n <= 0) return 0;
  return Math.max(1, n * 24 - THROTTLE_SLACK_HOURS);
}

/** Split recipients into those to send now and those held back. `held` holds
 *  lower-cased addresses; recipients are matched the same way. */
export function splitByThrottle<T extends { email: string }>(
  rows: T[],
  held: Set<string>,
): { send: T[]; hold: T[] } {
  const send: T[] = [];
  const hold: T[] = [];
  for (const r of rows) (held.has(r.email.trim().toLowerCase()) ? hold : send).push(r);
  return { send, hold };
}
