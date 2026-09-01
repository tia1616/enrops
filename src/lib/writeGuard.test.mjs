// Pins the rule that a write which touched nothing must not report success.
//
// The shape being tested is the real PostgREST behaviour that caused the bug: a
// viewer's UPDATE returns `{ data: [], error: null }`. Not an error - an empty
// array. Every assertion below is about telling that apart from a real save.

import { requireWritten, isWriteRefused, WriteRefusedError } from './writeGuard.js';

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name} — ${e.message}`); }
}
function eq(a, b, msg) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg ?? ""} got ${x}, wanted ${y}`);
}
function throws(fn, pred, msg) {
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  if (!caught) throw new Error(`${msg ?? "expected a throw"} — nothing was thrown`);
  if (pred && !pred(caught)) throw new Error(`${msg ?? "wrong error"} — got ${caught.name}: ${caught.message}`);
  return caught;
}

// --- the bug itself -------------------------------------------------------
ok('THE BUG: an RLS-refused update ({data:[], error:null}) is a refusal, not a save', () => {
  const e = throws(() => requireWritten({ data: [], error: null }, "this student's details"),
    (x) => isWriteRefused(x));
  if (!(e instanceof WriteRefusedError)) throw new Error('wrong error type');
  if (!/Nothing was saved/.test(e.message)) throw new Error(`message unhelpful: ${e.message}`);
  if (!/this student's details/.test(e.message)) throw new Error('message omits what failed');
});

ok('a write that DID affect a row returns the rows and does not throw', () => {
  const rows = requireWritten({ data: [{ id: 'abc' }], error: null }, 'x');
  eq(rows, [{ id: 'abc' }]);
});

ok('several affected rows are fine', () => {
  eq(requireWritten({ data: [{ id: 'a' }, { id: 'b' }], error: null }, 'x').length, 2);
});

// --- a real error still surfaces UNCHANGED --------------------------------
// The callers already word their own messages for these; swallowing them into a
// refusal would lose the reason (bad column, constraint, network).
ok('a genuine PostgREST error is re-thrown as-is, not converted to a refusal', () => {
  const real = new Error('column "nope" does not exist');
  const e = throws(() => requireWritten({ data: null, error: real }, 'x'));
  if (e !== real) throw new Error('the original error was replaced');
  if (isWriteRefused(e)) throw new Error('a real error was mislabelled a refusal');
});

// --- the ways a caller can get this wrong --------------------------------
// Forgetting .select() gives {data: null, error: null}. That MUST be a refusal:
// treating it as success is exactly the bug, just moved one level up.
ok('a missing .select() (data null, no error) is treated as a refusal, not a pass', () => {
  throws(() => requireWritten({ data: null, error: null }, 'x'), (e) => isWriteRefused(e));
});
ok('.single() shape (a bare object, not an array) is a refusal, not a silent pass', () => {
  throws(() => requireWritten({ data: { id: 'a' }, error: null }, 'x'), (e) => isWriteRefused(e));
});
ok('an undefined result does not crash with a TypeError', () => {
  throws(() => requireWritten(undefined, 'x'), (e) => isWriteRefused(e));
});

// --- isWriteRefused must not over-claim ----------------------------------
ok('isWriteRefused says no to everything that is not our refusal', () => {
  eq(isWriteRefused(new Error('boom')), false);
  eq(isWriteRefused(null), false);
  eq(isWriteRefused(undefined), false);
  eq(isWriteRefused({}), false);
  eq(isWriteRefused({ refused: 'yes' }), false, 'only a real boolean true counts');
  eq(isWriteRefused(new WriteRefusedError('x')), true);
});

ok('the message is safe to show a person even with no subject', () => {
  const e = new WriteRefusedError();
  if (/undefined|null/.test(e.message)) throw new Error(`leaks a placeholder: ${e.message}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
