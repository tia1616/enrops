// Pins the early-bird deadline to the END OF THE BUSINESS'S DAY.
//
// The bug this replaces: the gate ended at 23:59:59 UTC, so a Nov 2 deadline
// expired at 3:59:59pm Pacific and a parent buying at 11pm on the last evening
// paid full price. Eight hours of the busiest day, and for those eight hours the
// business's own website — which compares against LOCAL midnight — advertised the
// early-bird price while checkout charged the standard one.
//
// Every assertion names a wall-clock moment in a real zone, because that is the
// thing being promised. The UTC instants are written out so a reader can check
// them by hand rather than trusting the test to agree with itself.

import { isEarlyBirdActive } from './pricing.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}
const at = (iso) => new Date(iso);

const LA = 'America/Los_Angeles';
const NY = 'America/New_York';
const PHX = 'America/Phoenix';          // never observes daylight saving
const DL = '2026-11-02';                // the live Winter deadline

// --- the eight hours that were being lost -------------------------------
ok('Nov 2, 11:00pm Pacific is still early bird',
   isEarlyBirdActive(DL, at('2026-11-03T07:00:00Z'), LA));
ok('Nov 2, 11:59:59pm Pacific is still early bird',
   isEarlyBirdActive(DL, at('2026-11-03T07:59:59Z'), LA));
ok('Nov 3, 12:00am Pacific is NOT',
   !isEarlyBirdActive(DL, at('2026-11-03T08:00:00Z'), LA));
ok('Nov 3, 12:00:01am Pacific is NOT',
   !isEarlyBirdActive(DL, at('2026-11-03T08:00:01Z'), LA));
// The old gate died here. If this ever fails, the UTC cutoff is back.
ok('Nov 2, 4:01pm Pacific — where the old gate died — is still early bird',
   isEarlyBirdActive(DL, at('2026-11-03T00:01:00Z'), LA));

// --- ordinary days ------------------------------------------------------
ok('the day before is active', isEarlyBirdActive(DL, at('2026-11-01T12:00:00Z'), LA));
ok('a week before is active',  isEarlyBirdActive(DL, at('2026-10-26T12:00:00Z'), LA));
ok('a week after is not',      !isEarlyBirdActive(DL, at('2026-11-09T12:00:00Z'), LA));

// --- other businesses, other zones --------------------------------------
// A hardcoded Pacific cutoff would end an Eastern business's early bird at 9pm.
ok('Eastern: 11:30pm on the deadline day is still early bird',
   isEarlyBirdActive(DL, at('2026-11-03T04:30:00Z'), NY));
ok('Eastern: 12:30am the next day is not',
   !isEarlyBirdActive(DL, at('2026-11-03T05:30:00Z'), NY));
// Phoenix does not move its clocks; it is UTC-7 all year.
ok('Phoenix: 11:30pm on the deadline day is still early bird',
   isEarlyBirdActive(DL, at('2026-11-03T06:30:00Z'), PHX));
ok('Phoenix: 12:30am the next day is not',
   !isEarlyBirdActive(DL, at('2026-11-03T07:30:00Z'), PHX));
// Eastern midnight is three hours before Pacific midnight: the same instant is
// over for one business and still running for the other. That is correct.
ok('one instant, two answers, by zone',
   !isEarlyBirdActive(DL, at('2026-11-03T05:30:00Z'), NY) &&
    isEarlyBirdActive(DL, at('2026-11-03T05:30:00Z'), LA));

// --- daylight saving ----------------------------------------------------
// Clocks go BACK on 2026-11-01, so a deadline on that day is a 25-hour day.
ok('deadline on the fall-back day: 11:30pm local still counts',
   isEarlyBirdActive('2026-11-01', at('2026-11-02T07:30:00Z'), LA));
ok('deadline on the fall-back day: next midnight does not',
   !isEarlyBirdActive('2026-11-01', at('2026-11-02T08:00:00Z'), LA));
// Clocks go FORWARD on 2026-03-08, a 23-hour day; the day before ends at
// 08:00Z because 2026-03-08 00:00 local is still PST.
ok('deadline the day before spring-forward: 11:30pm local still counts',
   isEarlyBirdActive('2026-03-07', at('2026-03-08T07:30:00Z'), LA));
ok('deadline the day before spring-forward: next midnight does not',
   !isEarlyBirdActive('2026-03-07', at('2026-03-08T08:00:00Z'), LA));
// A deadline ON the spring-forward day ends at 07:00Z, because by then local
// time is PDT. An offset read once, at the wrong instant, gets this hour wrong.
ok('deadline on spring-forward day ends at local midnight (PDT)',
   isEarlyBirdActive('2026-03-08', at('2026-03-09T06:59:00Z'), LA) &&
   !isEarlyBirdActive('2026-03-08', at('2026-03-09T07:00:00Z'), LA));

// --- month and year boundaries -------------------------------------------
ok('end of month rolls over', isEarlyBirdActive('2026-01-31', at('2026-02-01T07:30:00Z'), LA));
ok('end of month then expires', !isEarlyBirdActive('2026-01-31', at('2026-02-01T08:30:00Z'), LA));
ok('new year rolls over', isEarlyBirdActive('2026-12-31', at('2027-01-01T07:30:00Z'), LA));
ok('new year then expires', !isEarlyBirdActive('2026-12-31', at('2027-01-01T08:30:00Z'), LA));

// --- nothing to gate ------------------------------------------------------
ok('no deadline is never active', !isEarlyBirdActive(null, at('2026-10-01T00:00:00Z'), LA));
ok('empty deadline is never active', !isEarlyBirdActive('', at('2026-10-01T00:00:00Z'), LA));
ok('unparseable deadline is never active',
   !isEarlyBirdActive('not-a-date', at('2026-10-01T00:00:00Z'), LA));
ok('a timestamp is read as its date',
   isEarlyBirdActive('2026-11-02T00:00:00Z', at('2026-11-03T07:00:00Z'), LA));

// --- the default must not move anyone's price -----------------------------
// Callers that have not been handed an organisation keep the old UTC behaviour,
// so wiring this through is a deliberate act per call site, never a side effect.
ok('default zone still ends at UTC end of day',
   isEarlyBirdActive(DL, at('2026-11-02T23:59:00Z')) &&
   !isEarlyBirdActive(DL, at('2026-11-03T00:00:01Z')));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
