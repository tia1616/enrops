// Pins nextVersionFor and the document-key contract.
//
// Both are load-bearing in ways a build cannot catch: a repeated version string
// violates UNIQUE(organization_id, document_key, document_version) and the
// publish fails at the database; a renamed key produces a document an operator
// writes and no wizard screen ever fetches.

import { nextVersionFor, versionNumberOf, INSTRUCTOR_DOCUMENTS, DOCUMENT_KEYS, documentByKey } from './instructorDocuments.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}
function eq(name, actual, expected) {
  ok(`${name} (got ${JSON.stringify(actual)})`, actual === expected);
}

// --- nextVersionFor -------------------------------------------------------
eq('no versions yet -> v1', nextVersionFor([]), 'v1');
eq('undefined arg -> v1', nextVersionFor(), 'v1');
eq('v1 -> v2', nextVersionFor(['v1']), 'v2');
eq('v1,v2 -> v3', nextVersionFor(['v1', 'v2']), 'v3');

// The real seeded shapes on prod. A naive count would return v2 for the first
// and collide the moment a second version is published.
eq("J2S agreement 'v2.0_2026-06-15' -> v3", nextVersionFor(['v2.0_2026-06-15']), 'v3');
eq("'3.0' -> v4", nextVersionFor(['3.0']), 'v4');
eq("'1.0' -> v2", nextVersionFor(['1.0']), 'v2');

// Highest wins, not most-recent or count.
eq('out of order picks the max', nextVersionFor(['v3', 'v1', 'v2']), 'v4');
eq('gap does not reuse a number', nextVersionFor(['v1', 'v7']), 'v8');

// Unparseable values still advance past the count, so two of them cannot
// both resolve to v1.
eq('unparseable versions still advance', nextVersionFor(['a', 'b']), 'v3');
eq('mixed parseable + not', nextVersionFor(['a', 'v5']), 'v6');

// Never returns something already taken — the property that actually matters.
const cases = [[], ['v1'], ['v1', 'v2'], ['3.0'], ['a', 'b'], ['v2.0_2026-06-15'], ['v1', 'v7'], ['a', 'v5']];
ok('never collides with an existing version',
  cases.every((existing) => !existing.includes(nextVersionFor(existing))));

// --- the key contract -----------------------------------------------------
// These seven are fetched BY NAME by Screen4Agreement, Screen5Policies and
// Screen6Additional. Changing one silently orphans a document.
const REQUIRED_KEYS = [
  'contractor_agreement',
  'pay_schedule',
  'attendance_policy',
  'code_of_conduct',
  'mandatory_reporter_ack',
  'photo_video_release',
  'vehicle_driving_ack',
];
ok('every key a wizard screen reads is offered',
  REQUIRED_KEYS.every((k) => DOCUMENT_KEYS.includes(k)));
ok('no key is offered that no screen reads',
  DOCUMENT_KEYS.every((k) => REQUIRED_KEYS.includes(k)));
eq('no duplicate keys', new Set(DOCUMENT_KEYS).size, DOCUMENT_KEYS.length);
ok('documentByKey finds a real one', documentByKey('pay_schedule')?.label === 'Pay schedule');
ok('documentByKey returns null for junk', documentByKey('nope') === null);

// --- starter drafts -------------------------------------------------------
ok('every document has a label, help and a starter draft',
  INSTRUCTOR_DOCUMENTS.every((d) => d.label && d.help && d.starter && d.starter.trim().length > 0));

// Starters must read as unfinished. A provider who publishes one unedited should
// get an obviously-incomplete document, not confident boilerplate they did not write.
ok('every starter still contains a bracketed prompt to replace',
  INSTRUCTOR_DOCUMENTS.every((d) => /\[[^\]]+\]/.test(d.starter)));

// No real provider may appear in shared starter text (same rule as the
// placeholder guard, applied to the one field that guard does not scan).
const TENANT_WORDS = ['journeytosteam', 'journey to steam', 'j2s', 'ukulele', 'shoreview',
  'richelle', 'yoga playgrounds', 'chase youth', 'kumon', 'jessica', 'arielle'];
ok('no starter draft names a real provider or person',
  INSTRUCTOR_DOCUMENTS.every((d) => {
    const hay = `${d.label} ${d.help} ${d.starter}`.toLowerCase();
    return !TENANT_WORDS.some((w) => hay.includes(w));
  }));

// Oregon-specific statute language is J2S's, not the platform's.
ok('no starter draft cites a specific state statute',
  INSTRUCTOR_DOCUMENTS.every((d) => !/ORS\s*\d|670\.600/i.test(d.starter)));

// --- versionNumberOf must AGREE with nextVersionFor ------------------------
// The screen showed a row count while the database stored a parsed integer, so
// for any hand-seeded document the operator was told "version 2" while v3 was
// written, and the signed PDF was named agreement_v3. This pins them together.
eq("parses 'v2.0_2026-06-15'", versionNumberOf('v2.0_2026-06-15'), 2);
eq("parses '3.0'", versionNumberOf('3.0'), 3);
eq("parses 'v7'", versionNumberOf('v7'), 7);
eq('null for unparseable', versionNumberOf('draft'), null);
eq('null for nullish', versionNumberOf(null), null);

// The property that actually matters: the number shown for the NEXT publish is
// always exactly the number inside the string that gets stored.
ok('displayed next-version number always matches the stored string',
  [[], ['v1'], ['3.0'], ['v2.0_2026-06-15'], ['v1', 'v7'], ['a', 'v5']].every((existing) => {
    const stored = nextVersionFor(existing);
    return versionNumberOf(stored) === parseInt(stored.replace(/^v/, ''), 10);
  }));
// And it is always higher than whatever is live, so "creates version N" is never
// a number the operator has already seen.
ok('next number always exceeds every existing number',
  [['v1'], ['3.0'], ['v2.0_2026-06-15'], ['v1', 'v7']].every((existing) => {
    const next = versionNumberOf(nextVersionFor(existing));
    return existing.every((v) => (versionNumberOf(v) ?? 0) < next);
  }));

// --- the agreement's substitution tokens -----------------------------------
// renderAgreementText substitutes exactly these four and nothing else. Without
// them in the starter, a provider-authored agreement's stored snapshot - the
// text meant to be "exactly what they signed" - names nobody and has no date.
const AGREEMENT_TOKENS = ['contractor_legal_name', 'signing_date', 'signed_at_timestamp', 'signed_at_ip'];
const agreement = documentByKey('contractor_agreement');
ok('the agreement starter declares its tokens',
  Array.isArray(agreement.tokens) && agreement.tokens.length === 4);
ok('the agreement starter actually CONTAINS all four tokens',
  AGREEMENT_TOKENS.every((t) => agreement.starter.includes(`{{${t}}}`)));
ok('declared tokens and used tokens are the same set',
  AGREEMENT_TOKENS.every((t) => agreement.tokens.includes(t)) && agreement.tokens.every((t) => AGREEMENT_TOKENS.includes(t)));
// Only the signed document substitutes anything, so a token anywhere else would
// reach an instructor as literal braces.
ok('no OTHER starter contains a substitution token',
  INSTRUCTOR_DOCUMENTS.filter((d) => d.key !== 'contractor_agreement')
    .every((d) => !/\{\{\s*\w+\s*\}\}/.test(d.starter)));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
