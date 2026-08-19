// What does this class's action button say?
//
// ONE rule, imported by BOTH registration trees. portal/Home.jsx renders two completely
// separate JSX trees - the lean catalog (early return, every provider) and J2S's own
// (with the year-long VIP bundle) - and they are not being merged in this change: they
// sell different things and J2S registration is live with real families in it.
//
// So the BUTTON is drawn twice and the RULE lives here once. Duplicated markup that reads
// a shared rule is a much smaller risk than two copies of the rule, which is how the
// screen and the server end up disagreeing.
//
// Deliberately a pure function of (program, isFull): no fetching, no supabase, no React.
// That is what makes it testable without a browser, and what stops a future caller
// quietly introducing a second source for "is it full".

// The registrations.status value for a child waiting for a place.
//
// EVERY reader that means "enrolled" must exclude it. Seven admin queries filtered only on
// `cancelled_at is null`, which was a correct definition of enrolled right up until this
// status existed - then a waiting child silently became a roster child and an enrolled
// count. That is the seam class: the bug is never in the line you wrote, it is in the code
// that depends on it. Import this rather than typing the literal, so the next reader that
// needs excluding is findable by its references.
export const WAITLIST_STATUS = 'waitlist';

export const ACTION_REGISTER = 'register';
export const ACTION_WAITLIST = 'waitlist';
export const ACTION_EXTERNAL = 'external';

/**
 * Decide what a family can do with this class.
 *
 * @param program  a row from `programs` (needs: runs_own_registration, external_registration_url)
 * @param isFull   the flag from program_full_flags(), or undefined when not yet loaded
 * @returns {'register'|'waitlist'|'external'}
 */
export function programAction(program, isFull) {
  if (!program) return ACTION_REGISTER;

  // A partner-run class is not ours to sell OR to waitlist - we take no money for it and
  // hold no list. It goes to the partner's own page. Checked FIRST, because a full
  // partner class must still send families onward rather than offering our waitlist.
  if (program.runs_own_registration === true) return ACTION_EXTERNAL;

  // UNKNOWN IS NOT FULL.
  //
  // isFull is undefined until the flags load, and null for a class the flag reader did not
  // return (not open, or a stale id). Neither means "full", and treating them as full
  // would turn families away from a class with room while the page was still loading -
  // the worst possible direction to fail. Only an explicit true offers a waitlist.
  return isFull === true ? ACTION_WAITLIST : ACTION_REGISTER;
}

/**
 * Build the {program_id: boolean} map the catalog needs from the rows
 * program_full_flags() returns. Tolerates a failed/absent fetch by returning {} - every
 * class then reads "not full", which is the same fail-open direction as above.
 */
export function fullFlagMap(rows) {
  const map = {};
  if (!Array.isArray(rows)) return map;
  for (const r of rows) {
    if (r && typeof r.program_id === 'string') map[r.program_id] = r.is_full === true;
  }
  return map;
}
