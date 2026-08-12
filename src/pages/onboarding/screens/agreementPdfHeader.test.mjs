// Pins the running header of the signed contractor agreement PDF.
//
// This header was hardcoded to one provider's name and one provider's version
// string and printed on EVERY provider's archived contract. Two lies on a legal
// document, and neither was visible from the code that generated it.
//
// The fallbacks are the whole point and they are invisible in a rendered PDF:
// nobody opens the archived agreement of an org with no display name until
// there is a dispute, which is the worst moment to discover "undefined" across
// the top of it.
//
// Imports the helper by reading the module rather than importing the .jsx
// directly: agreementPdf.jsx pulls in @react-pdf/renderer, which is a 1.4MB
// browser bundle that node cannot load here. The helper is pure, so the parse
// below evaluates just it — and the regex is asserted to have matched, so a
// rename fails loudly instead of silently testing nothing.

import { readFileSync } from 'node:fs';
import { versionNumberOf } from '../../../lib/instructorDocuments.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}
function eq(name, actual, expected) {
  ok(`${name} (got ${JSON.stringify(actual)})`, actual === expected);
}

const src = readFileSync(new URL('./agreementPdf.jsx', import.meta.url), 'utf8');
const m = /export function agreementPdfHeader\(([\s\S]*?)\n}/.exec(src);
ok('the helper was found in agreementPdf.jsx', Boolean(m));
if (!m) { console.error('\nFAILURES  (helper not found — was it renamed?)'); process.exit(1); }

// eslint-disable-next-line no-new-func
const agreementPdfHeader = new Function(
  'versionNumberOf',
  `return function agreementPdfHeader(${m[1]}\n}`,
)(versionNumberOf);

// --- the normal case ------------------------------------------------------
eq('a real provider, real title, real version',
  agreementPdfHeader({ orgName: 'Cascade Enrichment Co.', documentTitle: 'Contractor agreement', documentVersion: 'v4' }),
  'Cascade Enrichment Co. — Contractor agreement, Version 4');

// The number shown must be the number the authoring screen shows and the number
// in the stored value — one parse, three surfaces.
eq('version display matches versionNumberOf',
  agreementPdfHeader({ orgName: 'X', documentTitle: 'T', documentVersion: 'v12' }),
  `X — T, Version ${versionNumberOf('v12')}`);

// The seeded shapes that exist on prod today.
eq("hand-seeded 'v2.0_2026-06-15' shows its real number",
  agreementPdfHeader({ orgName: 'X', documentTitle: 'T', documentVersion: 'v2.0_2026-06-15' }),
  'X — T, Version 2');
eq("hand-seeded '3.0'",
  agreementPdfHeader({ orgName: 'X', documentTitle: 'T', documentVersion: '3.0' }),
  'X — T, Version 3');

// --- no tenant is ever baked in -------------------------------------------
ok('no output names a real tenant when none is passed',
  !/journey to steam|j2s/i.test(agreementPdfHeader({ documentTitle: 'T', documentVersion: 'v1' })));

// CODE ONLY, not comments. The comment above the helper deliberately quotes the
// old hardcoded header so the reason it went is on the record — and a naive grep
// over the raw file therefore fails on the very note explaining the fix. Grep
// finds; only reading confirms. Strip comments and assert on what actually ships.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
ok('the stripper still left real code behind', code.includes('agreementPdfHeader'));
ok('no rendered string in the module names a tenant',
  !/Journey to STEAM/i.test(code));
ok('the hardcoded version string is gone from the code',
  !/Version 2\.0/.test(code));

// --- fallbacks: never print undefined on a contract -----------------------
eq('no org name drops the segment, no dangling dash',
  agreementPdfHeader({ documentTitle: 'Contractor agreement', documentVersion: 'v1' }),
  'Contractor agreement, Version 1');
eq('empty org name drops the segment',
  agreementPdfHeader({ orgName: '', documentTitle: 'T', documentVersion: 'v1' }), 'T, Version 1');
eq('whitespace org name drops the segment',
  agreementPdfHeader({ orgName: '   ', documentTitle: 'T', documentVersion: 'v1' }), 'T, Version 1');
eq('no title falls back to a neutral one',
  agreementPdfHeader({ orgName: 'X', documentVersion: 'v1' }), 'X — Independent Contractor Agreement, Version 1');
eq('no version drops the comma',
  agreementPdfHeader({ orgName: 'X', documentTitle: 'T' }), 'X — T');
eq('nothing at all still yields a usable header',
  agreementPdfHeader(), 'Independent Contractor Agreement');
eq('called with no argument at all',
  agreementPdfHeader(undefined), 'Independent Contractor Agreement');

// An unparseable stored version shows the raw string rather than inventing a
// number — same rule as the authoring screen.
eq('unparseable version shows raw, never "Version null"',
  agreementPdfHeader({ orgName: 'X', documentTitle: 'T', documentVersion: 'draft' }), 'X — T, draft');

// The failure this guards against, stated directly.
for (const args of [
  {}, { orgName: 'X' }, { documentTitle: 'T' }, { documentVersion: 'v1' },
  { orgName: null, documentTitle: null, documentVersion: null },
  { orgName: undefined, documentTitle: undefined, documentVersion: undefined },
]) {
  const out = agreementPdfHeader(args);
  ok(`never prints undefined/null for ${JSON.stringify(args)}`, !/undefined|null|NaN/.test(out));
  ok(`never starts or ends with a separator for ${JSON.stringify(args)}`,
    !/^\s*[—,]|[—,]\s*$/.test(out));
  ok(`never empty for ${JSON.stringify(args)}`, out.trim().length > 0);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
