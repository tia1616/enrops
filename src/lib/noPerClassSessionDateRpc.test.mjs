// A session-dates RPC must never be fired once per class from the browser.
//
// The staffing board and the admin home both did exactly that:
// `programs.map(p => supabase.rpc("derive_program_session_dates", {p_program_id: p.id}))`.
// It reads as harmless - it is wrapped in Promise.all, so it "runs in parallel" -
// but a browser only runs about six requests at a time, so 33 classes is six
// sequential waves of network before the board can draw.
//
// Measured on prod 2026-09-07 with EXPLAIN ANALYZE: computing every one of those
// 33 classes' dates costs 44.7 ms of DATABASE time. The work was never slow. The
// queue was. derive_program_session_dates_bulk() asks the same question once.
//
// This is easy to undo by accident, because the per-class version is the obvious
// thing to write and it looks correct: the page still renders, the dates are
// still right, and the only symptom is a slow load that nobody attributes to a
// loop. So it is ratcheted here, read from SOURCE.
//
// Single calls are fine and are NOT flagged - ClassReports resolves one class,
// and the board's sub-assign drawer falls back for one class when the preloaded
// dates are missing. What is banned is a call whose argument is a loop variable.

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
      offenders.push(`${file.replace(srcRoot, 'src')}:${line}`);
    }
    i = src.indexOf(NEEDLE, i + NEEDLE.length);
  }
}

// If this finds nothing at all the test has stopped testing anything - most
// likely the RPC was renamed and this file was not.
ok('the single-class RPC still exists somewhere to guard',
  callers.length > 0,
  'no call to derive_program_session_dates found in src/ - was it renamed?');

ok('no per-class session-dates RPC inside a loop',
  offenders.length === 0,
  offenders.length ? `use derive_program_session_dates_bulk instead:\n      ${offenders.join('\n      ')}` : '');

// And the bulk function must actually be in use, or the rule above is vacuous:
// deleting both call sites would otherwise "pass".
const usesBulk = walk(srcRoot).some((f) =>
  stripComments(readFileSync(f, 'utf8')).includes('derive_program_session_dates_bulk'));
ok('the bulk RPC is wired up', usesBulk,
  'nothing calls derive_program_session_dates_bulk - the fan-out fix is gone');

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
