import { isEarlyBirdActive } from "./pricing.js";

// Early-bird eligibility, as the operator reads it.
//
// The RULE itself lives in SQL (early_bird_skip_reason, migration 20261006b) and
// is never re-implemented here: the program form and the Discounts preview both
// ASK the database what a program's reason is and this file only turns the answer
// into a sentence. That keeps the count an operator sees, the write they then
// authorise, and the explanation on the program form reading off one decision.
//
// Adding a reason: add it to the SQL CASE, then add it here. An unknown code
// falls through to a generic line rather than rendering "undefined" -- see
// skipReasonSentence.

// Short month, fixed to UTC, so an operator in Portland and the Postgres `date`
// column agree about which day a deadline is. Mirrors formatEarlyBirdDate in
// pricing.js, which spells the month out for families; operators get the short
// form because it sits inline in a sentence.
export function formatDeadlineShort(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatDollars(cents) {
  if (cents == null) return "";
  const whole = Number.isInteger(cents / 100);
  return `$${whole ? cents / 100 : (cents / 100).toFixed(2)}`;
}

// NOTE ON WHAT IS DELIBERATELY NOT HERE: there is no function in this file that
// works out an early-bird price. Every price shown by every screen comes back
// from SQL -- program_early_bird_preview for the program form, the dry run of
// apply_term_early_bird for the Discounts card -- because the screen that shows
// a price and the write that stores it must be ONE calculation.
//
// The two spellings do not agree, which is the point. SQL rounds the RESULT of a
// percentage, round(price * (1 - v/100)); the obvious JS, price - round(price *
// v/100), rounds the discount instead. 50% of $3.35 is $1.675, and those two
// give $1.68 and $1.67. A form that previews one and saves the other is the bug
// class that put a refund rate of 22.2% in an email and 100% on the screen it
// linked to. If you are about to add `earlyBirdPriceFor` here, add a parameter
// to the RPC instead.

// One sentence per reason, each true in the state that selects it.
//
// These are read by an operator deciding whether something is broken, so each one
// says what is true of THIS program, never what the rule is in general. "Preschool
// programs don't get the after-school early bird" is the pricing sheet's rule and
// is the whole explanation; "this class is cancelled" is a fact about the row.
const SENTENCES = {
  cancelled: "This class is cancelled, so it isn't offered an early bird.",
  closed: "This class is closed, so it isn't offered an early bird.",
  partner_run:
    "The partner runs registration for this class, so we don't set its price.",
  preschool: "Preschool classes don't get the after-school early bird.",
  free: "This class is free, so there's nothing to take off.",
  discount_exceeds_price:
    "The term's discount is more than this class costs, so it would come to $0.",
  opted_out: "Early bird is turned off for this class.",
};

// Short form for the skipped list on the Discounts card, where the program name
// is already on the row and a full sentence would read like noise repeated 6 times.
const LABELS = {
  cancelled: "Cancelled",
  closed: "Closed",
  partner_run: "Partner runs registration",
  preschool: "Preschool",
  free: "Free class",
  discount_exceeds_price: "Discount is bigger than the price",
  opted_out: "Turned off for this class",
};

export function skipReasonSentence(code) {
  if (!code) return "";
  return SENTENCES[code] ?? "This class isn't offered the term's early bird.";
}

export function skipReasonLabel(code) {
  if (!code) return "";
  return LABELS[code] ?? "Not offered";
}

// 'opted_out' is the only reason an operator can undo from the program form. Every
// other reason is a fact about the class, so the toggle is shown disabled rather
// than hidden -- a missing control reads as a bug, a disabled one with a reason
// reads as an answer.
export function isReasonReversible(code) {
  return code === "opted_out";
}

// How the term's discount reads in a sentence: "$25 off" or "10% off".
// Numeric columns arrive over PostgREST as strings ("25.0000000000000000"), so
// this goes through Number() rather than printing what the API handed back.
export function describeOffer(preview) {
  const raw = preview?.discount_value;
  // Number(null) is 0 and Number("") is 0, both finite -- so a Number.isFinite
  // guard alone turns "this term has no single discount" into "$0 off". Reject
  // the absent values before converting, not after.
  if (raw == null || raw === "") return "";
  const v = Number(raw);
  if (!Number.isFinite(v)) return "";
  return preview.discount_type === "percent"
    ? `${v}% off`
    : `${formatDollars(Math.round(v * 100))} off`;
}

// WHICH COLUMNS A SAVE WRITES. Takes what program_early_bird_preview answered
// and the position of the form's switch; returns the columns to write, or NULL
// meaning "don't touch this program's early-bird columns at all".
//
// NULL IS THE FAIL-SAFE DIRECTION and it is returned in three states, all of
// them "we do not know enough to write a price":
//   - the preview has not come back, or the lookup FAILED. A failed read must
//     never wipe a discount families may already be registering under; an error
//     that becomes `null` that becomes a cleared column is how money disappears.
//   - no price has been typed yet, so nothing has been decided.
//   - the term's eligible programs carry DIFFERENT discounts, so there is no
//     single price this form could honestly write.
// The row tells the operator which of those it is; this function's job is only
// to make sure none of them writes anything.
export function earlyBirdPatch(preview, enabled, today = new Date()) {
  if (!preview) return null;             // still asking, or the lookup failed
  if (preview.needs_price) return null;  // no price typed yet, nothing decided
  if (preview.skip_reason) {
    // Not allowed one. CLEAR any it is carrying -- this is what stops a class
    // cancelled in November keeping its discount until the term ends -- but do
    // NOT record an opt-out. The operator did not choose this, and recording it
    // would keep the class out of the term discount even after it is
    // un-cancelled, re-priced, or moved off the preschool tier.
    return { early_bird_price_cents: null, early_bird_deadline: null };
  }
  // `== null`, never falsiness: an early bird of 0 cents is a real value.
  if (preview.early_bird_cents == null) return null; // no offer, or no single one
  // An offer whose deadline has passed is not one to join a class to. Checkout
  // would ignore it anyway, so this is about not storing a price that is already
  // untrue -- and about not having the term keep reporting a dead deal as its
  // current one. Gated by the SAME function the family-facing price uses; `today`
  // is injectable so the branch is testable without waiting for a date.
  if (!isEarlyBirdActive(preview.deadline, today)) return null;
  return enabled
    ? {
        early_bird_price_cents: preview.early_bird_cents,
        early_bird_deadline: preview.deadline,
        early_bird_opt_out: false,
      }
    : { early_bird_price_cents: null, early_bird_deadline: null, early_bird_opt_out: true };
}
