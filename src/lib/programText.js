// Limits for operator-authored program text.
//
// ONE definition. The description cap was written twice — QuickProgramBuilder and
// the Scheduled Programs panel each hardcoded maxLength={600} — so raising it meant
// finding both, and a future edit to one would silently disagree with the other.
// Jessica, 2026-08-06: "the same information is entered in too many different ways.
// confusing for the user, but then also confusing when we're coding."

// Roughly three solid paragraphs. Jessica's call after Jeff hit the old ceiling:
// every one of his filled descriptions was pinned at exactly 599 characters.
//
// There is NO database limit — programs.short_description is `text`. This number
// exists only so a card stays readable and an operator gets told where the end is,
// which is the part that was actually broken: the old cap truncated in silence, so
// Jeff wrote past it and only found out afterwards.
export const PROGRAM_DESCRIPTION_MAX = 2000;

// Counter text under the field. Deliberately silent until it matters: a "0 / 2000"
// on an empty field reads as a demand for 2000 characters, and most descriptions are
// two sentences. Starts naming the ceiling at 75% and says so plainly at the limit.
//
// EVERY state has to open with "Character count:". The first version returned a bare
// "4 characters.", and the three call sites rendered it INLINE at the end of the help
// paragraph, so on prod Jessica read "…so you can write more than one paragraph. 4
// characters." — an unfinished sentence, not a count. Her fix, 2026-08-06: say
// "character count", and give it its own line. The line break is the caller's job;
// the unmistakable phrasing is this function's.
export function describeDescriptionLength(value, max = PROGRAM_DESCRIPTION_MAX) {
  const len = (value || '').length;
  if (len === 0) return null;
  const n = len.toLocaleString();
  const ceiling = max.toLocaleString();
  if (len >= max) return { text: `Character count: ${n} of ${ceiling}. That's the limit.`, atLimit: true };
  // Only mention the ceiling once it is close enough to matter. Below 75% the ceiling
  // is noise; above it, "of 2,000" is the warning, without needing a scary colour.
  if (len >= max * 0.75) return { text: `Character count: ${n} of ${ceiling}.`, atLimit: false };
  return { text: `Character count: ${n}.`, atLimit: false };
}
