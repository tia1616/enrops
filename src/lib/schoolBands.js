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

// Case-insensitive full words. Longer forms first so "middle school" is found
// before "middle"; presence is all that matters, but ordering keeps the
// reported band list readable.
const WORD_ELEMENTARY = [
  'elementary', 'elem', 'lower school', 'lower-school', 'primary',
  'preschool', 'pre-school', 'pre-k', 'prek', 'kindergarten', 'kinder',
];
const WORD_SECONDARY = [
  'middle school', 'middle', 'high school', 'high', 'upper school', 'upper',
  'secondary', 'junior high', 'junior', 'senior high', 'senior',
];

const NEGATORS = ['not', 'except', 'excluding', 'exc'];

// A band mention is negated when a negation word sits just before it, with
// nothing but filler between. Anchored to the BAND, never to the bare word:
// "School Not in Session" contains "not" and names no band, so nothing here
// fires and the date is kept.
const FILLER = /^[\s,:;/&()[\]{}.-]*(?:the\s+|all\s+|for\s+|at\s+|in\s+|to\s+)*$/;

function isNegated(haystackLower, matchStart) {
  const windowStart = Math.max(0, matchStart - 24);
  const before = haystackLower.slice(windowStart, matchStart);
  for (const neg of NEGATORS) {
    let idx = before.lastIndexOf(neg);
    while (idx !== -1) {
      const endsWord = idx + neg.length >= before.length || /[^a-z]/.test(before[idx + neg.length]);
      const startsWord = idx === 0 || /[^a-z]/.test(before[idx - 1]);
      if (endsWord && startsWord && FILLER.test(before.slice(idx + neg.length))) return true;
      idx = before.lastIndexOf(neg, idx - 1);
    }
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
    if (pluralOk && originalLower[end] === 's') end += 1;
    const after = originalLower[end] ?? '';
    const bounded = (before === '' || /[^a-z]/.test(before)) && (after === '' || /[^a-z]/.test(after));
    if (bounded) (isNegated(originalLower, i) ? negatedOut : out).push(needle);
    from = i + needle.length;
  }
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
    if (bounded) (isNegated(originalLower, i) ? negatedOut : out).push(abbrev);
    from = i + abbrev.length;
  }
}

// Grade ranges: a range that reaches down to K or grade 5 or below includes
// elementary; one that starts at 6 or above is secondary. "K-12" and "K-11"
// are both real labels and both mean the closure covers elementary too.
function gradeRangeBands(text, elementary, secondary) {
  const re = /\b(K|\d{1,2})\s*(?:-|–|—|to|through)\s*(\d{1,2})\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const lowRaw = m[1].toUpperCase();
    const low = lowRaw === 'K' ? 0 : parseInt(lowRaw, 10);
    const high = parseInt(m[2], 10);
    if (!Number.isFinite(high)) continue;
    if (low <= 5) elementary.push(m[0]);
    else if (low >= 6) secondary.push(m[0]);
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
  gradeRangeBands(text, elementary, secondary);

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
