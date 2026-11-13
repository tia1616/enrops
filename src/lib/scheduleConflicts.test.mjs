// Truth table for classifyOther() — the after-school board's same-day rule, which
// MUST agree with the DB trigger check_program_assignment_conflict (20260818a).
// Times are minutes since midnight; 60 is the tight-gap threshold.
import { classifyOther, tooCloseBetweenSites } from './scheduleConflicts.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log(`FAIL  ${name}`); }
}
const min = (h, m = 0) => h * 60 + m;

// The bug Jessica reported 2026-08-18: Grass Valley 12:15-1:15 vs OES 3:25-4:25,
// same Wednesday, different schools. Must NOT be a conflict, and NOT tight (2h10m).
{
  const r = classifyOther(
    { start: min(15, 25), end: min(16, 25), loc: 'oes' },      // the class being assigned
    { start: min(12, 15), end: min(13, 15), loc: 'grass' },    // what they already hold
    60,
  );
  ok('different school, 2h10m gap -> allowed', r.conflict === false);
  ok('different school, 2h10m gap -> not tight', r.tight === false);
  ok('different school -> not sameSchool', r.sameSchool === false);
}

// A real overlap at different schools still blocks.
{
  const r = classifyOther(
    { start: min(15, 5), end: min(16, 5), loc: 'a' },
    { start: min(14, 0), end: min(15, 25), loc: 'b' },
    60,
  );
  ok('overlapping times, different school -> conflict', r.conflict === true);
  ok('overlapping -> overlaps flag set', r.overlaps === true);
}

// A real overlap at the SAME school also blocks (two classes, one clock).
{
  const r = classifyOther(
    { start: min(14, 0), end: min(15, 0), loc: 'a' },
    { start: min(14, 30), end: min(15, 30), loc: 'a' },
    60,
  );
  ok('overlapping, same school -> conflict', r.conflict === true);
}

// Touching times do NOT overlap: 2:00-3:25 then 3:25-4:25 (the OES back-to-back).
{
  const r = classifyOther(
    { start: min(15, 25), end: min(16, 25), loc: 'a' },
    { start: min(14, 0), end: min(15, 25), loc: 'a' },
    60,
  );
  ok('touching times -> not a conflict', r.conflict === false);
  ok('touching, same school -> sameSchool', r.sameSchool === true);
  ok('touching, 0-min gap -> tight', r.tight === true && r.gap === 0);
}

// Different school, tight turnaround (30 min): allowed but flagged tight.
{
  const r = classifyOther(
    { start: min(15, 30), end: min(16, 30), loc: 'a' },
    { start: min(14, 0), end: min(15, 0), loc: 'b' },
    60,
  );
  ok('different school, 30-min gap -> allowed', r.conflict === false);
  ok('different school, 30-min gap -> tight', r.tight === true);
  ok('30-min gap computed', r.gap === 30);
}

// Different school, gap exactly at the threshold (60): NOT tight (strict <).
{
  const r = classifyOther(
    { start: min(16, 0), end: min(17, 0), loc: 'a' },
    { start: min(14, 0), end: min(15, 0), loc: 'b' },
    60,
  );
  ok('gap == threshold -> not tight', r.tight === false && r.gap === 60);
}

// Unknown time on either side -> fail closed as a conflict (the "2:30" case: the
// board passes null because parse12h needs an explicit AM/PM).
{
  const rOther = classifyOther(
    { start: min(15, 0), end: min(16, 0), loc: 'a' },
    { start: null, end: null, loc: 'b' },
    60,
  );
  ok('unknown other time -> conflict', rOther.conflict === true && rOther.unknown === true);
  ok('unknown other time -> not tight', rOther.tight === false);

  const rTarget = classifyOther(
    { start: null, end: null, loc: 'a' },
    { start: min(15, 0), end: min(16, 0), loc: 'b' },
    60,
  );
  ok('unknown target time -> conflict', rTarget.conflict === true);
}

// Gap is direction-agnostic: the other class BEFORE the target, tight.
{
  const r = classifyOther(
    { start: min(15, 30), end: min(16, 30), loc: 'a' },   // target later
    { start: min(14, 0), end: min(15, 0), loc: 'b' },     // other earlier, 30m before
    60,
  );
  ok('other-before, 30-min gap -> tight', r.tight === true && r.gap === 30);
}

// ---- tooCloseBetweenSites: the provider's cross-school minimum (20261113a) ----
// The WI27 prod pair: Atfalati Ridge 1:35-2:35, Alameda 2:35-3:35, same Wednesday.
{
  const cls = classifyOther(
    { start: min(14, 35), end: min(15, 35), loc: 'alameda' },
    { start: min(13, 35), end: min(14, 35), loc: 'atfalati' },
    60,
  );
  ok('WI27 pair: not a conflict on its own', cls.conflict === false);
  ok('WI27 pair: too close at 30', tooCloseBetweenSites(cls, 'alameda', 30) === true);
  ok('WI27 pair: rule off at 0', tooCloseBetweenSites(cls, 'alameda', 0) === false);
}
// Same school back-to-back stays allowed (OES).
{
  const cls = classifyOther(
    { start: min(15, 25), end: min(16, 25), loc: 'oes' },
    { start: min(14, 0), end: min(15, 25), loc: 'oes' },
    60,
  );
  ok('same school back-to-back: not too close', tooCloseBetweenSites(cls, 'oes', 30) === false);
}
// Exactly the minimum is fine; one minute short is not.
{
  const at = classifyOther({ start: min(15, 5), end: min(16, 5), loc: 'b' }, { start: min(14, 0), end: min(14, 35), loc: 'a' }, 60);
  const short = classifyOther({ start: min(15, 4), end: min(16, 4), loc: 'b' }, { start: min(14, 0), end: min(14, 35), loc: 'a' }, 60);
  ok('gap == minimum -> allowed', tooCloseBetweenSites(at, 'b', 30) === false);
  ok('gap one short -> too close', tooCloseBetweenSites(short, 'b', 30) === true);
}
// An overlap is the hard conflict, not this block; an unreadable time likewise.
{
  const over = classifyOther({ start: min(14, 0), end: min(15, 0), loc: 'a' }, { start: min(14, 30), end: min(15, 30), loc: 'b' }, 60);
  const unk = classifyOther({ start: null, end: null, loc: 'a' }, { start: min(14, 0), end: min(15, 0), loc: 'b' }, 60);
  ok('overlap -> left to the conflict block', tooCloseBetweenSites(over, 'a', 30) === false);
  ok('unknown time -> left to the conflict block', tooCloseBetweenSites(unk, 'a', 30) === false);
}
// No site on the class being placed: cannot prove one building -> treated as different.
{
  const cls = classifyOther({ start: min(14, 35), end: min(15, 35), loc: null }, { start: min(13, 35), end: min(14, 35), loc: null }, 60);
  ok('no site both sides -> sameSchool true from classifyOther', cls.sameSchool === true);
  ok('no site on target -> still too close', tooCloseBetweenSites(cls, null, 30) === true);
}

// Unknown minimum: the board passes Infinity and holds every readable
// different-school pairing, however far apart.
{
  const far = classifyOther({ start: min(15, 25), end: min(16, 25), loc: 'oes' }, { start: min(12, 15), end: min(13, 15), loc: 'grass' }, 60);
  const same = classifyOther({ start: min(15, 25), end: min(16, 25), loc: 'oes' }, { start: min(14, 0), end: min(15, 25), loc: 'oes' }, 60);
  ok('unknown minimum -> different school held', tooCloseBetweenSites(far, 'oes', Infinity) === true);
  ok('unknown minimum -> same school still fine', tooCloseBetweenSites(same, 'oes', Infinity) === false);
}

console.log(`\nscheduleConflicts: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
