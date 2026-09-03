// Pins the grade/age vocabulary. Repo convention: plain node script with a
// pass/fail counter, run by scripts/run-src-tests.mjs.
//
// These exist because the vocabulary was written FOUR times with four different
// answers (K-12 vs K-6, Pre-K handled vs not). One definition is only worth
// anything if it stays the definition.
import { GRADE_OPTIONS, GRADE_OPTIONS_LONG, gradeLabel, audienceLabel, audienceMode, audiencePatch, rangeBackwards, rangeBackwardsMessage, isUnset, KINDERGARTEN, gradeFitProblem, gradeFitMessage } from './grades.js';

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

// --- the parent-facing list is the SAME RANGE ------------------------------
// The bug this closes: the registration form carried its own list stopping at 6th
// while an operator could set a class to any grade, so a family with a 7th grader
// could not pick a grade and could not register at all. If these two ever diverge
// again, that is the failure - so the invariant is the pairing, not the wording.
eq('same number of grades in both lists', GRADE_OPTIONS_LONG.length, GRADE_OPTIONS.length);
eq('same values, in the same order',
  GRADE_OPTIONS_LONG.map((o) => o.value), GRADE_OPTIONS.map((o) => o.value));
eq('parent wording for K', GRADE_OPTIONS_LONG[0], { value: '0', label: 'Kindergarten' });
eq('parent wording for 1st', GRADE_OPTIONS_LONG[1].label, '1st grade');
eq('parent wording for 2nd', GRADE_OPTIONS_LONG[2].label, '2nd grade');
eq('parent wording for 3rd', GRADE_OPTIONS_LONG[3].label, '3rd grade');
eq('parent wording for 4th', GRADE_OPTIONS_LONG[4].label, '4th grade');
// The ordinals that trip naive suffix logic: 11th and 12th, not 11st and 12nd.
eq('parent wording for 11th', GRADE_OPTIONS_LONG[11].label, '11th grade');
eq('parent wording for 12th', GRADE_OPTIONS_LONG[12].label, '12th grade');
// A grade an operator can set must be one a family can choose.
for (const o of GRADE_OPTIONS) {
  eq(`grade ${o.label} is selectable at registration`,
    GRADE_OPTIONS_LONG.some((p) => p.value === o.value), true);
}

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
// THE AGREEMENT INVARIANT, now covering age_format - the branch that broke it.
// audienceMode started reading age_format first while audienceLabel still always
// preferred grades, so the card said "Grades K-5" and the editor opened on Ages;
// correcting the age there deleted the range the card was showing.
for (const row of [
  { age_format: 'age', grade_min: 0, grade_max: 5, age_min: 6, age_max: 12 },
  { age_format: 'grade', grade_min: 0, grade_max: 5, age_min: 6, age_max: 12 },
  { grade_min: 0, grade_max: 5, age_min: 6, age_max: 12 },
  { age_format: 'age', age_min: 6, age_max: 12 },
  { age_format: 'grade', grade_min: 1, grade_max: 3 },
  // THE TWO CONTRADICTORY SHAPES the first version of this loop missed: a row
  // whose age_format names a pair that is EMPTY. Trusting the claim over the data
  // made audienceLabel return null for the first one - the audience line simply
  // vanished from the family card for a class that states a real range - and
  // return "Ages 6-12" while the editor opened on Grades for the second.
  { age_format: 'age', grade_min: 0, grade_max: 5 },
  { age_format: 'grade', age_min: 6, age_max: 12 },
]) {
  const label = audienceLabel(row);
  const saysAges = audienceMode(row) === 'ages';
  // A row with ANY range must produce a label. `?? ''` here would let a vanished
  // label score as "not ages" and pass while the card showed nothing.
  eq(`a row with a range always has a label ${JSON.stringify(row)}`, typeof label === 'string' && label.length > 0, true);
  eq(`label and editor agree on ${JSON.stringify(row)}`, /^(Age|Ages|Up to age)/.test(label), saysAges);
}
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

// --- rangeBackwardsMessage ----------------------------------------------------
// The wizard and the Scheduled Programs panel both show this. It was typed out
// twice, so pin the exact wording rather than "contains 'grade'": the point of the
// helper is that the two surfaces say the SAME sentence.
eq('grades wording', rangeBackwardsMessage('grades'), 'Put the lower grade first.');
eq('ages wording', rangeBackwardsMessage('ages'), 'Put the younger age first.');
// Unknown mode reads as grades, matching audienceMode's defaultMode: afterschool is
// always grades and is the common case. Both callers pass an explicit mode today, so
// this pins the fallback rather than describing a path anything currently takes.
eq('unknown mode falls back to grades, not ages', rangeBackwardsMessage(undefined), 'Put the lower grade first.');
// No pointer at a control - each caller puts it somewhere different.
for (const m of ['grades', 'ages']) {
  eq(`${m}: names no control`, /below|above|button|right|left/i.test(rangeBackwardsMessage(m)), false);
}

// --- gradeFitProblem: the checkout warning ------------------------------------
// 2026-08-25: a parent paid, then realised her son was below the range. WARN, not
// block - so the thing these tests must protect hardest is every case that has to
// stay SILENT. A warning that fires when it should not is worse than none: the
// parent learns to click past it, including the time it was right.
const G46 = { grade_min: 4, grade_max: 6, age_format: 'grade' };

eq('below the range warns', gradeFitProblem(G46, '2')?.code, 'below');
eq('above the range warns', gradeFitProblem(G46, '8')?.code, 'above');
eq('inside the range is silent', gradeFitProblem(G46, '5'), null);
eq('on the lower edge is silent', gradeFitProblem(G46, '4'), null);
eq('on the upper edge is silent', gradeFitProblem(G46, '6'), null);

// KINDERGARTEN IS ZERO, AND '' IS NOT. Number('') is 0, so a form field the parent
// has not touched would read as Kindergarten and warn every family registering for
// a class that starts at grade 1. isUnset is what keeps those apart.
eq('unanswered grade is silent', gradeFitProblem(G46, ''), null);
eq('null grade is silent', gradeFitProblem(G46, null), null);
eq('undefined grade is silent', gradeFitProblem(G46, undefined), null);
eq('Kindergarten is a real answer, not a blank',
  gradeFitProblem({ grade_min: 1, grade_max: 5, age_format: 'grade' }, '0')?.code, 'below');
eq('Kindergarten inside a K-2 class is silent',
  gradeFitProblem({ grade_min: 0, grade_max: 2, age_format: 'grade' }, '0'), null);

// Open-ended ranges check ONE side. Inventing the missing bound would warn a 9th
// grader out of a class that deliberately left the top open.
eq('open top: far above is silent',
  gradeFitProblem({ grade_min: 2, grade_max: null, age_format: 'grade' }, '11'), null);
eq('open top: below still warns',
  gradeFitProblem({ grade_min: 2, grade_max: null, age_format: 'grade' }, '1')?.code, 'below');
eq('open bottom: far below is silent',
  gradeFitProblem({ grade_min: null, grade_max: 6, age_format: 'grade' }, '0'), null);
eq('open bottom: above still warns',
  gradeFitProblem({ grade_min: null, grade_max: 6, age_format: 'grade' }, '9')?.code, 'above');

// An AGE-based class has null grade columns and never stated a grade range, so
// quoting one at a parent would be inventing it.
eq('age-based class is silent',
  gradeFitProblem({ age_min: 6, age_max: 12, age_format: 'age', grade_min: null, grade_max: null }, '2'), null);
// A class carrying BOTH while claiming ages: audienceMode believes the claim, and
// this must agree with it or the form contradicts the family-facing card.
eq('class claiming ages wins over stray grade columns',
  gradeFitProblem({ age_min: 6, age_max: 12, age_format: 'age', grade_min: 4, grade_max: 6 }, '2'), null);
eq('class stating nothing at all is silent', gradeFitProblem({}, '2'), null);
eq('no program is silent', gradeFitProblem(null, '2'), null);

// A backwards range makes EVERY grade "outside", so the warning would fire at every
// family for the operator's typo. They meet rangeBackwards in their own editor.
eq('backwards range is silent, not a warning at every family',
  gradeFitProblem({ grade_min: 6, grade_max: 4, age_format: 'grade' }, '5'), null);

// String columns from a form round-trip must behave as numbers, not as text.
// '10' > '9' is FALSE as strings, so a text comparison would silently stop warning
// exactly where two-digit grades begin.
//
// WHAT THIS ACTUALLY PINS, checked by mutation 2026-09-02: it fails when BOTH the
// grade and the bounds are strings. Making only one side a string still passes,
// because JS coerces the other operand back to a number - that is not a defect,
// it is the language doing the right thing. Written down because a test whose
// name promises more than it checks is how a guard rots unnoticed.
eq('numeric compare, not lexical',
  gradeFitProblem({ grade_min: '1', grade_max: '9', age_format: 'grade' }, '10')?.code, 'above');

// --- the sentence -------------------------------------------------------------
// Quotes audienceLabel so the gate and the family-facing card cannot disagree
// about what the class says it is for.
eq('names the range and both ways out',
  gradeFitMessage(G46, 'Journey to STEAM'),
  "This class is for Grades 4–6. Choose a class that matches your child's grade, or ask Journey to STEAM if they should be in this one.");
eq('a single-grade class does not say 3-3',
  gradeFitMessage({ grade_min: 3, grade_max: 3, age_format: 'grade' }, 'Journey to STEAM'),
  "This class is for Grade 3. Choose a class that matches your child's grade, or ask Journey to STEAM if they should be in this one.");

// A GATE HAS TO NAME THE WAY OUT. This is the pinned half: the wording must never
// go back to "you can still register", which was true of the warning and is a lie
// about a gate, and it must always leave the family something to do. Three hard
// gates with no way past have been removed from this codebase; the sentence is
// what stops this becoming the fourth.
eq('does NOT claim they can still register', /still register/.test(gradeFitMessage(G46)), false);
eq('offers a class that fits', /Choose a class/.test(gradeFitMessage(G46)), true);
eq('offers asking the provider', /if they should be in this one/.test(gradeFitMessage(G46)), true);

// The provider is named when known, and the sentence still reads when it is not.
eq('names the provider when it is known',
  /ask Journey to STEAM/.test(gradeFitMessage(G46, 'Journey to STEAM')), true);
eq('falls back rather than printing a gap',
  /get in touch/.test(gradeFitMessage(G46)), true);
eq('no provider means no dangling "ask"',
  /ask\s+if|ask\s*$/.test(gradeFitMessage(G46)), false);
eq('a blank provider name is treated as absent',
  gradeFitMessage(G46, '   '), gradeFitMessage(G46));
eq('never says our own word for them at a parent',
  /the provider\b/i.test(gradeFitMessage(G46)), false);

eq('never renders the word null', /null/.test(gradeFitMessage(G46, null)), false);
eq('never renders undefined', /undefined/.test(gradeFitMessage(G46, undefined)), false);
// Promises nothing the code does not do, and points at no control.
eq('promises no follow-up nobody performs',
  /we'll|we will|let (the|your) (teacher|provider|instructor) know|contact you/i.test(gradeFitMessage(G46)), false);
eq('names no control', /below|above the button|grey button/i.test(gradeFitMessage(G46)), false);

// The problem object carries the SAME sentence, with the same provider name, so
// the box under the field and the refused-Continue message cannot drift.
eq('the problem carries the provider-named sentence',
  gradeFitProblem(G46, '2', 'Journey to STEAM')?.message,
  gradeFitMessage(G46, 'Journey to STEAM'));

console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
