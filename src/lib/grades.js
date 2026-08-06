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

// gradeLabel(0) -> "K"; gradeLabel(5) -> "5"; gradeLabel(-1) -> "Pre-K".
// Returns null (not "?") for a missing value, so callers decide whether to render
// anything at all rather than printing a question mark at a family.
export function gradeLabel(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
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
// Returns null when neither is set, so the caller omits the line instead of
// rendering "not set" at a parent.
export function audienceLabel(row) {
  if (!row) return null;

  const gMin = row.grade_min;
  const gMax = row.grade_max;
  if (gMin != null || gMax != null) {
    const lo = gradeLabel(gMin ?? gMax);
    const hi = gradeLabel(gMax ?? gMin);
    if (lo == null) return null;
    return lo === hi ? `Grade ${lo}` : `Grades ${lo}–${hi}`;
  }

  const aMin = row.age_min;
  const aMax = row.age_max;
  if (aMin != null || aMax != null) {
    const lo = aMin ?? aMax;
    const hi = aMax ?? aMin;
    return lo === hi ? `Age ${lo}` : `Ages ${lo}–${hi}`;
  }

  return null;
}

// Which mode an existing row is in, for opening an editor on the right tab.
// Mirrors CurriculumReview's rule (grades only when grades are set and ages are
// not), with one addition: a brand-new row with neither gets the default for its
// program shape, because afterschool is always grades.
export function audienceMode(row, { defaultMode = 'grades' } = {}) {
  const hasAge = row?.age_min != null || row?.age_max != null;
  const hasGrade = row?.grade_min != null || row?.grade_max != null;
  if (hasGrade && !hasAge) return 'grades';
  if (hasAge) return 'ages';
  return defaultMode;
}

// Clearing the pair being switched away from is the whole point of a mode: an
// offering must never carry both, or every downstream surface has to guess which
// to believe. Returns the patch to write alongside the new values.
export function clearOtherMode(mode) {
  return mode === 'grades'
    ? { age_min: null, age_max: null }
    : { grade_min: null, grade_max: null };
}

// TRACKED, not done here: repoint CurriculumReview, CurriculaList,
// AfterschoolSchedule and StepStudent at this module. StepStudent is the parent
// registration form and only offers K-6, so a class set to grade 7+ cannot be
// matched by any parent - a real bug, but it is on the money path and wants its
// own verified change rather than riding along with a builder field.
