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

// Normalize a contact name the SAME way the DB trigger does (lower + trim on
// first AND last). Returns null when there's nothing to match on. Keeping this
// identical to student_contacts_no_pickup_dnr_overlap() means the inline warning
// never disagrees with what the database will actually reject.
//
// Lived in RegExtraFields.jsx until 2026-08-31. It is a pure function, and while
// it sat in a .jsx the plain-node test runner could not reach it - so each screen
// that needed the rule wrote its own sentence for it.
export function normalizeContactName(c) {
  const first = (c?.first_name || '').trim().toLowerCase();
  const last = (c?.last_name || '').trim().toLowerCase();
  if (!first && !last) return null;
  return `${first} ${last}`;
}

// People who appear on BOTH the authorized-pickup and do-not-release lists for
// one child. The same person cannot be on both (Jessica: "that should be
// impossible") - the DB enforces it with a constraint trigger; this drives the
// friendly warning and the advance/save block so it is fixed before the save.
export function pickupDnrConflicts(pickup, doNotRelease) {
  const pickupKeys = new Map(); // normalized -> display name
  for (const p of Array.isArray(pickup) ? pickup : []) {
    const k = normalizeContactName(p);
    if (k) pickupKeys.set(k, `${(p.first_name || '').trim()} ${(p.last_name || '').trim()}`.trim());
  }
  const seen = new Set();
  const conflicts = [];
  for (const d of Array.isArray(doNotRelease) ? doNotRelease : []) {
    const k = normalizeContactName(d);
    if (k && pickupKeys.has(k) && !seen.has(k)) {
      seen.add(k);
      conflicts.push(pickupKeys.get(k));
    }
  }
  return conflicts;
}

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

  // ONE SENTENCE FOR THE CLASH, not three. The gate, the parent editor and the
  // operator's roster panel each wrote their own before this lived here, and two
  // of the three had already drifted to a different wording. The names are IN the
  // sentence because a roster row can carry four people and "a name" tells an
  // operator nothing about which.
  //
  // Last, deliberately: an unanswered question is the more basic problem, and a
  // family that has not chosen how their child leaves does not need to hear about
  // a list clash first.
  const clash = pickupDnrConflicts(data.pickup, data.doNotRelease);
  if (clash.length > 0) {
    return `${clash.join(', ')} ${clash.length > 1 ? 'are' : 'is'} on both the pickup and do-not-release lists. Remove ${clash.length > 1 ? 'them' : 'that name'} from one.`;
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
// ATTENDANCE IS CHECKED FIRST, AND THAT ORDER IS LOAD-BEARING. The attendance
// trigger raises two of its own, and one of them contains the exact phrase
// 'do-not-release list' - so under the old order it hit the pass-through branch
// above and printed a raw STUDENT UUID to a parent. Any `attendance_records:`
// message is handled here or falls to the generic line; none is ever returned
// raw. (Found 2026-09-03 while diagnosing the save that Seth Ring could not
// complete. His screen said "Sorry, that didn't save. Please try again." for a
// failure that could never succeed - the release record for his child named a
// guardian, and replacing the contact rows nulled the pointer to her, which
// re-ran the trigger. The one fact that made it actionable was thrown away at
// the last step.)
//
// The NAME is kept for the same reason the pickup conflict keeps it: it is the
// only detail that makes the sentence actionable. The uuid beside it is not.
//
// BOTH SENTENCES DESCRIBE THE CONFLICT AND ASSERT NOTHING ABOUT WHO IS ON FILE,
// and Seth's own case is why. A first draft said "that name is not on file as a
// parent or guardian" - which is what the trigger checked, and was FALSE on his
// screen: Amy Burke WAS his guardian. She only failed the check for the instant
// mid-transaction when the replace had deleted her row and not yet re-inserted
// it. Copy may only assert what the state selecting it actually proves (gate
// xii), and "you cannot remove this person" fails the same way - the save that
// fires this removed nobody. So they name the record, not a verdict.
//
// Matched on the distinctive phrase, not on a common word. An earlier draft
// tested `includes('both')`, which is a PROXY for this error rather than the
// error itself - it would have relabelled any unrelated failure whose message
// happened to contain "both" as a pickup conflict.
// `action` exists because the SAME failures reach a person on the way IN and on
// the way OUT, and only two of the branches care which. A load failure told a
// parent "Sorry, that didn't save" - about a screen that had not tried to save
// anything - which reads as though their data was lost. Defaulted to 'save' so
// every existing caller is unchanged.

// The adult's name out of an attendance raise, which carries it double-quoted.
// Returns '' when there is nothing quoted, so the caller falls back to a
// sentence that does not pretend to name anybody. Matched non-greedily and on
// the FIRST quoted run: both raises quote exactly one name, and a greedy match
// would swallow everything up to a later quote if the format ever grows one.
// Read off the ORIGINAL string, not the lower-cased copy, so the name keeps the
// capitalisation the family typed.
function quotedName(raw) {
  const found = /"([^"]+)"/.exec(raw);
  return found ? found[1].trim() : '';
}

// One sentence, one place. It ends all four attendance sentences, and four
// copies would drift the first time one of them is reworded.
const FIX_THE_RECORD = 'That release record has to be sorted out before this will save.';

export function careSaveMessage(error, { action = 'save' } = {}) {
  const raw = (error && (error.message || String(error))) || '';
  const m = raw.toLowerCase();
  // FIRST, and never `return raw` - see the header. Anything from this trigger
  // that is not one of the two known sentences falls through to the generic
  // line rather than leaking whatever ids it carries.
  if (m.includes('attendance_records:')) {
    const who = quotedName(raw);
    if (m.includes('is on the do-not-release list')) {
      return who
        ? `That didn't save. "${who}" is on the do-not-release list, and an attendance record for this child names them as the adult who collected them. ${FIX_THE_RECORD}`
        : `That didn't save. Someone on the do-not-release list is named on an attendance record as the adult who collected this child. ${FIX_THE_RECORD}`;
    }
    if (m.includes('is not the account parent or a guardian')) {
      return who
        ? `That didn't save. It conflicts with an attendance record for this child, which names "${who}" as the adult who collected them. ${FIX_THE_RECORD}`
        : `That didn't save. It conflicts with an attendance record for this child, naming the adult who collected them. ${FIX_THE_RECORD}`;
    }
    return action === 'load'
      ? "Sorry, we couldn't load that. Please try again."
      : "Sorry, that didn't save, so nothing changed. Tell us if it keeps happening.";
  }
  if (m.includes('do-not-release list')) return raw;
  if (m.includes('which aftercare program')) return raw;
  if (m.includes('not authorized') || m.includes('permission denied')) {
    return action === 'load'
      ? "You don't have permission to see this child's details."
      : "You don't have permission to change this child's details.";
  }
  if (m.includes('network') || m.includes('failed to fetch') || m.includes('timeout')) {
    return 'Network hiccup - please try again.';
  }
  return action === 'load'
    ? "Sorry, we couldn't load that. Please try again."
    : "Sorry, that didn't save. Please try again.";
}

// Jessica's words, approved 2026-09-04. It is the ACTION half and never stands
// alone: every branch below NAMES what was refused first, then ends with this.
// A bare instruction to phone home, with no reason attached, is the same
// unhelpful shrug as "check your connection" - just politer.
const CALL_THE_PARENTS = 'If no authorized adult is present for pick-up, call the parents.';

/**
 * The INSTRUCTOR-PORTAL half of the release rules.
 *
 * careSaveMessage() above and this one read the SAME trigger raises and must
 * not be merged. They speak to people standing in opposite directions:
 *
 *   careSaveMessage      - someone EDITING CONTACTS, told that an attendance
 *                          record already on file contradicts the edit. The
 *                          fix is to the record: FIX_THE_RECORD.
 *   attendanceSaveMessage - the instructor recording a release AS IT HAPPENS,
 *                          with the child in front of them. Nothing about a
 *                          past record helps; what helps is knowing the release
 *                          was refused and who to ring: CALL_THE_PARENTS.
 *
 * Only the PARSING is shared (quotedName + the 'attendance_records:' prefix),
 * which is why this lives here rather than in InstructorPortal.jsx - a second
 * copy of the prefix test is how the two would drift.
 *
 * Two properties the tests pin, both learned the hard way:
 *   - NEVER echo a raw raise. Every one of them carries a student uuid.
 *   - NEVER assert that an adult is "not on file". The guardian check fails for
 *     the instant a contact replace has deleted the row it is about to re-add,
 *     so a refusal does not prove absence. Say what could not be CONFIRMED.
 */
export function attendanceSaveMessage(error) {
  const raw = (error && (error.message || String(error))) || '';
  const m = raw.toLowerCase();

  if (m.includes('attendance_records:')) {
    const who = quotedName(raw);

    // --- the three custody refusals: name the refusal, then the action -----
    if (m.includes('is on the do-not-release list')) {
      return who
        ? `That didn't save. "${who}" is on this child's do-not-release list, so this child cannot be released to them. ${CALL_THE_PARENTS}`
        : `That didn't save. That adult is on this child's do-not-release list, so this child cannot be released to them. ${CALL_THE_PARENTS}`;
    }
    // Both the by-name and by-contact-id checks land here. The by-id raise
    // quotes nothing, so `who` is '' and the unnamed sentence runs.
    if (m.includes('is not the account parent or a guardian')
        || m.includes('is not an authorized pickup or guardian')) {
      return who
        ? `That didn't save. We couldn't confirm "${who}" as an adult approved to collect this child. ${CALL_THE_PARENTS}`
        : `That didn't save. We couldn't confirm that adult as someone approved to collect this child. ${CALL_THE_PARENTS}`;
    }

    // --- not custody refusals, but the same catch called these a connection
    // problem too. Each is fixable at the screen, and none carries a name. ---
    if (m.includes('requires released_to_name')) {
      return "That didn't save. Add the name of the adult collecting this child.";
    }
    if (m.includes('cannot record attendance for a future date')) {
      return "That didn't save. This class day hasn't happened yet.";
    }
    if (m.includes('a released child cannot be marked absent')) {
      return "That didn't save. This child is already marked as released. Clear the release first, then mark them absent.";
    }

    // Fail closed. The trigger has other raises and may grow more; an
    // unrecognised one carries ids and must never reach a screen.
    return "Sorry, that didn't save, so nothing changed. Tell us if it keeps happening.";
  }

  if (m.includes('not authorized') || m.includes('permission denied')) {
    return "You don't have permission to record attendance for this child.";
  }
  // Only a REAL transport failure keeps the connection wording. That sentence
  // was the whole bug: it was being shown for refusals the connection had
  // delivered perfectly well.
  if (m.includes('network') || m.includes('failed to fetch') || m.includes('timeout')) {
    return "Couldn't save. Check your connection and try again.";
  }
  return "Sorry, that didn't save. Please try again.";
}
