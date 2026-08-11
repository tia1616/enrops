// Guards the CLASS, not the instance: no real tenant's brand or domain may appear in a
// placeholder anywhere in src.
//
// Twice now a live provider's business has been the platform's example. The
// registration-wording fields on /admin/branding said "After-school ukulele classes in
// Portland", and the automations link box offered that provider's actual shop domain -
// both live on prod, both shown to every OTHER operator as our suggestion. Jessica,
// 2026-08-11: "don't have his real website on there either as the example."
//
// WHY THIS LIST IS NOT referral.test.mjs's TENANT_WORDS. That one guards a list of
// answers a FAMILY picks from, so it also bans cities and publications ('portland',
// 'pdx'). Here the risk is narrower and the false-positive cost is higher: "STEAM" and
// "chess" are ordinary words for a kind of programme, and a placeholder is allowed to
// say "e.g. STEAM camp". So this list holds only strings that identify a specific
// tenant - brand names and domains. Keep the two lists separate on purpose; merging
// them would either block legitimate wording here or weaken the referral guard there.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const TENANT_IDENTIFIERS = [
  'ukulele',            // The Ukulele Project — their instrument IS their brand
  'theukuleleproject',
  'journeytosteam',
  'journey to steam',
  'j2s',
  'kumon',
  'shoreview',
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(jsx?|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

// placeholder="..." | placeholder='...' | placeholder={"..."} | placeholder={'...'}
// | placeholder={`...`}  — the attribute an operator actually reads.
const PLACEHOLDER = /placeholder\s*=\s*(?:\{?\s*)(["'`])([\s\S]*?)\1/g;

let pass = 0, fail = 0;
const offenders = [];

for (const file of walk(SRC)) {
  // This file necessarily contains the words it bans.
  if (file.endsWith('placeholderTenantWords.test.mjs')) continue;
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (const m of text.matchAll(PLACEHOLDER)) {
    const value = m[2];
    const hit = TENANT_IDENTIFIERS.find((w) => value.toLowerCase().includes(w));
    if (!hit) continue;
    const line = text.slice(0, m.index).split('\n').length;
    offenders.push(`${file.replace(SRC, 'src')}:${line} -> placeholder "${value}" contains "${hit}"`);
  }
  void lines;
}

if (offenders.length === 0) {
  pass++;
  console.log('PASS  no placeholder in src names a real tenant');
} else {
  fail++;
  console.error('FAIL  a placeholder names a real tenant — use generic wording:');
  for (const o of offenders) console.error(`      ${o}`);
}

// Prove the scanner actually scans: if the regex ever stops matching, the check above
// would pass vacuously and report green while guarding nothing.
const totalPlaceholders = walk(SRC)
  .filter((f) => !f.endsWith('placeholderTenantWords.test.mjs'))
  .reduce((n, f) => n + [...readFileSync(f, 'utf8').matchAll(PLACEHOLDER)].length, 0);
if (totalPlaceholders > 50) {
  pass++;
  console.log(`PASS  scanner is live (${totalPlaceholders} placeholders inspected)`);
} else {
  fail++;
  console.error(`FAIL  only ${totalPlaceholders} placeholders found — the regex has stopped matching, so the guard above proves nothing`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
