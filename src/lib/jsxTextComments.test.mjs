// src/lib/jsxTextComments.test.mjs
//
// THE INVARIANT: a {/* comment */} must not sit inside a run of JSX prose.
//
// WHY. On 2026-08-13 /code-review found this in ClassSchedule.jsx:175 —
// an operator opening /admin/class-schedule read "Upload yourschedule and we'll
// build it here." A comment had been added between two lines of text:
//
//     <p>
//       ...day and time. Upload your
//       {/* why this sentence changed */}
//       schedule and we'll build it here.
//     </p>
//
// JSX trims leading and trailing whitespace, INCLUDING the newline, from each
// text run. The comment splits one run into two, both get trimmed, and the space
// between "your" and "schedule" is deleted at compile time. Nothing catches it:
// it is valid JSX, the build is green, the types are fine, and it is invisible in
// the diff because the comment looks like it is on its own line.
//
// The reviewer confirmed the mechanism by compiling the file with the project's
// own esbuild and reading the children array: two adjacent string literals with
// nothing between them. This test detects the SHAPE in source instead, which is
// cheap enough to run on every commit.
//
// CONSERVATIVE ON PURPOSE. It only flags a comment with prose on both sides —
// a letter, digit or sentence punctuation before it, and a letter or digit
// after. A comment following a tag (`>`) or an expression (`}`) is not flagged,
// even though `{name}{/* c */}text` loses its space the same way, because those
// shapes appear legitimately all over the repo and a check that cries wolf gets
// deleted. See the note in .github/workflows/build.yml about exactly that.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findJoinedProse } from './jsxTextComments.js';

const srcRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const repoRoot = join(srcRoot, '..');

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? `\n${detail}` : ''}`); }
};

function jsxFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) jsxFiles(full, out);
    else if (name.endsWith('.jsx')) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The detector must actually detect. This is the exact text from the real bug —
// if this assertion ever passes vacuously the whole file is decoration.
// ---------------------------------------------------------------------------
const REGRESSION_SAMPLE = `
      <p className="mt-1 text-sm">
        Tell us the day and time. Upload your
        {/* Was "Upload your schedule and we will build it" — reworded 8/13 */}
        schedule and we'll build it here. Assign instructors to each class under
      </p>
`;
const sampleHits = findJoinedProse(REGRESSION_SAMPLE);
ok(sampleHits.length === 1 && sampleHits[0].joined === 'yourschedule',
  'the detector catches the real ClassSchedule.jsx:175 regression',
  `      got ${JSON.stringify(sampleHits)}`);

// And must not fire on the shapes that are everywhere and fine.
const SAFE_SAMPLES = [
  ['comment above the element', `{/* why */}\n<p>Upload your schedule.</p>`],
  ['comment after a tag', `<p>\n  {/* why */}\n  Upload your schedule.\n</p>`],
  ['comment between elements', `<p>One</p>\n{/* why */}\n<p>Two</p>`],
  ['comment before an expression', `<p>\n  {/* why */}\n  {label}\n</p>`],
  ['comment at end of a text run', `<p>\n  Upload your schedule.\n  {/* why */}\n</p>`],
];
for (const [label, sample] of SAFE_SAMPLES) {
  const hits = findJoinedProse(sample);
  ok(hits.length === 0, `no false positive: ${label}`, `      got ${JSON.stringify(hits)}`);
}

// ---------------------------------------------------------------------------
// The repo itself.
// ---------------------------------------------------------------------------
const files = jsxFiles(srcRoot);
ok(files.length > 50, 'the scanner found the .jsx files', `      only ${files.length}`);

const offenders = [];
for (const file of files) {
  const hits = findJoinedProse(readFileSync(file, 'utf8'));
  for (const h of hits) offenders.push(`${relative(repoRoot, file).replace(/\\/g, '/')}:${h.line} renders "${h.joined}"`);
}

ok(offenders.length === 0,
  'no JSX comment splits a run of prose',
  offenders.map((o) => `      ${o}`).join('\n')
    + '\n      Move the comment ABOVE the element. JSX trims the newline from each'
    + '\n      text run, so a comment mid-sentence deletes the space around it.');

console.log(`\n${files.length} .jsx files scanned`);
console.log(`${fail ? 'FAILURES' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
