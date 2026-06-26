// Tests for achSettlement. Pure-function tests; no Supabase or Stripe.
// Run: deno test supabase/functions/_shared/tests/achSettlement.test.ts

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import {
  settlementForCheckoutCompleted,
  SETTLEMENT_ON_ASYNC_SUCCESS,
  SETTLEMENT_ON_ASYNC_FAILURE,
} from '../achSettlement.ts';

// --- checkout.session.completed: card (synchronous) ---

Deno.test("card completion (payment_status='paid') → paid, no ACH marker, funds settled", () => {
  assertEquals(settlementForCheckoutCompleted('paid'), {
    payment_status: 'paid',
    ach_payment_state: null,
    fundsSettled: true,
  });
});

// --- checkout.session.completed: ACH (asynchronous) ---

Deno.test("ACH completion (payment_status='unpaid') → unpaid + processing marker, NOT settled", () => {
  assertEquals(settlementForCheckoutCompleted('unpaid'), {
    payment_status: 'unpaid',
    ach_payment_state: 'processing',
    fundsSettled: false,
  });
});

Deno.test("only literal 'paid' counts as settled — 'no_payment_required' is treated as not-yet-paid", () => {
  // Edge: Stripe uses this for $0 sessions. Our checkout always has an amount,
  // but be explicit that anything other than 'paid' holds the seat optimistically.
  assertEquals(settlementForCheckoutCompleted('no_payment_required'), {
    payment_status: 'unpaid',
    ach_payment_state: 'processing',
    fundsSettled: false,
  });
});

Deno.test('missing/null payment_status defaults to the safe non-settled branch', () => {
  assertEquals(settlementForCheckoutCompleted(null), {
    payment_status: 'unpaid',
    ach_payment_state: 'processing',
    fundsSettled: false,
  });
  assertEquals(settlementForCheckoutCompleted(undefined), {
    payment_status: 'unpaid',
    ach_payment_state: 'processing',
    fundsSettled: false,
  });
});

// --- async resolution events ---

Deno.test('async_payment_succeeded flips to paid and clears the ACH marker', () => {
  assertEquals(SETTLEMENT_ON_ASYNC_SUCCESS, {
    payment_status: 'paid',
    ach_payment_state: null,
  });
});

Deno.test("async_payment_failed flags 'failed' and does NOT mark paid (seat stays held, unpaid)", () => {
  assertEquals(SETTLEMENT_ON_ASYNC_FAILURE, { ach_payment_state: 'failed' });
  // Crucially, no payment_status key — the registration stays 'unpaid' for the
  // operator to chase or release; we never silently mark a bounced ACH as paid.
  assertEquals('payment_status' in SETTLEMENT_ON_ASYNC_FAILURE, false);
});
