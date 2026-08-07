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

// Counter text under the field.
//
// ONE format at every length: "Character count: 8/2,000". Jessica picked it,
// 2026-08-06, having read the previous attempt on staging: no trailing period, and
// the ceiling always visible rather than appearing at 75% - a number that changes
// shape partway up makes the operator wonder what they did.
//
// It shipped once as a bare "4 characters." rendered INLINE at the end of the help
// paragraph, so the screen read "...so you can write more than one paragraph. 4
// characters." - an unfinished sentence, not a count. Hence the "Character count:"
// label, which is load-bearing and pinned by tests. The line break is the caller's
// job; the unmistakable phrasing is this function's.
//
// Still silent on an empty field: "0/2,000" under an untouched box reads as a demand
// for 2,000 characters, and most descriptions are two sentences.
//
// atLimit is the caller's cue to turn it red. No extra sentence at the ceiling -
// 2,000/2,000 in red already says it, and spelling it out would put back the
// punctuation this format exists to remove.
export function describeDescriptionLength(value, max = PROGRAM_DESCRIPTION_MAX) {
  const len = (value || '').length;
  if (len === 0) return null;
  return {
    text: `Character count: ${len.toLocaleString()}/${max.toLocaleString()}`,
    atLimit: len >= max,
  };
}
