// How a child leaves at the end of class — the one definition.
//
// WHY THIS FILE EXISTS. The dismissal vocabulary was written SIX times and the
// copies disagreed:
//   - RegExtraFields.jsx:114   the parent's radio list, "Released to a parent or
//                              authorized adult" / "Walks or bikes home on their own"
//   - ProgramRoster.jsx:76     DISMISSAL_LABELS, "Released to an authorized adult"
//   - Rosters.jsx:510          the same map again
//   - InstructorPortal:3622    the same map a third time
//   - StepReview.jsx:6         the same map a fourth time
//   - CartContext.jsx:29       the value list, in a comment
// So a family chose "Released to a parent or authorized adult" and every staff
// surface showed them something slightly different. Four of the five maps also
// fall back to printing the RAW value, so the moment a class answers `aftercare`
// — legal in the database since the customizable-registration work — a roster
// prints the literal word "aftercare" on a custody document.
//
// This is the same fix as src/lib/grades.js, applied to the safety path.

export const RELEASED_TO_ADULT = 'released_to_authorized_adult';
export const WALKS_OR_BIKES = 'walks_or_bikes_home';
export const BUS = 'bus';
export const AFTERCARE = 'aftercare';
export const OTHER = 'other';

// EVERY value students.dismissal_method accepts. Mirrors
// students_dismissal_method_check exactly — if these drift, the UI offers a
// choice the database rejects at save time, which is a wall the parent cannot
// get past mid-checkout.
export const DISMISSAL_VALUES = [RELEASED_TO_ADULT, WALKS_OR_BIKES, BUS, AFTERCARE, OTHER];

// Two wordings, ONE source. The parent form wants a full sentence; a roster
// column wants something that fits. That distinction is real (it is the same
// reason GRADE_OPTIONS and GRADE_OPTIONS_LONG both exist) — what was wrong was
// maintaining them in six places instead of one.
//
// `parent` is what the family reads while choosing. `short` is what staff read
// afterwards on rosters, dismissal lists and the instructor portal.
const CHOICES = [
  {
    value: RELEASED_TO_ADULT,
    parent: 'Released to a parent or authorized adult',
    short: 'Released to an authorized adult',
  },
  {
    value: WALKS_OR_BIKES,
    parent: 'Walks or bikes home on their own',
    short: 'Walks or bikes home',
  },
  {
    value: BUS,
    parent: 'Takes the bus',
    short: 'Bus',
  },
  {
    value: AFTERCARE,
    parent: 'Goes to aftercare',
    short: 'Aftercare',
  },
  {
    value: OTHER,
    parent: 'Something else',
    short: 'Other',
  },
];

// What a provider offers when they have not chosen. NOT all five: turning three
// new options on for every existing tenant silently would change a live
// registration form nobody asked to change. A provider opts in per choice.
export const DEFAULT_OFFERED = [RELEASED_TO_ADULT, WALKS_OR_BIKES];

// The choices to render, from custom_reg_fields.options for the dismissal_method
// row. `options` is null for every provider today, which is exactly why the
// default has to be the two that are already live.
//
// Filtered against CHOICES rather than trusted: options is operator-editable
// data, and a stale or hand-edited value must not render a radio the database
// will refuse. Order follows CHOICES, not the stored array, so the form reads
// the same everywhere regardless of what order they were switched on in.
export function offeredChoices(options) {
  const raw = Array.isArray(options?.offered) ? options.offered : DEFAULT_OFFERED;
  const allowed = new Set(raw);
  const list = CHOICES.filter((c) => allowed.has(c.value));
  // Never render an empty question. A provider who somehow switched every choice
  // off would otherwise get a required question with no answers - a checkout
  // that cannot be completed.
  return list.length ? list : CHOICES.filter((c) => DEFAULT_OFFERED.includes(c.value));
}

// All five, for the Settings screen where a provider picks which to offer.
export function allChoices() {
  return CHOICES.slice();
}

// Staff-facing label. Returns null for an unset value so callers omit the row
// rather than printing "None" at somebody. Falls back to the raw value ONLY for
// something outside the vocabulary, which the CHECK constraint should make
// impossible - but printing `aftercare` beats printing nothing on a custody
// document if it ever happens.
export function dismissalLabel(value) {
  if (!value) return null;
  const found = CHOICES.find((c) => c.value === value);
  return found ? found.short : String(value);
}

// Parent-facing label, same rule.
export function dismissalParentLabel(value) {
  if (!value) return null;
  const found = CHOICES.find((c) => c.value === value);
  return found ? found.parent : String(value);
}

// Does this answer need the "who?" free-text box? Jessica, 2026-08-07: free text
// rather than a preset list - Jeff has one provider per site and nobody has used
// the field yet, so a list would be scaffolding for data that does not exist.
export function needsAftercareProvider(value) {
  return value === AFTERCARE;
}

// Is this audience answer INCOMPLETE - chosen, but missing the one detail it
// exists to supply? Saying "aftercare" without saying which program answers the
// category and not the question, and the whole point of the answer is telling an
// instructor where to walk the child.
//
// Lives here so the form, the wizard's advance guard and the pickup gate's
// blocker all agree; each of those previously had its own idea of "complete".
export function dismissalAnswerIncomplete(dismissalMethod, aftercareProvider) {
  if (!needsAftercareProvider(dismissalMethod)) return false;
  return !(aftercareProvider || '').trim();
}

// Does this answer mean an adult collects the child, and therefore that the
// authorized-pickup list applies? Only the released-to-adult answer does.
// Written here so the form, the wizard's advance guard (Register.jsx) and the
// dashboard's pickup gate cannot disagree about when that list is required -
// they each hardcoded the comparison before.
export function needsAuthorizedPickup(value) {
  return value === RELEASED_TO_ADULT;
}

// WHAT THE INSTRUCTOR RECORDS when they hand an aftercare child over.
//
// Jessica, 2026-08-07, on how dismissal actually runs: "instructors usually walk
// kids to aftercare then take the rest outside to their parents or bikes." It is
// something staff DO, not a release to a person who turned up - so the label says
// "Walked to aftercare", not "Released to".
//
// attendance_records.dismissal_kind gained its own 'aftercare' value (migration
// 20260807d) rather than reusing released_to_adult, because Class Reports flags
// released_to_adult with no contact row as "Released to someone not on the
// authorized list" in red - every correct aftercare handoff would have raised a
// safety violation against the instructor who did the right thing.
export const DISMISSAL_KIND_AFTERCARE = 'aftercare';

// The label and the stored name both carry the provider, so the attendance record
// says WHERE the child went and not merely that they went somewhere. Falls back
// without the name rather than printing a dangling separator.
export function aftercareReleaseLabel(aftercareProvider) {
  const who = (aftercareProvider || '').trim();
  return who ? `Walked to aftercare — ${who}` : 'Walked to aftercare';
}

// CONFIRMING A RECORDED DISMISSAL, in English.
//
// released_to_name holds two different kinds of thing. For a person it is a name
// ("Grandma Pat") and needs "Released to" in front of it. For the two answers
// where nobody collects the child it is already a whole phrase describing what
// staff did ("Walked / biked home", "Walked to aftercare — Champions"), and
// prefixing those produces "Released to Walked to aftercare — Champions".
//
// The walked/biked case has read that way since before aftercare existed; adding
// a second one is what made it worth a helper instead of a second hardcoded
// prefix. Anything not in this set is treated as a person, so an unrecognised
// kind still errs toward naming who took the child.
const SELF_RELEASE_KINDS = new Set(['walked_or_biked', DISMISSAL_KIND_AFTERCARE]);

// Exported for surfaces that label a field rather than write a sentence: a
// "Released to" caption is wrong above "Walked to aftercare — Champions".
export function isSelfRelease(dismissalKind) {
  return SELF_RELEASE_KINDS.has(dismissalKind);
}

export function releaseConfirmationLine(dismissalKind, releasedToName) {
  const who = (releasedToName || '').trim();
  if (!who) return 'Released';
  return SELF_RELEASE_KINDS.has(dismissalKind) ? who : `Released to ${who}`;
}

// ONE LINE FOR A ROSTER, provider name included.
//
// The name is the entire point of the aftercare answer: "Aftercare" alone tells
// an instructor nothing about where the child is supposed to go. Every staff
// surface should call this rather than the bare label, so the name cannot be
// dropped on one screen and shown on another.
//
// Returns null when nothing was stated, so callers omit the field.
export function dismissalSummary({ dismissal_method, aftercare_provider } = {}) {
  const label = dismissalLabel(dismissal_method);
  if (!label) return null;
  if (!needsAftercareProvider(dismissal_method)) return label;
  const who = (aftercare_provider || '').trim();
  // "Aftercare (not stated)" rather than a bare "Aftercare": on a dismissal list
  // the difference between "we know where they go" and "we don't" is the whole
  // safety question, and silence reads as the former.
  return who ? `${label} — ${who}` : `${label} (provider not stated)`;
}
