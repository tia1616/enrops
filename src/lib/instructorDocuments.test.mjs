// Pins nextVersionFor and the document-key contract.
//
// Both are load-bearing in ways a build cannot catch: a repeated version string
// violates UNIQUE(organization_id, document_key, document_version) and the
// publish fails at the database; a renamed key produces a document an operator
// writes and no wizard screen ever fetches.

import {
  nextVersionFor, versionNumberOf, INSTRUCTOR_DOCUMENTS, DOCUMENT_KEYS, documentByKey,
  bodyForPublish, willAppendSignatureBlock, stripAppendedSignatureBlock,
  AGREEMENT_SIGNATURE_BLOCK, AGREEMENT_SIGNATURE_TOKENS,
  isDocumentEnabled, enabledDocumentKeys, documentKeysForStep,
  enabledDocumentKeysForStep, stepHasEnabledDocuments,
} from './instructorDocuments.js';

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

// --- the signature block is SYSTEM-APPENDED, not typed ---------------------
// It used to live in the editable starter, where a provider could delete it or
// typo a token. Now bodyForPublish appends it, and the editor shows it locked.
const agreement = documentByKey('contractor_agreement');
ok('the agreement block carries all four substitution tokens',
  AGREEMENT_SIGNATURE_TOKENS.every((t) => AGREEMENT_SIGNATURE_BLOCK.includes(`{{${t}}}`)));
ok('the agreement is flagged for the auto block', agreement.autoSignatureBlock === true);
ok('no starter contains a substitution token any more',
  INSTRUCTOR_DOCUMENTS.every((d) => !/\{\{\s*\w+\s*\}\}/.test(d.starter)));

// Publishing the agreement always yields a body with the four tokens, whatever
// the provider wrote — including if they wrote nothing resembling a signature.
ok('publishing the agreement appends the block',
  AGREEMENT_SIGNATURE_TOKENS.every((t) => bodyForPublish('contractor_agreement', 'My own agreement text.').includes(`{{${t}}}`)));
ok('publishing the STARTER yields all four tokens',
  AGREEMENT_SIGNATURE_TOKENS.every((t) => bodyForPublish('contractor_agreement', agreement.starter).includes(`{{${t}}}`)));

// Not appended twice. The seeded agreement carries its own COMPLETE signature
// wording inline; appending would give it two.
//
// This fixture used to hold only two of the four tokens and assert "no append",
// which encoded the .some() bug: a two-token body is HALF a signature, and
// treating it as complete is exactly how an agreement ended up with an audit line
// that named nobody. All four now, because all four is what complete means.
const alreadySigned = 'Terms.\n\nSigned by {{contractor_legal_name}} on {{signing_date}}.\n'
  + 'Recorded electronically at {{signed_at_timestamp}} from {{signed_at_ip}}.';
eq('does not double-append when a COMPLETE signature is already present',
  bodyForPublish('contractor_agreement', alreadySigned), alreadySigned);

// Unsigned documents are left completely alone — a token in a policy would
// reach an instructor as literal braces, since only the agreement substitutes.
for (const key of ['pay_schedule', 'code_of_conduct', 'photo_video_release']) {
  eq(`${key} is untouched by bodyForPublish`,
    bodyForPublish(key, 'Some policy text.'), 'Some policy text.');
}
ok('no unsigned document is flagged for the auto block',
  INSTRUCTOR_DOCUMENTS.filter((d) => d.key !== 'contractor_agreement')
    .every((d) => !d.autoSignatureBlock));
// Trims, so a trailing newline in the box cannot produce a ragged stored body.
eq('trims the provider body', bodyForPublish('pay_schedule', '  text  \n'), 'text');

// The SCREEN and the WRITE must answer "will a block be appended?" identically,
// or the editor promises to add a signature it will not add - which is what it
// did for the seeded agreement, showing a second copy of one it already had.
const predicateCases = [
  ['contractor_agreement', 'plain text', true],
  ['contractor_agreement', alreadySigned, false],
  ['contractor_agreement', '', true],
  ['pay_schedule', 'plain text', false],
  ['photo_video_release', 'has {{signing_date}} oddly', false],
];
for (const [key, text, expected] of predicateCases) {
  eq(`willAppend(${key}, ${JSON.stringify(text).slice(0, 22)}…)`, willAppendSignatureBlock(key, text), expected);
}
ok('predicate and writer never disagree',
  predicateCases.every(([key, text]) => {
    const appended = bodyForPublish(key, text) !== stripAppendedSignatureBlock(text);
    return appended === willAppendSignatureBlock(key, text);
  }));

// --- the block is never editable, and half-deletion cannot survive -----------
// The bug this replaces: the block was appended once, then lived in body_text,
// so the SECOND edit put it in the textarea. Deleting three of its four lines
// left one token, .some() called that "already signed", and the stored agreement
// kept an audit line naming nobody. Round-tripping now strips it on load.
const published = bodyForPublish('contractor_agreement', 'My agreement prose.');
eq('publish then reopen gives back the prose ONLY',
  stripAppendedSignatureBlock(published), 'My agreement prose.');
eq('the round trip is stable',
  bodyForPublish('contractor_agreement', stripAppendedSignatureBlock(published)), published);
ok('reopening still shows the locked panel',
  willAppendSignatureBlock('contractor_agreement', stripAppendedSignatureBlock(published)));

// A body holding SOME tokens is incomplete and must get a full block.
const halfDeleted = 'Terms.\n\nRecorded electronically at {{signed_at_timestamp}} from {{signed_at_ip}}.';
ok('a half-deleted block is treated as incomplete',
  willAppendSignatureBlock('contractor_agreement', halfDeleted));
ok('publishing a half-deleted block yields ALL four tokens',
  AGREEMENT_SIGNATURE_TOKENS.every((t) => bodyForPublish('contractor_agreement', halfDeleted).includes(`{{${t}}}`)));

// A body with all four already (the seeded agreement's own inline wording) is
// left alone - no second signature.
ok('a complete inline signature is not duplicated',
  !willAppendSignatureBlock('contractor_agreement', alreadySigned));

// Stripping must never eat a provider's own prose.
eq('strip leaves unrelated text untouched',
  stripAppendedSignatureBlock('Just my terms.'), 'Just my terms.');
eq('strip handles a body that is ONLY the block', stripAppendedSignatureBlock(AGREEMENT_SIGNATURE_BLOCK), '');
eq('strip is null-safe', stripAppendedSignatureBlock(null), '');

// --- per-document on/off --------------------------------------------------
//
// THE ONE THAT MATTERS IS "absent means ON". If that ever inverts, a provider
// who has not written their code of conduct yet stops being asked for it, and
// instructors onboard having acknowledged nothing — silently, with no error
// anywhere. Nothing else in the toolchain would catch it.

ok('absent key is ON', isDocumentEnabled({}, 'code_of_conduct'));
ok('null config is ON', isDocumentEnabled(null, 'code_of_conduct'));
ok('undefined config is ON', isDocumentEnabled(undefined, 'code_of_conduct'));
ok('explicit true is ON', isDocumentEnabled({ code_of_conduct: true }, 'code_of_conduct'));
ok('explicit false is OFF', !isDocumentEnabled({ code_of_conduct: false }, 'code_of_conduct'));

// Only an exact `false` turns something off. Anything else — a string, a null
// written by hand, a 0 — resolves ON, which is the safe side: onboarding keeps
// asking rather than quietly dropping a document.
ok('the string "false" is still ON', isDocumentEnabled({ code_of_conduct: 'false' }, 'code_of_conduct'));
ok('null value is still ON', isDocumentEnabled({ code_of_conduct: null }, 'code_of_conduct'));
ok('0 is still ON', isDocumentEnabled({ code_of_conduct: 0 }, 'code_of_conduct'));

// One key off must not touch the others.
ok('turning one off leaves the rest ON',
  isDocumentEnabled({ vehicle_driving_ack: false }, 'photo_video_release'));

// The agreement is signed, not acknowledged, and submit-agreement requires it.
ok('the agreement ignores an explicit false',
  isDocumentEnabled({ contractor_agreement: false }, 'contractor_agreement'));
ok('the agreement is marked alwaysOn', documentByKey('contractor_agreement').alwaysOn === true);
ok('nothing else is alwaysOn',
  INSTRUCTOR_DOCUMENTS.filter((d) => d.alwaysOn).length === 1);

eq('empty config enables all seven', enabledDocumentKeys({}).length, DOCUMENT_KEYS.length);
eq('two off leaves five',
  enabledDocumentKeys({ photo_video_release: false, vehicle_driving_ack: false }).length,
  DOCUMENT_KEYS.length - 2);
eq('everything off still leaves the agreement',
  enabledDocumentKeys(Object.fromEntries(DOCUMENT_KEYS.map((k) => [k, false]))).length, 1);

// --- screen grouping ------------------------------------------------------
//
// Every key belongs to exactly one screen. A key with no step would be written
// by an operator and fetched by nobody; a key in two would be acknowledged twice.
eq('every key has a step',
  INSTRUCTOR_DOCUMENTS.filter((d) => !d.step).length, 0);
eq('the three groups cover every key',
  ['agreement', 'policies', 'additional'].reduce((n, s) => n + documentKeysForStep(s).length, 0),
  DOCUMENT_KEYS.length);
eq('screen 5 reads three', documentKeysForStep('policies').length, 3);
eq('screen 6 reads three', documentKeysForStep('additional').length, 3);

// The wizard/gate contract: a screen with nothing left must be DROPPED, not
// rendered empty — and dropped server-side too, or the step key is never written
// and onboarding can never reach 'complete'.
ok('policies required by default', stepHasEnabledDocuments({}, 'policies'));
ok('additional required by default', stepHasEnabledDocuments({}, 'additional'));
ok('one document left still keeps the screen',
  stepHasEnabledDocuments({ photo_video_release: false, vehicle_driving_ack: false }, 'additional'));
eq('...and it is the remaining one',
  enabledDocumentKeysForStep({ photo_video_release: false, vehicle_driving_ack: false }, 'additional').join(),
  'mandatory_reporter_ack');
ok('all three off drops the screen',
  !stepHasEnabledDocuments(
    { mandatory_reporter_ack: false, photo_video_release: false, vehicle_driving_ack: false },
    'additional',
  ));
ok('emptying screen 6 does not empty screen 5',
  stepHasEnabledDocuments(
    { mandatory_reporter_ack: false, photo_video_release: false, vehicle_driving_ack: false },
    'policies',
  ));
ok('the agreement screen can never be emptied',
  stepHasEnabledDocuments({ contractor_agreement: false }, 'agreement'));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
