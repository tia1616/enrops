// Standalone check of the credit allocation rule.
// Usage: deno run --allow-read creditAllocation.test.mjs  (from this dir)
//
// Follows promoPricing.test.mjs: the module is .ts, so this runs under Deno
// (the edge runtime) rather than through scripts/run-src-tests.mjs, which only
// scans src/**.
import {
  allocateCreditAcrossLines,
  creditApplicationKey,
  encodeCreditAllocation,
  decodeCreditAllocation,
} from './creditAllocation.ts';

let failures = 0;
function check(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

const A = 'aaaa0001-0000-4000-8000-000000000001';
const B = 'bbbb0002-0000-4000-8000-000000000002';
const C = 'cccc0003-0000-4000-8000-000000000003';

// 1) No credit: everything is charged, nothing allocated.
{
  const r = allocateCreditAcrossLines([{ registrationId: A, amountCents: 24000 }], 0);
  check('no credit allocates nothing', r.totalCreditCents === 0 && r.totalChargeCents === 24000);
}

// 2) Credit smaller than the order: greedy fill, remainder charged.
{
  const r = allocateCreditAcrossLines(
    [{ registrationId: A, amountCents: 24000 }, { registrationId: B, amountCents: 24000 }],
    30000,
  );
  check('greedy fills the first line whole', r.entries[0].creditCents === 24000 && r.entries[0].chargeCents === 0);
  check('remainder lands on the second', r.entries[1].creditCents === 6000 && r.entries[1].chargeCents === 18000);
  check('totals agree', r.totalCreditCents === 30000 && r.totalChargeCents === 18000);
}

// 3) Credit larger than the order: capped at the order, never over-allocated.
{
  const r = allocateCreditAcrossLines([{ registrationId: A, amountCents: 5000 }], 99999);
  check('never allocates more than the line costs', r.totalCreditCents === 5000 && r.totalChargeCents === 0);
}

// 4) ROW ORDER MUST NOT DECIDE ANYTHING. PostgREST `.in()` returns rows in no
//    particular order, so the same cart presented two ways must allocate
//    identically or the webhook restores the wrong child.
{
  const forward = allocateCreditAcrossLines(
    [{ registrationId: A, amountCents: 10000 }, { registrationId: B, amountCents: 10000 }, { registrationId: C, amountCents: 10000 }],
    15000,
  );
  const shuffled = allocateCreditAcrossLines(
    [{ registrationId: C, amountCents: 10000 }, { registrationId: A, amountCents: 10000 }, { registrationId: B, amountCents: 10000 }],
    15000,
  );
  check('row order does not change the allocation',
    JSON.stringify(forward.entries) === JSON.stringify(shuffled.entries),
    JSON.stringify(shuffled.entries.map((e) => e.creditCents)));
}

// 4b) AN EXPLICIT ORDER WINS, and survives the rows arriving shuffled. This is
//     what lets the Pay step predict the same split the server will make: it
//     knows its cart order, not the ids the server will mint.
{
  const wanted = [C, A, B];
  const a = allocateCreditAcrossLines(
    [{ registrationId: A, amountCents: 10000 }, { registrationId: B, amountCents: 10000 }, { registrationId: C, amountCents: 10000 }],
    15000, wanted,
  );
  const b = allocateCreditAcrossLines(
    [{ registrationId: B, amountCents: 10000 }, { registrationId: C, amountCents: 10000 }, { registrationId: A, amountCents: 10000 }],
    15000, wanted,
  );
  const byId = Object.fromEntries(a.entries.map((e) => [e.registrationId, e.creditCents]));
  check('the named order is filled first', byId[C] === 10000 && byId[A] === 5000 && byId[B] === 0,
    JSON.stringify(byId));
  check('and shuffled rows give the same answer',
    JSON.stringify(a.entries) === JSON.stringify(b.entries));
  check('it differs from the id-order default, so the order is really being used',
    JSON.stringify(a.entries) !== JSON.stringify(
      allocateCreditAcrossLines(
        [{ registrationId: A, amountCents: 10000 }, { registrationId: B, amountCents: 10000 }, { registrationId: C, amountCents: 10000 }],
        15000,
      ).entries));
}

// 4c) A line missing from the order is filled LAST, not dropped.
{
  const r = allocateCreditAcrossLines(
    [{ registrationId: A, amountCents: 10000 }, { registrationId: B, amountCents: 10000 }],
    20000, [B],
  );
  const byId = Object.fromEntries(r.entries.map((e) => [e.registrationId, e.creditCents]));
  check('an unlisted line still gets its share', byId[B] === 10000 && byId[A] === 10000);
  check('nothing is dropped', r.totalCreditCents === 20000);
}

// 5) The key is order-stable too, for the same reason.
{
  check('application key is order-stable',
    creditApplicationKey([C, A, B]) === creditApplicationKey([A, B, C]));
  check('application key distinguishes different carts',
    creditApplicationKey([A, B]) !== creditApplicationKey([A, C]));
}

// 6) Metadata round-trip, including the zero-credit lines being dropped.
{
  const r = allocateCreditAcrossLines(
    [{ registrationId: A, amountCents: 10000 }, { registrationId: B, amountCents: 10000 }],
    10000,
  );
  const enc = encodeCreditAllocation(r);
  const dec = decodeCreditAllocation(enc);
  check('encode drops lines that took no credit', dec.length === 1, enc);
  check('round-trip preserves the amount', dec[0].registrationId === A && dec[0].creditCents === 10000);
  check('decode of empty is empty', decodeCreditAllocation('').length === 0);
  check('decode of junk is empty, not a throw', decodeCreditAllocation('nonsense').length === 0);
  // A uuid contains no colon, but lastIndexOf is used so a key that ever did
  // would still split on the RIGHT one.
  check('decode splits on the LAST colon', decodeCreditAllocation('a:b:500')[0].registrationId === 'a:b');
}

// 7) Defensive: a negative or NaN balance charges full price rather than throwing.
{
  const neg = allocateCreditAcrossLines([{ registrationId: A, amountCents: 1000 }], -500);
  const nan = allocateCreditAcrossLines([{ registrationId: A, amountCents: 1000 }], Number.NaN);
  check('negative balance allocates nothing', neg.totalCreditCents === 0 && neg.totalChargeCents === 1000);
  check('NaN balance allocates nothing', nan.totalCreditCents === 0 && nan.totalChargeCents === 1000);
}

// 8) A zero-priced line cannot absorb credit.
{
  const r = allocateCreditAcrossLines(
    [{ registrationId: A, amountCents: 0 }, { registrationId: B, amountCents: 5000 }],
    5000,
  );
  check('a $0 line takes no credit', r.entries[0].creditCents === 0 && r.entries[1].creditCents === 5000);
}

console.log('');
console.log(failures === 0 ? `All checks passed.` : `${failures} FAILED`);
if (failures > 0) Deno.exit(1);
