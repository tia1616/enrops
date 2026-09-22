// Runs every src/**/*.test.mjs as a standalone node script and fails if any of
// them fail. The repo convention for src-side unit tests is a plain node file
// with a pass/fail counter that ends in `process.exit(fail ? 1 : 0)` (see
// src/lib/programSchedule.test.mjs, src/pages/admin/rosterParse.test.mjs) - they
// are NOT node:test / Deno.test files, so `deno test` and `node --test` both skip
// them. Without this runner they execute in no automated runner and a regression
// ships green. Wired into `npm test` and CI (.github/workflows/test.yml).
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

function findTests(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...findTests(full));
    else if (name.endsWith('.test.mjs')) found.push(full);
  }
  return found;
}

const tests = findTests(srcRoot).sort();

// A green run with zero test files is a lie - if the glob ever stops matching
// (moved dir, renamed suffix), fail loudly instead of reporting success.
if (tests.length === 0) {
  console.error('run-src-tests: found no src/**/*.test.mjs files - runner is misconfigured.');
  process.exit(1);
}

let failed = 0;
for (const t of tests) {
  console.log(`\n=== ${t} ===`);
  const res = spawnSync(process.execPath, [t], { stdio: 'inherit' });
  if (res.status !== 0) {
    failed++;
    console.error(`FAILED: ${t} (exit ${res.status})`);
  }
}

console.log(`\nsrc tests: ${tests.length - failed}/${tests.length} files passed`);

// A STATIC CHECK THE UNIT TESTS CANNOT DO. None of the files above mounts a
// component, so a `const` read before its own declaration in a component body -
// a guaranteed ReferenceError on every render - passes both `npm test` and
// `npm run build` and reaches a human as a blank screen. Run here so it cannot
// be forgotten. See scripts/check-component-tdz.mjs.
console.log('\n=== component TDZ check ===');
const tdz = spawnSync(process.execPath, [join(fileURLToPath(new URL('.', import.meta.url)), 'check-component-tdz.mjs')], { stdio: 'inherit' });
if (tdz.status !== 0) failed++;

process.exit(failed ? 1 : 0);
