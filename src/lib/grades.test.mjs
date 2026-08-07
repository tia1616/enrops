// Pins the grade/age vocabulary. Repo convention: plain node script with a
// pass/fail counter, run by scripts/run-src-tests.mjs.
//
// These exist because the vocabulary was written FOUR times with four different
// answers (K-12 vs K-6, Pre-K handled vs not). One definition is only worth
// anything if it stays the definition.
import { GRADE_OPTIONS, gradeLabel, audienceLabel, audienceMode, audiencePatch, rangeBackwards, isUnset, KINDERGARTEN } from './grades.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`); }
}

// --- the option list -------------------------------------------------------
eq('K through 12 = 13 options', GRADE_OPTIONS.length, 13);
eq('first option is K, value 0', GRADE_OPTIONS[0], { value: '0', label: 'K' });
eq('last option is 12', GRADE_OPTIONS[12], { value: '12', label: '12' });
eq('K is zero', KINDERGARTEN, 0);
// The bug this guards: the parent registration form stops at 6, so a class set
// above it cannot be matched by any parent. If this list ever shrinks to match,
// that is a decision, not a drift.
eq('12th grade is offered', GRADE_OPTIONS.some((o) => o.value === '12'), true);

// --- gradeLabel ------------------------------------------------------------
eq('0 renders K', gradeLabel(0), 'K');
eq('5 renders 5', gradeLabel(5), '5');
eq('negative renders Pre-K', gradeLabel(-1), 'Pre-K');
eq('null renders null, not "?"', gradeLabel(null), null);
eq('undefined renders null', gradeLabel(undefined), null);
eq('string number still works', gradeLabel('3'), '3');
eq('garbage renders null', gradeLabel('abc'), null);

// --- audienceLabel: one line, never both ----------------------------------
eq('grades range', audienceLabel({ grade_min: 0, grade_max: 5 }), 'Grades K–5');
eq('ages range', audienceLabel({ age_min: 6, age_max: 12 }), 'Ages 6–12');
eq('single grade collapses', audienceLabel({ grade_min: 3, grade_max: 3 }), 'Grade 3');
eq('single age collapses', audienceLabel({ age_min: 7, age_max: 7 }), 'Age 7');
// OPEN-ENDED, NOT EXACT. These two assertions previously pinned 'Grade 2' and
// 'Age 9' — the implementation's answer, not the parent's. A class open to age 5
// and up was being advertised as "Age 5", which reads as a hard cut-off to the
// parent of a six-year-old. The live catalog card already said "Ages 5+"; the
// module had to match it before anything was repointed at the module.
// SYMMETRIC with the age forms below. The first version read "Grades 2 and up"
// sitting beside "Ages 5+" - two renderings of one concept on the same card, which
// is the duplication this module exists to remove.
eq('grade_min only is open-ended', audienceLabel({ grade_min: 2, grade_max: null }), 'Grades 2+');
eq('grade_max only is a ceiling', audienceLabel({ grade_min: null, grade_max: 5 }), 'Up to grade 5');
eq('age_min only is open-ended', audienceLabel({ age_min: 5, age_max: null }), 'Ages 5+');
eq('age_max only is a ceiling', audienceLabel({ age_min: null, age_max: 9 }), 'Up to age 9');
// K is 0, which is falsy — an `if (min)` anywhere in here would drop it.
eq('grade_min K only', audienceLabel({ grade_min: 0, grade_max: null }), 'Grades K+');
// The bug that made isUnset() necessary: a panel draft holds "" in untouched fields,
// and Number("") is 0, so an empty field decoded as Kindergarten.
eq('empty-string grade renders nothing, not "Grade K"',
  audienceLabel({ grade_min: '', grade_max: '' }), null);
// And the one that put the word "null" on a family-facing card.
eq('unparseable grade renders nothing, never "Up to grade null"',
  audienceLabel({ grade_min: 'n/a', grade_max: null }), null);
// age_format is the operator's explicit answer and outranks mere presence.
eq('age_format wins over presence',
  audienceMode({ age_format: 'age', grade_min: 0, grade_max: 5, age_min: 6, age_max: 12 }), 'ages');
eq('age_min 0 only', audienceLabel({ age_min: 0, age_max: null }), 'Ages 0+');
eq('neither set renders nothing', audienceLabel({}), null);
eq('null row renders nothing', audienceLabel(null), null);
// If a row somehow carries both, show ONE. Grades win because afterschool is the
// common case and grades are its vocabulary.
eq('both set shows grades only',
  audienceLabel({ grade_min: 0, grade_max: 5, age_min: 6, age_max: 12 }), 'Grades K–5');
eq('K-K collapses to Grade K', audienceLabel({ grade_min: 0, grade_max: 0 }), 'Grade K');
// An en dash, not a hyphen — it is what the existing surfaces render.
eq('range uses an en dash', audienceLabel({ grade_min: 1, grade_max: 4 }).includes('–'), true);

// --- audienceMode ---------------------------------------------------------
eq('grades set, ages not -> grades', audienceMode({ grade_min: 0, grade_max: 5 }), 'grades');
eq('ages set -> ages', audienceMode({ age_min: 6, age_max: 12 }), 'ages');
// Must agree with audienceLabel on the same row, or the card says one thing and the
// editor opens on the other and the first save wipes what was on screen.
eq('both set -> grades, AGREEING with audienceLabel',
  audienceMode({ grade_min: 0, grade_max: 5, age_min: 6, age_max: 12 }), 'grades');
{
  const both = { grade_min: 0, grade_max: 5, age_min: 6, age_max: 12 };
  const labelSaysGrades = audienceLabel(both).startsWith('Grade');
  const modeSaysGrades = audienceMode(both) === 'grades';
  eq('label and mode agree on a both-set row', labelSaysGrades === modeSaysGrades, true);
}
eq('empty row defaults to grades (afterschool)', audienceMode({}), 'grades');
eq('empty row honours an explicit default',
  audienceMode({}, { defaultMode: 'ages' }), 'ages');
eq('null row defaults to grades', audienceMode(null), 'grades');

// --- clearOtherMode: never carry both ------------------------------------
// --- audiencePatch: the ONE place that decides what an audience edit writes ---
// Replaces clearOtherMode(), which was exported, tested, imported by nobody, and the
// wrong shape - it could only null the other pair, not state the chosen one or set
// age_format, which is why both writers hand-rolled the whole rule instead.
eq('grades patch nulls ages and sets the format',
  audiencePatch('grades', { gradeMin: '0', gradeMax: '5' }),
  { grade_min: 0, grade_max: 5, age_min: null, age_max: null, age_format: 'grade' });
eq('ages patch nulls grades and sets the format',
  audiencePatch('ages', { ageMin: '6', ageMax: '12' }),
  { grade_min: null, grade_max: null, age_min: 6, age_max: 12, age_format: 'age' });
// K is 0. `Number(x) || null` here would file Kindergarten as "not stated".
eq('grade K survives as 0, not null',
  audiencePatch('grades', { gradeMin: '0', gradeMax: '0' }).grade_min, 0);
// A class that states nothing must not claim to be grade-shaped.
eq('no range means no format',
  audiencePatch('grades', { gradeMin: '', gradeMax: '' }).age_format, null);
eq('no range still nulls everything',
  audiencePatch('ages', {}),
  { grade_min: null, grade_max: null, age_min: null, age_max: null, age_format: null });
// One end only is legitimate - "Grades 2+".
eq('one-sided grade range keeps the format',
  audiencePatch('grades', { gradeMin: '2', gradeMax: '' }),
  { grade_min: 2, grade_max: null, age_min: null, age_max: null, age_format: 'grade' });
// The invariant the helper exists for: no input can produce both pairs.
for (const [mode, vals] of [
  ['grades', { gradeMin: '1', gradeMax: '5', ageMin: '6', ageMax: '12' }],
  ['ages', { gradeMin: '1', gradeMax: '5', ageMin: '6', ageMax: '12' }],
]) {
  const p = audiencePatch(mode, vals);
  const both = (p.grade_min != null || p.grade_max != null) && (p.age_min != null || p.age_max != null);
  eq(`${mode}: cannot produce a row carrying both`, both, false);
}
// age_format may only ever be one of the two strings the CHECK constraint allows,
// or null. The UI toggle uses the PLURAL "grades"/"ages"; the column takes singular.
for (const mode of ['grades', 'ages']) {
  const f = audiencePatch(mode, { gradeMin: '1', gradeMax: '2', ageMin: '3', ageMax: '4' }).age_format;
  eq(`${mode}: age_format is a value the CHECK allows`, ['grade', 'age', null].includes(f), true);
}

// --- rangeBackwards / isUnset -------------------------------------------------
eq('backwards range detected', rangeBackwards(5, 2), true);
eq('equal ends are not backwards', rangeBackwards(3, 3), false);
eq('K to 5 is not backwards', rangeBackwards(0, 5), false);
// An open-ended range cannot be backwards - there is nothing to compare against.
eq('open-ended is never backwards', rangeBackwards(5, ''), false);
eq('empty string is unset, NOT zero', isUnset(''), true);
eq('zero is set', isUnset(0), false);
eq('"0" is set', isUnset('0'), false);

console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
