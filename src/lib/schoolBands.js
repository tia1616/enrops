// Which school band does a calendar closure actually name?
//
// WHY THIS EXISTS. A district calendar lists closures for the whole district,
// so "No School: MS Grade Prep" is a middle-school day that an elementary
// after-school class is entirely unaffected by. Nothing in the product knew
// that, so on 2026-09-30 the no-school reminder told 8 families and an
// instructor that a class was cancelled on a day the school was open. This
// turns the label the reader already quotes verbatim into a SUGGESTION that a
// closure may not apply - the provider always confirms before anything is
// dropped, so this is never the last word.
//
// THE SAFETY PROPERTY, which every change here must preserve:
//   - an elementary word can only ever cause KEEP
//   - a secondary word causes a drop-SUGGESTION only when no elementary word
//     is present
//   - a label naming no band at all is KEPT
// So every direction of failure lands on "keep the closure", and the worst
// outcome is a suggestion the provider declines.
//
// THE TRAP, paid for once. "Early Release Days (not high schools)" and
// "Early Release Day - Except High Schools" are 16 real PPS dates that DO
// apply to elementary - the label names high school only to EXCLUDE it. A
// naive "contains HS" test drops exactly the dates that matter most. Negated
// band mentions are therefore discounted. The negation words are only `not`,
// `except` and `excluding`: "no LS classes" is NOT a negation, it is how a
// calendar says lower school is the band that is out.
//
// Abbreviations are matched CASE-SENSITIVELY and uppercase-only, because that
// is how calendars write them and because the lowercase forms are ordinary
// English - "US" is Upper School, "us" is a pronoun. Full words are matched
// case-insensitively.

// Uppercase-only abbreviations. LS = Lower School, EL/ES = Elementary,
// P/PK = Preschool. US = UPPER SCHOOL (independent schools), JH = Junior High.
const ABBREV_ELEMENTARY = ['LS', 'EL', 'ES', 'PK', 'P'];
const ABBREV_SECONDARY = ['MS', 'HS', 'US', 'JHS', 'JH'];

// Case-insensitive full words.
//
// SECONDARY WORDS ARE MULTI-WORD ONLY, and that is load-bearing. The bare words
// were here first and had to be removed: "No School: High Holy Days" and
// "High Holidays" are standard all-school closure labels, "Junior Achievement
// Day" and "Senior Project Day" are real no-school days, and every one of them
// was being pre-ticked for deletion. Deleting Rosh Hashanah off a calendar
// sends an instructor to a locked building - the same failure this module
// exists to prevent, inverted. A band is only a band when the label says
// "school", so only those forms count.
const WORD_ELEMENTARY = [
  'elementary', 'elem', 'lower school', 'lower-school', 'primary',
  'preschool', 'pre-school', 'pre-k', 'prek', 'kindergarten', 'kinder',
];
const WORD_SECONDARY = [
  'middle school', 'high school', 'upper school', 'junior high', 'senior high', 'secondary',
];

// Genuine exclusion words. Negating a band here is safe in both directions:
// it removes a secondary band (so we stop suggesting a drop) or an elementary
// one (so we stop forcing a keep), and both land on "keep" overall.
const NEGATORS = ['not', 'except', 'excepting', 'excluding', 'excl', 'exc', 'but', 'minus', 'outside'];

// "no" IS NOT AN EXCLUSION WORD, and treating it as one was a defect worse
// than the bug it fixed. In a closure label "no X" almost always means X is
// the band that is OUT: "No Elementary Classes, MS Conferences" is a day
// elementary is shut. With "no" negating freely, that label lost its
// elementary band and came back secondary-only - PRE-TICKED FOR DELETION. It
// also killed the main case the screen exists for, because "No MS Classes"
// negated its own MS. Prod already stores three labels of this shape
// ("LS Conferences - no LS classes" and two siblings).
//
// It survives in exactly one shape: a PLURAL "... schools", as in "no high
// schools", where the label is naming schools the day does NOT cover. That is
// the real PPS wording this guard was added for, and it is the only place
// `no` is allowed to negate anything.
const NEGATORS_WITH_NO = [...NEGATORS, 'no'];

// Post-positioned: "high schools excepted". Looked for just AFTER the band.
// Prebuilt once rather than per call.
const TRAILING_NEGATOR_RES = ['excepted', 'excluded', 'exempt', 'unaffected'].map(
  (neg) => new RegExp(`^[\\s,:;/&()\\[\\]{}.-]*(?:are\\s+|is\\s+|were\\s+|was\\s+)*${neg}\\b`),
);

// A band mention is negated when a negation word sits just before it, with
// nothing but filler between. Anchored to the BAND, never to the bare word:
// "School Not in Session" contains "not" and names no band, so nothing here
// fires and the date is kept.
const FILLER = /^[\s,:;/&()[\]{}.-]*(?:the\s+|all\s+|for\s+|at\s+|in\s+|to\s+)*$/;

function isNegated(haystackLower, matchStart, matchEnd, allowNo = false) {
  const windowStart = Math.max(0, matchStart - 24);
  const before = haystackLower.slice(windowStart, matchStart);
  for (const neg of (allowNo ? NEGATORS_WITH_NO : NEGATORS)) {
    let idx = before.lastIndexOf(neg);
    while (idx !== -1) {
      const endsWord = idx + neg.length >= before.length || /[^a-z]/.test(before[idx + neg.length]);
      const startsWord = idx === 0 || /[^a-z]/.test(before[idx - 1]);
      if (endsWord && startsWord && FILLER.test(before.slice(idx + neg.length))) return true;
      // lastIndexOf(needle, -1) searches from 0 and returns 0 again, so a
      // negator sitting at the very start of the window with a failing filler
      // test spins forever. Hit the moment "no" became a negator: the window
      // before the range in "No School 11-27" starts with "no". Stop at 0.
      if (idx === 0) break;
      idx = before.lastIndexOf(neg, idx - 1);
    }
  }
  if (typeof matchEnd === 'number') {
    const after = haystackLower.slice(matchEnd, matchEnd + 24);
    for (const re of TRAILING_NEGATOR_RES) if (re.test(after)) return true;
  }
  return false;
}

function findWord(originalLower, needle, out, negatedOut) {
  // Calendars pluralise the "... school" forms ("Except High Schools"), so a
  // trailing "s" is allowed on exactly those - not on bare words, where it
  // would let "highs" read as high school.
  const pluralOk = needle.endsWith('school');
  let from = 0;
  for (;;) {
    const i = originalLower.indexOf(needle, from);
    if (i === -1) return;
    const before = i === 0 ? '' : originalLower[i - 1];
    let end = i + needle.length;
    // "no" may only negate the PLURAL "... schools" form. See NEGATORS_WITH_NO.
    const isPluralSchools = pluralOk && originalLower[end] === 's';
    if (isPluralSchools) end += 1;
    const after = originalLower[end] ?? '';
    const bounded = (before === '' || /[^a-z]/.test(before)) && (after === '' || /[^a-z]/.test(after));
    if (bounded) (isNegated(originalLower, i, end, isPluralSchools) ? negatedOut : out).push(needle);
    from = i + needle.length;
  }
}

// "US" is Upper School in an independent school's calendar and the COUNTRY
// everywhere else, and both are written in caps: prod already stores labels
// like "NO SCHOOL-VETERANS DAY OBSERVED", so "NO SCHOOL - US HOLIDAY" is
// ordinary. It therefore only counts as a band when the very next word is
// something only a school does. "US Conferences" is a band; "US Holiday" and
// "US Thanksgiving Holiday" are not.
const US_FOLLOWERS = /^[\s.,:;/&-]*(classes|class|conferences|conference|students|student|exams|exam|finals|advisory|dismissal|retreat|assembly|prep|grade|grades|schedule)\b/i;

function abbrevQualifies(abbrev, original, index) {
  if (abbrev !== 'US') return true;
  return US_FOLLOWERS.test(original.slice(index + abbrev.length));
}

function findAbbrev(original, originalLower, abbrev, out, negatedOut) {
  let from = 0;
  for (;;) {
    const i = original.indexOf(abbrev, from);
    if (i === -1) return;
    const before = i === 0 ? '' : original[i - 1];
    const after = original[i + abbrev.length] ?? '';
    // Uppercase-only AND word-bounded: "MS" in "Elem, MS Conferences" counts,
    // "Ms" and the "ms" inside a word do not.
    const bounded = (before === '' || !/[A-Za-z]/.test(before)) && (after === '' || !/[A-Za-z]/.test(after));
    if (bounded && abbrevQualifies(abbrev, original, i)) {
      (isNegated(originalLower, i, i + abbrev.length) ? negatedOut : out).push(abbrev);
    }
    from = i + abbrev.length;
  }
}

// Grade ranges: a range reaching down to K or grade 5 includes elementary; one
// starting at 6 or above is secondary.
//
// A CUE IS REQUIRED - the word "grade(s)"/"gr" in front, or a range starting at
// K, which can only be a grade. Matching any two numbers joined by a dash was a
// one-click catastrophe: "Winter Break 22-31" read as grades 22-31, i.e.
// secondary, i.e. PRE-TICKED FOR DELETION, and confirming it would have wiped a
// whole winter break off the calendar. "Thanksgiving Break 26-28",
// "No School 11-27" and "Conferences (No School) 6-8 pm" all did the same. The
// extract prompt stores the calendar's exact label, so date and time ranges in
// labels are normal, not exotic.
function gradeRangeBands(text, lower, elementary, secondary, negated) {
  const push = (cueIndex, matchEnd, token, low) => {
    const target = low <= 5 ? elementary : secondary;
    (isNegated(lower, cueIndex, matchEnd) ? negated : target).push(token);
  };
  // "grades 6-8", "gr. 3-5"
  const cued = /\b(grades?|gr\.?)\s*(K|\d{1,2})\s*(?:-|–|—|to|through)\s*(\d{1,2})\b/gi;
  let m;
  while ((m = cued.exec(text)) !== null) {
    const lowRaw = m[2].toUpperCase();
    push(m.index, m.index + m[0].length, m[0].trim(), lowRaw === 'K' ? 0 : parseInt(lowRaw, 10));
  }
  // "K-12", "K-5" - K is its own cue, and always reaches elementary.
  const kRange = /\bK\s*(?:-|–|—|to|through)\s*(\d{1,2})\b/gi;
  while ((m = kRange.exec(text)) !== null) {
    if (/\b(grades?|gr\.?)\s*$/i.test(text.slice(0, m.index))) continue; // already counted above
    push(m.index, m.index + m[0].length, m[0].trim(), 0);
  }
}

/**
 * Which bands does this closure label name?
 * @param {string} reason the calendar's own label, quoted verbatim
 * @returns {{elementary: string[], secondary: string[], negated: string[]}}
 */
export function classifyBands(reason) {
  const text = typeof reason === 'string' ? reason : '';
  const lower = text.toLowerCase();
  const elementary = [];
  const secondary = [];
  const negated = [];

  for (const w of WORD_ELEMENTARY) findWord(lower, w, elementary, negated);
  for (const w of WORD_SECONDARY) findWord(lower, w, secondary, negated);
  for (const a of ABBREV_ELEMENTARY) findAbbrev(text, lower, a, elementary, negated);
  for (const a of ABBREV_SECONDARY) findAbbrev(text, lower, a, secondary, negated);
  gradeRangeBands(text, lower, elementary, secondary, negated);

  return {
    elementary: Array.from(new Set(elementary)),
    secondary: Array.from(new Set(secondary)),
    negated: Array.from(new Set(negated)),
  };
}

/**
 * True when the label names ONLY secondary bands - i.e. this closure is a
 * candidate to drop for a provider running elementary programs. Never the last
 * word: the provider confirms every drop.
 * @param {string} reason
 * @returns {boolean}
 */
export function isSecondaryOnly(reason) {
  const { elementary, secondary } = classifyBands(reason);
  return secondary.length > 0 && elementary.length === 0;
}

/**
 * The closure dates whose label names only secondary bands, in input order.
 * Rows without a usable date are never suggested.
 * @param {Array<{date?: string, reason?: string}>} dates
 * @returns {Array<{date: string, reason: string}>}
 */
export function secondaryOnlyDates(dates) {
  if (!Array.isArray(dates)) return [];
  return dates
    .filter((d) => typeof d?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date.trim()))
    .filter((d) => isSecondaryOnly(d?.reason ?? ''))
    .map((d) => ({ date: d.date.trim(), reason: (d?.reason ?? '').trim() }));
}

/**
 * The secondary-only dates a provider has NOT already ruled on. A date they
 * confirmed does apply carries `applies: true` and is never asked about again.
 * One spelling, because the confirm panel and the badge that advertises it must
 * agree - a badge offering a question the panel then says it has nothing to ask
 * is the dead end this product keeps having to fix.
 * @param {Array<{date?: string, reason?: string, applies?: boolean}>} dates
 * @returns {Array<{date: string, reason: string}>}
 */
export function unansweredSecondaryOnlyDates(dates) {
  const rows = Array.isArray(dates) ? dates : [];
  // Trimmed on BOTH sides. secondaryOnlyDates trims its output, so comparing
  // against a raw stored date meant an answered row never matched and the
  // panel re-asked about it forever - the exact failure the trim was added to
  // fix, left in the one place that also needed it.
  const answered = new Set(
    rows.filter((r) => r?.applies === true)
      .map((r) => (typeof r?.date === 'string' ? r.date.trim() : '')),
  );
  return secondaryOnlyDates(rows).filter((r) => !answered.has(r.date));
}
