// Pins the one rule the Calendars row badge and the ClosureScopeChoice panel
// must agree on. Two spellings of it disagreed in BOTH directions in review:
// the badge counting a calendar the panel would not find, and the panel finding
// one the badge never counted. Either way the operator is shown a question
// about a different row than the one that gets written.

import { matchCalendarForRow } from './districtCalendarMatch.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}

const structured = { id: 'a', district_id: 'd1', district: 'LOSD' };
const legacy = { id: 'b', district_id: null, district: 'LOSD' };
const otherLegacy = { id: 'c', district_id: null, district: 'Lake Oswego School District' };

ok('structured district matches on district_id',
  matchCalendarForRow([structured, legacy], { districtId: 'd1', calendarKey: 'LOSD', label: 'Lake Oswego School District' })?.id === 'a');

ok('a structured row with no calendar of its own falls back to the legacy key',
  matchCalendarForRow([legacy], { districtId: 'd1', calendarKey: 'LOSD', label: 'Lake Oswego School District' })?.id === 'b');

// The old divergence: the panel fell back to the row LABEL, which the list
// never tries. A legacy calendar named after the district would be found by one
// and not the other.
ok('the label is NOT used as a fallback key for a structured row',
  matchCalendarForRow([otherLegacy], { districtId: 'd1', calendarKey: 'LOSD', label: 'Lake Oswego School District' }) === null);

ok('an own-calendar school (no district) matches on its label',
  matchCalendarForRow([otherLegacy], { districtId: null, calendarKey: null, label: 'Lake Oswego School District' })?.id === 'c');

ok('a structured row never matches another district\'s legacy calendar',
  matchCalendarForRow([{ id: 'z', district_id: null, district: 'PPS' }], { districtId: 'd1', calendarKey: 'LOSD', label: 'LOSD' }) === null);

ok('no calendars at all is null, not a throw', matchCalendarForRow([], { districtId: 'd1', calendarKey: 'LOSD', label: 'x' }) === null);
ok('a non-array is safe', matchCalendarForRow(null, { districtId: 'd1' }) === null);
ok('a missing row is safe', matchCalendarForRow([structured], null) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
