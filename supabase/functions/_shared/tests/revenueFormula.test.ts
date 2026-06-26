// Tests for the Revenue-Activity money formula (mirror of get_revenue_summary).
// Pure-function tests; no Supabase. Run:
//   deno test supabase/functions/_shared/tests/revenueFormula.test.ts
import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import {
  collectedCents,
  payInFullCents,
  installmentsPaidCents,
  refundedCents,
  externalCount,
  RegistrationRow,
  InstallmentRow,
  RefundRow,
} from '../revenueFormula.ts';

const reg = (payment_method: string | null, payment_status: string, amount_cents: number | null): RegistrationRow =>
  ({ payment_method, payment_status, amount_cents });
const inst = (status: string, amount_cents: number): InstallmentRow => ({ status, amount_cents });
const ref = (status: string, amount_cents: number): RefundRow => ({ status, amount_cents });

Deno.test('pay-in-full stripe paid is counted', () => {
  assertEquals(collectedCents([reg('stripe', 'paid', 29900)], [], []), 29900);
});

Deno.test('external (payment_method null) is EXCLUDED from collected, counted as external', () => {
  const regs = [reg(null, 'paid', 32500), reg('stripe', 'paid', 29900)];
  assertEquals(collectedCents(regs, [], []), 29900);
  assertEquals(externalCount(regs), 1);
});

Deno.test('comp (payment_method comp) contributes $0', () => {
  assertEquals(collectedCents([reg('comp', 'paid', 0)], [], []), 0);
  assertEquals(payInFullCents([reg('comp', 'paid', 5000)]), 0); // comp is not stripe
});

Deno.test('unpaid stripe reg is not counted', () => {
  assertEquals(collectedCents([reg('stripe', 'unpaid', 29900)], [], []), 0);
});

Deno.test('installment plan: stripe_installments reg NOT in pay-in-full; installments table is the truth (no double count)', () => {
  const regs = [reg('stripe_installments', 'paid', 30000)]; // full contract on the reg
  const insts = [inst('paid', 10000), inst('paid', 10000), inst('pending', 10000)]; // 2 of 3 collected
  assertEquals(payInFullCents(regs), 0);           // excluded — not 'stripe'
  assertEquals(installmentsPaidCents(insts), 20000); // only the 2 paid
  assertEquals(collectedCents(regs, insts, []), 20000); // NOT 30000+20000
});

Deno.test('succeeded refund subtracts; failed/pending refunds do not', () => {
  const regs = [reg('stripe', 'paid', 29900)];
  const refunds = [ref('succeeded', 5000), ref('failed', 9999), ref('pending', 1234)];
  assertEquals(refundedCents(refunds), 5000);
  assertEquals(collectedCents(regs, [], refunds), 24900);
});

Deno.test('refunded stripe pay-in-full nets to ZERO (the bug-fix case)', () => {
  // reg flipped to payment_status='refunded' + a succeeded full refund.
  // Gross captured (24000) − refund (24000) = 0, NOT −24000.
  const regs = [reg('stripe', 'refunded', 24000)];
  const refunds = [ref('succeeded', 24000)];
  assertEquals(payInFullCents(regs), 24000); // still counted gross
  assertEquals(collectedCents(regs, [], refunds), 0);
});

Deno.test('partial refund: gross minus the partial', () => {
  const regs = [reg('stripe', 'partial', 29900)];
  const refunds = [ref('succeeded', 10000)];
  assertEquals(collectedCents(regs, [], refunds), 19900);
});

Deno.test('mixed realistic set', () => {
  const regs = [
    reg('stripe', 'paid', 29900),          // +29900
    reg('stripe', 'paid', 29900),          // +29900
    reg('stripe_installments', 'paid', 30000), // excluded (installments below)
    reg(null, 'paid', 32500),              // external, excluded
    reg('comp', 'paid', 0),                // comp $0
    reg('stripe', 'unpaid', 29900),        // not captured
  ];
  const insts = [inst('paid', 10000), inst('pending', 20000)]; // +10000
  const refunds = [ref('succeeded', 5000)];                    // −5000
  // 29900 + 29900 + 10000 − 5000 = 64800
  assertEquals(collectedCents(regs, insts, refunds), 64800);
  assertEquals(externalCount(regs), 1);
});

Deno.test('null amount_cents is treated as 0', () => {
  assertEquals(collectedCents([reg('stripe', 'paid', null)], [inst('paid', null as unknown as number)], []), 0);
});
