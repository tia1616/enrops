// Proves regCatalogPicker.test.mjs actually DETECTS, rather than merely passing.
// Breaks the module one way at a time, runs the suite, and requires it to go RED.
// A mutation that stays green is a test that is not testing.
//
// Node does the file I/O on purpose: PowerShell re-encodes UTF-8 on the way
// through and would corrupt the source it is meant to restore.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SRC = new URL('../src/lib/regCatalogPicker.js', import.meta.url);
const TEST = new URL('../src/lib/regCatalogPicker.test.mjs', import.meta.url).pathname.slice(1);
const original = readFileSync(SRC, 'utf8');

const mutations = [
  ['REMOVE THE GATE (always show every class)',
    'const schoolChosen = !hasMultiLoc || !!school;',
    'const schoolChosen = true;'],
  ['SHOW ALL CLASSES WHEN NOTHING IS PICKED',
    '(school ? all.filter((p) => p.program_location_id === school) : []);',
    '(school ? all.filter((p) => p.program_location_id === school) : all);'],
  ['KEY LOCATIONS ON NAME INSTEAD OF ID',
    'if (!id || !name || seen.has(id)) continue;\n    seen.add(id);',
    'if (!id || !name || seen.has(name)) continue;\n    seen.add(name);'],
  ['HONOUR AN UNKNOWN SCHOOL ID (the stale-state bug)',
    'const school = locOptions.some((l) => l.id === selection.school) ? selection.school : \'\';',
    'const school = selection.school || \'\';'],
  ['SHOW A DISTRICT STEP FOR A SINGLE DISTRICT',
    'const useGroups = namedCount >= 2;',
    'const useGroups = namedCount >= 1;'],
  ['SORT THE CATCH-ALL BUCKET ALPHABETICALLY WITH REAL DISTRICTS',
    'const groupNames = groups.has(OTHER_DISTRICT) ? [...named, OTHER_DISTRICT] : named;',
    'const groupNames = [...groups.keys()].sort((a, b) => a.localeCompare(b));'],
  ['DROP THE MISSING-DISTRICT-NAME FALLBACK',
    'out.push({ id, name, district: (districtId && districtNames[districtId]) || OTHER_DISTRICT });',
    'out.push({ id, name, district: districtNames[districtId] });'],
];

let survived = 0;
try {
  for (const [label, from, to] of mutations) {
    if (!original.includes(from)) {
      console.log(`SKIP (anchor moved)  ${label}`);
      survived++;
      continue;
    }
    writeFileSync(SRC, original.replace(from, to), 'utf8');
    let red = false;
    let firstFail = '';
    try {
      execFileSync(process.execPath, [TEST], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      red = true;
      firstFail = (String(e.stdout || '') + String(e.stderr || ''))
        .split('\n').find((l) => l.startsWith('FAIL')) || '';
    }
    console.log(`${red ? 'CAUGHT ' : 'SURVIVED'}  ${label}${red ? `\n           first: ${firstFail.trim()}` : ''}`);
    if (!red) survived++;
  }
} finally {
  writeFileSync(SRC, original, 'utf8');
}

console.log(`\n${survived === 0 ? 'EVERY MUTATION CAUGHT' : `${survived} MUTATION(S) SURVIVED - the suite has a hole`}`);
process.exit(survived === 0 ? 0 : 1);
