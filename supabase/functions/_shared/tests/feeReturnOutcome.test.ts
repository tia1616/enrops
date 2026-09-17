// feeReturnOutcome — the money layer's fifth checkbox, tested against the
// shapes that actually occurred on production in September 2026.
//
// The rule being protected: a zero in platform_fee_refunded_cents cannot tell
// "no margin existed" from "we tried and could not", and the second one is
// money an operator is owed. Every tie breaks towards visible.

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { feeReturnOutcome } from '../feeReturnOutcome.ts';

Deno.test('returned: the ordinary case, money went back', () => {
  assertEquals(
    feeReturnOutcome({ owedCents: 240, applicationFeeId: 'fee_1', returnedCents: 240, failed: false }),
    'returned',
  );
});

// Lochlan Dillard and Adalyn Snowley, both refunded 8 Sept, both registered in
// June before the fee existed. computeMarginRefund returns 0 and there is no
// ApplicationFee on the charge. Correct, and it must stop looking like a skip.
Deno.test('nothing_owed: a pre-fee registration', () => {
  assertEquals(
    feeReturnOutcome({ owedCents: 0, applicationFeeId: null, returnedCents: 0, failed: false }),
    'nothing_owed',
  );
});

// The legacy own-platform org shape: a fee exists but carries no uplift to
// recover, so computeMarginRefund returns 0. Still nothing owed.
Deno.test('nothing_owed: a fee with no recoverable margin', () => {
  assertEquals(
    feeReturnOutcome({ owedCents: 0, applicationFeeId: 'fee_1', returnedCents: 0, failed: false }),
    'nothing_owed',
  );
});

// Laura Lillison, Morgan Marlett, Addie Schmitt on 8 September: the platform
// balance was too low, the family had their money, the operator did not have
// the margin. THIS is the row that used to be indistinguishable from the two
// above, and the one that took a hand audit to find.
Deno.test('failed: owed, attempted, threw', () => {
  assertEquals(
    feeReturnOutcome({ owedCents: 371, applicationFeeId: 'fee_1', returnedCents: 0, failed: true }),
    'failed',
  );
});

// FAIL-SAFE. Owed, no error, and nothing came back. Not a shape the current
// code produces, but the operator is short either way, so it is flagged rather
// than filed as "nothing owed" and forgotten.
Deno.test('failed: owed and silently returned nothing, with no error raised', () => {
  assertEquals(
    feeReturnOutcome({ owedCents: 240, applicationFeeId: 'fee_1', returnedCents: 0, failed: false }),
    'failed',
  );
});

// The caller and this function disagreeing about what was owed must not lose
// the fact that money moved.
Deno.test('returned: money moved even though nothing was thought to be owed', () => {
  assertEquals(
    feeReturnOutcome({ owedCents: 0, applicationFeeId: 'fee_1', returnedCents: 101, failed: false }),
    'returned',
  );
});

// A partial return is still a return. It is the AMOUNT column's job to say how
// much; this column only says what happened.
Deno.test('returned: a partial return is a return', () => {
  assertEquals(
    feeReturnOutcome({ owedCents: 371, applicationFeeId: 'fee_1', returnedCents: 285, failed: false }),
    'returned',
  );
});

// THE ONE THAT FOUND A BUG. Garbage in must not produce a confident "nothing
// owed". The first version of this function asked "was anything owed" before
// "did it throw", so a NaN amount collapsed to 0 and the thrown attempt was
// silently relabelled as nothing_owed - a fail-OPEN in the function whose
// entire purpose is to fail safe. It was written expecting 'nothing_owed' and
// that is exactly what made the bug visible.
Deno.test('failed: a NaN owed amount with an attempt that threw', () => {
  assertEquals(
    feeReturnOutcome({ owedCents: NaN, applicationFeeId: 'fee_1', returnedCents: NaN, failed: true }),
    'failed',
  );
});

// And the mirror: a thrown attempt where money went back anyway (the fee
// refund succeeded and a later step threw) must read as returned, or somebody
// refunds the fee a second time.
Deno.test('returned: money moved even though a later step threw', () => {
  assertEquals(
    feeReturnOutcome({ owedCents: 240, applicationFeeId: 'fee_1', returnedCents: 240, failed: true }),
    'returned',
  );
});
