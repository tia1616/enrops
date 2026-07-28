import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { renderAsk } from '../operatorGrowthAsks.ts';
import { PLATFORM_FOOTER_TEXT } from '../platformFooter.ts';

Deno.test('review ask leads with what the operator just did, not with the ask', () => {
  const a = renderAsk('review', 'Onboard test', 1);
  assertEquals(a.subject, 'That refund went through cleanly');
  assertEquals(a.text.startsWith('Hi Onboard test,'), true);
  // The first substantive line is about their refund, not about reviewing us.
  const firstLine = a.text.split('\n').filter((l) => l.trim())[1];
  assertEquals(firstLine.includes('refunded a family'), true);
});

Deno.test('referral ask cites the real count, not a vague "a few"', () => {
  const a = renderAsk('referral', 'Onboard test', 3);
  assertEquals(a.text.includes('3 refunds'), true);
  assertEquals(a.subject, 'Know another program owner?');
});

// HARD RULE on anything going out over Jessica's name.
Deno.test('POLICY: no em dashes in either ask', () => {
  for (const ask of ['review', 'referral'] as const) {
    const a = renderAsk(ask, 'Onboard test', 3);
    assertEquals(`${a.subject} ${a.text} ${a.html}`.includes('—'), false, `${ask} has an em dash`);
  }
});

Deno.test('POLICY: brand is lowercase enrops everywhere', () => {
  for (const ask of ['review', 'referral'] as const) {
    const a = renderAsk(ask, 'Onboard test', 3);
    const blob = `${a.subject} ${a.text} ${a.html}`.replace(/getenrops/gi, '');
    assertEquals(/Enrops/.test(blob), false, `${ask} capitalises the brand`);
  }
});

Deno.test('both asks carry the shared platform footer, not hand-rolled copy', () => {
  for (const ask of ['review', 'referral'] as const) {
    const a = renderAsk(ask, 'Onboard test', 3);
    assertEquals(a.text.includes(PLATFORM_FOOTER_TEXT), true, `${ask} text missing the line`);
    assertEquals(a.html.includes(PLATFORM_FOOTER_TEXT), true, `${ask} html missing the line`);
  }
});

// POLICY, LOCKED. The review ask must always offer the reply-instead route.
// An ask that only accepts praise is how you stop hearing about problems.
Deno.test('POLICY: the review ask invites a complaint as readily as a review', () => {
  const a = renderAsk('review', 'Onboard test', 1);
  assertEquals(a.text.toLowerCase().includes('reply to this instead'), true);
  assertEquals(a.text.toLowerCase().includes('worth more to us than the review'), true);
});

Deno.test('a missing org name degrades to something still sendable', () => {
  const a = renderAsk('review', '', 1);
  assertEquals(a.text.startsWith('Hi there,'), true);
  assertEquals(a.html.includes('Hi there,'), true);
});

Deno.test('org names with html characters are escaped', () => {
  const a = renderAsk('referral', 'Bob\'s "Club" & <Co>', 3);
  assertEquals(a.html.includes('<Co>'), false);
  assertEquals(a.html.includes('&amp;'), true);
});
