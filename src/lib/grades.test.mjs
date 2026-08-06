// Pins the grade/age vocabulary. Repo convention: plain node script with a
// pass/fail counter, run by scripts/run-src-tests.mjs.
//
// These exist because the vocabulary was written FOUR times with four different
// answers (K-12 vs K-6, Pre-K handled vs not). One definition is only worth
// anything if it stays the definition.
import { GRADE_OPTIONS, gradeLabel, audienceLabel, audienceMode, clearOtherMode, KINDERGARTEN } from './grades.js';

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
eq('grade_min only', audienceLabel({ grade_min: 2, grade_max: null }), 'Grade 2');
eq('age_max only', audienceLabel({ age_min: null, age_max: 9 }), 'Age 9');
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
eq('switching to grades clears ages', clearOtherMode('grades'), { age_min: null, age_max: null });
eq('switching to ages clears grades', clearOtherMode('ages'), { grade_min: null, grade_max: null });

console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
