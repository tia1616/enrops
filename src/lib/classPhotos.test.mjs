// Pins the two pieces of class-photo logic that are pure: who the instructor is
// warned about, and how an oversized photo is fitted. The rest is database
// policy and is proven against staging, not here.

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}
function eq(name, actual, expected) {
  ok(`${name} (got ${JSON.stringify(actual)})`, JSON.stringify(actual) === JSON.stringify(expected));
}

import { childrenWithoutPhotoPermission, groupByDay, uploadErrorMessage } from './classPhotoLogic.js';
import { fitWithin } from './classPhotoPrep.js';

const reg = (id, first, last, consent) => ({ id, photo_release_consent: consent, student: { id: `s${id}`, first_name: first, last_name: last } });

// --- only a recorded yes is permission -------------------------------------
const rows = [
  reg(1, 'Ada', 'Lovelace', true),
  reg(2, 'Ben', 'Carter', false),   // explicit refusal
  reg(3, 'Cleo', 'Diaz', null),     // never asked: 56 of these on prod
  reg(4, 'Dev', 'Eze', undefined),  // column missing from a select
];
const out = childrenWithoutPhotoPermission(rows);
eq('only the children without a yes are listed', out.map((c) => c.name), ['Ben Carter', 'Cleo Diaz', 'Dev Eze']);
eq('a refusal is marked declined', out.find((c) => c.name === 'Ben Carter').declined, true);
eq('a never-asked child is NOT marked declined', out.find((c) => c.name === 'Cleo Diaz').declined, false);
eq('a class where everyone said yes lists nobody', childrenWithoutPhotoPermission([reg(1, 'A', 'B', true)]), []);
eq('no rows lists nobody', childrenWithoutPhotoPermission(null), []);
eq('a row with no name is skipped, not shown blank', childrenWithoutPhotoPermission([{ id: 9, photo_release_consent: false, student: {} }]), []);

// --- the gallery groups newest day first -----------------------------------
const g = groupByDay([
  { id: 'a', session_date: '2026-10-01' },
  { id: 'b', session_date: '2026-10-08' },
  { id: 'c', session_date: '2026-10-01' },
]);
eq('days are newest first', g.map((d) => d.date), ['2026-10-08', '2026-10-01']);
eq('photos stay with their day', g[1].photos.map((p) => p.id), ['a', 'c']);

// --- fitting ---------------------------------------------------------------
eq('a big landscape photo is fitted to 1600 on its long side', fitWithin(4032, 3024), { width: 1600, height: 1200 });
eq('a big portrait photo is fitted to 1600 on its long side', fitWithin(3024, 4032), { width: 1200, height: 1600 });
eq('a small photo is never enlarged', fitWithin(800, 600), { width: 800, height: 600 });

// --- refusals are worded for a person --------------------------------------
ok('a known code gets its own sentence', uploadErrorMessage('class_photos_off').includes('switched off'));
ok('an unknown code still says something useful', uploadErrorMessage('who_knows').includes('try again'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
