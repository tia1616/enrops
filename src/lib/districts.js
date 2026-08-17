// One definition of "does this districts row behave like a district".
//
// `districts` is really the CALENDAR SOURCE table: it carries calendar_key and the
// flyer settings, and the Calendars page offers every row as an upload target. Since
// 20260817a a row also declares WHAT it is:
//
//   district           - a real school district. Groups schools under its own name,
//                        and is a legitimate answer to "which district is this
//                        school in?"
//   independent_school - a private/charter/independent school that owns its own
//                        calendar. It exists ONLY so that school can have one. It
//                        must never be offered as another school's district, and it
//                        must never render as its own heading in the public
//                        registration picker.
//
// THREE SEPARATE USES, and they do NOT all want the same list — getting this wrong is
// how a duplicate district row gets created:
//
//   1. A "pick a district" DROPDOWN  -> grouping rows only. Use groupingDistricts().
//      (VenueEditor, LocationsList's EditCard, AddSchoolModal.)
//   2. Name-match-before-create      -> ALL rows. Matching against a filtered list
//      would miss an existing independent_school of the same name and insert a
//      second row beside it, which the per-org unique-on-lower(name) index is there
//      to prevent.
//   3. id -> name for DISPLAY        -> ALL rows. A school legitimately linked to an
//      independent_school row still has to show its name.
//
// The Calendars page is use 3's cousin and deliberately lists BOTH types: every row
// is a calendar target, which is the whole point.
export const INDEPENDENT_SCHOOL = 'independent_school';

// Does this row group schools under its own name? Type-only on purpose, so callers
// can compose it with whatever else they need (the registration picker also requires
// a readable name, because a row missing from its map means a BROKEN READ rather than
// a private school - see regCatalogPicker).
export function isGroupingDistrict(row) {
  return row?.district_type !== INDEPENDENT_SCHOOL;
}

// The subset a "which district is this school in?" control may offer.
export function groupingDistricts(rows) {
  return (rows ?? []).filter(isGroupingDistrict);
}
