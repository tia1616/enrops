// Twin-parity guard for familyRecipients.
//
// groupFamilyRecipients and joinChildNames exist TWICE: here in Deno for
// notify-program-curriculum-change, which actually sends, and in
// src/lib/familyRecipients.js for the modal's preview. They cannot import each
// other (Vite and Deno bundle roots), and this pair has ALREADY drifted once in
// the worst possible way — both sides carried the same first-child-wins dedupe,
// so the preview named one child, the send named one child, and the two agreeing
// made a real defect look like correct behaviour. A parent with two children in
// one class was told about one of them.
//
// Modelled on platformFooterTwinParity.test.ts and deliberately just as crude:
// it reads both files as text and compares the ORDERED control-flow lines of each
// function. It does not execute either side. It fails on the drift that actually
// happens here — one twin fixed, the other forgotten.
//
// If this fails: make the two functions agree. Do not "fix" it by loosening the
// comparison.

import { assertEquals, assert } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import {
  groupFamilyRecipients,
  joinChildNames,
  rowsToRegistrationShape,
} from '../familyRecipients.ts';

const EDGE = new URL('../familyRecipients.ts', import.meta.url);
const WEB = new URL('../../../../src/lib/familyRecipients.js', import.meta.url);

// Strip the things TypeScript has and JavaScript does not, so the two languages
// compare equal: generic parameters (`new Map<string, any>()`) and `as` casts
// (`(regs ?? []) as any[]`). Nothing else may be normalised away — the point is
// to catch a real difference in logic, so the filter has to stay narrow.
function normalise(line: string): string {
  return line
    .replace(/<[^<>]*>/g, '')
    .replace(/\s+as\s+[A-Za-z_$][\w$\[\]]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function bodyLines(source: string, fnName: string): string[] {
  const start = source.indexOf(`export function ${fnName}`);
  if (start < 0) throw new Error(`${fnName} not found`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  return source
    .slice(open + 1, end)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map(normalise);
}

Deno.test('familyRecipients twins have identical bodies', async () => {
  const edge = await Deno.readTextFile(EDGE);
  const web = await Deno.readTextFile(WEB);
  for (const fn of ['rowsToRegistrationShape', 'joinChildNames', 'groupFamilyRecipients']) {
    assertEquals(
      bodyLines(edge, fn),
      bodyLines(web, fn),
      `${fn} has drifted between the Deno and web twins`,
    );
  }
});

// Behaviour, not just parity — the parity test alone would pass on two copies of
// the SAME bug, which is precisely the state this pair was found in.
const ZHOU = (sid: string, name: string) => ({
  parent: { id: 'p1', first_name: 'Yu', last_name: 'Zhou', email: 'YU@Example.com ' },
  student: { id: sid, first_name: name },
});

Deno.test('a parent with two children in one class is named for both', () => {
  const out = groupFamilyRecipients([ZHOU('s1', 'Ryan'), ZHOU('s2', 'Evan')]);
  assertEquals(out.length, 1, 'still ONE email per family');
  assertEquals(out[0].student_first_name, 'Evan and Ryan');
  assertEquals(out[0].children, ['Evan', 'Ryan']);
  assertEquals(out[0].email, 'yu@example.com', 'email is trimmed and lowercased');
});

// Neither caller's query has an ORDER BY, so the row order is Postgres's choice
// and can differ between two identical sends. Without sorting, the test above
// would pass purely because its fixture is written Ryan-then-Evan — which is a
// test agreeing with the code rather than checking it.
Deno.test('the greeting does not change when the database returns rows the other way round', () => {
  const forwards = groupFamilyRecipients([ZHOU('s1', 'Ryan'), ZHOU('s2', 'Evan')]);
  const backwards = groupFamilyRecipients([ZHOU('s2', 'Evan'), ZHOU('s1', 'Ryan')]);
  assertEquals(forwards[0].student_first_name, backwards[0].student_first_name);
  assertEquals(forwards[0].children, backwards[0].children);
});

Deno.test('one child is unchanged, and three read as a list', () => {
  const one = groupFamilyRecipients([
    { parent: { id: 'p1', first_name: 'A', last_name: 'B', email: 'a@b.com' },
      student: { id: 's1', first_name: 'Ryan' } },
  ]);
  assertEquals(one[0].student_first_name, 'Ryan');
  assertEquals(joinChildNames(['Ryan', 'Evan', 'Mia']), 'Ryan, Evan and Mia');
});

Deno.test('the same child twice counts once; two children sharing a name count twice', () => {
  const dupeRow = groupFamilyRecipients([
    { parent: { id: 'p1', first_name: 'A', last_name: 'B', email: 'a@b.com' },
      student: { id: 's1', first_name: 'Alex' } },
    { parent: { id: 'p1', first_name: 'A', last_name: 'B', email: 'a@b.com' },
      student: { id: 's1', first_name: 'Alex' } },
  ]);
  assertEquals(dupeRow[0].children, ['Alex'], 'two registrations for one child is one child');

  const twoAlexes = groupFamilyRecipients([
    { parent: { id: 'p1', first_name: 'A', last_name: 'B', email: 'a@b.com' },
      student: { id: 's1', first_name: 'Alex' } },
    { parent: { id: 'p1', first_name: 'A', last_name: 'B', email: 'a@b.com' },
      student: { id: 's2', first_name: 'Alex' } },
  ]);
  assertEquals(twoAlexes[0].children, ['Alex', 'Alex'],
    'deduping by NAME would have hidden a real second child');
});

// The preview and the send both feed program_note_recipients' FLAT rows through
// this mapper. If it ever disagreed with the nested shape the two surfaces would
// silently diverge again, which is the whole reason the RPC exists.
Deno.test('flat RPC rows group identically to the nested registration shape', () => {
  const flat = rowsToRegistrationShape([
    { parent_id: 'p1', parent_first_name: 'Yu', parent_last_name: 'Zhou',
      parent_email: 'YU@Example.com ', student_id: 's1', student_first_name: 'Ryan' },
    { parent_id: 'p1', parent_first_name: 'Yu', parent_last_name: 'Zhou',
      parent_email: 'YU@Example.com ', student_id: 's2', student_first_name: 'Evan' },
  ]);
  const fromFlat = groupFamilyRecipients(flat);
  const fromNested = groupFamilyRecipients([ZHOU('s1', 'Ryan'), ZHOU('s2', 'Evan')]);
  assertEquals(fromFlat, fromNested);
  assertEquals(fromFlat.length, 1);
  assertEquals(fromFlat[0].student_first_name, 'Evan and Ryan');
});

Deno.test('a parent with no email is skipped, and a missing child name falls back', () => {
  const noEmail = groupFamilyRecipients([
    { parent: { id: 'p1', first_name: 'A', last_name: 'B', email: null },
      student: { id: 's1', first_name: 'Ryan' } },
  ]);
  assertEquals(noEmail.length, 0);

  const noName = groupFamilyRecipients([
    { parent: { id: 'p1', first_name: 'A', last_name: 'B', email: 'a@b.com' },
      student: { id: 's1', first_name: '  ' } },
  ]);
  assert(noName.length === 1);
  assertEquals(noName[0].student_first_name, 'your child',
    'never render an empty name into a sentence about somebody’s child');
});
