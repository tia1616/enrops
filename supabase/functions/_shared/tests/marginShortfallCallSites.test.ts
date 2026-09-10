// Every path that can fail to return our margin must ANNOUNCE it.
//
// On 2026-09-08 three fee returns failed and the only record was a column on
// the refunds row. The fix was an alert - but an alert wired into one of the
// two failure paths is barely better than none, because the unwired one goes
// silent in exactly the way that cost two days. refund-registration is the path
// used from the app; stripe-webhook's charge.refunded is the path used when a
// refund is issued in the Stripe dashboard instead.
//
// This is a SOURCE ratchet, the same shape as sendLogCallSites: add a third
// caller of applicationFees.createRefund and this goes red until it alerts too.

import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';

const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));

/** Strip comments so prose naming a symbol is not mistaken for code calling it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const FUNCTIONS = [
  '../../refund-registration/index.ts',
  '../../stripe-webhook/index.ts',
];

Deno.test('every function that refunds an application fee also alerts on failure', () => {
  const missing: string[] = [];
  for (const rel of FUNCTIONS) {
    const code = stripComments(read(rel));
    if (!/applicationFees\.createRefund/.test(code)) continue; // not a fee-refunding path
    if (!/alertMarginShortfall\s*\(/.test(code)) missing.push(rel);
  }
  assertEquals(
    missing,
    [],
    `these refund an application fee and never announce a failure, so the debt is silent:\n        ${missing.join('\n        ')}`,
  );
});

Deno.test('the ratchet catches a THIRD fee-refunding function appearing', () => {
  // Guards the list above from rotting: if a new function starts refunding
  // application fees, this names it so somebody has to decide.
  const all: string[] = [];
  for (const dir of Deno.readDirSync(new URL('../../', import.meta.url))) {
    if (!dir.isDirectory || dir.name === '_shared') continue;
    let src: string;
    try {
      src = read(`../../${dir.name}/index.ts`);
    } catch {
      continue;
    }
    if (/applicationFees\.createRefund/.test(stripComments(src))) all.push(`../../${dir.name}/index.ts`);
  }
  assertEquals(
    all.sort(),
    [...FUNCTIONS].sort(),
    'a function started refunding application fees and is not in this test\'s list. Wire it to alertMarginShortfall and add it here.',
  );
});

Deno.test('the alert is armed only while the debt is genuinely outstanding', () => {
  // The webhook's try block contains BOTH the fee refund and the refunds-row
  // UPDATE that follows it, so a successful refund plus a failed database write
  // lands in the same catch. If the debt were armed eagerly, that would email
  // "we could not return $X" about money already returned - and the reader's
  // correct next action, refunding it in Stripe, would be a SECOND refund of
  // the same fee. So the arm must sit next to the attempt and be cleared on
  // success, never set once at the top.
  const code = stripComments(read('../../stripe-webhook/index.ts'));
  const armIdx = code.indexOf('alertOwedCents = owed');
  const callIdx = code.indexOf('applicationFees.createRefund');
  // The already-returned lookup is the landmark that separates the two
  // placements. `armIdx < callIdx` alone does NOT: it is true both for an arm
  // sitting next to the attempt and for one hoisted to the top of the try,
  // which is the bug. Checked by planting the eager version - that mutation
  // slipped past the looser assertion, which is why this landmark is here.
  const lookupIdx = code.indexOf('const existingFeeRefund');
  assert(armIdx !== -1, 'the webhook no longer arms a shortfall amount at all');
  assert(lookupIdx !== -1, 'the already-returned lookup moved; this test needs a new landmark');
  assert(
    armIdx > lookupIdx,
    'the debt is armed BEFORE the already-returned check, so a fee that was already refunded ' +
    'would be emailed as still owed and refunded a second time',
  );
  assert(armIdx < callIdx, 'the debt must be armed before the refund attempt');
  assert(
    /alertOwedCents = 0/.test(code.slice(callIdx)),
    'nothing clears the armed debt after a successful fee refund, so a later bookkeeping failure would raise a false alarm',
  );
});
