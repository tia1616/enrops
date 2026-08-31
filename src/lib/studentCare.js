// ONE definition of "edit a child's care details after checkout".
//
// WHY THIS FILE EXISTS. Until now exactly one screen could write a child's
// dismissal answer and pickup people: PickupInfoGate, the one-time backfill
// interstitial, which fires only when `dismissal_method` is null or the answer
// is aftercare-with-no-provider. So a family who answered "released to an
// authorized adult" and then actually started going to aftercare had NO route in
// the app at all, and no operator surface wrote `student_contacts` either - when
// a parent told an operator "actually she goes to aftercare", there was no box
// anyone could type it into. That is the safety gap this build closes.
//
// Closing it means THREE screens write the same fact (the gate, the parent's own
// editor, the operator's roster editor). Three copies of the validation and
// three spellings of the payload is how the dismissal vocabulary ended up
// written six times and disagreeing - see the note at the top of dismissal.js.
// So the rules live here, once, and the screens only render.
//
// Pure and dependency-light on purpose: it is imported by a .test.mjs that node
// runs directly, so nothing here may reach a .jsx module.
import { dismissalAnswerIncomplete } from './dismissal.js';
import { namedContacts, contactsWithAnyName } from './registrationFields.js';

// THE COLUMNS A CARE EDITOR MUST READ, in one place.
//
// This is a select/read contract, not a convenience. `replace_student_pickup_dnr_guardian`
// DELETEs every row for roles authorized_pickup / do_not_release / guardian and
// re-INSERTs from the payload, so any column a screen fails to load is a column
// the next save writes NULL over. `relationship` and `notes` are unset on every
// row on both environments today and no UI collects them - which is precisely
// why they are easy to drop and never notice.
export const CARE_CONTACT_COLUMNS =
  'id, student_id, role, first_name, last_name, phone, email, relationship, notes, sort_order';

// The contact fields the RPC actually inserts. Anything else on a loaded row
// (id, student_id, sort_order) is re-derived by the function and must NOT be
// echoed back, or a re-save would try to reuse a primary key that the DELETE
// above just removed.
const RPC_CONTACT_FIELDS = ['first_name', 'last_name', 'phone', 'email', 'relationship', 'notes'];

// Strip a loaded contact row down to what the RPC reads, keeping every value it
// carries. Used for rows the editor is carrying through untouched.
export function toRpcContact(c) {
  const out = {};
  for (const k of RPC_CONTACT_FIELDS) {
    const v = c?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') out[k] = v;
  }
  return out;
}

// WHAT GETS SAVED: anything with a name in either box, NOT the stricter
// "counts as an answer" rule. Filtering the save with the strict rule would
// silently delete real entries - prod holds "Club K Teachers",
// "Casey Negrieff" and "AINSWORTH AFTERCARE - MOST DAYS". Same helper the gate
// and the registration form already use.
export const savableContacts = contactsWithAnyName;

// A DO-NOT-RELEASE NAME A PARENT MAY NOT DELETE.
//
// Jessica, 2026-08-31: a parent can ADD to the do-not-release list but cannot
// remove an entry that is already saved. Adding a name to that list is always
// safe; removing one may be exactly what a custody order forbids, and
// `student_contacts` has no `created_by` column, so we cannot tell whether this
// parent, the other parent or the operator put it there. The operator keeps full
// edit on the roster, so the action still exists - with them in the loop.
//
// This is NOT merely a hidden delete button. Because the RPC replaces the whole
// role, a parent editor that dropped these rows from its payload would DELETE
// them just as surely as a delete button would. Every locked row must come back
// out of here and go into the save.
export function lockedDoNotRelease(loadedRows) {
  return (Array.isArray(loadedRows) ? loadedRows : [])
    .filter((c) => c?.role === 'do_not_release')
    .map((c) => ({ ...toRpcContact(c), __locked: true }));
}

export function isLockedContact(c) {
  return !!c?.__locked;
}

// The do-not-release list to SAVE: every locked row carried through verbatim,
// then whatever the editor added. Order is locked-first so the saved rows keep
// their existing sort_order positions.
//
// Callers that may remove entries (the operator) simply pass a list with no
// locked rows in it; this function never re-adds a row that is not in `list`,
// so it cannot resurrect something an operator deliberately deleted.
export function doNotReleaseToSave(list) {
  const rows = Array.isArray(list) ? list : [];
  const locked = rows.filter(isLockedContact).map(toRpcContact);
  const added = savableContacts(rows.filter((c) => !isLockedContact(c))).map(toRpcContact);
  return [...locked, ...added];
}

/**
 * What (if anything) stops this child's care details being saved?
 *
 * ONE reason, as a sentence a person can act on, or null. Mirrors the
 * registration wizard's advanceProblem() and the gate's problemFor() - which is
 * the point: all three now ask this function instead of each spelling it out.
 *
 * `std` is parseRegFields(...).std for the org. `data` is the editor's staged
 * state for one child.
 *
 * Returns the string 'loading' when the child's data has not arrived. That is a
 * sentinel, never shown to a person: a caller must treat it as "blocked" but
 * must not render it, or a parent reads the word "loading" as an instruction.
 */
export function careProblem(std, data) {
  if (!data) return 'loading';

  if (std?.dismissal_method && !data.dismissal_method) {
    return 'Choose how this child leaves.';
  }

  // "Aftercare" with no program named answers the category and withholds the
  // destination - the one detail the answer exists to supply. The database
  // enforces this too (the 7-arg RPC raises on it), so an editor that skipped
  // the check would turn a knowingly-incomplete save into a 500.
  if (dismissalAnswerIncomplete(data.dismissal_method, data.aftercare_provider)) {
    return 'Add which aftercare program they go to.';
  }

  // NO REQUIREMENT ON THE EXTRA-ADULTS LIST, deliberately - a family whose only
  // collectors are the parents has nobody to name, and demanding one here would
  // strand them on a screen with no way past. See registrationQuestions.js.
  //
  // namedContacts (strict), not savableContacts (wide): this asks "has a
  // mandatory question been answered", which is a different question from "what
  // must we keep".
  if (std?.do_not_release?.required && namedContacts(data.doNotRelease).length === 0) {
    return 'Add the name(s) we should not release this child to.';
  }

  return null;
}

// HOMEROOM IS NOT PART OF THE RPC, ON PURPOSE.
//
// Jessica, 2026-08-28, choosing this over extending or pruning the overloads:
// `replace_student_pickup_dnr_guardian` already exists as TWO signatures (6-arg
// and 7-arg); an 8th argument would make three spellings of one write path.
// Homeroom is a plain student attribute with no mutual-exclusion trigger and no
// snapshot, so it is written by an ordinary update alongside the custody RPC.
// The two invariants are independent, and a partial failure leaves custody
// correct and homeroom stale - the safe direction.
//
// Returns the patch to send, or null when nothing changed. Sending nothing when
// nothing changed is what keeps this from becoming a whole-row write that
// reverts a value another screen just set (see the 2026-08-07 audit).
export function homeroomPatch(loadedValue, nextValue) {
  const before = (loadedValue ?? '').trim();
  const after = (nextValue ?? '').trim();
  if (before === after) return null;
  return { homeroom_teacher: after === '' ? null : after };
}

/**
 * The arguments for replace_student_pickup_dnr_guardian, built once.
 *
 * Always passes p_aftercare_provider, even as null: migration 20260807b gave the
 * 7th parameter NO default so the 6-arg and 7-arg overloads coexist
 * unambiguously, which means omitting it resolves to the OLD function and
 * silently drops the aftercare destination.
 */
export function careRpcArgs({ studentId, organizationId, data }) {
  // "I NEVER LOADED IT" AND "THERE ARE NONE" MUST NOT LOOK ALIKE.
  //
  // The RPC replaces the whole do_not_release role from this payload, so a
  // caller that forgot to select those rows sends [] and DELETES a child's
  // custody entries - silently, with a success toast. `[].some(...)` being false
  // is the same empty-collection trap that made a "has none" warning trivially
  // true for rows that had nothing at all.
  //
  // undefined means the screen never loaded the list; [] means it loaded and the
  // child has none. Only the second is a legitimate save, and the difference is
  // invisible unless something insists on it. Thrown rather than defaulted: a
  // silent fallback here is the bug.
  if (!Array.isArray(data?.doNotRelease)) {
    throw new Error(
      'careRpcArgs: doNotRelease must be an array. An editor that has not loaded the ' +
      'do-not-release rows would delete them - select them (CARE_CONTACT_COLUMNS) first.',
    );
  }
  const g2 = data?.guardian2 || {};
  return {
    p_student_id: studentId,
    p_organization_id: organizationId,
    p_pickup: savableContacts(data?.pickup).map(toRpcContact),
    p_do_not_release: doNotReleaseToSave(data?.doNotRelease),
    p_guardian: (g2.first_name || '').trim() ? [toRpcContact(g2)] : [],
    p_dismissal_method: data?.dismissal_method || null,
    p_aftercare_provider: data?.aftercare_provider || null,
  };
}

// The database's own sentences, turned into ones a person can act on.
//
// TWO of these raises are ALREADY written to a person and say more than any
// replacement could, so they are passed through verbatim rather than flattened:
//
//   - the pickup/do-not-release exclusion is a CONSTRAINT TRIGGER, so every
//     writer inherits it whether or not it checked first, and it names the
//     offending contact ('Contact "Pat Byron" cannot be on both...'). Replacing
//     it with a generic sentence would throw away the one detail that makes it
//     actionable when four people are listed.
//   - the 7-arg RPC's aftercare raise is already a request to a parent.
//
// The other two raises must NOT reach anybody: 'not authorized to edit contacts
// for student <uuid>' and 'student <uuid> not in organization <uuid>' both put
// raw ids on screen, so they fall through to the generic line.
//
// Matched on the distinctive phrase, not on a common word. An earlier draft
// tested `includes('both')`, which is a PROXY for this error rather than the
// error itself - it would have relabelled any unrelated failure whose message
// happened to contain "both" as a pickup conflict.
export function careSaveMessage(error) {
  const raw = (error && (error.message || String(error))) || '';
  const m = raw.toLowerCase();
  if (m.includes('do-not-release list')) return raw;
  if (m.includes('which aftercare program')) return raw;
  if (m.includes('not authorized')) {
    return "You don't have permission to change this child's details.";
  }
  if (m.includes('network') || m.includes('failed to fetch') || m.includes('timeout')) {
    return 'Network hiccup - please try again.';
  }
  return "Sorry, that didn't save. Please try again.";
}
