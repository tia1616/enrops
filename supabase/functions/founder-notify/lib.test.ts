import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { cityStateFrom, fmtDate, fmtMoney, esc, pickOperatorName, fmtWhen } from './lib.ts';

// ---------------------------------------------------------------------------
// cityStateFrom - the ONLY source of "where is this operator". Every address
// below is a real, verbatim value from public.program_locations.address on prod.
// ---------------------------------------------------------------------------

Deno.test('cityStateFrom reads real prod addresses', () => {
  assertEquals(cityStateFrom('SE Morrison St, Gresham, OR 97030, USA'), 'Gresham, OR');
  assertEquals(cityStateFrom('1772 Educational Park Dr, San Jose, CA 95133, USA'), 'San Jose, CA');
  assertEquals(cityStateFrom('4014 NE 13th Terrace, Gresham, OR 97030, USA'), 'Gresham, OR');
  assertEquals(cityStateFrom('4588 Peralta Blvd Ste 1, Fremont, CA 94536, USA'), 'Fremont, CA');
  assertEquals(cityStateFrom('2425 SW Vista Ave, Portland, OR 97201, USA'), 'Portland, OR');
});

// A wrong town in a founder's inbox is worse than a blank line, because she acts
// on it. Every one of these must decline to guess.
Deno.test('cityStateFrom returns null rather than guessing', () => {
  assertEquals(cityStateFrom(null), null);
  assertEquals(cityStateFrom(undefined), null);
  assertEquals(cityStateFrom(''), null);
  assertEquals(cityStateFrom('Online'), null);
  assertEquals(cityStateFrom('Podrocks Studio'), null);
  assertEquals(cityStateFrom('123 Main St'), null);
  // A bare state with nothing before it has no city to report.
  assertEquals(cityStateFrom('OR 97030'), null);
});

Deno.test('cityStateFrom handles ZIP+4 and a missing ZIP', () => {
  assertEquals(cityStateFrom('1 A St, Beaverton, OR 97005-1234, USA'), 'Beaverton, OR');
  assertEquals(cityStateFrom('1 A St, Beaverton, OR'), 'Beaverton, OR');
});

// Two-letter street abbreviations must not be mistaken for a state code.
Deno.test('cityStateFrom is not fooled by a two-letter fragment mid-address', () => {
  assertEquals(cityStateFrom('PO Box 12, Bend, OR 97701, USA'), 'Bend, OR');
});

// ---------------------------------------------------------------------------
// fmtDate - a calendar date must not drift a day. first_session_date is a DATE;
// formatting it in a local timezone would show Sep 14 to anyone west of GMT.
// ---------------------------------------------------------------------------

Deno.test('fmtDate does not shift the day', () => {
  assertEquals(fmtDate('2026-09-15'), 'Tue, Sep 15, 2026');
  assertEquals(fmtDate('2026-01-01'), 'Thu, Jan 1, 2026');
  assertEquals(fmtDate('2026-12-31'), 'Thu, Dec 31, 2026');
});

Deno.test('fmtDate tolerates absent dates', () => {
  assertEquals(fmtDate(null), null);
  assertEquals(fmtDate(undefined), null);
  assertEquals(fmtDate(''), null);
});

// ---------------------------------------------------------------------------
// fmtMoney - this is money in a founder's inbox; it must never render "$NaN"
// or drop to "$185" when the real figure is $185.00.
// ---------------------------------------------------------------------------

Deno.test('fmtMoney formats cents correctly', () => {
  assertEquals(fmtMoney(18500), '$185.00');
  assertEquals(fmtMoney(0), '$0.00');
  assertEquals(fmtMoney(1), '$0.01');
  assertEquals(fmtMoney(103_00), '$103.00');
  assertEquals(fmtMoney(999999), '$9999.99');
});

Deno.test('fmtMoney omits itself rather than printing garbage', () => {
  assertEquals(fmtMoney(null), null);
  assertEquals(fmtMoney(undefined), null);
  assertEquals(fmtMoney(NaN), null);
});

// ---------------------------------------------------------------------------
// esc - operator-supplied business names land in HTML. Angle brackets in a
// business name must not become markup.
// ---------------------------------------------------------------------------

Deno.test('esc neutralises HTML in operator-supplied text', () => {
  assertEquals(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assertEquals(esc('Ben & Jerry\'s STEAM'), 'Ben &amp; Jerry&#39;s STEAM');
  assertEquals(esc(null), '');
  assertEquals(esc(undefined), '');
});

// esc() output goes inside href="...". A slug carrying a double quote would
// otherwise close the attribute and inject its own. organizations.slug has no
// CHECK constraint, so this cannot be assumed away at the database layer.
Deno.test('esc cannot break out of an HTML attribute', () => {
  const evil = 'a" onmouseover="steal()';
  const escaped = esc(evil);
  assertEquals(escaped.includes('"'), false);
  assertEquals(escaped, 'a&quot; onmouseover=&quot;steal()');
  // The rendered attribute stays a single attribute.
  assertEquals(`href="${escaped}"`, 'href="a&quot; onmouseover=&quot;steal()"');
});

// ---------------------------------------------------------------------------
// pickOperatorName - every case below mirrors a real prod row in org_members
// joined to auth.users.
// ---------------------------------------------------------------------------

Deno.test('pickOperatorName prefers the org_members name', () => {
  // chase-youth: member name set.
  assertEquals(pickOperatorName('Darren Chase', 'Darren Chase', 'Darren Chase', 'Chase Youth Programs'), 'Darren Chase');
});

Deno.test('pickOperatorName falls back to the auth user name', () => {
  // podrocks + reebok: org_members.name is null, auth metadata has a real person.
  assertEquals(pickOperatorName(null, 'Jasmine', 'Jasmine', 'Podrocks Art Studio OR'), 'Jasmine');
  assertEquals(pickOperatorName(null, 'Arielle Hammond', 'Arielle Hammond', 'Reebok hoops'), 'Arielle Hammond');
});

// shoreview-chess, the-ukulele-project and yoga-playgrounds all signed up with
// the BUSINESS name in the personal-name field. Echoing it would print the same
// string twice in one short email.
Deno.test('pickOperatorName suppresses the business name masquerading as a person', () => {
  assertEquals(pickOperatorName(null, 'Shoreview Chess', 'Shoreview Chess', 'Shoreview Chess'), null);
  assertEquals(pickOperatorName(null, 'The Ukulele Project', 'The Ukulele Project', 'The Ukulele Project'), null);
  assertEquals(pickOperatorName(null, 'yoga playgrounds', null, 'Yoga Playgrounds'), null); // case-insensitive
});

Deno.test('pickOperatorName returns null when there is genuinely no name', () => {
  // final / iphone / beeboop: no member name, no auth metadata.
  assertEquals(pickOperatorName(null, null, null, 'beeboop hoops'), null);
  assertEquals(pickOperatorName('  ', '  ', '  ', 'beeboop hoops'), null);
});

// ---------------------------------------------------------------------------
// fmtWhen - the timestamp is rendered in the OPERATOR's timezone, not UTC.
// ---------------------------------------------------------------------------

Deno.test('fmtWhen renders in the operator timezone', () => {
  // 2026-07-28T12:40:00Z is 5:40 AM in Los Angeles.
  const la = fmtWhen('2026-07-28T12:40:00Z', 'America/Los_Angeles');
  assertEquals(la.includes('5:40'), true);
  const ny = fmtWhen('2026-07-28T12:40:00Z', 'America/New_York');
  assertEquals(ny.includes('8:40'), true);
});

Deno.test('fmtWhen survives a junk timezone instead of throwing', () => {
  const got = fmtWhen('2026-07-28T12:40:00Z', 'Not/AZone');
  assertEquals(got, '2026-07-28T12:40:00.000Z');
});
