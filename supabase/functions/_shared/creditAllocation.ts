// creditAllocation - how a family's credit is spread across the registrations
// in one cart.
//
// WHY THIS IS A SHARED MODULE AND NOT A FEW LINES INSIDE create-checkout.
// Two places need the same answer and they run minutes apart: create-checkout
// decides how much to discount each line and how much credit to hold, and
// stripe-webhook has to convert exactly those holds into spends. A figure that
// shows in two places must be COMPUTED in one - re-deriving the split in the
// webhook would be a second implementation of a money rule, and the two would
// eventually disagree about a cent on some cart nobody tested.
//
// DETERMINISM IS THE WHOLE POINT. The rows come from a PostgREST `.in()`
// query, which returns them in NO PARTICULAR ORDER - a trap this repo has
// already been bitten by in this exact function. An allocation that depended
// on arrival order would hand $240 to Ada on one call and to Ben on the next,
// and the webhook would then restore the wrong child's credit on a refund. So
// the lines are sorted by registration id before anything is allocated, and
// the sort is part of the contract, not an implementation detail.
//
// GREEDY, NOT PROPORTIONAL. Filling one registration before moving to the next
// means whole classes go to zero and a parent can be told "your credit covered
// Ada's class in full and $60 of Ben's" - one sentence, which is the test the
// money doc sets for every rule in section 6. Proportional splitting gives
// every child an odd remainder and explains worse. It also keeps the refund
// story clean: a fully covered registration refunds as a whole credit.

export interface CreditLine {
  registrationId: string;
  amountCents: number;
}

export interface CreditAllocationEntry {
  registrationId: string;
  /** The full price of this registration, unchanged. */
  amountCents: number;
  /** How much credit this registration takes. */
  creditCents: number;
  /** What the family still owes on it, in money. */
  chargeCents: number;
}

export interface CreditAllocation {
  entries: CreditAllocationEntry[];
  /** Credit consumed across the whole cart. */
  totalCreditCents: number;
  /** What the cart still costs after credit. */
  totalChargeCents: number;
}

/**
 * Spread `availableCents` of credit across `lines`, cheapest path first:
 * registrations in id order, each filled before the next is touched.
 *
 * Never allocates more than a line costs, and never more than is available.
 * A negative or absent balance allocates nothing rather than throwing - the
 * caller's job is to charge the full price, not to fail the checkout.
 */
export function allocateCreditAcrossLines(
  lines: CreditLine[],
  availableCents: number,
): CreditAllocation {
  // Sorted, ALWAYS. See the header: `.in()` row order is not a fact.
  const ordered = [...lines].sort((a, b) =>
    a.registrationId < b.registrationId ? -1 : a.registrationId > b.registrationId ? 1 : 0
  );

  let left = Number.isFinite(availableCents) && availableCents > 0
    ? Math.floor(availableCents)
    : 0;

  const entries: CreditAllocationEntry[] = ordered.map((l) => {
    const price = Math.max(0, Math.floor(l.amountCents || 0));
    const take = Math.min(price, left);
    left -= take;
    return {
      registrationId: l.registrationId,
      amountCents: price,
      creditCents: take,
      chargeCents: price - take,
    };
  });

  return {
    entries,
    totalCreditCents: entries.reduce((s, e) => s + e.creditCents, 0),
    totalChargeCents: entries.reduce((s, e) => s + e.chargeCents, 0),
  };
}

/**
 * The cart's application key: the one string that identifies this family's
 * draw on their credit for this set of registrations.
 *
 * DERIVED FROM THE CART, NOT RANDOM, and that is deliberate. A random key per
 * attempt would mean a family who abandons checkout and immediately tries
 * again finds their own credit held by the attempt they just walked away from.
 * Keyed on the cart, the second attempt reuses the first attempt's hold
 * instead of stacking a second one on top of it.
 *
 * Sorted for the same reason the allocation is: the same cart must produce the
 * same key however PostgREST happened to order the rows.
 */
export function creditApplicationKey(registrationIds: string[]): string {
  return `cart:${[...registrationIds].sort().join(',')}`;
}

/** Compact, order-stable encoding for Stripe metadata (500 chars per value). */
export function encodeCreditAllocation(alloc: CreditAllocation): string {
  return alloc.entries
    .filter((e) => e.creditCents > 0)
    .map((e) => `${e.registrationId}:${e.creditCents}`)
    .join(',');
}

/** Read back what encodeCreditAllocation wrote. Bad input yields no entries. */
export function decodeCreditAllocation(
  encoded: string | null | undefined,
): Array<{ registrationId: string; creditCents: number }> {
  if (!encoded) return [];
  return encoded
    .split(',')
    .map((part) => {
      const i = part.lastIndexOf(':');
      if (i <= 0) return null;
      const id = part.slice(0, i).trim();
      const cents = Number(part.slice(i + 1));
      if (!id || !Number.isFinite(cents) || cents <= 0) return null;
      return { registrationId: id, creditCents: Math.floor(cents) };
    })
    .filter((x): x is { registrationId: string; creditCents: number } => x !== null);
}
