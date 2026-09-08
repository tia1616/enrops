// The gift arithmetic families are shown at checkout. Every number here has to
// equal what create-checkout charges, so the cases below are deliberately the
// same ones _shared/tests/scholarshipFund.test.ts pins on the server side.
import {
  coverFeeCents,
  chargedGiftCents,
  giftWithinBounds,
  formatGift,
  parseGiftInput,
} from './scholarshipFund.js';

const CFG = {
  enabled: true,
  min_cents: 100,
  max_cents: 500000,
  cover_fee_pct: 0.029,
};

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) pass++;
  else { fail++; console.log(`FAIL  ${name}`); }
}

// --- the fee cover ---
{
  // 2.9% of a gift, and NOTHING else. The flat 30c Stripe charges per successful
  // charge is already covered by the tuition the family is paying alongside; a
  // second one here would be 6% of a $5 gift.
  ok('$5 gift covers 15c', coverFeeCents(500, true, CFG) === 15);
  ok('$10 gift covers 29c', coverFeeCents(1000, true, CFG) === 29);
  ok('$25 gift covers 73c', coverFeeCents(2500, true, CFG) === 73);
  ok('$50 gift covers 145c', coverFeeCents(5000, true, CFG) === 145);
  ok('declining the box costs nothing', coverFeeCents(2500, false, CFG) === 0);
  ok('a zero gift covers nothing', coverFeeCents(0, true, CFG) === 0);
  ok('a negative gift covers nothing', coverFeeCents(-100, true, CFG) === 0);
  // A provider who sets the rate to 0 has effectively turned the box off; it
  // must not fall back to a hardcoded 2.9%.
  ok('a 0% configured rate covers nothing', coverFeeCents(2500, true, { cover_fee_pct: 0 }) === 0);
  ok('a missing rate covers nothing', coverFeeCents(2500, true, {}) === 0);
}

// --- what the card is charged ---
{
  ok('$25 + cover charges $25.73', chargedGiftCents(2500, true, CFG) === 2573);
  ok('$25 without cover charges $25.00', chargedGiftCents(2500, false, CFG) === 2500);
  ok('no gift charges nothing', chargedGiftCents(0, true, CFG) === 0);
}

// --- bounds ---
{
  ok('the minimum is allowed', giftWithinBounds(100, CFG) === true);
  ok('a cent under the minimum is refused', giftWithinBounds(99, CFG) === false);
  ok('the maximum is allowed', giftWithinBounds(500000, CFG) === true);
  ok('a cent over the maximum is refused', giftWithinBounds(500001, CFG) === false);
  ok('a fractional cent is refused', giftWithinBounds(100.5, CFG) === false);
  // The fund being switched off is not a bounds question, but the UI asks this
  // ONE function whether to enable the Pay button, so it has to answer for it.
  ok('a disabled fund refuses every amount', giftWithinBounds(2500, { ...CFG, enabled: false }) === false);
  ok('a missing config refuses every amount', giftWithinBounds(2500, null) === false);
  // int4: what we send must be storable in donations.gift_cents.
  ok('the default maximum stays inside int4', 500000 < 2147483647);
}

// --- display ---
{
  ok('whole dollars have no cents', formatGift(2500) === '$25');
  ok('an odd amount keeps its cents', formatGift(2573) === '$25.73');
  ok('a single cent renders', formatGift(1) === '$0.01');
}

// --- the custom-amount box, as a person actually types into it ---
{
  ok('"25" is $25', parseGiftInput('25') === 2500);
  ok('"25.50" is $25.50', parseGiftInput('25.50') === 2550);
  ok('"$25" is $25', parseGiftInput('$25') === 2500);
  ok('"1,000" is $1000', parseGiftInput('1,000') === 100000);
  ok('" 25 " is $25', parseGiftInput(' 25 ') === 2500);
  // Mid-typing states must not throw or produce a wrong number.
  ok('"" is not an amount yet', parseGiftInput('') === null);
  ok('"25." is tolerated while typing', parseGiftInput('25.') === 2500);
  ok('"." is not an amount', parseGiftInput('.') === null);
  ok('"abc" is not an amount', parseGiftInput('abc') === null);
  ok('"-5" is not an amount', parseGiftInput('-5') === null);
  ok('"0" is not an amount', parseGiftInput('0') === null);
  // Three decimal places would round to a half-cent the server would reject.
  ok('"25.005" is refused rather than rounded', parseGiftInput('25.005') === null);
  ok('a non-string is not an amount', parseGiftInput(2500) === null);
}

console.log(`\nscholarshipFund: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
