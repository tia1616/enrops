import { assertEquals, assertNotEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  addDaysUtc, chargeIdempotencyKey, declineFollowUp, formatRetryDate, isFinalNotice, NO_RETRY_DECLINE_CODES,
  NOT_CHARGEABLE_REGISTRATION_STATUSES, planDeclineRetry, RETRY_GAPS_DAYS,
} from '../declineRetry.ts';

const plan = (outcome: 'retry_scheduled' | 'retries_exhausted' | 'hard_decline' | 'not_a_decline') =>
  ({
    outcome, nextRetryOn: outcome === 'retry_scheduled' ? '2026-10-10' : null, retryNumber: null, totalRetries: 2,
    payBy: null, providerFollowUpOn: null,
  });

Deno.test('follow-up: first decline tells the family once and the business', () => {
  assertEquals(
    declineFollowUp({ plan: plan('retry_scheduled'), retriesDone: 0, familyAlreadyTold: false, hasEmail: true }),
    { familyEmail: 'first', alertBusiness: true },
  );
  // already told about this plan payment - no second first-email, business still alerted
  assertEquals(
    declineFollowUp({ plan: plan('not_a_decline'), retriesDone: 0, familyAlreadyTold: true, hasEmail: true }),
    { familyEmail: null, alertBusiness: true },
  );
});

Deno.test('follow-up: a dead card goes straight to the final notice (Jessica 2026-10-08)', () => {
  // first attempt, never told before
  assertEquals(
    declineFollowUp({ plan: plan('hard_decline'), retriesDone: 0, familyAlreadyTold: false, hasEmail: true }),
    { familyEmail: 'final', alertBusiness: true },
  );
  // already given the first email earlier in the cycle: the final still goes - it carries the deadline
  assertEquals(
    declineFollowUp({ plan: plan('hard_decline'), retriesDone: 1, familyAlreadyTold: true, hasEmail: true }),
    { familyEmail: 'final', alertBusiness: true },
  );
});

Deno.test('follow-up: a failed retry with another booked is silent to both sides', () => {
  assertEquals(
    declineFollowUp({ plan: plan('retry_scheduled'), retriesDone: 1, familyAlreadyTold: true, hasEmail: true }),
    { familyEmail: null, alertBusiness: false },
  );
  // ...even if the first email never went out (silence is about the retry, not the dedup)
  assertEquals(
    declineFollowUp({ plan: plan('retry_scheduled'), retriesDone: 1, familyAlreadyTold: false, hasEmail: true }),
    { familyEmail: null, alertBusiness: false },
  );
});

Deno.test('follow-up: the last retry always sends the final email, past the dedup', () => {
  assertEquals(
    declineFollowUp({ plan: plan('retries_exhausted'), retriesDone: 2, familyAlreadyTold: true, hasEmail: true }),
    { familyEmail: 'final', alertBusiness: true },
  );
  assertEquals(
    declineFollowUp({ plan: plan('retries_exhausted'), retriesDone: 2, familyAlreadyTold: true, hasEmail: false }),
    { familyEmail: null, alertBusiness: true },
  );
  // a dead card found BY a retry is not quiet - the business must hear the retries ended
  assertEquals(
    declineFollowUp({ plan: plan('hard_decline'), retriesDone: 1, familyAlreadyTold: true, hasEmail: true }).alertBusiness,
    true,
  );
});

Deno.test('a removed or refunded registration is never chargeable; an active one is', () => {
  assertEquals([...NOT_CHARGEABLE_REGISTRATION_STATUSES].sort(), ['cancelled', 'refunded']);
  for (const s of ['confirmed', 'pending', 'waitlist']) {
    assertEquals(NOT_CHARGEABLE_REGISTRATION_STATUSES.includes(s), false, s);
  }
});

const TODAY = '2026-10-07';

Deno.test('policy: retries on day 3 and day 7, then stops', () => {
  assertEquals(RETRY_GAPS_DAYS, [3, 4]);

  const first = planDeclineRetry({ isCardDecline: true, codes: ['insufficient_funds', 'card_declined'], retriesDone: 0, today: TODAY });
  assertEquals(first, { outcome: 'retry_scheduled', nextRetryOn: '2026-10-10', retryNumber: 1, totalRetries: 2, payBy: null, providerFollowUpOn: null });

  // Retry 1 ran on day 3 (10 Oct) and failed: retry 2 is four days later = day 7.
  const second = planDeclineRetry({ isCardDecline: true, codes: ['insufficient_funds'], retriesDone: 1, today: '2026-10-10' });
  assertEquals(second, { outcome: 'retry_scheduled', nextRetryOn: '2026-10-14', retryNumber: 2, totalRetries: 2, payBy: null, providerFollowUpOn: null });

  // Final notice on 14 Oct: the family has until the 18th, the business hears
  // on the morning of the 19th - five days after the final notice, the day
  // after the deadline, so "the deadline has passed" is true when it arrives.
  const last = planDeclineRetry({ isCardDecline: true, codes: ['insufficient_funds'], retriesDone: 2, today: '2026-10-14' });
  assertEquals(last, {
    outcome: 'retries_exhausted', nextRetryOn: null, retryNumber: null, totalRetries: 2,
    payBy: '2026-10-18', providerFollowUpOn: '2026-10-19',
  });

  // Past the end stays exhausted - never wraps round into a new schedule.
  assertEquals(planDeclineRetry({ isCardDecline: true, codes: [], retriesDone: 9, today: TODAY }).outcome, 'retries_exhausted');
});

Deno.test('policy: a dead card is never retried, whichever field the code arrives in', () => {
  // decline_code carries it
  assertEquals(planDeclineRetry({ isCardDecline: true, codes: ['stolen_card', 'card_declined'], retriesDone: 0, today: TODAY }).outcome, 'hard_decline');
  // code carries it, no decline_code
  assertEquals(planDeclineRetry({ isCardDecline: true, codes: [undefined, 'expired_card'], retriesDone: 0, today: TODAY }).outcome, 'hard_decline');
  for (const code of NO_RETRY_DECLINE_CODES) {
    const p = planDeclineRetry({ isCardDecline: true, codes: [code], retriesDone: 0, today: TODAY });
    assertEquals(p.nextRetryOn, null, code);
  }
});

Deno.test('policy: the common temporary declines ARE retried', () => {
  for (const code of ['insufficient_funds', 'generic_decline', 'do_not_honor', 'try_again_later', 'processing_error', 'card_velocity_exceeded']) {
    assertEquals(NO_RETRY_DECLINE_CODES.has(code), false, code);
    assertEquals(planDeclineRetry({ isCardDecline: true, codes: [code, 'card_declined'], retriesDone: 0, today: TODAY }).outcome, 'retry_scheduled', code);
  }
});

Deno.test('policy: an error that is not a bank decline is never retried automatically', () => {
  // A timeout or outage has an unknown outcome - retrying on a new key could charge twice.
  const p = planDeclineRetry({ isCardDecline: false, codes: ['api_connection_error'], retriesDone: 0, today: TODAY });
  assertEquals(p, { outcome: 'not_a_decline', nextRetryOn: null, retryNumber: null, totalRetries: 2, payBy: null, providerFollowUpOn: null });
  assertEquals(isFinalNotice(p), false);
});

Deno.test('policy: a dead card gets the SAME deadline and follow-up as running out of retries', () => {
  const hard = planDeclineRetry({ isCardDecline: true, codes: ['invalid_account', 'card_declined'], retriesDone: 0, today: TODAY });
  assertEquals(hard, {
    outcome: 'hard_decline', nextRetryOn: null, retryNumber: null, totalRetries: 2,
    payBy: '2026-10-11', providerFollowUpOn: '2026-10-12',
  });
  const exhausted = planDeclineRetry({ isCardDecline: true, codes: ['insufficient_funds'], retriesDone: 2, today: TODAY });
  assertEquals([hard.payBy, hard.providerFollowUpOn], [exhausted.payBy, exhausted.providerFollowUpOn]);
  assertEquals([isFinalNotice(hard), isFinalNotice(exhausted)], [true, true]);
  // a booked retry is never a final notice
  assertEquals(isFinalNotice(planDeclineRetry({ isCardDecline: true, codes: [], retriesDone: 0, today: TODAY })), false);
});

Deno.test('policy: a garbage retry count cannot book a retry off the end of the schedule', () => {
  assertEquals(planDeclineRetry({ isCardDecline: true, codes: [], retriesDone: -3, today: TODAY }).retryNumber, 1);
  assertEquals(planDeclineRetry({ isCardDecline: true, codes: [], retriesDone: NaN, today: TODAY }).retryNumber, 1);
  assertEquals(planDeclineRetry({ isCardDecline: true, codes: [], retriesDone: 1.7, today: TODAY }).retryNumber, 2);
});

Deno.test('dates: UTC calendar arithmetic across month and year ends', () => {
  assertEquals(addDaysUtc('2026-10-30', 3), '2026-11-02');
  assertEquals(addDaysUtc('2026-12-30', 4), '2027-01-03');
  assertEquals(addDaysUtc('2027-02-27', 3), '2027-03-02');
  assertEquals(formatRetryDate('2026-10-10'), 'Saturday, October 10');
});

Deno.test('idempotency: first attempt keeps the historic key; every attempt after a decline gets a new one', () => {
  const ids = ['a', 'b'];
  assertEquals(chargeIdempotencyKey(ids, 0), 'installment_group_a_b');
  const k1 = chargeIdempotencyKey(ids, 1);
  const k2 = chargeIdempotencyKey(ids, 2);
  assertEquals(k1, 'installment_group_a_b_d1');
  assertNotEquals(k1, k2);
  // Same inputs, same key: two cron runs racing on one attempt still collapse.
  assertEquals(chargeIdempotencyKey(ids, 1), k1);
});
