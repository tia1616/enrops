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
// two sentences. Starts speaking at 75% and gets specific at the ceiling.
export function describeDescriptionLength(value, max = PROGRAM_DESCRIPTION_MAX) {
  const len = (value || '').length;
  if (len === 0) return null;
  if (len >= max) return { text: `You've reached the ${max.toLocaleString()} character limit.`, atLimit: true };
  const left = max - len;
  if (len >= max * 0.75) return { text: `${left.toLocaleString()} characters left.`, atLimit: false };
  return { text: `${len.toLocaleString()} characters.`, atLimit: false };
}
