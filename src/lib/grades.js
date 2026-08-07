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
  if (row?.age_format === 'grade') return 'grades';
  if (row?.age_format === 'age') return 'ages';
  const hasGrade = !isUnset(row?.grade_min) || !isUnset(row?.grade_max);
  const hasAge = !isUnset(row?.age_min) || !isUnset(row?.age_max);
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

// TRACKED, not done here: repoint CurriculumReview, CurriculaList,
// AfterschoolSchedule and StepStudent at this module. StepStudent is the parent
// registration form and only offers K-6, so a class set to grade 7+ cannot be
// matched by any parent - a real bug, but it is on the money path and wants its
// own verified change rather than riding along with a builder field.
