import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { allocateRefundAcrossRegistrations } from '../refundAllocation.ts';

const sum = (rows: Array<{ amountCents: number }>) => rows.reduce((s, r) => s + r.amountCents, 0);

Deno.test('a single registration gets the whole refund', () => {
  const got = allocateRefundAcrossRegistrations(6199, [{ registrationId: 'a', baseCents: 6000 }]);
  assertEquals(got, [{ registrationId: 'a', amountCents: 6199 }]);
});

Deno.test('two children split by what each contributed', () => {
  const got = allocateRefundAcrossRegistrations(30000, [
    { registrationId: 'a', baseCents: 10000 },
    { registrationId: 'b', baseCents: 20000 },
  ]);
  assertEquals(got, [
    { registrationId: 'a', amountCents: 10000 },
    { registrationId: 'b', amountCents: 20000 },
  ]);
});

// POLICY, LOCKED. Our records must agree with Stripe to the cent. A naive
// Math.round() per slice loses or invents money on any amount that does not
// divide evenly, and on a money table that drift is permanent.
Deno.test('POLICY: the parts always sum to exactly the refunded amount', () => {
  const awkward = [
    { registrationId: 'a', baseCents: 3333 },
    { registrationId: 'b', baseCents: 3333 },
    { registrationId: 'c', baseCents: 3334 },
  ];
  for (const amount of [1, 2, 7, 99, 100, 6199, 27674, 100001]) {
    assertEquals(sum(allocateRefundAcrossRegistrations(amount, awkward)), amount, `amount ${amount}`);
  }
});

Deno.test('a one-cent refund goes somewhere, and only somewhere', () => {
  const got = allocateRefundAcrossRegistrations(1, [
    { registrationId: 'a', baseCents: 5000 },
    { registrationId: 'b', baseCents: 5000 },
  ]);
  assertEquals(got.length, 1);
  assertEquals(got[0].amountCents, 1);
});

// refunds.amount_cents carries CHECK (amount_cents > 0), so a zero slice would
// fail the insert and lose that child's row entirely.
Deno.test('zero-amount slices are dropped, never written', () => {
  const got = allocateRefundAcrossRegistrations(2, [
    { registrationId: 'a', baseCents: 1 },
    { registrationId: 'big', baseCents: 1000000 },
  ]);
  assertEquals(got.every((r) => r.amountCents > 0), true);
  assertEquals(sum(got), 2);
});

Deno.test('degenerate inputs allocate nothing rather than guessing', () => {
  assertEquals(allocateRefundAcrossRegistrations(0, [{ registrationId: 'a', baseCents: 100 }]), []);
  assertEquals(allocateRefundAcrossRegistrations(-5, [{ registrationId: 'a', baseCents: 100 }]), []);
  assertEquals(allocateRefundAcrossRegistrations(100, []), []);
  assertEquals(allocateRefundAcrossRegistrations(100, [{ registrationId: 'a', baseCents: 0 }]), []);
});

Deno.test('registrations with no base are ignored, not credited', () => {
  const got = allocateRefundAcrossRegistrations(100, [
    { registrationId: 'a', baseCents: 0 },
    { registrationId: 'b', baseCents: 100 },
  ]);
  assertEquals(got, [{ registrationId: 'b', amountCents: 100 }]);
});
