// The ORDER of children on a roster, once. Pure functions, so the edge cases
// have a test instead of a hope. The Deno twin that edge functions import is
// supabase/functions/_shared/rosterOrder.ts and must behave identically (same
// arrangement as roomLabel.js / roomLabel.ts and waiverText.js / waiverText.ts,
// and guarded the same way by _shared/tests/rosterOrderTwinParity.test.ts).
//
// WHY THIS EXISTS. Five roster surfaces were ordered two different ways and
// neither was alphabetical-by-first-name: the admin roster list and the
// instructor portal showed REGISTRATION order (whoever paid first leads), while
// the per-program roster and the emailed/printed roster sorted by LAST name then
// first, under the comment "print/sign-in friendly". The camp roster email had
// no name sort at all. The last-name comparator was written out twice, verbatim.
//
// WHY FIRST NAME, when the code deliberately chose last. Jeff (Ukulele), via
// Jessica 2026-08-31: "alphabetize student names on rosters by first name - all
// rosters including instructor portal." These are elementary-age classes, the
// instructor knows the children by first name, and the roster is read standing
// in a hallway rather than filed in a cabinet. Jessica made the call. The
// last-name order is deliberately REVERSED here, not lost by accident - which is
// the whole reason this note exists.
//
// WHAT THE LIVE DATA FORCES (measured on prod, 2026-09-01, 649 students):
//
//   1. TRIM FIRST. 47 first names and 26 last names carry a trailing space
//      ("Benjamin ", "Ada ", "Kai "). Ten-plus first names exist in BOTH a
//      spaced and a clean copy, so comparing untrimmed does not merely misplace
//      one row - it makes the two spellings UNEQUAL, so the last-name tiebreak
//      below never fires and two children called Benjamin are ordered by an
//      invisible character.
//   2. FOLD CASE. Seven first names on prod do not start with a capital, and
//      staging carries "j dog". A plain byte comparison puts every lowercase
//      name after every uppercase one, so "aiden" would sort past "Zoe".
//      Collator sensitivity 'base' lands "aiden" and "Aiden" together.
//   3. TIES ON FIRST NAME ARE REAL, AND THEY ARE A CAMP THING. Zero
//      after-school classes on prod have two children sharing a first name, but
//      five camp sessions do ("Julian Eustaquio | Julian Toms", "Aiden Gillis |
//      Aiden Ng"). Last name breaks the tie, and the camp roster email is the
//      surface where it shows.
//   4. A ROW MAY NOT CARRY registered_at. Rosters.jsx orders its QUERY by that
//      column without selecting it, so those row objects have no such field.
//      The tiebreak chain cannot depend on it, hence the final fall back to the
//      registration id: two rows identical all the way down still get one fixed
//      order instead of shuffling between renders.
//
// BLANK FIRST NAMES SORT LAST. Zero on prod today, but the CSV import path can
// make one, and a nameless row is a row that needs attention: last is where it
// can be seen, rather than scattered in among the A's.
//
// NOT FOR the waitlist (waitlist_position) or contacts (sort_order) - those are
// meaningful sequences, not names.

// sensitivity 'base' folds case AND accents, so "Jose" and "Jose" with an accent
// sort together instead of in two places. No `numeric` option: these are names,
// and a numeric collation here would only invent behaviour nobody asked for.
const collator = new Intl.Collator(undefined, { sensitivity: "base" });

// Names arrive from PostgREST as string | null. Anything else (a number typed
// into an import column) is coerced rather than thrown, because a bad cell must
// not blank the roster an instructor is holding.
function nameKey(v) {
  if (v == null) return "";
  return (typeof v === "string" ? v : String(v)).trim();
}

// Compares two REGISTRATION rows (the shape every roster surface holds:
// { id, registered_at, student: { first_name, last_name } }), not two students -
// because the stable tiebreaks live on the registration, not the child.
export function compareRosterRows(a, b) {
  const af = nameKey(a?.student?.first_name);
  const bf = nameKey(b?.student?.first_name);
  if (!af !== !bf) return af ? -1 : 1;            // no first name -> last
  const byFirst = collator.compare(af, bf);
  if (byFirst !== 0) return byFirst;

  const byLast = collator.compare(
    nameKey(a?.student?.last_name),
    nameKey(b?.student?.last_name),
  );
  if (byLast !== 0) return byLast;

  // Same name twice in one class (it happens - two "Jessica Vorster" rows sit on
  // a staging class today). Registration order where the caller selected it,
  // then the id, so the answer is always the same one.
  const ar = nameKey(a?.registered_at), br = nameKey(b?.registered_at);
  if (ar !== br) return ar < br ? -1 : 1;
  const ai = nameKey(a?.id), bi = nameKey(b?.id);
  if (ai === bi) return 0;
  return ai < bi ? -1 : 1;
}

// Returns a NEW array. Callers hold these rows in React state, and sorting one
// in place is a mutation of state that React has no way to notice.
export function sortRosterRows(rows) {
  return [...(rows ?? [])].sort(compareRosterRows);
}
