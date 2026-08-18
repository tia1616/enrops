// Truth table for classifyOther() — the after-school board's same-day rule, which
// MUST agree with the DB trigger check_program_assignment_conflict (20260818a).
// Times are minutes since midnight; 60 is the tight-gap threshold.
import { classifyOther } from './scheduleConflicts.js';

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

console.log(`\nscheduleConflicts: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
