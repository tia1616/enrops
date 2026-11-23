// One family's email typed onto another family's record.
//
// `parents` is one row per PERSON across every business on enrops, and
// `parents.email` is unique. So when an operator corrects a family's email to an
// address that is already on a different parent record (typically the same
// person, registered once with a typo and once correctly, sometimes at another
// business), the write fails with 23505 on `parents_email_key`. The roster used
// to show that raw database string (Jen Israel, 11/23).
//
// The fix for the family is to combine the two records, which is a platform
// job: the records can carry registrations, waivers and a sign-in at other
// businesses this operator cannot see. So the message says what happened and
// who fixes it, and nothing is changed.
//
// The Contacts edit (supabase/functions/update-contact) uses the same sentence.
//
// WORDING. "Belongs to another family" was not true in the case that prompted
// this: Jen Israel's two records were the SAME family, typed twice. All the
// database can say is that the address is on a different record, so that is all
// the sentence claims - and it names the common cause and a real way to reach us
// (Share feedback is in every admin sidebar; HELP_EMAIL receives mail).

import { HELP_EMAIL } from "./helpEmail.js";

const REASON =
  `that email is already on a different record in enrops (often the same family, registered twice). Send us a note with Share feedback or email ${HELP_EMAIL}, and we'll combine the two records.`;

// Contacts: the edit is all-or-nothing (checked before anything is written).
export const PARENT_EMAIL_TAKEN_MESSAGE = `Nothing was changed: ${REASON}`;

// Roster: the student and registration details ARE saved; only the parent's
// name, email and phone (one write) are not.
export const PARENT_EMAIL_TAKEN_ON_ROSTER =
  `Saved, except the parent's name, email and phone: ${REASON}`;

export function isParentEmailTaken(e) {
  if (!e || e.code !== "23505") return false;
  return /parents_email_key/.test(`${e.message ?? ""} ${e.details ?? ""}`);
}
