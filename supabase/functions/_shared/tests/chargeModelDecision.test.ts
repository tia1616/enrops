// Branch matrix for decideChargeModel (2026-08-04).
//
// This rule decides where live money is routed when a Stripe account is
// connected to an org. The branch that matters most - an established org keeping
// its model instead of having one inferred - cannot be reached by connecting a
// fresh test account, which is exactly why the logic was pulled out of
// stripe-oauth-callback and into a pure function. Everything below is asserted
// against the CONTRACT, not against a re-run of the implementation.
//
// The case that motivated the change is `preserves destination for an
// established org connecting a Standard account`. Get that wrong and
// process-installments fails closed on every pre-existing payment plan, marking
// them paused_card_failed. That pauses real families, it does not re-route them.
//
// The NULL outcome came out of code review: the first version collapsed "cannot
// read the charge history" and "cannot read the current model" into one flag, so
// when the org row was the unreadable one it reported `preserved` while actually
// defaulting a direct org to destination. Preservation is only possible when the
// current value is known; otherwise the column must be left alone.
//
// Run: deno test supabase/functions/_shared/tests/chargeModelDecision.test.ts

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { decideChargeModel } from '../chargeModelDecision.ts';

// A brand new operator: nothing taken, both reads clean.
const NEW_ORG = {
  existingModel: 'destination',
  existingModelUnreadable: false,
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
  assertEquals(d.inferredModel, 'destination');
});

// ── THE CASE THIS FILE EXISTS FOR ────────────────────────────────────────────
// J2S on 2026-08-04: destination, 72 registrations holding a payment intent, 32
// pending installments, connecting acct_1TZhD8 which Stripe reports as Standard
// (so operatorBearsStripeFees is true and the inference would say 'direct').
Deno.test('established destination org connecting a Standard account KEEPS destination', () => {
  const d = decideChargeModel({
    existingModel: 'destination',
    existingModelUnreadable: false,
    hasTakenMoney: true,
    historyUnreadable: false,
    operatorBearsStripeFees: true,
  });
  assertEquals(d.chargeModel, 'destination');
  assertEquals(d.preserved, true);
  assertEquals(d.inferredModel, 'direct');
});

Deno.test('established direct org keeps direct even if the new account does not confirm', () => {
  const d = decideChargeModel({
    existingModel: 'direct',
    existingModelUnreadable: false,
    hasTakenMoney: true,
    historyUnreadable: false,
    operatorBearsStripeFees: false,
  });
  assertEquals(d.chargeModel, 'direct');
  assertEquals(d.preserved, true);
  assertEquals(d.inferredModel, 'destination');
});

// ── fail-closed on the history read ──────────────────────────────────────────
Deno.test('unreadable history preserves, and OVERRIDES hasTakenMoney=false', () => {
  // The ordering trap: if hasTakenMoney were trusted on its own, an unreadable
  // history (which reports false) would fall through to the inference branch and
  // silently flip an established org. Prove the guard, not the happy path.
  const d = decideChargeModel({
    existingModel: 'destination',
    existingModelUnreadable: false,
    hasTakenMoney: false,
    historyUnreadable: true,
    operatorBearsStripeFees: true,
  });
  assertEquals(d.chargeModel, 'destination');
  assertEquals(d.preserved, true);
  assertEquals(d.source.includes('could not read'), true);
});

// ── the NULL outcome: cannot preserve what you cannot read ───────────────────
Deno.test('established org whose current model is unreadable writes NOTHING', () => {
  // The code-review bug: this used to return 'destination', silently rewriting a
  // direct org while the log claimed preservation.
  const d = decideChargeModel({
    existingModel: null, // unread, so the caller has nothing to pass
    existingModelUnreadable: true,
    hasTakenMoney: true,
    historyUnreadable: false,
    operatorBearsStripeFees: false,
  });
  assertEquals(d.chargeModel, null);
  assertEquals(d.preserved, true);
  assertEquals(d.source.includes('left unchanged'), true);
});

Deno.test('both reads failing writes NOTHING rather than defaulting', () => {
  const d = decideChargeModel({
    existingModel: null,
    existingModelUnreadable: true,
    hasTakenMoney: false,
    historyUnreadable: true,
    operatorBearsStripeFees: true,
  });
  assertEquals(d.chargeModel, null);
  assertEquals(d.preserved, true);
});

Deno.test('a genuinely NEW org still infers even if its model read failed', () => {
  // The null outcome must not over-trigger. History read fine and says no money,
  // so there is nothing to protect and onboarding must still work. If this
  // regressed, every new operator whose org read hiccupped would be left with no
  // charge model written at all.
  const d = decideChargeModel({
    existingModel: null,
    existingModelUnreadable: true,
    hasTakenMoney: false,
    historyUnreadable: false,
    operatorBearsStripeFees: true,
  });
  assertEquals(d.chargeModel, 'direct');
  assertEquals(d.preserved, false);
});

// ── coercion: never a guess toward direct ────────────────────────────────────
Deno.test('null existing model resolves to destination, never direct', () => {
  const d = decideChargeModel({
    existingModel: null,
    existingModelUnreadable: false,
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
    existingModelUnreadable: false,
    hasTakenMoney: true,
    historyUnreadable: false,
    operatorBearsStripeFees: false,
  });
  assertEquals(d.chargeModel, 'destination');
});

Deno.test('every input combination holds the three invariants', () => {
  const models: (string | null)[] = ['destination', 'direct', null, '', 'DIRECT', 'nonsense'];
  const bools = [true, false];
  let checked = 0;
  for (const existingModel of models) {
    for (const existingModelUnreadable of bools) {
      for (const hasTakenMoney of bools) {
        for (const historyUnreadable of bools) {
          for (const operatorBearsStripeFees of bools) {
            const d = decideChargeModel({
              existingModel,
              existingModelUnreadable,
              hasTakenMoney,
              historyUnreadable,
              operatorBearsStripeFees,
            });
            const where =
              `existing=${existingModel} modelUnread=${existingModelUnreadable} ` +
              `money=${hasTakenMoney} histUnread=${historyUnreadable} bears=${operatorBearsStripeFees}`;

            // 1. Always null or a model the CHECK constraint permits.
            assertEquals(
              d.chargeModel === null || d.chargeModel === 'destination' || d.chargeModel === 'direct',
              true,
              `invalid model ${d.chargeModel} for ${where}`,
            );

            // 2. 'direct' is never manufactured - it comes from the org already
            //    being direct, or from the account itself saying so.
            if (d.chargeModel === 'direct') {
              assertEquals(
                existingModel === 'direct' || operatorBearsStripeFees,
                true,
                `manufactured direct for ${where}`,
              );
            }

            // 3. Writing nothing happens ONLY when preservation was required AND
            //    the current value was unreadable. Any other null would be a
            //    silent no-op on a live money column.
            if (d.chargeModel === null) {
              assertEquals(
                existingModelUnreadable && (historyUnreadable || hasTakenMoney),
                true,
                `unjustified null for ${where}`,
              );
            }
            checked++;
          }
        }
      }
    }
  }
  assertEquals(checked, 96);
});
