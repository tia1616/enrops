// Grades and ages — how a program says who it is for.
//
// Jessica, 2026-08-06: "afterschool is always done by grades. only camps are done
// by ages. provider won't show both - they just need to be able to enter grades or
// ages for the program." So a program carries ONE of the two, never both, and the
// afterschool default is grades.
//
// WHY THIS FILE EXISTS. The grade vocabulary was written three times, and the three
// disagreed:
//   - CurriculumReview.jsx:109   GRADE_OPTIONS  K through 12, labels "K","1","2"
//   - StepStudent.jsx:19         GRADE_OPTIONS  K through 6 ONLY, labels "Kindergarten","1st grade"
//   - CurriculaList.jsx:355      gradeLabel()   0=K, negatives=Pre-K
//   - AfterschoolSchedule.jsx    gradeLabel()   0=K, no Pre-K handling at all
//
// That is the duplication Jessica called out: "the same information is entered in
// too many different ways. confusing for the user, but then also confusing when
// we're coding." One definition here; new callers use it, and the existing four are
// tracked for repointing (see the note at the bottom).

// 0 = Kindergarten. Negative = Pre-K, matching the convention CurriculaList
// already established, so existing rows keep their meaning.
export const KINDERGARTEN = 0;

// K through 12. Pre-K is representable in the DATA (negative) but deliberately not
// offered here: no provider has used it, and adding an option nobody needs to every
// grade dropdown is noise. If one asks, add { value: '-1', label: 'Pre-K' } at the
// front and gradeLabel already renders it.
export const GRADE_OPTIONS = [
  { value: '0', label: 'K' },
  ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
];

// "" IS NOT ZERO. This codebase uses "" for "not stated" in form state and NULL in
// the database, and `Number("")` is 0, not NaN - so every `== null` guard in this
// module let an empty form field through as Kindergarten. A panel draft holds "" in
// an untouched field, so `audienceLabel(draft)` would have rendered "Grade K" for a
// class nobody had described. One place to decide it, used by everything below.
export function isUnset(v) {
  return v === null || v === undefined || v === '' || Number.isNaN(Number(v));
}

// The SAME RANGE, in the words a parent reads. The registration form used to carry
// its own list that stopped at 6th grade while operators could set a class to any
// grade - so a provider who set "Grades 7-9" had families who could not pick their
// child's grade and therefore could not register at all. Jessica, 2026-08-07:
// "grades that can be entered should be the range shown in registration. obviously."
//
// One place defines WHICH grades exist; the two label styles differ only because an
// admin dropdown wants "5" and a parent wants "5th grade". Derived from
// GRADE_OPTIONS so the two lists cannot drift apart again.
const ORDINAL = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};
export const GRADE_OPTIONS_LONG = GRADE_OPTIONS.map(({ value }) => ({
  value,
  label: value === '0' ? 'Kindergarten' : `${ORDINAL(Number(value))} grade`,
}));

// gradeLabel(0) -> "K"; gradeLabel(5) -> "5"; gradeLabel(-1) -> "Pre-K".
// Returns null (not "?") for a missing value, so callers decide whether to render
// anything at all rather than printing a question mark at a family.
export function gradeLabel(n) {
  if (isUnset(n)) return null;
  const g = Number(n);
  if (g === KINDERGARTEN) return 'K';
  if (g < 0) return 'Pre-K';
  return String(g);
}

// The one sentence a family reads: "Grades K–5" or "Ages 6–12", never both.
//
// Grades win when present. That is not arbitrary: grades are the afterschool
// vocabulary and afterschool is the common case, so if a row somehow carries both
// (legacy data, an import), the afterschool reading is the safer one to show. A
// single-value range collapses to "Grade 3" / "Age 7" rather than "3–3".
//
// OPEN-ENDED RANGES ARE NOT EXACT ONES. The first version of this function
// coalesced a missing end onto the other (`lo = aMin ?? aMax`), so age_min 5 with
// no max rendered "Age 5" — telling a parent of a six-year-old the class was not
// for them. The registration card this module is meant to replace already got this
// right ("Ages 5+", "Up to age 12"), so adopting the module unchanged would have
// been a downgrade on the one surface families actually read. Its own tests pinned
// the wrong answer, because they were written from the implementation rather than
// from what a parent needs to know.
//
// Returns null when neither is set, so the caller omits the line instead of
// rendering "not set" at a parent.
// TOTAL: every path returns a string or null, never a string containing "null".
// An earlier version dropped the all-unparseable guard and fell through to
// `Up to grade ${hi}` with hi still null, which renders the literal word "null" on
// a family-facing card. The `lo == null && hi == null` check below is that guard,
// restored and now covering both branches rather than only the grade one.
export function audienceLabel(row) {
  if (!row) return null;

  // MUST AGREE WITH audienceMode. Once audienceMode started reading age_format
  // first, this still preferred grades unconditionally - so a row saying
  // age_format 'age' while also carrying a grade pair showed "Grades K-5" on the
  // family card and opened the editor on Ages. The operator corrects the age,
  // saves, and the range the card was showing is gone. Same rule, one place: the
  // operator's explicit answer outranks whichever columns happen to be filled.
  if (audienceMode(row, { defaultMode: null }) === 'ages') return ageLabel(row);

  const gLo = gradeLabel(row.grade_min);
  const gHi = gradeLabel(row.grade_max);
  if (gLo != null || gHi != null) {
    if (gLo != null && gHi != null) return gLo === gHi ? `Grade ${gLo}` : `Grades ${gLo}–${gHi}`;
    // Symmetric with the age forms below - "Grades 2+" beside "Ages 5+", not
    // "Grades 2 and up". Two renderings of one concept sitting side by side on the
    // same card is the duplication this module exists to remove.
    if (gLo != null) return `Grades ${gLo}+`;
    return `Up to grade ${gHi}`;
  }

  return ageLabel(row);
}

// Ages: the wording is carried over verbatim from the lean catalog card, which is
// live and which families have been reading all term - EXCEPT the equal-endpoints
// case, which the old card rendered "Ages 7–7" and which collapses here to "Age 7".
// No live row has equal endpoints (checked on both databases).
function ageLabel(row) {
  const aLo = isUnset(row.age_min) ? null : Number(row.age_min);
  const aHi = isUnset(row.age_max) ? null : Number(row.age_max);
  if (aLo == null && aHi == null) return null;
  if (aLo != null && aHi != null) return aLo === aHi ? `Age ${aLo}` : `Ages ${aLo}–${aHi}`;
  if (aLo != null) return `Ages ${aLo}+`;
  return `Up to age ${aHi}`;
}

// Which mode an existing row is in, for opening an editor on the right tab.
//
// MUST agree with audienceLabel on a row that carries both. It did not in the first
// version of this file: audienceLabel showed grades, audienceMode opened on ages, so
// an operator would see "Grades K–5" on the card, open the editor on Ages, and the
// first save would clear the grades they were looking at. Nothing imports this yet,
// so it was caught before it could do that.
//
// Grades win in both, deliberately diverging from CurriculumReview's rule
// (`hasGrade && !hasAge ? 'grades' : 'ages'`). Afterschool is always grades and is
// the common case, so on an ambiguous row the afterschool reading is the safer one
// to both show and edit. A brand-new row with neither gets the caller's default.
// age_format FIRST. It is the operator's explicit answer to "which question does
// this class answer", and ProgramWizardNew has always treated it as the source of
// truth. Deriving the mode from null-ness instead gave the app TWO competing
// definitions: on a row carrying both pairs the wizard said 'age' and this said
// 'grades', so an editor opened on Grades and the first save silently destroyed the
// age range. Presence is now only the fallback for rows written before the column
// was filled in.
export function audienceMode(row, { defaultMode = 'grades' } = {}) {
  const hasGrade = !isUnset(row?.grade_min) || !isUnset(row?.grade_max);
  const hasAge = !isUnset(row?.age_min) || !isUnset(row?.age_max);
  // age_format is the operator's stated answer and outranks mere presence - but
  // ONLY when the pair it names actually holds something. A row claiming 'grade'
  // with no grades in it is contradictory, and trusting the claim over the data
  // made the label disagree with the editor again: a row saying 'age' while
  // carrying grades returned NO LABEL AT ALL, so the audience line vanished from
  // the family card for a class that plainly stated a range. Believe the claim
  // when it is backed by data; otherwise believe the data.
  if (row?.age_format === 'grade' && hasGrade) return 'grades';
  if (row?.age_format === 'age' && hasAge) return 'ages';
  if (hasGrade) return 'grades';
  if (hasAge) return 'ages';
  return defaultMode;
}

// True when a range reads backwards. Both ends must be present for it to be wrong -
// an open-ended range cannot be.
export function rangeBackwards(min, max) {
  if (isUnset(min) || isUnset(max)) return false;
  return Number(min) > Number(max);
}

// What an operator is told when rangeBackwards is true. Lives beside the rule it
// explains, for the same reason GRADE_OPTIONS_LONG lives beside GRADE_OPTIONS: the
// Scheduled Programs panel and the classic wizard both meet this rule, and the
// moment the sentence is typed twice the two surfaces start drifting - which is the
// duplication this whole module exists to remove.
//
// No pointer at a control ("below", "the grey button"): each caller renders it in a
// different place, so any direction would be false on one of them.
export function rangeBackwardsMessage(mode) {
  return `Put the ${mode === 'ages' ? 'younger age' : 'lower grade'} first.`;
}

// DOES THIS CHILD'S GRADE FIT THE CLASS? A GATE.
//
// 2026-08-25: a parent picked a class, filled the form, paid, and only afterwards
// realised her son was below the range. The class carries grade_min/grade_max, the
// form asks the grade, and nothing ever compared the two.
//
// IT WAS A WARNING FIRST, AND JESSICA CHANGED IT TO A GATE on 2026-09-03: "we
// shouldn't allow people to register if they're not in the grade range. shouldn't
// be a warning should be a gate." Recorded with the number she was told before
// deciding, because it is the cost of the rule: measured on prod that day, 29 of
// 414 live registrations were BELOW the class range - across 25 classes and BOTH
// tenants, every one paid, every one off by exactly one grade, and not one
// registration anywhere above the range. So this is not typos; families with a
// slightly-young child were registering and both providers were keeping them.
// A gate turns those away at checkout.
//
// WHAT MAKES THE GATE SAFE IS THAT THE PROVIDER STILL HAS A DOOR. Blocking the
// family does not lose the registration: an operator can add the child from the
// roster by hand, which runs through admin-import-program-roster and never
// touches this rule. So the decision moves to the person who knows their own
// exceptions, instead of the product guessing. The message says so rather than
// leaving a family at a wall - this codebase has now removed three hard gates
// that trapped somebody with no way past, and that is the pattern to avoid, not
// gating itself.
//
// Returns null - meaning "let them through" - in every case where refusing would
// be wrong. These matter more than the blocking cases now that this is a gate:
// each false block is a paid registration turned away, and last term there were
// 29 real ones riding on exactly these rules.
//   - the grade is not filled in yet. Same rule as birthdateProblem: lighting the
//     form up before the parent has answered teaches them to ignore it. It is also
//     OPTIONAL for lean orgs, so an unanswered grade is a legitimate final state.
//   - the class is age-based, or states no audience at all. audienceMode is the one
//     place that decides which question a class answers; comparing a grade against
//     the grade columns of an age-based class would quote a range the provider
//     never stated.
//   - the class's own range reads backwards (grade_max below grade_min). Every
//     grade is "outside" a backwards range, so the gate would refuse EVERY family
//     for what is the operator's typo - it would read as the class being broken.
//     rangeBackwards already names that condition, and the operator meets it in
//     their own editor.
//
// @returns {null | { code: 'below'|'above', message: string }}
export function gradeFitProblem(program, grade, providerName) {
  if (!program || isUnset(grade)) return null;
  // defaultMode null: a class that states neither grades nor ages must not be
  // treated as grade-shaped just because grades are the common case.
  if (audienceMode(program, { defaultMode: null }) !== 'grades') return null;
  if (rangeBackwards(program.grade_min, program.grade_max)) return null;

  const g = Number(grade);
  const lo = isUnset(program.grade_min) ? null : Number(program.grade_min);
  const hi = isUnset(program.grade_max) ? null : Number(program.grade_max);

  // Open-ended ranges check ONE side. "Grades 2+" has nothing to say about an
  // upper bound, and inventing one would warn a 9th grader out of a class that
  // deliberately left the top open.
  let code = null;
  if (lo != null && g < lo) code = 'below';
  else if (hi != null && g > hi) code = 'above';
  if (!code) return null;

  return { code, message: gradeFitMessage(program, providerName) };
}

// The sentence, beside the rule that produces it - same reason
// rangeBackwardsMessage lives here. Three surfaces show this now (the student
// step, the advance guard beside the Continue button, and the review screen), and
// the moment it is typed twice they start drifting.
//
// A GATE HAS TO NAME THE WAY OUT. The previous wording ended "you can still
// register if that's right for your child", which was true of a warning and is a
// lie about a gate. What replaces it is not "sorry": it is the two things the
// family can actually do - pick a class that fits, or ask the provider, who can
// add them by hand. A blocked family with no next step is the exact pattern that
// cost this platform a registration on 24 Aug and has been removed three times.
//
// The provider is named when the caller knows the name, because "contact the
// provider" is our word for them, not a parent's. It falls back rather than
// printing an empty gap, and stays out of this module's own knowledge - the same
// reason referral.js takes the org name rather than importing a tenant.
export function gradeFitMessage(program, providerName) {
  const who = (providerName || '').trim();
  const ask = who ? `ask ${who}` : 'get in touch';
  return `This class is for ${audienceLabel(program)}. Choose a class that matches your child's grade, or ${ask} if they should be in this one.`;
}

// THE ONLY PLACE THAT DECIDES WHICH COLUMNS AN AUDIENCE EDIT WRITES.
//
// Returns the complete five-column patch, so a caller cannot express "both" even by
// accident and cannot invent its own age_format rule. This replaces clearOtherMode(),
// which was exported, unit-tested, imported by NOBODY, and the wrong shape - it could
// only null the other pair, not state the chosen one or set age_format, which is
// exactly why both writers hand-rolled the full rule and the invariant ended up
// living in four copied ternaries instead of here.
//
// Values arrive as form strings or numbers or null; "" means not stated.
// age_format is only claimed when there IS a range - a class that states nothing
// should not assert that it is grade-shaped.
export function audiencePatch(mode, { gradeMin, gradeMax, ageMin, ageMax } = {}) {
  const n = (v) => (isUnset(v) ? null : Number(v));
  if (mode === 'grades') {
    const lo = n(gradeMin);
    const hi = n(gradeMax);
    return {
      grade_min: lo, grade_max: hi,
      age_min: null, age_max: null,
      age_format: lo != null || hi != null ? 'grade' : null,
    };
  }
  const lo = n(ageMin);
  const hi = n(ageMax);
  return {
    grade_min: null, grade_max: null,
    age_min: lo, age_max: hi,
    age_format: lo != null || hi != null ? 'age' : null,
  };
}

// TRACKED, not done here: repoint CurriculumReview, CurriculaList and
// AfterschoolSchedule at this module.
//
// StepStudent IS DONE and is off this list. It reads GRADE_OPTIONS_LONG, so the
// parent form offers K-12 and a class set to grade 7+ is reachable at checkout;
// verified rendering all thirteen grades on staging 2026-09-02. The note here
// still described the old K-6 list long after it was replaced, which is the kind
// of claim that sends somebody to fix a bug that is already fixed.
