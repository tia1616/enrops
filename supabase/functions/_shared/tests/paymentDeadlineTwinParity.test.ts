// Twin-parity guard for the family's card deadline, in the spirit of
// roomLabelTwinParity.test.ts: src/lib/paymentDeadline.js is plain ESM, so the
// charger's OWN plan is pushed through the browser copy and must land on the
// same date the family's final email names.
//
// Why it matters: the final email says "put a new card on by Sunday" and the
// parent portal repeats the date. If the two ever disagree, a family is given
// two deadlines for one payment.
//
// If this fails: make the two files agree. Do not loosen the comparison.

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { formatRetryDate, NOT_CHARGEABLE_REGISTRATION_STATUSES as EDGE_NOT_CHARGEABLE, planDeclineRetry } from '../declineRetry.ts';

const WEB = new URL('../../../../src/lib/paymentDeadline.js', import.meta.url);
const {
  payByFromFollowUp, earliestPayBy, formatDeadline, NOT_CHARGEABLE_REGISTRATION_STATUSES: WEB_NOT_CHARGEABLE,
} = await import(WEB.href);

Deno.test('the portal and the charger agree on which families are no longer on a plan', () => {
  // The portal must never ask for a card from a family the charger refuses to charge.
  assertEquals([...WEB_NOT_CHARGEABLE].sort(), [...EDGE_NOT_CHARGEABLE].sort());
  assertEquals(WEB_NOT_CHARGEABLE.includes('cancelled'), true);
});

// Final notices on dates that cross month, year and leap-year boundaries, for
// both ways a payment reaches a final notice.
const FINAL_DAYS = ['2026-10-14', '2026-10-30', '2026-12-29', '2027-02-26', '2028-02-27'];

Deno.test('the portal derives exactly the deadline the final email names', () => {
  for (const today of FINAL_DAYS) {
    for (const [codes, retriesDone] of [[['insufficient_funds'], 2], [['invalid_account'], 0]] as const) {
      const plan = planDeclineRetry({ isCardDecline: true, codes: [...codes], retriesDone, today });
      assertEquals(
        payByFromFollowUp(plan.providerFollowUpOn),
        plan.payBy,
        `final notice on ${today} (${plan.outcome}): email says ${plan.payBy}, portal would say ` +
          `${payByFromFollowUp(plan.providerFollowUpOn)}. src/lib/paymentDeadline.js and _shared/declineRetry.ts have drifted.`,
      );
      assertEquals(formatDeadline(plan.payBy!), formatRetryDate(plan.payBy!));
    }
  }
});

// Guards the guard: a twin that returned null for everything would compare
// null to null on a plan with no deadline and pass while proving nothing.
Deno.test('the browser twin returns real dates and ignores rows with none', () => {
  assertEquals(payByFromFollowUp('2026-10-19'), '2026-10-18');
  assertEquals(payByFromFollowUp(null), null);
  assertEquals(payByFromFollowUp('not a date'), null);
  assertEquals(earliestPayBy([{ provider_followup_on: null }, { provider_followup_on: '2026-10-25' }, { provider_followup_on: '2026-10-19' }]), '2026-10-18');
  assertEquals(earliestPayBy([{ provider_followup_on: null }]), null);
  assertEquals(earliestPayBy(undefined), null);
});
