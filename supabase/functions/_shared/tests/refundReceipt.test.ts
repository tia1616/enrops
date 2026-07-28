import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { renderRefundReceipt, refundCoversWholeCharge } from '../refundReceipt.ts';
import { PLATFORM_FOOTER_TEXT } from '../platformFooter.ts';

const BASE = {
  parentName: 'Jessica Vorster',
  childName: 'Ava',
  programName: 'Direct Charge Test Class',
  orgName: 'Onboard test',
  withdrawn: false,
};

// A $240 class with the 3% fee passed to the family: charged $247.20.
const FULL = { ...BASE, refundedCents: 24720, chargedCents: 24720, familyFeeCents: 720 };

Deno.test('states the amount coming back, in the subject and the body', () => {
  const r = renderRefundReceipt(FULL);
  assertEquals(r.subject.includes('$247.20'), true);
  assertEquals(r.text.includes('$247.20'), true);
  assertEquals(r.html.includes('$247.20'), true);
});

// POLICY, LOCKED. The platform-fee refund goes to the OPERATOR's balance, not
// to the family. Telling a family "we refunded our fee" is only true when their
// own refund covered the whole charge, because the fee was part of what they
// paid. Any other case must say nothing about the fee rather than imply the
// family received money that went somewhere else.
Deno.test('POLICY: mentions the enrops fee ONLY when the family got the whole charge back', () => {
  const whole = renderRefundReceipt(FULL);
  assertEquals(whole.text.includes('$7.20'), true);
  assertEquals(whole.text.toLowerCase().includes('enrops service fee'), true);

  // Partial refund: the family did NOT get the fee back.
  const partial = renderRefundReceipt({ ...FULL, refundedCents: 10000 });
  assertEquals(partial.text.includes('$7.20'), false);
  assertEquals(partial.text.toLowerCase().includes('service fee'), false);
});

Deno.test('says nothing about the fee when we cannot derive what the family paid', () => {
  const unknown = renderRefundReceipt({ ...BASE, refundedCents: 24720, chargedCents: null, familyFeeCents: null });
  assertEquals(unknown.text.toLowerCase().includes('service fee'), false);
  // Still tells them the amount.
  assertEquals(unknown.text.includes('$247.20'), true);
});

Deno.test('absorb orgs charged no fee, so no fee sentence appears', () => {
  const absorbed = renderRefundReceipt({ ...BASE, refundedCents: 24000, chargedCents: 24000, familyFeeCents: 0 });
  assertEquals(absorbed.text.toLowerCase().includes('service fee'), false);
});

Deno.test('refundCoversWholeCharge is false when the charge is unknown', () => {
  assertEquals(refundCoversWholeCharge({ ...BASE, refundedCents: 5000, chargedCents: null }), false);
  assertEquals(refundCoversWholeCharge({ ...BASE, refundedCents: 5000, chargedCents: 0 }), false);
  assertEquals(refundCoversWholeCharge({ ...BASE, refundedCents: 5000, chargedCents: 5000 }), true);
  assertEquals(refundCoversWholeCharge({ ...BASE, refundedCents: 5001, chargedCents: 5000 }), true);
});

Deno.test('withdrawn vs kept spot say different, accurate things', () => {
  const kept = renderRefundReceipt(FULL);
  assertEquals(kept.text.includes('still enrolled'), true);
  const gone = renderRefundReceipt({ ...FULL, withdrawn: true });
  assertEquals(gone.text.includes('no longer enrolled'), true);
  assertEquals(gone.text.includes('still enrolled'), false);
});

// POLICY, LOCKED (Jessica, 2026-07-28, reading a real receipt on prod).
// "Roster" is operator vocabulary, and what happens to the spot after a family
// cancels is the operator's business, not theirs. The old line read "has been
// taken off the roster and the spot is free for someone else", which is both
// jargon and cold at the worst possible moment.
Deno.test('POLICY: the family receipt never says "roster" or offers their spot on', () => {
  for (const w of [true, false, null]) {
    const r = renderRefundReceipt({ ...FULL, withdrawn: w });
    const blob = `${r.subject} ${r.text} ${r.html}`;
    assertEquals(/roster/i.test(blob), false, `withdrawn=${w} still says roster`);
    assertEquals(/free for someone else/i.test(blob), false, `withdrawn=${w} offers the spot on`);
  }
});

// POLICY, LOCKED. A refund made in the operator's own Stripe tells us money
// moved and nothing about whether the child was withdrawn. Claiming "still
// enrolled" after a full refund would be a guess that reads as a promise. Say
// nothing instead.
Deno.test('POLICY: unknown enrolment state says NOTHING about the spot', () => {
  const unknown = renderRefundReceipt({ ...FULL, withdrawn: null });
  assertEquals(unknown.text.includes('enrolled'), false);
  assertEquals(unknown.html.includes('enrolled'), false);
  // The rest of the receipt still stands on its own.
  assertEquals(unknown.text.includes('$247.20'), true);
  assertEquals(unknown.text.includes('business days'), true);
});

// HARD RULE on anything a family reads.
Deno.test('POLICY: no em dashes anywhere in the copy', () => {
  const r = renderRefundReceipt(FULL);
  assertEquals(r.subject.includes('—'), false, 'subject has an em dash');
  assertEquals(r.text.includes('—'), false, 'text has an em dash');
  assertEquals(r.html.includes('—'), false, 'html has an em dash');
});

// v4 section 8 wants the platform line on the refund receipt. The WORDING is
// not ours: it comes from _shared/platformFooter.ts, which owns the approved
// copy and the ?src= vocabulary. Asserting the module's output here rather than
// a literal string means a future copy change lands in one place.
Deno.test('carries the shared platform footer line, not hand-rolled copy (v4 section 8)', () => {
  const r = renderRefundReceipt(FULL);
  assertEquals(r.text.includes(PLATFORM_FOOTER_TEXT), true);
  assertEquals(r.html.includes(PLATFORM_FOOTER_TEXT), true);
  assertEquals(r.html.includes('src=receipt'), true, 'link must carry the receipt surface');
  // Lowercase brand, always.
  assertEquals(/Enrops/.test(r.text.replace(/getenrops/gi, '')), false, 'brand is lowercase enrops');
});

// POLICY, LOCKED. These exact phrases were retired on 2026-07-26. A receipt is a
// brand-new surface, so it is exactly where retired copy sneaks back in.
Deno.test('POLICY: none of the retired footer copy appears', () => {
  const r = renderRefundReceipt(FULL);
  const blob = `${r.subject} ${r.text} ${r.html}`;
  for (const dead of ['Powered by enrops', 'start your own program free', 'Try enrops free']) {
    assertEquals(blob.toLowerCase().includes(dead.toLowerCase()), false, `retired copy present: ${dead}`);
  }
  // The retired UTM tagging went with it; the standard is ?src=<surface>.
  assertEquals(blob.includes('utm_source'), false, 'UTM params were retired in favour of ?src=');
});

Deno.test('speaks as the PROVIDER, never as enrops, in the body', () => {
  const r = renderRefundReceipt(FULL);
  assertEquals(r.subject.includes('Onboard test'), true);
  assertEquals(r.text.includes('Onboard test has refunded'), true);
});

Deno.test('missing names degrade to something still sendable', () => {
  const r = renderRefundReceipt({
    orgName: 'Onboard test', refundedCents: 5000, withdrawn: false,
    parentName: null, childName: null, programName: null,
  });
  assertEquals(r.text.startsWith('Hi there,'), true);
  assertEquals(r.text.includes('$50.00'), true);
  assertEquals(r.text.includes('your registration'), true);
});

Deno.test('escapes names so a quote or bracket cannot break the html', () => {
  const r = renderRefundReceipt({ ...FULL, childName: 'A<script>x</script>', orgName: 'Bob\'s "Club" & Co' });
  assertEquals(r.html.includes('<script>'), false);
  assertEquals(r.html.includes('&amp;'), true);
});
