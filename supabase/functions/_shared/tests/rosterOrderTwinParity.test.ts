// Twin-parity guard for the roster order, built the same way as
// roomLabelTwinParity.test.ts: the pair can be EXECUTED on both sides rather
// than compared as text, because src/lib/rosterOrder.js is plain ESM with no
// imports, so Deno can load it directly. The same table of rows is sorted by
// both copies and the two orders must be identical.
//
// Why the pair exists: the browser (instructor portal, admin roster list,
// per-program roster + its CSV) and Deno (the program roster email and the camp
// roster email) cannot import each other. If these two ever disagree, the roster
// an instructor is holding on PAPER is in a different order from the one on the
// screen they checked it against - and the whole point of the shared rule, when
// Jeff asked for first-name order on 2026-08-31, was that all of them agree.
//
// If this fails: make the two files agree. Do not loosen the comparison.

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { sortRosterRows as edge, compareRosterRows as edgeCmp } from '../rosterOrder.ts';

const WEB = new URL('../../../../src/lib/rosterOrder.js', import.meta.url);
const { sortRosterRows: web, compareRosterRows: webCmp } = await import(WEB.href);

// Every name here is in the live prod or staging data, plus the blank / junk
// rows that decide whether a roster renders at all.
const CASES: Array<[string, unknown[]]> = [
  ['a real 12-child staging class, in registration order', [
    { id: 'a1', registered_at: '2026-08-03T17:00:00+00:00', student: { first_name: 'Ava', last_name: 'Nguyen' } },
    { id: 'a2', registered_at: '2026-08-03T17:00:00+00:00', student: { first_name: 'Finn', last_name: 'Brennan' } },
    { id: 'a3', registered_at: '2026-08-04T17:00:00+00:00', student: { first_name: 'Mia', last_name: 'Chen' } },
    { id: 'a4', registered_at: '2026-08-04T17:00:00+00:00', student: { first_name: 'Diego', last_name: 'Silva' } },
    { id: 'a5', registered_at: '2026-08-05T17:00:00+00:00', student: { first_name: 'Nora', last_name: 'Abbott' } },
    { id: 'a6', registered_at: '2026-08-13T17:00:00+00:00', student: { first_name: 'Wyatt', last_name: 'Sorenson' } },
    { id: 'a7', registered_at: '2026-08-13T17:00:00+00:00', student: { first_name: 'Piper', last_name: 'Sorenson' } },
  ]],
  ['three Vorsters, one shouting', [
    { id: 'b1', registered_at: '2026-07-12T18:44:05.992264+00:00', student: { first_name: 'Jessica', last_name: 'Vorster' } },
    { id: 'b2', registered_at: '2026-07-12T18:46:54.349491+00:00', student: { first_name: 'James', last_name: 'Vorster' } },
    { id: 'b3', registered_at: '2026-07-12T19:20:46.845893+00:00', student: { first_name: 'JACK', last_name: 'Vorster' } },
  ]],
  // Built to DISCRIMINATE: the spaced row carries the earlier last name (and the
  // earlier id, for the last-name pair), so a copy that stopped trimming returns
  // these in the reverse order rather than the same order by luck. A trailing
  // space sorts low, so the obvious "Ada " / "Adam" pair proves nothing.
  ['prod trailing spaces, both spellings of the same name', [
    { id: 'c1', registered_at: null, student: { first_name: 'Benjamin ', last_name: 'Adams' } },
    { id: 'c2', registered_at: null, student: { first_name: 'Benjamin', last_name: 'Zimmerman' } },
    { id: 'c3', registered_at: null, student: { first_name: 'Ada ', last_name: 'Fitch' } },
    { id: 'c4', registered_at: null, student: { first_name: 'Adam', last_name: 'Boyle' } },
    { id: 'c5a', student: { first_name: 'Kai', last_name: 'Tran ' } },
    { id: 'c5z', student: { first_name: 'Kai', last_name: 'Tran' } },
  ]],
  ['case folding, including staging\'s "j dog"', [
    { id: 'd1', student: { first_name: 'Zoe', last_name: 'Park' } },
    { id: 'd2', student: { first_name: 'aiden', last_name: 'Ng' } },
    { id: 'd3', student: { first_name: 'j dog', last_name: 'vorster' } },
    { id: 'd4', student: { first_name: 'Maya', last_name: 'Cole' } },
  ]],
  ['prod camp first-name ties', [
    { id: 'e1', student: { first_name: 'Julian', last_name: 'Toms' } },
    { id: 'e2', student: { first_name: 'Julian', last_name: 'Eustaquio' } },
    { id: 'e3', student: { first_name: 'Aiden', last_name: 'Ng' } },
    { id: 'e4', student: { first_name: 'Aiden', last_name: 'Gillis' } },
    { id: 'e5', student: { first_name: 'Everett', last_name: 'Collingwood-Bersaas' } },
    { id: 'e6', student: { first_name: 'Everett', last_name: 'Chase' } },
  ]],
  ['blanks, junk and no registered_at at all (the Rosters.jsx row shape)', [
    { id: 'f1', student: { first_name: '', last_name: 'Nolastname' } },
    { id: 'f2', student: { first_name: '   ', last_name: 'Spaces' } },
    { id: 'f3', student: { first_name: null, last_name: 'Younger' } },
    { id: 'f4', student: { first_name: null, last_name: 'Adams' } },
    { id: 'f5', student: null },
    { id: 'f6', student: { first_name: 7, last_name: 'Seven' } },
    { id: 'f7', student: { first_name: 'Amara', last_name: 'Osei' } },
  ]],
  ['identical rows apart from the id', [
    { id: 'zzz', registered_at: '2026-01-02T00:00:00+00:00', student: { first_name: 'Jessica', last_name: 'Vorster' } },
    { id: 'aaa', registered_at: '2026-01-01T00:00:00+00:00', student: { first_name: 'Jessica', last_name: 'Vorster' } },
    { id: 'mmm', student: { first_name: 'Jessica', last_name: 'Vorster' } },
    { id: 'bbb', student: { first_name: 'Jessica', last_name: 'Vorster' } },
  ]],
  ['empty', []],
];

Deno.test('the Deno and browser roster orders agree on every real class', () => {
  for (const [label, rows] of CASES) {
    const e = edge(rows as never[]).map((r: { id?: unknown }) => r.id);
    const w = web(rows).map((r: { id?: unknown }) => r.id);
    assertEquals(
      w,
      e,
      `"${label}" ordered differently: browser gave ${JSON.stringify(w)}, ` +
      `edge gave ${JSON.stringify(e)}. src/lib/rosterOrder.js and ` +
      '_shared/rosterOrder.ts have drifted.',
    );
  }
});

// Guards the guard. If both copies were broken the same way - or if an import
// silently resolved to something that returns its input untouched - the loop
// above would compare two identical wrong answers and pass while proving
// nothing. These pin the behaviours that are actually load-bearing.
const S = (first: unknown, last: unknown, id: string) => ({ id, student: { first_name: first, last_name: last } });
const order = (fn: (r: unknown[]) => Array<{ id?: unknown }>, rows: unknown[]) => fn(rows).map((r) => r.id);

Deno.test('the shared rule still sorts by FIRST name, not last', () => {
  const rows = [S('Zoe', 'Abbott', 'zoe'), S('Amara', 'Zimmerman', 'amara')];
  assertEquals(order(edge as never, rows), ['amara', 'zoe']);
  assertEquals(order(web as never, rows), ['amara', 'zoe']);
});

Deno.test('the shared rule still trims, so the last-name tiebreak fires', () => {
  // Spaced row = earlier LAST name, so skipping the trim reverses this.
  const rows = [S('Benjamin', 'Zimmerman', 'z'), S('Benjamin ', 'Adams', 'a')];
  assertEquals(order(edge as never, rows), ['a', 'z']);
  assertEquals(order(web as never, rows), ['a', 'z']);
});

Deno.test('the shared rule still folds case and still puts blanks last', () => {
  assertEquals(order(edge as never, [S('Zoe', 'Park', 'z'), S('aiden', 'Ng', 'a')]), ['a', 'z']);
  assertEquals(order(edge as never, [S('', 'Nobody', 'blank'), S('Zoe', 'Park', 'z')]), ['z', 'blank']);
  assertEquals(edgeCmp(S('Kai', 'Tran', 'x'), S('Kai', 'Tran', 'x')), 0);
  assertEquals(webCmp(S('Kai', 'Tran', 'x'), S('Kai', 'Tran', 'x')), 0);
});
