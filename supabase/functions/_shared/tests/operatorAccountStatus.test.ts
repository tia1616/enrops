// Equivalence proof for the operatorAccountStatus extraction (2026-07-29).
//
// stripe-webhook's handleAccountUpdated and sync-operator-stripe-status each
// carried their own hand-copied copy of this mapping. Both now call the shared
// mapper. This test is the empirical proof that the extraction changed nothing:
// it re-implements the PRE-REFACTOR algorithm verbatim as an oracle and asserts
// the shared mapper agrees across the ENTIRE input matrix, not a happy path.
//
// The oracle is a copy of the old code, NOT a call to the new code - a test that
// compares a function to itself passes and proves nothing.
//
// Run: deno test supabase/functions/_shared/tests/operatorAccountStatus.test.ts
// (No permission flags: this file only imports a pure function. An earlier
//  version of this line said `--allow-none`, which is not a real Deno flag and
//  made the documented command fail outright.)

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import {
  mapOperatorAccountStatus,
  OperatorAccountSnapshot,
} from '../operatorAccountStatus.ts';

// ── ORACLE: the mapping exactly as it stood in stripe-webhook before the
// extraction. Do not "tidy" this - its value is being an unchanged copy.
function oracle(account: OperatorAccountSnapshot): string {
  const chargesEnabled = account.charges_enabled === true;
  const payoutsEnabled = account.payouts_enabled === true;
  const detailsSubmitted = account.details_submitted === true;
  const disabledReason = account.requirements?.disabled_reason || null;

  const PENDING_REVIEW_REASONS = ['requirements.pending_verification', 'under_review'];
  const isPendingReview =
    disabledReason !== null && PENDING_REVIEW_REASONS.includes(disabledReason);

  let nextStatus: string;
  if (chargesEnabled && payoutsEnabled) {
    nextStatus = 'active';
  } else if (detailsSubmitted && isPendingReview) {
    nextStatus = 'verifying';
  } else if (detailsSubmitted && !chargesEnabled && disabledReason) {
    nextStatus = 'restricted';
  } else {
    nextStatus = 'onboarding';
  }
  return nextStatus;
}

const BOOLS: Array<boolean | null | undefined> = [true, false, null, undefined];
const REASONS: Array<string | null | undefined> = [
  null,
  undefined,
  'requirements.pending_verification',
  'under_review',
  'requirements.past_due',
  'rejected.fraud',
  '',
];

Deno.test('shared mapper matches the pre-refactor algorithm across the full matrix', () => {
  let cases = 0;
  for (const charges of BOOLS) {
    for (const payouts of BOOLS) {
      for (const details of BOOLS) {
        for (const reason of REASONS) {
          // Cover both "no requirements object at all" and "requirements with a
          // reason" - a Standard account connected by OAuth can arrive either way.
          for (const withRequirements of [true, false]) {
            const account: OperatorAccountSnapshot = {
              charges_enabled: charges,
              payouts_enabled: payouts,
              details_submitted: details,
              requirements: withRequirements ? { disabled_reason: reason } : null,
            };
            const got = mapOperatorAccountStatus(account).status;
            const want = oracle(account);
            assertEquals(
              got,
              want,
              `mismatch for charges=${charges} payouts=${payouts} details=${details} ` +
                `reason=${reason} withRequirements=${withRequirements}: got ${got}, oracle says ${want}`,
            );
            cases++;
          }
        }
      }
    }
  }
  // Guard against the loop silently collapsing and the test passing on nothing.
  assertEquals(cases, BOOLS.length ** 3 * REASONS.length * 2);
});

Deno.test('the four documented buckets are each actually reachable', () => {
  // An N-way condition needs N proven states. If a branch is unreachable, the
  // mapping is lying about what it can return.
  assertEquals(
    mapOperatorAccountStatus({ charges_enabled: true, payouts_enabled: true }).status,
    'active',
  );
  assertEquals(
    mapOperatorAccountStatus({
      details_submitted: true,
      requirements: { disabled_reason: 'requirements.pending_verification' },
    }).status,
    'verifying',
  );
  assertEquals(
    mapOperatorAccountStatus({
      details_submitted: true,
      requirements: { disabled_reason: 'under_review' },
    }).status,
    'verifying',
  );
  assertEquals(
    mapOperatorAccountStatus({
      details_submitted: true,
      charges_enabled: false,
      requirements: { disabled_reason: 'requirements.past_due' },
    }).status,
    'restricted',
  );
  assertEquals(mapOperatorAccountStatus({}).status, 'onboarding');
});

Deno.test('never returns a status that is set elsewhere', () => {
  // 'disconnected' is the deauthorize handler's, 'not_connected' is set at
  // insert. If this mapper ever returned one, a status poll would silently
  // resurrect or orphan an org.
  //
  // The OperatorAccountStatus union already makes both unreachable, and the type
  // checker says so. Widening to string on purpose: the point of this test is to
  // fail loudly if someone later broadens that union, which is exactly when the
  // compile-time guarantee quietly disappears.
  for (const charges of BOOLS) {
    for (const payouts of BOOLS) {
      for (const details of BOOLS) {
        for (const reason of REASONS) {
          const status: string = mapOperatorAccountStatus({
            charges_enabled: charges,
            payouts_enabled: payouts,
            details_submitted: details,
            requirements: { disabled_reason: reason },
          }).status;
          if (status === 'disconnected' || status === 'not_connected') {
            throw new Error(`mapper returned a caller-owned status: ${status}`);
          }
        }
      }
    }
  }
});

Deno.test('an established Standard account connecting via OAuth reads as active', () => {
  // The shape stripe-oauth-callback will see: a real trading account, charges
  // and payouts already on, nothing outstanding. If this did not come back
  // 'active' with charges enabled, buildChargeRouting would fail closed and
  // every family would be told the provider cannot take payments.
  const state = mapOperatorAccountStatus({
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    requirements: { disabled_reason: null },
  });
  assertEquals(state.status, 'active');
  assertEquals(state.chargesEnabled, true);
  assertEquals(state.payoutsEnabled, true);
});
