// A session-dates RPC must never be fired once per class from the browser.
//
// The staffing board and the admin home both did exactly that:
// `programs.map(p => supabase.rpc("derive_program_session_dates", {p_program_id: p.id}))`.
// It reads as harmless - it is wrapped in Promise.all, so it "runs in parallel" -
// but a browser only runs about six requests at a time, so 33 classes is six
// sequential waves of network before the board can draw.
//
// The queue is only half of it, and the smaller half. Measured on prod
// 2026-09-07 as the AUTHENTICATED role - a superuser connection reports 47 ms
// for the same work because it never evaluates RLS, and believing that number
// is what sent the first fix in the wrong direction - one class costs ~92 ms,
// of which ~37 ms is PLANNING the program_locations policy. Thirty-three
// classes re-planned it thirty-three times: ~2 s before the board could draw.
//
// derive_program_session_dates_bulk() asks the question once AND is SECURITY
// DEFINER, so the policy is not re-planned per class. Both halves matter; the
// second is the one that made the difference (2305 ms -> 176 ms).
//
// This is easy to undo by accident, because the per-class version is the obvious
// thing to write and it looks correct: the page still renders, the dates are
// still right, and the only symptom is a slow load that nobody attributes to a
// loop. So it is ratcheted here, read from SOURCE.
//
// Single calls are fine and are NOT flagged - ClassReports resolves one class,
// and the board's sub-assign drawer falls back for one class when the preloaded
// dates are missing. What is banned is a call whose argument is a loop variable.
//
// THE BULK FUNCTION IS NOT A DROP-IN REPLACEMENT, and this test must not push
// anybody into believing it is. programs carries TWO select policies:
//
//   members_read_programs   is_org_member(organization_id) OR is_platform_admin()
//   public_read_programs    organization_id IN (SELECT id FROM public_org_directory)
//
// derive_program_session_dates is granted to PUBLIC and anon and honours both, so
// a signed-in parent, or an instructor who is not an org_member, can resolve dates
// for a publicly listed class. derive_program_session_dates_bulk is SECURITY
// DEFINER and implements only the FIRST of those in its WHERE clause, and is
// granted to authenticated + service_role. For a non-member it returns HTTP 200
// and an empty array: no error, no rows, dates just gone.
//
// Parents are not org_members. So this rule applies to ADMIN surfaces only, and
// the failure message says which function is safe where. A parent or instructor
// screen that needs many classes at once needs a differently-authorised bulk
// function, not this one.

// Admin-only surfaces. A per-class loop anywhere else is out of scope for this
// rule because the bulk function would silently return nothing there.
const ADMIN_PATH = /[\\/]pages[\\/]admin[\\/]/;

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(jsx?|mjs)$/.test(name) && !name.endsWith('.test.mjs')) out.push(full);
  }
  return out;
}

/** Strip comments so prose describing the old pattern is not mistaken for it. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const NEEDLE = 'rpc("derive_program_session_dates"';
const offenders = [];
const nonAdminFanOut = [];
const callers = [];

for (const file of walk(srcRoot)) {
  const src = stripComments(readFileSync(file, 'utf8'));
  let i = src.indexOf(NEEDLE);
  while (i !== -1) {
    callers.push(file);
    // Look back far enough to catch `.map(` / `for (` on an enclosing line, but
    // not so far that an unrelated earlier loop trips it. The fan-out shape puts
    // the map within a line or two of the call.
    const before = src.slice(Math.max(0, i - 220), i);
    if (/\.map\s*\(|\.forEach\s*\(|for\s*\(\s*const\b[^)]*\bof\b/.test(before)) {
      const line = src.slice(0, i).split('\n').length;
      const where = `${file.replace(srcRoot, 'src')}:${line}`;
      if (ADMIN_PATH.test(file)) offenders.push(where);
      else nonAdminFanOut.push(where);
    }
    i = src.indexOf(NEEDLE, i + NEEDLE.length);
  }
}

// If this finds nothing at all the test has stopped testing anything - most
// likely the RPC was renamed and this file was not.
ok('the single-class RPC still exists somewhere to guard',
  callers.length > 0,
  'no call to derive_program_session_dates found in src/ - was it renamed?');

ok('no per-class session-dates RPC inside a loop, on ADMIN surfaces',
  offenders.length === 0,
  offenders.length
    ? `use derive_program_session_dates_bulk (admin-only: its WHERE clause is\n` +
      `      is_org_member OR is_platform_admin, so it is safe here):\n      ${offenders.join('\n      ')}`
    : '');

// Reported, never failed. A fan-out outside /pages/admin/ is a genuine perf
// problem but the bulk function is the WRONG fix there - it is members-only and
// would return an empty array to a parent or a non-member instructor, turning a
// slow screen into a silently empty one. Surfacing it without prescribing the
// unsafe remedy is the honest middle.
if (nonAdminFanOut.length) {
  console.log(
    `NOTE  per-class fan-out on a NON-admin surface (slow, but do NOT switch it to\n` +
    `      derive_program_session_dates_bulk - that function is org-member-only and\n` +
    `      would return zero rows to parents and non-member instructors):\n      ` +
    nonAdminFanOut.join('\n      '),
  );
}

// And the bulk function must actually be in use, or the rule above is vacuous:
// deleting both call sites would otherwise "pass".
const usesBulk = walk(srcRoot).some((f) =>
  stripComments(readFileSync(f, 'utf8')).includes('derive_program_session_dates_bulk'));
ok('the bulk RPC is wired up', usesBulk,
  'nothing calls derive_program_session_dates_bulk - the fan-out fix is gone');

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
