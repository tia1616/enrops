// Parse an operator-typed gas/distance bonus into cents.
//
// This is a MONEY path and it is deliberately strict. parseFloat() is not: it
// reads "3 5" as 3 and "35abc" as 35, so a slip would quietly pay someone $3
// instead of $35 with no error anywhere. Two bugs were found here in review on
// 2026-08-18 (a negative and an unparseable value were both silently coerced to
// "no bonus", so the operator believed a bonus was set and payroll never saw it).
//
// Returns { cents, error }:
//   - blank            -> { cents: null, error: null }   no bonus, not an error
//   - "0"              -> { cents: null, error: null }   zero means no bonus
//   - a valid amount   -> { cents: <int>, error: null }
//   - anything else    -> { cents: null, error: <message for the operator> }
//
// The caller must NOT assign when error is set. maxDollars guards
// program_assignments.distance_bonus_cents, which is a 4-byte integer.

export function parseBonusDollars(raw, maxDollars) {
  // Be forgiving about a typed "$" or thousands commas, strict about the rest.
  const s = String(raw ?? "").trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (!s) return { cents: null, error: null };

  // Digits, optionally with 1-2 decimal places. Rejects negatives, exponents,
  // trailing text, embedded spaces and sub-cent precision.
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    return { cents: null, error: "Enter a dollar amount, or leave it blank for no bonus." };
  }

  const n = parseFloat(s);
  if (n > maxDollars) {
    return { cents: null, error: `That's higher than we can record — enter $${maxDollars.toLocaleString()} or less.` };
  }

  const cents = Math.round(n * 100);
  return { cents: cents === 0 ? null : cents, error: null };
}
