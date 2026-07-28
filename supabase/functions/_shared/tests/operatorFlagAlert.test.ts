import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { renderFlagAlert } from '../operatorFlagAlert.ts';

const base = {
  orgName: 'Onboard test',
  ratePct: 22.5,
  threshold: 15,
  transactions: 40,
  refunded: 9,
  windowDays: 30,
  siteUrl: 'https://enrops-staging.netlify.app',
};

Deno.test('the alert states the real numbers, not just "over the threshold"', () => {
  const a = renderFlagAlert(base);
  assertEquals(a.text.includes('9 of their last 40 charges'), true);
  assertEquals(a.text.includes('22.5%'), true);
  assertEquals(a.text.includes('15%'), true);
  assertEquals(a.subject.includes('22.5%'), true);
  assertEquals(a.subject.includes('Onboard test'), true);
});

// v4 section 4, verbatim: "This never blocks or delays any individual refund -
// it's a dashboard flag for us, not a gate on the transaction." If a future
// edit makes this read like an enforcement notice, the tone has drifted from
// what the checklist actually asked for.
Deno.test('POLICY: the alert says nothing was blocked and nobody was told', () => {
  const a = renderFlagAlert(base);
  assertEquals(a.text.includes('Nothing has been blocked'), true);
  assertEquals(a.text.includes('nothing has been said to them'), true);
});

// A rate can be high for entirely innocent reasons. An alert that reads as an
// accusation gets someone treated badly on a statistic.
Deno.test('POLICY: the alert offers the innocent explanations first', () => {
  const a = renderFlagAlert(base);
  assertEquals(a.text.includes('often innocent'), true);
});

Deno.test('the alert links the screen that shows the detail', () => {
  const a = renderFlagAlert(base);
  assertEquals(a.text.includes('https://enrops-staging.netlify.app/admin/dev/refund-watch'), true);
});

Deno.test('POLICY: no em dashes', () => {
  const a = renderFlagAlert(base);
  assertEquals(`${a.subject} ${a.text}`.includes('—'), false);
});
