// Branch matrix for decideChargeModel (2026-08-04).
//
// This rule decides where live money is routed when a Stripe account is
// connected to an org. The branch that matters most - an established org keeping
// its model instead of having one inferred - cannot be reached by connecting a
// fresh test account, which is exactly why the logic was pulled out of
// stripe-oauth-callback and into a pure function. Everything below is asserted
// against the CONTRACT, not against a re-run of the implementation.
//
// The case that motivated the whole change is `preserves destination for an
// established org connecting a Standard account`. Get that wrong and
// process-installments fails closed on every pre-existing payment plan, marking
// them paused_card_failed. That pauses real families, it does not re-route them.
//
// Run: deno test supabase/functions/_shared/tests/chargeModelDecision.test.ts

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { decideChargeModel } from '../chargeModelDecision.ts';

// A brand new operator: nothing taken, history readable.
const NEW_ORG = {
  existingModel: 'destination',
  hasTakenMoney: false,
  historyUnreadable: false,
  operatorBearsStripeFees: true,
};

Deno.test('new org + account that bears Stripe fees -> infers direct', () => {
  const d = decideChargeModel(NEW_ORG);
  assertEquals(d.chargeModel, 'direct');
  assertEquals(d.preserved, false);
  assertEquals(d.inferredModel, 'direct');
});

Deno.test('new org + account that does NOT confirm -> infers destination', () => {
  const d = decideChargeModel({ ...NEW_ORG, operatorBearsStripeFees: false });
  assertEquals(d.chargeModel, 'destination');
  assertEquals(d.preserved, false);
  // The caller uses this to pick its review message; it must say what the
  // account implied, not what was written.
  assertEquals(d.inferredModel, 'destination');
});

// ── THE CASE THIS FILE EXISTS FOR ────────────────────────────────────────────
// J2S on 2026-08-04: destination, 71 registrations holding a payment intent, 32
// pending installments, connecting acct_1TZhD8 which Stripe reports as Standard
// (so operatorBearsStripeFees is true and the inference would say 'direct').
Deno.test('established destination org connecting a Standard account KEEPS destination', () => {
  const d = decideChargeModel({
    existingModel: 'destination',
    hasTakenMoney: true,
    historyUnreadable: false,
    operatorBearsStripeFees: true,
  });
  assertEquals(d.chargeModel, 'destination');
  assertEquals(d.preserved, true);
  // The inference is still reported, so the connect log and the review branch
  // can say the account implied something different.
  assertEquals(d.inferredModel, 'direct');
});

Deno.test('established direct org keeps direct even if the new account does not confirm', () => {
  const d = decideChargeModel({
    existingModel: 'direct',
    hasTakenMoney: true,
    historyUnreadable: false,
    operatorBearsStripeFees: false,
  });
  assertEquals(d.chargeModel, 'direct');
  assertEquals(d.preserved, true);
  assertEquals(d.inferredModel, 'destination');
});

// ── fail-closed ──────────────────────────────────────────────────────────────
Deno.test('unreadable history preserves, and OVERRIDES hasTakenMoney=false', () => {
  // The ordering trap: if hasTakenMoney were checked first, an unreadable
  // history (which reports false) would fall through to the inference branch and
  // silently flip an established org. Prove the guard, not the happy path.
  const d = decideChargeModel({
    existingModel: 'destination',
    hasTakenMoney: false,
    historyUnreadable: true,
    operatorBearsStripeFees: true,
  });
  assertEquals(d.chargeModel, 'destination');
  assertEquals(d.preserved, true);
  assertEquals(d.source.includes('could not read'), true);
});

// ── coercion: never null, never a guess toward direct ────────────────────────
Deno.test('null existing model resolves to destination, never direct', () => {
  const d = decideChargeModel({
    existingModel: null,
    hasTakenMoney: true,
    historyUnreadable: false,
    operatorBearsStripeFees: true,
  });
  assertEquals(d.chargeModel, 'destination');
});

Deno.test('a wrong-case DIRECT row is NOT treated as direct', () => {
  // buildChargeRouting compares exactly against 'direct'; this must agree with
  // it. Disagreeing would route charges one way and describe them another.
  const d = decideChargeModel({
    existingModel: 'DIRECT',
    hasTakenMoney: true,
    historyUnreadable: false,
    operatorBearsStripeFees: false,
  });
  assertEquals(d.chargeModel, 'destination');
});

Deno.test('every input combination yields a valid, non-null model', () => {
  const models: (string | null)[] = ['destination', 'direct', null, '', 'DIRECT', 'nonsense'];
  const bools = [true, false];
  let checked = 0;
  for (const existingModel of models) {
    for (const hasTakenMoney of bools) {
      for (const historyUnreadable of bools) {
        for (const operatorBearsStripeFees of bools) {
          const d = decideChargeModel({
            existingModel,
            hasTakenMoney,
            historyUnreadable,
            operatorBearsStripeFees,
          });
          assertEquals(
            d.chargeModel === 'destination' || d.chargeModel === 'direct',
            true,
            `invalid model ${d.chargeModel} for existing=${existingModel}`,
          );
          // An org can only END UP direct if it was already direct or the
          // account said so. Nothing else may manufacture 'direct'.
          if (d.chargeModel === 'direct') {
            assertEquals(
              existingModel === 'direct' || operatorBearsStripeFees,
              true,
              `manufactured direct from existing=${existingModel} bears=${operatorBearsStripeFees}`,
            );
          }
          checked++;
        }
      }
    }
  }
  assertEquals(checked, 48);
});
