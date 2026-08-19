// src/lib/waitlistState.test.mjs
//
// THE INVARIANT: "unknown" must never render as "full".
//
// WHY THIS EXISTS. The catalog cannot see enrolment: program_enrollment is
// security_invoker=on (the 2026-06-06 hotfix), so an anonymous visitor reads zeros by
// design. The full/not-full flag comes from a separate fetch, which means there is a
// window on every page load - and any failed fetch - where fullness is simply not known.
//
// If unknown collapsed to "full", a family would be offered a waitlist for a class with
// eleven empty chairs. That is the exact shape of the bug this whole build started from
// (Happy Valley reading 12 of 14 with 3 real children), pointed the other way. So the
// fail-open direction is the invariant worth pinning, not the happy path.
//
// It also pins the partner-run precedence: a FULL partner-run class must still send the
// family to the partner's site, never offer our waitlist, because we hold no list for a
// class we take no money for.

import {
  programAction,
  fullFlagMap,
  ACTION_REGISTER,
  ACTION_WAITLIST,
  ACTION_EXTERNAL,
} from './waitlistState.js';

let pass = 0;
let fail = 0;
function is(name, actual, expected) {
  if (actual === expected) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}

const ours = { runs_own_registration: false };
const partner = { runs_own_registration: true, external_registration_url: 'https://example.com' };

// --- the invariant: only an explicit true offers a waitlist ---
is('full class offers the waitlist', programAction(ours, true), ACTION_WAITLIST);
is('class with room offers register', programAction(ours, false), ACTION_REGISTER);
is('UNDEFINED (flags not loaded yet) offers register, NOT waitlist',
  programAction(ours, undefined), ACTION_REGISTER);
is('NULL (class absent from the flag reader) offers register',
  programAction(ours, null), ACTION_REGISTER);
is('a truthy non-boolean does NOT count as full',
  programAction(ours, 'true'), ACTION_REGISTER);
is('1 does NOT count as full', programAction(ours, 1), ACTION_REGISTER);

// --- partner-run wins over fullness ---
is('partner-run class goes external when full',
  programAction(partner, true), ACTION_EXTERNAL);
is('partner-run class goes external when it has room',
  programAction(partner, false), ACTION_EXTERNAL);

// --- degenerate input must not throw ---
is('missing program falls back to register', programAction(null, true), ACTION_REGISTER);
is('undefined program falls back to register', programAction(undefined, true), ACTION_REGISTER);
is('program with no runs_own_registration is treated as ours',
  programAction({}, true), ACTION_WAITLIST);

// --- fullFlagMap ---
const map = fullFlagMap([
  { program_id: 'a', is_full: true },
  { program_id: 'b', is_full: false },
  { program_id: 'c', is_full: null },
]);
is('map reads true', map.a, true);
is('map reads false', map.b, false);
is('map coerces null to false, never undefined-as-full', map.c, false);
is('a failed fetch (null) yields an empty map, so nothing reads as full',
  Object.keys(fullFlagMap(null)).length, 0);
is('a non-array yields an empty map',
  Object.keys(fullFlagMap({ program_id: 'x' })).length, 0);
is('a row with no program_id is skipped',
  Object.keys(fullFlagMap([{ is_full: true }])).length, 0);

// and the whole point, stated as one assertion: an empty map means register everywhere
const emptyMap = fullFlagMap(null);
is('empty map + full class = register (fail open)',
  programAction(ours, emptyMap['anything']), ACTION_REGISTER);

console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
