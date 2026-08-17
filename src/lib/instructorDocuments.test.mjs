// Pins nextVersionFor and the document-key contract.
//
// Both are load-bearing in ways a build cannot catch: a repeated version string
// violates UNIQUE(organization_id, document_key, document_version) and the
// publish fails at the database; a renamed key produces a document an operator
// writes and no wizard screen ever fetches.

import { readFileSync, readdirSync } from 'node:fs';
import {
  nextVersionFor, versionNumberOf, INSTRUCTOR_DOCUMENTS, DOCUMENT_KEYS, documentByKey,
  bodyForPublish, willAppendSignatureBlock, stripAppendedSignatureBlock,
  AGREEMENT_SIGNATURE_BLOCK, AGREEMENT_SIGNATURE_TOKENS,
  isDocumentEnabled, enabledDocumentKeys, documentKeysForStep,
  enabledDocumentKeysForStep, stepHasEnabledDocuments, documentsBannerPhrase,
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
// These eight are fetched BY NAME by Screen4Agreement, Screen5Policies and
// Screen6Additional. Changing one silently orphans a document.
const REQUIRED_KEYS = [
  'contractor_agreement',
  'pay_schedule',
  'attendance_policy',
  'code_of_conduct',
  'contractor_status',
  'mandatory_reporter_ack',
  'photo_video_release',
  'vehicle_driving_ack',
];
ok('every key a wizard screen reads is offered',
  REQUIRED_KEYS.every((k) => DOCUMENT_KEYS.includes(k)));
ok('no key is offered that no screen reads',
  DOCUMENT_KEYS.every((k) => REQUIRED_KEYS.includes(k)));
eq('no duplicate keys', new Set(DOCUMENT_KEYS).size, DOCUMENT_KEYS.length);

// --- ARRAY ORDER IS THE ADMIN SCREEN'S ORDER, and it was pinned by nothing ---
//
// InstructorDocuments maps this array raw, under a banner reading "Start with the
// contractor agreement — it's the one they actually sign — then work down the
// list." The header comment declares the order load-bearing and the commit that
// wrote it also REORDERED the array; neither added an assertion. Mutation: move
// contractor_agreement to the end and every test still passed, while the screen
// rendered it last under that banner.
eq('the agreement is first, because the banner tells operators to start there',
  DOCUMENT_KEYS[0], 'contractor_agreement');
// Full order, so a document cannot drift away from the screen that reads it —
// an instructor meets them in step order, and the admin list should match.
eq('the full order matches the order instructors meet them in',
  DOCUMENT_KEYS.join(','),
  [
    'contractor_agreement',
    'pay_schedule', 'attendance_policy', 'code_of_conduct',
    'contractor_status', 'mandatory_reporter_ack', 'photo_video_release', 'vehicle_driving_ack',
  ].join(','));
// ...and that the grouping is contiguous, which is the property the order is FOR.
// Asserted structurally so adding a document to an existing step cannot pass by
// being appended to the end of the array.
ok('each step\'s documents sit together in the array',
  ['agreement', 'policies', 'additional'].every((step) => {
    const idx = DOCUMENT_KEYS.map((k, i) => [k, i])
      .filter(([k]) => documentByKey(k).step === step).map(([, i]) => i);
    return idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  }));
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

// --- the one opt-in document ----------------------------------------------
//
// contractor_status inverts the rule above, and these pin the inversion in both
// directions. It is the ONLY exception; if a second document ever wants to
// default off it needs its own argument, so the count is asserted too.
const DEFAULT_OFF_KEYS = INSTRUCTOR_DOCUMENTS.filter((d) => d.defaultOff).map((d) => d.key);
eq('exactly one document defaults off', DEFAULT_OFF_KEYS.join(), 'contractor_status');
ok('contractor_status is OFF when absent', !isDocumentEnabled({}, 'contractor_status'));
ok('contractor_status is OFF for undefined config', !isDocumentEnabled(undefined, 'contractor_status'));
ok('contractor_status is OFF for an explicit false',
  !isDocumentEnabled({ contractor_status: false }, 'contractor_status'));
ok('contractor_status is ON only for an explicit true',
  isDocumentEnabled({ contractor_status: true }, 'contractor_status'));
// Strict === true. A hand-written truthy value in the JSONB must not switch on a
// legal acknowledgment nobody chose in the UI — the inverse of the "0 is still
// ON" case above, and deliberately so.
for (const truthy of ['true', 1, 'yes', {}]) {
  ok(`contractor_status stays OFF for ${JSON.stringify(truthy)}`,
    !isDocumentEnabled({ contractor_status: truthy }, 'contractor_status'));
}
// The whole point of shipping it off: nobody's onboarding changes today.
ok('turning contractor_status on does not disturb the others',
  isDocumentEnabled({ contractor_status: true }, 'code_of_conduct'));

eq('empty config enables all but the opt-in one',
  enabledDocumentKeys({}).length, DOCUMENT_KEYS.length - 1);
eq('opting in enables all eight',
  enabledDocumentKeys({ contractor_status: true }).length, DOCUMENT_KEYS.length);
eq('two off leaves the rest',
  enabledDocumentKeys({ photo_video_release: false, vehicle_driving_ack: false }).length,
  DOCUMENT_KEYS.length - 3);
eq('everything off still leaves the agreement',
  enabledDocumentKeys(Object.fromEntries(DOCUMENT_KEYS.map((k) => [k, false]))).length, 1);

// --- THE FOURTH COPY: the SQL view -----------------------------------------
//
// instructor_documents_public is a hand-written enumeration of these keys inside
// public_org_directory, and it is the copy the WIZARD actually reads — an
// instructor cannot select organizations.instructor_document_config at all.
// Until now the JS<->TS pair was pinned and the view was pinned by nothing, and
// the drift is silent AND unsafe in one direction: omit a key from the view, it
// resolves to undefined, `!== false` treats undefined as ON, and the instructor
// is asked for a document with no published body — a 404 dead end.
//
// Parsed out of the migration rather than queried, because a unit test has no
// database. That means this pins what the repo SAYS the view is; schema-parity
// is what proves the database agrees. Both are needed and neither substitutes.
{
  // THE NEWEST MIGRATION THAT DEFINES THE VIEW, not a filename. The first version
  // hardcoded 20260813a — and public_org_directory had already been redefined
  // three times in two days, so a fourth migration dropping or mis-resolving a key
  // would have left this green against a file that was no longer the live
  // definition. Sorted by filename, which is how the migration runner orders them.
  const migrationsDir = new URL('../../supabase/migrations/', import.meta.url);
  const defining = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => readFileSync(new URL(f, migrationsDir), 'utf8')
      .includes('as instructor_documents_public'));
  ok('at least one migration defines instructor_documents_public', defining.length > 0);
  const newest = defining[defining.length - 1];
  const migrationSrc = readFileSync(new URL(newest, migrationsDir), 'utf8');

  // ANCHOR ON THE ALIAS AND SCAN BACK, rather than matching
  // /jsonb_build_object\(...\) as instructor_documents_public/ — the view builds
  // background_check_public with the SAME function twenty lines earlier, so even
  // a non-greedy match starts at THAT opening paren and swallows its four keys.
  // The first run of this test failed with `enabled, provider_name, provider_url,
  // instructions` in the list, which is the test being wrong, not the view.
  const aliasAt = migrationSrc.lastIndexOf('as instructor_documents_public');
  ok(`instructor_documents_public found in ${newest}`, aliasAt > 0);
  if (aliasAt > 0) {
    const before = migrationSrc.slice(0, aliasAt);
    const openAt = before.lastIndexOf('jsonb_build_object(');
    // BOTH SQL comment forms. Stripping only `--` let a key be commented out with
    // /* ... */ while still matching the key regex, so the view stopped resolving
    // it, it came back undefined, `!== false` read that as ON, and the instructor
    // was asked for a document the view no longer publishes. Deleting a key
    // outright was caught; commenting one out — the far likelier edit — was not.
    const body = before.slice(openAt)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--.*$/gm, '');
    const viewKeys = [...body.matchAll(/'([a-z_]+)'\s*,/g)].map((m) => m[1]);

    // MULTIPLICITY MATTERS, so this is asserted before the Set collapses it.
    // Postgres resolves a duplicated jsonb_build_object key LAST-WINS, so listing
    // a key twice with the second occurrence mis-resolved silently changes its
    // behaviour for every org while the key set still looks correct.
    eq('the view lists each key exactly once', viewKeys.length, DOCUMENT_KEYS.length);
    eq('the view enumerates exactly the documents this file defines',
      [...new Set(viewKeys)].sort().join(','), [...DOCUMENT_KEYS].sort().join(','));

    // EVERY KEY'S RESOLUTION, not just the two interesting ones. Pinning only
    // contractor_status and contractor_agreement left the other six free to flip:
    // changing code_of_conduct to `= 'true', false` passed this whole block while
    // silently switching the code of conduct OFF for every provider who had never
    // opted in — the same silent drift, in the permissive direction.
    for (const key of DOCUMENT_KEYS) {
      const meta = documentByKey(key);
      if (meta?.alwaysOn) {
        ok(`the view pins ${key} to a literal true`,
          new RegExp(`'${key}',\\s*true`).test(body));
      } else if (meta?.defaultOff) {
        // Opt-in: needs an explicit true. `<> 'false'` here would default it ON
        // for everybody and hand every provider's instructors an unpublished
        // document.
        ok(`the view resolves ${key} with = 'true' (opt-in)`,
          new RegExp(`'${key}',\\s*coalesce\\(\\(instructor_document_config -> '${key}'\\) = 'true'::jsonb, false\\)`)
            .test(body));
      } else {
        ok(`the view resolves ${key} with <> 'false' (absent means on)`,
          new RegExp(`'${key}',\\s*coalesce\\(\\(instructor_document_config -> '${key}'\\) <> 'false'::jsonb, true\\)`)
            .test(body));
      }
    }
  }
}

// --- the banner may not attribute a choice nobody made --------------------
//
// A default-off document means the UNTOUCHED state is no longer "all of them",
// so any copy that reaches for the not-all branch is now the DEFAULT sentence
// rather than an edge case. The admin banner said "the 7 you've turned on" to a
// provider who had turned on nothing — true the day it was written, false the
// day contractor_status shipped, and shown to every provider on first visit.
//
// Asserted against the source because it is JSX copy with no seam to call. The
// invariant is the reason, not the wording: the untouched config must not equal
// the full set, and the branch it therefore selects must not claim the operator
// chose it.
// THE FIRST VERSION OF THIS TEST GREPPED THE SCREEN FOR BANNED WORDING, and
// /code-review was right that it was weaker than it looked: it failed on the
// comment explaining the fix, needed a comment stripper to compensate, then
// needed a meta-assertion to prove the stripper had run, and STILL missed
// `you&apos;ve` and the U+2019 apostrophe — both idiomatic in this file. Three
// layers of scaffolding around a regex that could not see the thing it guarded.
//
// The phrase is now a function, so these assert the sentence itself. All the
// scaffolding is gone.
eq('untouched: names the enabled set, claims no choice',
  documentsBannerPhrase(enabledDocumentKeys({}).length), 'the 7 that are switched on');
ok('untouched does NOT hit the all-N branch (this is what broke the old copy)',
  enabledDocumentKeys({}).length !== DOCUMENT_KEYS.length);
eq('fully opted in: all N',
  documentsBannerPhrase(DOCUMENT_KEYS.length), `all ${DOCUMENT_KEYS.length}`);
// Reachable — six toggleable documents off with contractor_status already off —
// and "the 1 that are switched on" is what the previous wording produced.
eq('exactly one left is grammatical', documentsBannerPhrase(1), 'the one that is switched on');
eq('two left', documentsBannerPhrase(2), 'the 2 that are switched on');
ok('no branch tells an operator they turned these on',
  [0, 1, 2, 7, DOCUMENT_KEYS.length].every((n) => !/turned on/.test(documentsBannerPhrase(n))));
// The sentence reads "They read and sign <phrase> during onboarding", so every
// branch has to survive that frame.
//
// OVER THE COUNTS THE eq()s ABOVE DO NOT COVER. The first version ran over
// [1, 2, 7, DOCUMENT_KEYS.length] — the exact four inputs already pinned
// character-for-character above it, so it had zero mutation-kill power: deleting
// the singular branch, returning "" from every branch, or appending "!" all
// passed it while failing the eq()s. Only inputs with no eq() of their own can
// tell you anything.
for (const n of [3, 4, 5, 6]) {
  const p = documentsBannerPhrase(n);
  ok(`phrase for ${n} is non-empty, lowercase-initial and unterminated`,
    p.length > 0 && !/^[A-Z]/.test(p) && !/[.!?]$/.test(p));
  ok(`phrase for ${n} states the count`, p.includes(String(n)));
}
// The screen must actually USE it; asserting a function nobody calls is the
// same failure the grep version had, one level up.
//
// COMMENTS STRIPPED, because this is a raw grep and the last raw grep in this
// file matched its own explanatory comment. Mutation-tested: replacing the call
// with inline banned copy while leaving a comment that mentions the call passed
// the unstripped version, as did commenting the call out entirely.
{
  const screenSrc = readFileSync(
    new URL('../pages/admin/InstructorDocuments.jsx', import.meta.url), 'utf8',
  )
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ');
  ok('the admin screen renders the shared phrase',
    /documentsBannerPhrase\(/.test(screenSrc));
  // ...and does not hand-roll the sentence beside it.
  ok('the admin screen does not inline its own count phrase',
    !/that are switched on|you'(ve|d)\s+turned\s+on|you\s+have\s+turned\s+on/.test(screenSrc));
}

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
eq('screen 6 offers four', documentKeysForStep('additional').length, 4);
// ...but shows three unless the provider opts in. documentKeysForStep is what
// EXISTS; enabledDocumentKeysForStep is what an instructor is asked for, and the
// gap between them is the default-off document.
eq('screen 6 shows three by default',
  enabledDocumentKeysForStep({}, 'additional').join(),
  'mandatory_reporter_ack,photo_video_release,vehicle_driving_ack');
eq('screen 6 shows four once opted in',
  enabledDocumentKeysForStep({ contractor_status: true }, 'additional').length, 4);

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
