// Which stored calendar belongs to a row on the Calendars screen?
//
// ONE SPELLING, because two spellings of this rule disagree in both directions
// and each direction is its own defect: the row badge counting one calendar
// while the panel edits another, or the badge offering a question the panel
// then says it has nothing to ask. Both were real in review.
//
// The rule itself predates this file - it is the matcher the Calendars list has
// always used. A school links to a calendar structurally by `district_id`, and
// a school linked before structured districts existed still matches on the
// legacy free-text `district` string.
export function matchCalendarForRow(calendars, row) {
  const rows = Array.isArray(calendars) ? calendars : [];
  if (!row) return null;
  if (row.districtId) {
    return rows.find(
      (c) => c.district_id === row.districtId
        || (row.calendarKey && !c.district_id && c.district === row.calendarKey),
    ) ?? null;
  }
  return rows.find((c) => !c.district_id && c.district === row.label) ?? null;
}
