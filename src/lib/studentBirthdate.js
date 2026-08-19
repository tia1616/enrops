// studentBirthdate — is this plausibly a STUDENT's birth date?
//
// Why this exists: 2026-08-19, a parent registering for Ukulele Club filled the
// "About your student" step with his OWN name and his OWN birth date (1980), paid
// $301.99, and only found out because the confirmation email greeted the wrong
// person. Nothing on the form objected: the field required a date and 1980-12-18
// is a date. The roster went out with a 45-year-old first-grader on it.
//
// The check is deliberately LOOSE. Its job is to catch "that's an adult" and
// "that's a typo", not to police who may enroll: providers run programs from
// preschool through high school, and a guard that argues with a legitimate
// 4-year-old or 18-year-old is worse than no guard, because the parent cannot
// get past it and abandons a paid registration.
//
// Reference date is TODAY, not the first session. At these bounds a few weeks
// never flips the verdict, and the student step does not know which program the
// cart holds - threading it through to buy nothing would be scaffolding.

// Outside this band, we ask the parent to look again. Inclusive.
export const MIN_PLAUSIBLE_AGE = 3;
export const MAX_PLAUSIBLE_AGE = 19;

// Parse 'YYYY-MM-DD' into integer parts. No Date involved on purpose: every
// timezone-shifted date bug in this repo started with new Date('2026-09-16')
// resolving to the previous day west of UTC.
function parts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return null;
  // The day must exist IN THAT MONTH, not merely be under 32. Checking the two
  // bounds independently let 2019-02-30 through, and it did not fail loudly: the
  // same-month comparison in ageOn then read day 28 < day 30 and returned 6 for a
  // seven-year-old, inside the plausible band, so no message was shown. A date
  // input cannot emit February 30th, but a restored sessionStorage cart or a
  // browser that degrades type=date to free text can.
  if (d > daysInMonth(y, mo)) return null;
  return { y, mo, d };
}

/** Days in a month, Gregorian leap rule. mo is 1-12. */
function daysInMonth(y, mo) {
  if (mo === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(mo) ? 30 : 31;
}

/**
 * Whole years old on `asOf`. Null when either date is unparseable.
 * @param {string} birthdate  'YYYY-MM-DD'
 * @param {string} asOf       'YYYY-MM-DD'
 */
export function ageOn(birthdate, asOf) {
  const b = parts(birthdate);
  const a = parts(asOf);
  if (!b || !a) return null;
  let age = a.y - b.y;
  // Birthday hasn't come round yet this year.
  if (a.mo < b.mo || (a.mo === b.mo && a.d < b.d)) age -= 1;
  return age;
}

/** Today as 'YYYY-MM-DD' in the viewer's own timezone. */
export function todayIso(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * What (if anything) is wrong with this birth date?
 *
 * Returns null when it is fine or when it is simply not filled in yet - an empty
 * field is the required-field guard's business, not this one's. Returning a
 * problem for '' would light the form up red before the parent has typed.
 *
 * @returns {null | { code: 'unparseable'|'future'|'too_old'|'too_young', age: number|null, message: string }}
 */
export function birthdateProblem(birthdate, asOf = todayIso()) {
  const raw = String(birthdate ?? '').trim();
  if (!raw) return null;

  const b = parts(raw);
  if (!b) {
    return { code: 'unparseable', age: null, message: 'Please enter the birth date as month, day and year.' };
  }

  const age = ageOn(raw, asOf);
  if (age === null) return null; // asOf unusable — don't invent a complaint

  if (age < 0) {
    return { code: 'future', age, message: "That birth date is in the future - please check the year." };
  }
  if (age > MAX_PLAUSIBLE_AGE) {
    return {
      code: 'too_old',
      age,
      // Names the number, because "invalid date" tells a parent nothing and this
      // is the exact mistake being caught: their own birth date in their child's
      // field. The wording asks rather than accuses - a 19-year-old sibling in a
      // high-school program is a real case that lands here too.
      message: `This works out to ${age} years old. Please check the year, and make sure this is your student's birth date rather than your own.`,
    };
  }
  if (age < MIN_PLAUSIBLE_AGE) {
    return {
      code: 'too_young',
      age,
      message: `This works out to ${age} year${age === 1 ? '' : 's'} old. Please check the year.`,
    };
  }
  return null;
}
