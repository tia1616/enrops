// Deno twin of src/lib/rosterOrder.js. Same order, same tiebreaks, same
// treatment of blanks - the full reasoning lives in that file and is not
// duplicated here beyond the four lines that matter. Keep the behaviour
// identical; a divergence between these two means the roster an instructor gets
// by EMAIL is in a different order from the one on their portal screen, which is
// the exact failure the shared rule exists to end. Guarded by
// _shared/tests/rosterOrderTwinParity.test.ts, which executes both copies.
//
//   1. First name, then last name, both TRIMMED (47 of 649 prod first names
//      carry a trailing space, and the same name exists spaced and unspaced).
//   2. Case- and accent-folded, so "aiden" sits with "Aiden" instead of after
//      "Zoe".
//   3. A blank first name sorts LAST - it is the row needing attention.
//   4. Ties fall back to registered_at then the registration id, because a row
//      may not carry registered_at at all (Rosters.jsx orders by it without
//      selecting it) and two identical names must not shuffle between renders.
//
// Jeff's ask, via Jessica 2026-08-31: "alphabetize student names on rosters by
// first name - all rosters including instructor portal." This deliberately
// reverses a previous last-name-first order that was marked "print/sign-in
// friendly" in both of the places it had been written out.

export interface RosterRow {
  id?: unknown;
  registered_at?: unknown;
  student?: { first_name?: unknown; last_name?: unknown } | null;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

function nameKey(v: unknown): string {
  if (v == null) return '';
  return (typeof v === 'string' ? v : String(v)).trim();
}

export function compareRosterRows(a: RosterRow, b: RosterRow): number {
  const af = nameKey(a?.student?.first_name);
  const bf = nameKey(b?.student?.first_name);
  if (!af !== !bf) return af ? -1 : 1;            // no first name -> last
  const byFirst = collator.compare(af, bf);
  if (byFirst !== 0) return byFirst;

  const byLast = collator.compare(
    nameKey(a?.student?.last_name),
    nameKey(b?.student?.last_name),
  );
  if (byLast !== 0) return byLast;

  const ar = nameKey(a?.registered_at), br = nameKey(b?.registered_at);
  if (ar !== br) return ar < br ? -1 : 1;
  const ai = nameKey(a?.id), bi = nameKey(b?.id);
  if (ai === bi) return 0;
  return ai < bi ? -1 : 1;
}

export function sortRosterRows<T extends RosterRow>(rows: T[] | null | undefined): T[] {
  return [...(rows ?? [])].sort(compareRosterRows);
}

// WHO IS ON A ROSTER AT ALL - twin of isOnRoster in src/lib/rosterOrder.js; the
// full reasoning lives there. Four surfaces had hand-written copies of this rule
// and two more had none, so the seat count said 12 while the screen listed 14.
//
//   paid              -> money arrived.
//   confirmed         -> an operator says the child is in the class. 354 prod
//                        rows are confirmed-and-unpaid (hand-added, imported,
//                        comped, school pays off-platform); filtering on payment
//                        alone would empty real classrooms.
//   ach 'processing'  -> a bank transfer clearing. Zero rows on either
//                        environment today, so this clause moves nothing now; it
//                        is here so the first such family is not dropped off an
//                        instructor's roster for the three days it settles,
//                        which is already how registration_holds_seat() treats
//                        them for capacity.
//
// Does NOT replace the cancelled/waitlist filters callers already apply: this
// answers "has this child got a place", not "is this row live at all".
export interface RosterMembershipRow {
  status?: unknown;
  payment_status?: unknown;
  ach_payment_state?: unknown;
}

export function isOnRoster(reg: RosterMembershipRow | null | undefined): boolean {
  if (!reg) return false;
  return (
    reg.payment_status === 'paid' ||
    reg.status === 'confirmed' ||
    reg.ach_payment_state === 'processing'
  );
}

export function isAwaitingPayment(reg: RosterMembershipRow | null | undefined): boolean {
  return !!reg && !isOnRoster(reg);
}
