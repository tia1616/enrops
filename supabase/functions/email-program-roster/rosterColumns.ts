// rosterColumns.ts — what a PARTNER SCHOOL's roster PDF is allowed to say.
//
// This lives in its own module, and is tested, because the list is a privacy
// boundary rather than a layout preference. The PDF is emailed to every contact
// on a partner site, and that audience is deliberately wide: three J2S sites have
// NO school staff on file at all, so a PTA or booster-club inbox is the only way
// the school hears anything. The recipients therefore cannot be narrowed without
// cutting real schools off — which means the document itself has to be safe to
// send to all of them.
//
// Jessica, 2026-09-11: "rosters only need student names, homeroom teacher,
// grade." Until that day the same PDF also carried parent name, parent phone,
// parent email and emergency contact, and 24 deliveries had gone to 19 PTA,
// booster-club and personal gmail addresses.
//
// Co-located rather than in _shared/ on purpose: the Supabase CLI bundles a
// function's imports at deploy time, so anything in _shared/ rides along with
// every function that imports it. Camps have their own roster sender with its own
// (still wider) column list; when that one is brought into line the two can be
// merged into a single shared spec deliberately, in a release that deploys both.

/** One column of the partner roster table. */
export interface RosterColumn {
  /** Key into the per-row value map built by the PDF renderer. */
  key: string;
  /** Header text drawn at the top of the table. */
  label: string;
  /** Column width in PDF points. */
  width: number;
}

/**
 * The total table width the page was laid out around. Kept fixed so the header,
 * the footer rule, the continuation-page geometry and the landscape page size do
 * not have to move whenever the column list changes.
 */
export const ROSTER_TABLE_WIDTH = 692;

/**
 * Every column the partner-facing roster may contain. Name, grade and homeroom
 * are what a front office needs to release a child to us; nothing else is the
 * school's business, and nothing else is fetched (see the registrations select
 * in index.ts, which is narrowed to match).
 *
 * Allergy and EpiPen were removed from this PDF earlier and stay out: they live
 * on the admin roster screen and the instructor's own view.
 */
export const ROSTER_COLUMNS: readonly RosterColumn[] = Object.freeze([
  { key: 'name', label: 'Student', width: 320 },
  { key: 'grade', label: 'Grade', width: 72 },
  { key: 'homeroom', label: 'Homeroom', width: 300 },
]);

/**
 * Column keys that must never appear on a partner roster again, with the field
 * each one came from. Named explicitly so the test fails loudly with the reason
 * rather than a bare inequality, and so anyone adding a column sees the list.
 */
export const FORBIDDEN_ROSTER_KEYS: readonly string[] = Object.freeze([
  'parent',
  'parent_phone',
  'parent_email',
  'ec',
  'emergency_contact',
  'emergency_contact_name',
  'emergency_contact_phone',
  'allergies',
  'epipen',
  'epipen_required',
  'medical_notes',
  'medical_conditions',
  'medications_at_program',
  'dietary_restrictions',
  'birthdate',
  'pronouns',
  'authorized_pickup_contacts',
]);
