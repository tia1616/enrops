// Review ask rules (J2S Reviews Playbook section 4, built for every provider).
// Pure functions only, so each rule is pinned by reviewAsk.test.ts; index.ts
// does the reads and the sends.
//
// THE RULES, in one place:
//   - WHEN: N days after the class or camp's LAST session date (the last element
//     of derive_program_session_dates), at 6 pm org-local. N = 0 is the evening
//     of the last session. A missed evening is caught for up to GRACE_DAYS more.
//   - WHO: every registration in the program that was ever really enrolled.
//     Confirmed = the standard copy. Withdrawn or refunded = the withdrawn copy.
//     A registration that never enrolled (unfinished, waitlist, cancelled before
//     paying) is not a family that tried the program and is never asked.
//   - NEVER FILTERED BY score, complaint or refund. Nothing here reads a score,
//     a note or a refund amount; refunded only ever CHANGES THE WORDING. That is
//     Google's rule (ask everyone the same way), so do not add a filter here.
//   - ONE ASK PER FAMILY PER TERM, plus one reminder. Enforced by the send
//     ledger's UNIQUE(automation_id, context_key): the keys below carry the term
//     and the family address, never the program, so a second class ending later
//     in the same term collides and is skipped.
//   - SKIPPED: staff / instructor / owner households (review_ask_excluded_emails)
//     and marketing opt-outs. Both are applied by the caller and fail closed.

export const EVENING_HOUR = 18;
export const REVIEW_GRACE_DAYS = 3;

/** YYYY-MM-DD + n days, timezone-free (the date is already org-local). */
export function plusDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Is an evening send for `target` due right now?
 * Due from 6 pm org-local on the target day, and for `graceDays` whole days
 * after it (a missed sweep is caught by the next morning's daily run). Never
 * before 6 pm on the day itself: the daily 7 am run must not send the evening
 * email at breakfast.
 */
export function eveningDue(target: string, today: string, hour: number, graceDays = REVIEW_GRACE_DAYS): boolean {
  if (target === today) return hour >= EVENING_HOUR;
  if (target > today) return false;
  return target >= plusDays(today, -graceDays);
}

export type ReviewVariant = "standard" | "withdrawn";

/**
 * Which copy a registration gets, or null if it is not asked at all.
 * payment_status semantics (project memory, verified live): 'refunded' = fully
 * refunded, 'partial' = PARTIALLY REFUNDED, 'paid' = paid, 'unpaid' = nothing
 * collected yet (installments and pay-later are 'confirmed' + 'unpaid').
 */
export function reviewVariantFor(status: string | null | undefined, paymentStatus: string | null | undefined): ReviewVariant | null {
  const s = (status ?? "").toLowerCase();
  const p = (paymentStatus ?? "").toLowerCase();
  if (s === "confirmed") return p === "refunded" ? "withdrawn" : "standard";
  // The CHECK also allows status 'refunded' (0 rows on prod 2026-11-23, but
  // legal): a refunded family is asked, with the withdrawn wording.
  if (s === "refunded") return "withdrawn";
  // Withdrawn after money changed hands. cancelled + unpaid is an abandoned
  // checkout or a cancel before paying: they never attended.
  if (s === "cancelled") return (p === "paid" || p === "partial" || p === "refunded") ? "withdrawn" : null;
  return null; // pending (unfinished registration), waitlist, anything new
}

export function familyKey(email: string): string {
  return email.trim().toLowerCase();
}

export function reviewAskContextKey(term: string, email: string): string {
  return `review_ask:${term}:${familyKey(email)}`;
}
export function reviewReminderContextKey(term: string, email: string): string {
  return `review_reminder:${term}:${familyKey(email)}`;
}

export interface ReviewCandidateRow {
  registration_id: string;
  program_id: string;
  program_name: string;
  term: string;
  status: string;
  payment_status: string | null;
  parent_id: string;
  parent_email: string;
  parent_first_name: string | null;
  child_first_name: string | null;
  target_date: string;
}

export interface ReviewFamily {
  email: string;               // as stored on the parent (first one wins)
  key: string;                 // familyKey(email)
  term: string;
  parent_id: string;
  parent_first_name: string | null;
  child_first_names: string[]; // every child in the asked program(s), in row order
  program_id: string;          // the program the ask is about (first due one)
  program_name: string;
  variant: ReviewVariant;      // standard if ANY covered registration is standard
  registrations: { registration_id: string; program_id: string; variant: ReviewVariant }[];
}

/**
 * Collapse due registrations into one ask per (term, family). The ask is about
 * ONE program (the first due row's); its registrations are every due row for
 * that family in that SAME program, so siblings in one class share one email
 * and both get the click. A second program ending the same evening is not
 * folded in: its program name would be wrong in the copy, and the ledger key is
 * per term anyway, so it is simply not asked.
 * A family with one active and one withdrawn child gets the standard copy.
 */
export function groupReviewFamilies(
  rows: readonly ReviewCandidateRow[],
  skip: (emailKey: string) => boolean,
): ReviewFamily[] {
  const out = new Map<string, ReviewFamily>();
  for (const r of rows) {
    const variant = reviewVariantFor(r.status, r.payment_status);
    if (!variant) continue;
    if (!r.parent_email || !r.parent_email.includes("@")) continue;
    const key = familyKey(r.parent_email);
    if (skip(key)) continue;
    const mapKey = `${r.term}|${key}`;
    let fam = out.get(mapKey);
    if (!fam) {
      fam = {
        email: r.parent_email.trim(),
        key,
        term: r.term,
        parent_id: r.parent_id,
        parent_first_name: r.parent_first_name,
        child_first_names: [],
        program_id: r.program_id,
        program_name: r.program_name,
        variant,
        registrations: [],
      };
      out.set(mapKey, fam);
    }
    if (r.program_id !== fam.program_id) continue;
    if (fam.registrations.some((x) => x.registration_id === r.registration_id)) continue;
    fam.registrations.push({ registration_id: r.registration_id, program_id: r.program_id, variant });
    if (r.child_first_name && !fam.child_first_names.includes(r.child_first_name)) fam.child_first_names.push(r.child_first_name);
    if (variant === "standard") fam.variant = "standard";
  }
  return [...out.values()];
}

/** "Following up: " on the reminder subject, never doubled. */
export function reminderSubject(subject: string): string {
  const s = subject.trim();
  return /^following up:/i.test(s) ? s : `Following up: ${s}`;
}
