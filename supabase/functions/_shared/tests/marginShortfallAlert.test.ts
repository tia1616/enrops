// The margin-shortfall alert's wording has a runner, because every fact in it
// is one somebody will act on with real money.
//
// The 2026-09-08 incident is the fixture throughout: three failed fee returns,
// $3.71 + $2.40 to Journey to STEAM and $1.01 to The Ukulele Project, found two
// days later only because somebody ran a query.

import { assertEquals, assertStringIncludes, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { renderShortfallAlert } from '../marginShortfallAlert.ts';

const base = {
  orgName: 'The Ukulele Project',
  owedCents: 101,
  items: [{ applicationFeeId: 'fee_1U6NPh', owedCents: 101, reason: 'Insufficient funds in your Stripe balance to refund this amount.' }],
  registrationId: 'reg-abc',
  siteUrl: 'https://enrops.com',
};

Deno.test('the subject carries the amount and the operator, because that decides whether it is opened now', () => {
  const { subject } = renderShortfallAlert(base);
  assertStringIncludes(subject, '$1.01');
  assertStringIncludes(subject, 'The Ukulele Project');
});

Deno.test('cents are rendered as money, never as raw cents', () => {
  const { text } = renderShortfallAlert({ ...base, owedCents: 371, items: [{ ...base.items[0], owedCents: 371 }] });
  assertStringIncludes(text, '$3.71');
  assert(!text.includes('371c'), 'the reader settles this in Stripe, where amounts are dollars');
});

Deno.test('it names the Stripe object to refund and quotes Stripe on why it failed', () => {
  const { text } = renderShortfallAlert(base);
  assertStringIncludes(text, 'fee_1U6NPh');
  assertStringIncludes(text, 'Insufficient funds in your Stripe balance');
});

Deno.test('it says refund the APPLICATION FEE and warns off a transfer', () => {
  // Jessica asked "how do i pay jeff's connected account" on 2026-09-09 and the
  // answer was: not with a transfer. A transfer lands as unattributed money and
  // never reconciles. The alert has to pre-empt that, because it is the
  // instruction somebody follows at speed.
  const { text } = renderShortfallAlert(base);
  assertStringIncludes(text, 'application fee');
  assertStringIncludes(text, 'NOT a transfer');
});

Deno.test('it states that nothing retries, because that is the whole reason it exists', () => {
  const { text } = renderShortfallAlert(base);
  assertStringIncludes(text, 'NOTHING RETRIES IT');
});

Deno.test('it says the family is unaffected, so nobody chases the wrong problem', () => {
  const { text } = renderShortfallAlert(base);
  assertStringIncludes(text, 'family is unaffected');
});

Deno.test('it says the provider has NOT been told and should not be', () => {
  // The operator-facing version of this message was removed on 2026-09-08 after
  // Jeff read one. If this internal copy ever drifts into implying the provider
  // knows, somebody will reply to them about it.
  const { text } = renderShortfallAlert(base);
  assertStringIncludes(text, 'has NOT been told');
});

Deno.test('several shortfalls on one refund are all listed, not just the first', () => {
  const { text, subject } = renderShortfallAlert({
    ...base,
    orgName: 'Journey to STEAM',
    owedCents: 611,
    items: [
      { applicationFeeId: 'fee_A', owedCents: 371, reason: 'Insufficient funds.' },
      { applicationFeeId: 'fee_B', owedCents: 240, reason: 'Insufficient funds.' },
    ],
  });
  assertStringIncludes(text, 'fee_A');
  assertStringIncludes(text, 'fee_B');
  assertStringIncludes(text, '$3.71');
  assertStringIncludes(text, '$2.40');
  // The subject totals them, so the headline is the debt and not one slice.
  assertStringIncludes(subject, '$6.11');
});

Deno.test('NO EM DASHES anywhere in the rendered alert', () => {
  const { subject, text } = renderShortfallAlert(base);
  assertEquals(subject.includes('—'), false);
  assertEquals(text.includes('—'), false);
});
