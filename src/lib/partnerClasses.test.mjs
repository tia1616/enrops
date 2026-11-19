// Partner portal Classes section (20261119a): words, counts and the roster rule pin.
import { readFileSync } from 'node:fs';
import {
  scheduleText, enrolledText, countSourceText, classBadge, rosterAvailable,
  sortClasses, rosterDisplayRows, asksDismissal, shortDate, showsHomeroom,
} from './partnerClasses.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.error(`FAIL  ${name} (got ${JSON.stringify(actual)})`); }
}

const base = { kind: 'class', status: 'open', count_source: 'enrops', enrolled: 5, max_capacity: 18, day_of_week: 'Tuesday', class_days: null, start_time: '4:15 PM', first_date: '2027-01-12', last_date: '2027-03-09' };

// --- count, as Jessica asked: 5/18 ------------------------------------------
eq('count with a maximum reads 5/18', enrolledText(base), '5/18');
eq('no maximum set: just the count', enrolledText({ ...base, max_capacity: null }), '5');
eq('zero enrolled still shows', enrolledText({ ...base, enrolled: 0 }), '0/18');
eq('partner registers: no number', enrolledText({ ...base, count_source: 'partner', enrolled: null }), null);
eq('provider has not typed one: no number', enrolledText({ ...base, count_source: 'provider', enrolled: null }), null);
eq('provider typed 11', enrolledText({ ...base, count_source: 'provider', enrolled: 11 }), '11/18');

// --- where the count came from, every branch true in its state ---------------
eq('live', countSourceText(base), 'Live from registrations');
eq('partner registers, partner view', countSourceText({ ...base, count_source: 'partner' }), 'You run registration for this class');
eq('partner registers, provider view', countSourceText({ ...base, count_source: 'partner' }, { viewer: 'provider', partnerName: 'West Linn Parks and Rec' }), 'West Linn Parks and Rec runs registration for this class');
eq('typed, partner view', countSourceText({ ...base, count_source: 'provider', enrolled: 11, reported_on: '2026-11-19' }, { orgName: 'Journey to STEAM' }), 'Entered by Journey to STEAM, as of Nov 19, 2026');
eq('typed, provider view', countSourceText({ ...base, count_source: 'provider', enrolled: 11, reported_on: '2026-11-19' }, { viewer: 'provider' }), 'Entered by you, as of Nov 19, 2026');
eq('not typed, partner view', countSourceText({ ...base, count_source: 'provider', enrolled: null }, { orgName: 'Journey to STEAM' }), "Journey to STEAM hasn't entered a count yet");
eq('not typed, provider view', countSourceText({ ...base, count_source: 'provider', enrolled: null }, { viewer: 'provider' }), "You haven't entered a count yet");

// --- chip ---------------------------------------------------------------------
eq('open', classBadge(base).label, 'Open');
eq('full at max', classBadge({ ...base, enrolled: 18 }).label, 'Full');
eq('no max is never full', classBadge({ ...base, max_capacity: 0, enrolled: 40 }).label, 'Open');
eq('cancelled wins', classBadge({ ...base, status: 'cancelled', enrolled: 18 }).label, 'Cancelled');
eq('draft', classBadge({ ...base, status: 'draft' }).label, 'Not open yet');
eq('partner-run never "Full" from a null', classBadge({ ...base, count_source: 'partner', enrolled: null }).label, 'Open');

// --- roster availability --------------------------------------------------------
eq('live open class has a roster', rosterAvailable(base), true);
eq('draft has none', rosterAvailable({ ...base, status: 'draft' }), false);
eq('cancelled has none', rosterAvailable({ ...base, status: 'cancelled' }), false);
eq('typed count has none', rosterAvailable({ ...base, count_source: 'provider' }), false);
eq('partner-run has none', rosterAvailable({ ...base, count_source: 'partner' }), false);

// --- schedule ---------------------------------------------------------------------
eq('weekly class', scheduleText(base, 2027), 'Tue 4:15 PM, Jan 12 to Mar 9');
eq('other year shows the year', shortDate('2026-08-08', 2027), 'Aug 8, 2026');
eq('camp days', scheduleText({ ...base, class_days: ['Monday', 'Tuesday', 'Wednesday'], day_of_week: null, start_time: '9:00 AM', first_date: '2027-06-21', last_date: '2027-06-23' }, 2027), 'Mon, Tue, Wed 9:00 AM, Jun 21 to Jun 23');
eq('one day', scheduleText({ ...base, last_date: '2027-01-12' }, 2027), 'Tue 4:15 PM, Jan 12');
eq('nothing known', scheduleText({ status: 'draft' }), 'Dates not set yet');

// --- order ---------------------------------------------------------------------------
eq('site, then first date', sortClasses([
  { site: 'B', first_date: '2027-01-01', title: 'x' },
  { site: 'A', first_date: '2027-02-01', title: 'y' },
  { site: 'A', first_date: '2027-01-05', title: 'z' },
  { site: 'A', first_date: null, title: 'w' },
]).map((c) => c.title), ['z', 'y', 'w', 'x']);

// --- roster rows: the shared roster order, only the agreed fields ------------------
const roster = rosterDisplayRows([
  { row_key: '2', registered_at: '2026-10-02', first_name: 'zoe', last_name: 'Ng', grade: 0, homeroom: ' ', dismissal_method: null },
  { row_key: '1', registered_at: '2026-10-01', first_name: 'Ava', last_name: 'Li', grade: 3, homeroom: 'Ms. Park', dismissal_method: 'walks_or_bikes_home' },
]);
eq('sorted by first name, case-insensitive', roster.map((r) => r.name), ['Ava Li', 'zoe Ng']);
eq('K grade', roster[1].grade, 'K');
eq('blank homeroom is none', roster[1].homeroom, null);
eq('homeroom column shows when a child has one', showsHomeroom(roster), true);
eq('no homeroom anywhere hides the column (parks, camps)', showsHomeroom(rosterDisplayRows([{ row_key: '1', first_name: 'A', homeroom: null }, { row_key: '2', first_name: 'B', homeroom: '' }])), false);
eq('empty roster hides it', showsHomeroom([]), false);
{
  const sqlc = readFileSync(new URL('../../supabase/migrations/20261119c_partner_roster_homeroom_schools_only.sql', import.meta.url), 'utf8');
  eq('homeroom only for a school class (or an untyped partner)', sqlc.includes("p_kind = 'class' and (p.partner_type is null or private.partner_is_school(p.partner_type))"), true);
  // The camp branch is the last `return query` block; it must carry null::text, never homeroom_teacher.
  const campBranch = sqlc.slice(sqlc.lastIndexOf('return query'), sqlc.indexOf('r.camp_session_id = p_class_id'));
  eq('camp roster never carries homeroom', campBranch.includes('null::text') && !campBranch.includes('homeroom_teacher'), true);
}
eq('no dismissal answer says so', roster[1].dismissal, 'Not stated');
eq('only display fields', Object.keys(roster[0]).sort(), ['dismissal', 'grade', 'homeroom', 'key', 'name']);

// --- dismissal column, the emailed roster's rule ---------------------------------------
eq('read failed shows the column', asksDismissal(null, 'class'), true);
eq('asks', asksDismissal([{ standard_key: 'dismissal_method', is_active: true }], 'class'), true);
eq('inactive field', asksDismissal([{ standard_key: 'dismissal_method', is_active: false }], 'class'), false);
eq('camp-only field on a class', asksDismissal([{ standard_key: 'dismissal_method', applies_to: 'enrollment_type', applies_to_value: 'camp' }], 'class'), false);
eq('camp-only field on a camp', asksDismissal([{ standard_key: 'dismissal_method', applies_to: 'enrollment_type', applies_to_value: 'camp' }], 'camp'), true);
eq('never asked', asksDismissal([], 'class'), false);

// --- THE ROSTER RULE IS ONE RULE ----------------------------------------------------------
// private.registration_on_roster (SQL) and isOnRoster (src/lib/rosterOrder.js)
// must say the same thing, plus email-program-roster's cancelled_at filter.
{
  const sql = readFileSync(new URL('../../supabase/migrations/20261119a_partner_portal_classes.sql', import.meta.url), 'utf8');
  const fn = sql.slice(sql.indexOf('create or replace function private.registration_on_roster'), sql.indexOf('revoke all on function private.registration_on_roster'));
  const js = readFileSync(new URL('./rosterOrder.js', import.meta.url), 'utf8');
  const jsFn = js.slice(js.indexOf('export function isOnRoster'), js.indexOf('}', js.indexOf('export function isOnRoster')));
  for (const [s, j] of [
    ["payment_status = 'paid'", 'reg.payment_status === "paid"'],
    ["status = 'confirmed'", 'reg.status === "confirmed"'],
    ["ach_payment_state = 'processing'", 'reg.ach_payment_state === "processing"'],
  ]) {
    eq(`SQL roster rule has ${s}`, fn.includes(s), true);
    eq(`JS roster rule has ${j}`, jsFn.includes(j), true);
  }
  eq('SQL roster rule drops cancelled registrations', fn.includes('r.cancelled_at is null'), true);
  eq('JS rule has exactly three conditions (a fourth must be copied to SQL)', (jsFn.match(/===/g) || []).length, 3);
  // The count and the roster both read the same rule.
  eq('count reads the rule', (sql.match(/private\.registration_on_roster\(r\)/g) || []).length >= 3, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
