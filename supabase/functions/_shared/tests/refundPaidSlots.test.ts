import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { paidPaymentSlots } from '../refundPaidSlots.ts';

// The checkout's charge, stamped on EVERY leg of a year bundle.
const SHARED_PI = 'pi_fall_leg';

Deno.test('unpaid plan leg does NOT borrow the sibling leg\'s charge (2026-10-21 incident)', () => {
  // WI27 leg: Jan instalment still pending (or paused by the withdraw), but
  // the registration row says paid and carries the FA26 leg's PI.
  const got = paidPaymentSlots(
    [{ installment_number: 2, amount_cents: 24000, status: 'pending', stripe_payment_intent_id: null }],
    { payment_status: 'paid', stripe_payment_intent_id: SHARED_PI, amount_cents: 24000 },
  );
  assertEquals(got, []);
});

Deno.test('paused plan leg has nothing to refund either', () => {
  const got = paidPaymentSlots(
    [{ installment_number: 3, amount_cents: 24000, status: 'paused_program_cancelled', stripe_payment_intent_id: null }],
    { payment_status: 'paid', stripe_payment_intent_id: SHARED_PI, amount_cents: 24000 },
  );
  assertEquals(got, []);
});

Deno.test('paid plan leg refunds against its own paid instalments only', () => {
  const got = paidPaymentSlots(
    [
      { installment_number: 1, amount_cents: 24000, status: 'paid', stripe_payment_intent_id: SHARED_PI, stripe_charge_account_id: 'acct_x' },
      { installment_number: 2, amount_cents: 24000, status: 'pending', stripe_payment_intent_id: null },
    ],
    { payment_status: 'paid', stripe_payment_intent_id: SHARED_PI, amount_cents: 48000 },
  );
  assertEquals(got, [{ pi: SHARED_PI, amount: 24000, sortKey: 1, chargeAccountId: 'acct_x' }]);
});

Deno.test('single-pay registration (no instalment rows) still uses the registration\'s charge', () => {
  const got = paidPaymentSlots([], {
    payment_status: 'paid', stripe_payment_intent_id: 'pi_single', amount_cents: 29900, stripe_charge_account_id: null,
  });
  assertEquals(got, [{ pi: 'pi_single', amount: 29900, sortKey: 1, chargeAccountId: null }]);
});

Deno.test('single-pay registration that is not paid has nothing to refund', () => {
  assertEquals(paidPaymentSlots([], { payment_status: 'pending', stripe_payment_intent_id: 'pi_x', amount_cents: 29900 }), []);
});
