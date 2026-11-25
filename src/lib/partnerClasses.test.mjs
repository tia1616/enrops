// Partner portal Classes section (20261119a): words, counts and the roster rule pin.
import { readFileSync } from 'node:fs';
import {
  scheduleText, enrolledText, countSourceText, classBadge, rosterAvailable,
  sortClasses, rosterDisplayRows, asksDismissal, shortDate, showsHomeroom,
  summaryAvailable, detailsButtonText, sessionsHeadline, sessionStatusText, paidText, dollars,
  csvCell, classSummaryCsv, summaryFileName, childPaidText, paidByChild,
  termStatementCsv, statementFileName, classesAtAGlance, glanceText,
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

// --- terms (Kacy Cullen, 2026-11-19) ------------------------------------------------
{
  const { termCodeForDate, termOfClass, groupClassesByTerm } = await import('./partnerClasses.js');
  eq('December is next year\'s winter', termCodeForDate('2026-12-28'), 'WI27');
  eq('February is winter', termCodeForDate('2027-02-05'), 'WI27');
  eq('April is spring', termCodeForDate('2027-04-19'), 'SP27');
  eq('July is summer', termCodeForDate('2027-07-12'), 'SU27');
  eq('October is fall', termCodeForDate('2026-10-05'), 'FA26');
  eq('no date, no term', termCodeForDate(null), null);
  eq('a class keeps its own term', termOfClass({ term: 'SP27', first_date: '2027-01-12' }), 'SP27');
  eq('a camp takes its season', termOfClass({ term: null, first_date: '2027-07-12' }), 'SU27');
  const label = (t) => ({ WI27: 'Winter 2027', SP27: 'Spring 2027', SU27: 'Summer 2027' })[t] ?? t;
  const g = groupClassesByTerm([
    { title: 'Robotics', term: 'SP27', first_date: '2027-04-06', site: 'A' },
    { title: 'Camp', term: null, first_date: '2027-07-12', site: 'A' },
    { title: 'LEGO', term: 'WI27', first_date: '2027-01-12', site: 'A' },
    { title: 'Draft', term: null, first_date: null, site: 'A' },
    { title: 'Mario', term: 'WI27', first_date: null, site: 'A' },
  ], label);
  eq('earliest term first, undated last', g.map((x) => x.label), ['Winter 2027', 'Spring 2027', 'Summer 2027', 'Dates not set yet']);
  eq('a dateless class with a term stays in its term', g[0].classes.map((c) => c.title), ['LEGO', 'Mario']);
  eq('empty list, no groups', groupClassesByTerm([], label), []);
}

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

// --- finished classes and the end-of-term summary (20261125t) ---------------
{
  const done = { ...base, status: 'finished' };
  eq('finished badge', classBadge(done).label, 'Finished');
  eq('finished full class still says Finished', classBadge({ ...done, enrolled: 18 }).label, 'Finished');
  eq('finished enrops class keeps its roster', rosterAvailable(done), true);
  eq('finished class: one button', detailsButtonText(done, false), 'Roster & sessions');
  eq('open, hide', detailsButtonText(base, true), 'Hide roster & sessions');
  eq('partner-run: sessions only', detailsButtonText({ ...base, count_source: 'partner' }, false), 'Sessions');
  eq('typed count: sessions only', detailsButtonText({ ...base, count_source: 'provider' }, false), 'Sessions');
  eq('draft: no button', detailsButtonText({ ...base, status: 'draft' }, false), null);
  eq('cancelled: no button', detailsButtonText({ ...base, status: 'cancelled' }, false), null);
  eq('summary on finished', summaryAvailable(done), true);

  const s = (status, date = '2026-09-01') => ({ date, status });
  eq('all held', sessionsHeadline([s('held'), s('held')]), '2 of 2 sessions held');
  eq('cancelled is not on the schedule count', sessionsHeadline([s('held'), s('cancelled'), s('not_confirmed')]),
    '1 of 2 sessions held · 1 not confirmed yet · 1 cancelled');
  eq('one session', sessionsHeadline([s('upcoming')]), '0 of 1 session held · 1 upcoming');
  eq('no dates', sessionsHeadline([]), 'No session dates set');
  eq('status words', ['held', 'cancelled', 'upcoming', 'not_confirmed', 'odd'].map(sessionStatusText),
    ['Held', 'Cancelled', 'Upcoming', 'Not confirmed yet', 'Not confirmed yet']);

  // HV Fall Super Mario on prod, 2026-11-25: 6 children, $1,686.
  eq('paid line, all paid', paidText({ children: 6, paid_cents: 168600 }, 6), 'Families paid $1,686.00, after discounts and refunds (all 6 children on the roster paid).');
  // Staging HV Fall Super Mario, 2026-11-25: 5 on the roster, 1 paid (free, refunded, never charged).
  eq('fewer paid than enrolled says so', paidText({ children: 1, paid_cents: 26910 }, 5), 'Families paid $269.10, after discounts and refunds (1 of the 5 children on the roster paid).');
  eq('one on the roster', paidText({ children: 1, paid_cents: 29900 }, 1), 'Families paid $299.00, after discounts and refunds (the 1 child on the roster paid).');
  eq('no roster count', paidText({ children: 2, paid_cents: 500 }), 'Families paid $5.00, after discounts and refunds (2 children).');
  eq('nothing paid', paidText({ children: 0, paid_cents: 0 }, 3), 'No payments yet (0 of the 3 children on the roster paid).');
  eq('nothing paid, no count', paidText({ children: 0, paid_cents: 0 }), 'No payments yet.');
  eq('no money line off enrops', paidText(null), null);
  eq('dollars', dollars(123456), '$1,234.56');

  eq('csv quotes commas', csvCell('Smith, Jo'), '"Smith, Jo"');
  eq('csv quotes quotes', csvCell('Jo "JJ"'), '"Jo ""JJ"""');
  eq('csv defuses a formula', csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  eq('csv defuses a minus', csvCell('-1'), "'-1");
  eq('csv null', csvCell(null), '');

  const csv = classSummaryCsv(
    { ...done, title: 'Super Mario', site: 'Happy Valley Library', first_date: '2026-09-15', last_date: '2026-11-03' },
    { sessions: [s('held', '2026-09-15'), s('cancelled', '2026-10-13')], money: { children: 2, paid_cents: 59800 } },
    [{ name: 'Ava Lee', grade: '2nd', homeroom: null }, { name: '=cmd', grade: 'K', homeroom: null }],
    { providerName: 'Journey to STEAM', termLabel: 'Fall 2026' },
  ).split('\r\n');
  eq('csv first line', csv[0], 'Class,Super Mario');
  eq('csv has term and provider', csv.includes('Term,Fall 2026') && csv.includes('Provider,Journey to STEAM'), true);
  eq('csv lists each date with status', csv.includes('2026-09-15,Held') && csv.includes('2026-10-13,Cancelled'), true);
  eq('csv total', csv.includes('Families paid,"$598.00"') || csv.includes('Families paid,$598.00'), true);
  eq('csv roster, no homeroom column when none', csv.includes('Student,Grade') && csv.includes('Ava Lee,2nd'), true);
  eq('csv roster defuses a formula name', csv.includes("'=cmd,K"), true);
  const noMoney = classSummaryCsv(done, { sessions: [], money: null }, null).split('\r\n');
  eq('csv without money or roster', noMoney.some((l) => l.startsWith('Families paid') || l.startsWith('Student')), false);
  eq('file name', summaryFileName({ title: 'Robots: Go/Build' }, 'Fall 2026'), 'Robots GoBuild - Fall 2026 summary.csv');
}

// Paid per child (Jessica 2026-11-25: "put per person what they paid").
{
  eq('paid', childPaidText({ status: 'paid', paid_cents: 26910 }), '$269.10');
  eq('paying', childPaidText({ status: 'paying', paid_cents: 10000 }), '$100.00 so far (paying in instalments)');
  eq('free', childPaidText({ status: 'free', paid_cents: 0 }), 'Free');
  eq('refunded', childPaidText({ status: 'refunded', paid_cents: 0 }), 'Refunded');
  eq('processing', childPaidText({ status: 'processing', paid_cents: 0 }), 'Bank payment pending');
  eq('unpaid', childPaidText({ status: 'unpaid', paid_cents: 0 }), 'Not paid');
  eq('no entry', childPaidText(undefined), '');
  eq('no money, no column', paidByChild(null), null);
  const money = { children: 1, paid_cents: 26910, by_child: [{ row_key: 'a', status: 'paid', paid_cents: 26910 }, { row_key: 'b', status: 'free', paid_cents: 0 }] };
  const csv = classSummaryCsv({ ...base, status: 'finished', title: 'X', site: 'S', enrolled: 2 },
    { sessions: [], money }, [{ key: 'a', name: 'Ava Lee', grade: '2nd', homeroom: null }, { key: 'b', name: 'Bo Kim', grade: 'K', homeroom: null }]).split('\r\n');
  eq('csv has a Paid column', csv.includes('Student,Grade,Paid'), true);
  eq('csv paid per child', csv.includes('Ava Lee,2nd,$269.10') && csv.includes('Bo Kim,K,Free'), true);
  const hidden = classSummaryCsv({ ...base, title: 'X' }, { sessions: [], money: null }, [{ key: 'a', name: 'Ava Lee', grade: '2nd', homeroom: null }]).split('\r\n');
  eq('no money, no Paid column in csv', hidden.includes('Student,Grade'), true);
}

// Term statement per partner (Jessica 2026-11-25).
{
  const a = { ...base, class_id: 'a', status: 'finished', title: 'Super Mario', site: 'HV Library', enrolled: 6, first_date: '2026-09-15', last_date: '2026-11-03' };
  const b = { ...base, class_id: 'b', status: 'open', title: 'LEGO', site: 'Annex', enrolled: 5 };
  const draft = { ...base, class_id: 'd', status: 'draft', title: 'Draft' };
  const held = (n) => Array.from({ length: n }, () => ({ status: 'held' }));
  const sums = new Map([
    ['class:a', { sessions: held(8), money: { children: 6, paid_cents: 168600 } }],
    ['class:b', { sessions: [...held(2), { status: 'upcoming' }, { status: 'cancelled' }], money: { children: 5, paid_cents: 122800 } }],
  ]);
  const rows = termStatementCsv('Fall 2026', [a, b, draft], sums, { partnerName: 'Happy Valley Parks and Rec', providerName: 'Journey to STEAM', invoicingNote: 'Their 10% of what families paid' }).split('\r\n');
  eq('statement title', rows[0], 'Statement,"Happy Valley Parks and Rec, Fall 2026"');
  eq('provider note only when passed', rows.includes('Your invoicing notes (only on your copy),Their 10% of what families paid'), true);
  eq('money columns when shared', rows.some((r) => r.startsWith('Class,') && r.endsWith('Children paid for,Families paid')), true);
  eq('class row', rows.includes('Super Mario,HV Library,2026-09-15 to 2026-11-03,Finished,8,8,0,0,6,6,"$1,686.00"'), true);
  eq('cancelled not scheduled', rows.some((r) => r.startsWith('LEGO,Annex,') && r.includes(',Running,2,3,0,1,5,5,')), true);
  eq('totals', rows.includes('Total,,,2 classes,10,11,0,1,11,11,"$2,914.00"'), true);
  eq('drafts left out', rows.some((r) => r.startsWith('Draft,')), false);
  const partnerCopy = termStatementCsv('Fall 2026', [a], new Map([['class:a', { sessions: held(8), money: null }]]), { providerName: 'Journey to STEAM' }).split('\r\n');
  eq('no money columns when not shared', partnerCopy.some((r) => r.includes('Families paid')), false);
  eq('no note on a partner copy', partnerCopy.some((r) => r.startsWith('Your invoicing notes')), false);
  const unread = termStatementCsv('Fall 2026', [a], new Map(), {}).split('\r\n');
  eq('unread summary says so', unread.some((r) => r.startsWith('Note,')), true);
  eq('statement file name', statementFileName('Happy Valley Parks and Rec', 'Fall 2026'), 'Happy Valley Parks and Rec - Fall 2026 statement.csv');
}

// Partner home: classes at a glance (enrollment first).
{
  const g = classesAtAGlance([
    { ...base, class_id: '1', status: 'open', first_date: '2026-11-01', enrolled: 10 },
    { ...base, class_id: '2', status: 'open', first_date: '2027-01-12', enrolled: 4 },
    { ...base, class_id: '3', status: 'finished', first_date: '2026-09-01', enrolled: 6 },
    { ...base, class_id: '4', status: 'cancelled', enrolled: 9 },
    { ...base, class_id: '5', status: 'open', first_date: '2026-11-01', count_source: 'partner', enrolled: null },
  ], '2026-11-25');
  eq('glance counts', g, { running: 2, upcoming: 1, finished: 1, children: 14, nextStart: '2027-01-12' });
  eq('glance words', glanceText(g, 2026), '2 classes running · 1 starting from Jan 12, 2027 · 14 children enrolled · 1 finished, summary ready');
  eq('only finished', glanceText({ running: 0, upcoming: 0, finished: 2, children: 0, nextStart: null }), '2 finished, summaries ready');
  eq('nothing', glanceText(classesAtAGlance([], '2026-11-25')), '');
}

// The database keeps a finished class listed 60 days, as 'finished'.
{
  const sql = readFileSync(new URL('../../supabase/migrations/20261125t_partner_term_summary.sql', import.meta.url), 'utf8');
  eq('classes stay 60 days', (sql.match(/>= v_today - 60/g) || []).length, 2);
  eq('finished status for classes and camps', (sql.match(/then 'finished'/g) || []).length, 2);
  eq('summary has no anon grant', /grant execute on function public\.partner_portal_class_summary\(uuid, text, uuid\) to authenticated;/.test(sql)
    && /revoke all on function public\.partner_portal_class_summary\(uuid, text, uuid\) from public, anon;/.test(sql), true);
  eq('summary money counts only the roster', sql.includes('private.registration_on_roster(r)'), true);
}

// Money goes to a partner only when the provider shares it (20261125u).
{
  const sql = readFileSync(new URL('../../supabase/migrations/20261125u_partner_show_family_payments.sql', import.meta.url), 'utf8');
  eq('switch is off by default', /show_family_payments boolean not null default false/.test(sql), true);
  eq('money needs admin or the switch', sql.includes("(coalesce(v_admin, false) or v_shared)"), true);
  eq('a partner gets only sessions and money', sql.includes("return jsonb_build_object('sessions', v_sessions, 'money', v_money);"), true);
  eq('no anon grant', /revoke all on function public\.partner_portal_class_summary\(uuid, text, uuid\) from public, anon;/.test(sql), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
