// parseBonusDollars — the gas-bonus money path on the after-school board.
// Every case below is a way an operator can actually mistype a dollar amount;
// the ones marked REVIEW were real bugs caught in code review on 2026-08-18.
import { parseBonusDollars } from './bonusAmount.js';

const MAX = 10000;
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) pass++;
  else { fail++; console.log(`FAIL  ${name}`); }
}

// --- no bonus is not an error ---
{
  for (const blank of ['', '   ', null, undefined]) {
    const r = parseBonusDollars(blank, MAX);
    ok(`blank (${JSON.stringify(blank)}) -> no bonus, no error`, r.cents === null && r.error === null);
  }
  const zero = parseBonusDollars('0', MAX);
  ok('"0" means no bonus, not a $0 line', zero.cents === null && zero.error === null);
  const zeroDec = parseBonusDollars('0.00', MAX);
  ok('"0.00" means no bonus', zeroDec.cents === null && zeroDec.error === null);
}

// --- valid amounts convert to cents ---
{
  ok('35 -> 3500 cents', parseBonusDollars('35', MAX).cents === 3500);
  ok('35.5 -> 3550 cents', parseBonusDollars('35.5', MAX).cents === 3550);
  ok('35.50 -> 3550 cents', parseBonusDollars('35.50', MAX).cents === 3550);
  ok('0.99 -> 99 cents', parseBonusDollars('0.99', MAX).cents === 99);
  ok('whitespace tolerated', parseBonusDollars('  42  ', MAX).cents === 4200);
  ok('leading $ tolerated', parseBonusDollars('$40', MAX).cents === 4000);
  ok('thousands comma tolerated', parseBonusDollars('1,250', MAX).cents === 125000);
  ok('valid amount has no error', parseBonusDollars('35', MAX).error === null);
}

// --- REVIEW: a negative was silently dropped, so no bonus was paid ---
{
  const r = parseBonusDollars('-20', MAX);
  ok('negative -> error, not silent', r.error !== null);
  ok('negative -> no cents', r.cents === null);
}

// --- REVIEW: unparseable was silently dropped ---
{
  const r = parseBonusDollars('abc', MAX);
  ok('letters -> error, not silent', r.error !== null && r.cents === null);
}

// --- the dangerous parseFloat cases: a slip must NOT quietly underpay ---
{
  // parseFloat("3 5") === 3 — would have paid $3 instead of $35.
  const spaced = parseBonusDollars('3 5', MAX);
  ok('"3 5" -> error, never $3', spaced.error !== null && spaced.cents === null);
  // parseFloat("35abc") === 35 — trailing junk means we cannot trust the intent.
  const trailing = parseBonusDollars('35abc', MAX);
  ok('"35abc" -> error', trailing.error !== null && trailing.cents === null);
  // parseFloat("1e3") === 1000 — an exponent is never a typed dollar amount.
  const expo = parseBonusDollars('1e3', MAX);
  ok('"1e3" -> error, never $1000', expo.error !== null && expo.cents === null);
  // Sub-cent precision cannot be represented; reject rather than round silently.
  const subCent = parseBonusDollars('10.005', MAX);
  ok('"10.005" -> error', subCent.error !== null && subCent.cents === null);
}

// --- REVIEW: an oversized amount overflowed int4 and showed raw Postgres text ---
{
  const r = parseBonusDollars('99999999', MAX);
  ok('over the cap -> error', r.error !== null && r.cents === null);
  ok('cap message names the limit', /10,000/.test(r.error));
  ok('exactly at the cap is allowed', parseBonusDollars(String(MAX), MAX).cents === MAX * 100);
  ok('a cent over the cap is refused', parseBonusDollars('10000.01', MAX).error !== null);
  // The whole point of the cap: never emit a value int4 cannot hold.
  ok('allowed cents stay inside int4', parseBonusDollars(String(MAX), MAX).cents < 2147483647);
}

console.log(`\nbonusAmount: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
