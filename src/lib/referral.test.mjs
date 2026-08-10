// Pins the referral vocabulary. Repo convention: plain node script with a
// pass/fail counter, run by scripts/run-src-tests.mjs.
//
// These exist because this list already leaked one tenant's channels to every
// other tenant once. The invariant is not the wording - it is that no answer
// names a provider unless that provider's own name was passed in.
import { REFERRAL_OPTIONS, referralOptions } from './referral.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}

// --- the shared list names no tenant ---------------------------------------
// The regression this guards: someone adds "Journey to STEAM email" (or any
// other operator's channel) as a literal string, and Shoreview Chess families
// are asked whether they heard from Journey to STEAM.
const TENANT_WORDS = ['journey', 'steam', 'j2s', 'ukulele', 'kumon', 'chess', 'pdx', 'portland', 'yoga'];
eq('no shared option names a tenant, city, or publication',
  REFERRAL_OPTIONS.filter((o) => TENANT_WORDS.some((w) => o.toLowerCase().includes(w))), []);

// --- the provider's own email is DERIVED ----------------------------------
eq('J2S gets its own name', referralOptions('Journey to STEAM').includes('Journey to STEAM email'), true);
eq('another tenant gets THEIR name, not J2S',
  referralOptions('Shoreview Chess').filter((o) => o.endsWith(' email') && !o.startsWith('School')),
  ['Shoreview Chess email']);
eq('one tenant never sees another tenant',
  referralOptions('Shoreview Chess').some((o) => o.includes('Journey to STEAM')), false);

// --- no name = no option (never "undefined email") -------------------------
// The failure this closes: an org row with a null/blank name renders an answer
// reading "undefined email" or " email" to a family mid-checkout.
eq('missing name offers the plain list', referralOptions(undefined), REFERRAL_OPTIONS);
eq('null name offers the plain list', referralOptions(null), REFERRAL_OPTIONS);
eq('blank name offers the plain list', referralOptions('   '), REFERRAL_OPTIONS);
eq('no option is ever "undefined email"',
  referralOptions(undefined).concat(referralOptions('')).some((o) => o.includes('undefined')), false);
eq('name is trimmed, not padded into the label',
  referralOptions('  Journey to STEAM  ').includes('Journey to STEAM email'), true);

// --- additive: nothing a family could already choose is taken away ---------
// how_heard is free text and old rows hold these exact strings, so dropping or
// rewording one orphans historical answers.
const withName = referralOptions('Journey to STEAM');
eq('every original option survives', REFERRAL_OPTIONS.every((o) => withName.includes(o)), true);
eq('exactly one option is added', withName.length, REFERRAL_OPTIONS.length + 1);
eq('"Other" stays last so the free-text escape hatch reads last',
  withName[withName.length - 1], 'Other');
// StepStudent.jsx shows the free-text box when the answer is exactly 'Other'.
// If a new label ever collided with that value the box would appear for it.
eq('the derived label is not the literal "Other"', withName.includes('Other email'), false);

// --- placement is anchored, not indexed -----------------------------------
eq('provider email sits right after the school-email answer',
  withName[withName.indexOf('School newsletter, PTO, or PTA email') + 1], 'Journey to STEAM email');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
