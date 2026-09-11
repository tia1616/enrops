// The partner roster is emailed to PTA and booster-club inboxes as well as school
// staff, because three J2S sites have no school staff on file and the PTA is the
// only route in. So these assertions are about what may leave the building, not
// about table layout.

import { assert, assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import {
  ROSTER_COLUMNS,
  ROSTER_TABLE_WIDTH,
  ROSTER_PRINTABLE_WIDTH,
  FORBIDDEN_ROSTER_KEYS,
} from './rosterColumns.ts';

Deno.test('partner roster prints exactly student, grade and homeroom', () => {
  assertEquals(ROSTER_COLUMNS.map((c) => c.key), ['name', 'grade', 'homeroom']);
});

Deno.test('no family contact or medical field can reach a partner school', () => {
  for (const key of ROSTER_COLUMNS.map((c) => c.key)) {
    assert(
      !FORBIDDEN_ROSTER_KEYS.includes(key),
      `"${key}" is on the partner roster. This PDF goes to PTA and booster-club ` +
        `inboxes as well as school staff, so family contact details and medical ` +
        `fields must not be columns on it. If a school genuinely needs this, it ` +
        `needs a different document with a different recipient rule.`,
    );
  }
});

Deno.test('column widths still total the width the page was laid out around', () => {
  // The header rule and the per-row rule are drawn across this number. Changing
  // the columns without re-balancing them leaves the table a different width from
  // the rules drawn under its own header.
  const total = ROSTER_COLUMNS.reduce((sum, c) => sum + c.width, 0);
  assertEquals(
    total,
    ROSTER_TABLE_WIDTH,
    `columns total ${total} but the table is laid out for ${ROSTER_TABLE_WIDTH}; ` +
      `re-balance the widths rather than moving the page.`,
  );
});

Deno.test('the table actually fits on the page it is printed on', () => {
  // The assertion above only compares the columns to a number written beside
  // them, so on its own it cannot see the page at all: change the page size or a
  // margin and it stays green while the last column runs off the paper. This one
  // checks the thing that actually goes wrong.
  const total = ROSTER_COLUMNS.reduce((sum, c) => sum + c.width, 0);
  assert(
    total <= ROSTER_PRINTABLE_WIDTH,
    `columns total ${total}pt but only ${ROSTER_PRINTABLE_WIDTH}pt fits between ` +
      `the margins; the last column would be printed off the edge of the page.`,
  );
});

Deno.test('every column has a usable header and a positive width', () => {
  for (const c of ROSTER_COLUMNS) {
    assert(c.label.trim().length > 0, `column "${c.key}" has no header text`);
    assert(c.width > 0, `column "${c.key}" has a non-positive width`);
  }
});
