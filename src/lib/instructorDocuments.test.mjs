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
// These eight are fetched BY NAME by Screen3ORS, Screen4Agreement,
// Screen5Policies and Screen6Additional. Changing one silently orphans a document.
//
// Screen3ORS joined this list on 2026-08-21. It fetches `contractor_status` — the
// screen used to be hardcoded platform text with no document behind it, which is
// why no provider could find it in Settings. Its actual fetch is pinned
// structurally further down, in the block that parses each screen's own declared
// keys; this list is the flat contract.
const REQUIRED_KEYS = [
  'contractor_status',
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

// --- ARRAY ORDER IS THE ADMIN SCREEN'S ORDER, and it was pinned by nothing ---
//
// InstructorDocuments maps this array raw. The header comment declares the order
// load-bearing and the commit that wrote it also REORDERED the array; neither added
// an assertion. Mutation: move contractor_agreement to the end and every test still
// passed, while the screen rendered it last under a banner naming it first.
//
// SETTINGS ORDER IS ONBOARDING ORDER, decided 2026-08-21. Jessica: "can't you just
// put the settings in the order they appear in the onboarding?" So the first entry
// is contractor_status (Screen 3), NOT the agreement (Screen 4) — and the banner
// that used to say "start with the contractor agreement… then work down the list"
// was reworded in the same pass, because it became false. The two have to move
// together, which is what the pair of assertions below is for: the first pins the
// order, and the banner test further down pins that no copy names a starting
// document. Twice now, this sentence has been broken by a reorder nothing caught.
eq('the document an instructor meets first is first in the list',
  DOCUMENT_KEYS[0], 'contractor_status');
// Full order, so a document cannot drift away from the screen that reads it —
// an instructor meets them in step order, and the admin list should match.
eq('the full order matches the order instructors meet them in',
  DOCUMENT_KEYS.join(','),
  [
    'contractor_status',
    'contractor_agreement',
    'pay_schedule', 'attendance_policy', 'code_of_conduct',
    'mandatory_reporter_ack', 'photo_video_release', 'vehicle_driving_ack',
  ].join(','));
// ...and that the grouping is contiguous, which is the property the order is FOR.
// Asserted structurally so adding a document to an existing step cannot pass by
// being appended to the end of the array.
ok('each step\'s documents sit together in the array',
  ['contractor_status', 'agreement', 'policies', 'additional'].every((step) => {
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

// --- no document defaults off, and that is now pinned ----------------------
//
// `contractor_status` used to be the one opt-in document and had five tests pinning
// the inversion. It was deleted on 2026-08-21 as redundant with the contractor
// agreement, and RESTORED the same day as an ordinary document backing its own
// screen — because deleting the key left Screen3ORS exactly as hardcoded and
// invisible as it had always been, which was the actual complaint. The `defaultOff`
// flag did NOT come back with it. That is the assertion below: a flag with no holder
// is an invitation, and the next person who wants an optional document should have
// to argue for it rather than find the mechanism lying around.
ok('no document defaults off any more',
  INSTRUCTOR_DOCUMENTS.every((d) => d.defaultOff === undefined));
ok('the restored document IS offered again',
  DOCUMENT_KEYS.includes('contractor_status'));
// And the rule it used to bend now applies to IT: absent means ON.
ok('an absent value leaves a document ON', isDocumentEnabled({}, 'photo_video_release'));
ok('an undefined config leaves a document ON', isDocumentEnabled(undefined, 'photo_video_release'));

// THE KEY THAT MUST NOT SILENTLY GO BACK TO OPT-IN. This is the one assertion in
// this file whose failure is invisible and total: resolve contractor_status with
// `= 'true'` again and every provider's Screen 3 vanishes from the wizard, because
// no provider has the key set. Nobody would see an error. The screen would simply
// stop existing, which is the state this whole build exists to undo.
ok('contractor_status follows absent-means-ON like everything else',
  isDocumentEnabled({}, 'contractor_status')
    && isDocumentEnabled(null, 'contractor_status')
    && isDocumentEnabled(undefined, 'contractor_status'));
eq('an untouched provider is asked for it', enabledDocumentKeys({}).includes('contractor_status'), true);
// ...and it is a REAL toggle, not alwaysOn. A provider who does not want the screen
// must be able to switch it off — that half is what gateCheck.ts has to mirror, or
// onboarding never reaches 'complete' for them.
ok('an explicit false switches it off',
  !isDocumentEnabled({ contractor_status: false }, 'contractor_status'));
ok('it is not pinned alwaysOn', documentByKey('contractor_status').alwaysOn === undefined);

// A LEFTOVER `false` FROM THE OPT-IN ERA WOULD NOW MEAN "OFF", and that inversion
// is the one migration hazard here: under 20260813a a stored `false` meant
// "untouched, same as absent"; under 20260821e it means "the provider switched this
// off". Counted live on both databases on 2026-08-21 before restoring the key: ZERO
// organizations hold `contractor_status` in instructor_document_config on prod or on
// staging, so no provider inherits an OFF they never chose. If that count is ever
// non-zero on an environment this ships to, those rows need reading before the
// frontend lands, not after.
ok('turning it off disturbs no other document',
  isDocumentEnabled({ contractor_status: false }, 'code_of_conduct')
    && isDocumentEnabled({ contractor_status: false }, 'contractor_agreement'));
eq('turning it off removes exactly one document',
  enabledDocumentKeys({ contractor_status: false }).length, DOCUMENT_KEYS.length - 1);

eq('empty config enables every document',
  enabledDocumentKeys({}).length, DOCUMENT_KEYS.length);
eq('two off leaves the rest',
  enabledDocumentKeys({ photo_video_release: false, vehicle_driving_ack: false }).length,
  DOCUMENT_KEYS.length - 2);
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
// CASE-INSENSITIVE, and this is not a hypothetical hardening. The first version
  // matched the literal lowercase `as instructor_documents_public`; the migration
  // that deleted contractor_status writes `AS` in capitals, because that is how
  // Postgres prints a view definition and the file was built from one. So the
  // NEWEST definition was invisible to this filter, the block silently pinned the
  // superseded 20260813a file instead, and it would have stayed green while
  // asserting against a view that no longer exists — precisely the failure the
  // paragraph above describes, arrived at through keyword case rather than through
  // a missing test. It only surfaced because the key count moved at the same time.
  const aliasRe = () => /\bas\s+instructor_documents_public/gi;
  const migrationsDir = new URL('../../supabase/migrations/', import.meta.url);
  const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const defining = sqlFiles
    .filter((f) => aliasRe().test(readFileSync(new URL(f, migrationsDir), 'utf8')));
  ok('at least one migration defines instructor_documents_public', defining.length > 0);
  const newest = defining[defining.length - 1];
  const migrationSrc = readFileSync(new URL(newest, migrationsDir), 'utf8');

  // AND NOTHING LATER TOUCHES THE VIEW WITHOUT PUBLISHING THE DOCUMENTS OBJECT.
  // The check above finds the last migration that BUILDS instructor_documents_public;
  // it cannot see a later one that redefines public_org_directory and drops the
  // column altogether. That is the dangerous direction — the wizard then reads
  // undefined for every key, `!== false` calls all of them ON, and every instructor
  // is asked for documents with no published body.
  //
  // MATCH A REDEFINITION, NOT A MENTION. This used to be
  // `.includes('public_org_directory')`, which fired on any migration that so
  // much as SELECTED from the view. That is most of them: it is the tenant
  // allowlist every public-facing policy and view filters on, so
  // `organization_id in (select id from public_org_directory)` appears in
  // ordinary, harmless files. 20260825b/c/d each read it that way to scope the
  // sites fix, and the guard failed on 20260825d - a migration that does not go
  // near this view's shape.
  //
  // A read cannot drop a column; only a redefinition or a drop can, and that is
  // exactly what the paragraph above is guarding against. So match the DDL
  // verbs and nothing else. Kept deliberately loose on whitespace and the
  // optional schema qualifier, and case-insensitive for the same reason
  // aliasRe() is: these files are often pasted from what Postgres prints.
  const redefinesRe = /(create\s+(or\s+replace\s+)?view|drop\s+view(\s+if\s+exists)?|alter\s+view)\s+(public\.)?public_org_directory\b/i;
  const touching = sqlFiles
    .filter((f) => redefinesRe.test(readFileSync(new URL(f, migrationsDir), 'utf8')));
  eq('the newest migration touching the view is the one that defines the documents',
    touching[touching.length - 1], newest);

  // ANCHOR ON THE ALIAS AND SCAN BACK, rather than matching
  // /jsonb_build_object\(...\) as instructor_documents_public/ — the view builds
  // background_check_public with the SAME function twenty lines earlier, so even
  // a non-greedy match starts at THAT opening paren and swallows its four keys.
  // The first run of this test failed with `enabled, provider_name, provider_url,
  // instructions` in the list, which is the test being wrong, not the view.
  let aliasAt = -1;
  for (const m of migrationSrc.matchAll(aliasRe())) aliasAt = m.index;
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
// The admin banner said "the 7 you've turned on" to a provider who had turned on
// nothing. That copy was true the day it was written — the untouched state was
// all-on — and became false the day a default-off document shipped, because the
// untouched state stopped being "all of them" and the not-all branch turned into
// the DEFAULT sentence shown to every provider on first visit.
//
// DELETING THAT DOCUMENT RESTORES THE ORIGINAL CONDITION. Untouched is all-on
// again, so the first thing a provider reads is "all 7", which attributes nothing.
// The not-all branch is once more a genuine edge case, reached only by an operator
// who switched something off — so it stays pinned below, because copy that is
// currently right for the wrong reason breaks the next time the default moves.
// The invariant that survives both worlds: NO branch may tell an operator they
// turned these on.
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
eq('untouched: names the whole set, claims no choice',
  documentsBannerPhrase(enabledDocumentKeys({}).length), `all ${DOCUMENT_KEYS.length}`);
eq('untouched IS the all-N state again, now that nothing defaults off',
  enabledDocumentKeys({}).length, DOCUMENT_KEYS.length);
// The not-all branch is now reached only by an operator who actually switched
// something off. Still reachable, so still pinned — and derived from a real config
// rather than a bare number, so it moves with the document list.
eq('one switched off: names the enabled set, claims no choice',
  documentsBannerPhrase(enabledDocumentKeys({ photo_video_release: false }).length),
  `the ${DOCUMENT_KEYS.length - 1} that are switched on`);
// Reachable — every toggleable document off — and "the 1 that are switched on" is
// what the previous wording produced.
eq('exactly one left is grammatical', documentsBannerPhrase(1), 'the one that is switched on');
eq('two left', documentsBannerPhrase(2), 'the 2 that are switched on');
ok('no branch tells an operator they turned these on',
  [0, 1, 2, DOCUMENT_KEYS.length - 1, DOCUMENT_KEYS.length]
    .every((n) => !/turned on/.test(documentsBannerPhrase(n))));
// The sentence reads "They read and sign <phrase> during onboarding", so every
// branch has to survive that frame.
//
// OVER THE COUNTS THE eq()s ABOVE DO NOT COVER. The first version ran over
// [1, 2, 7, DOCUMENT_KEYS.length] — the exact four inputs already pinned
// character-for-character above it, so it had zero mutation-kill power: deleting
// the singular branch, returning "" from every branch, or appending "!" all
// passed it while failing the eq()s. Only inputs with no eq() of their own can
// tell you anything.
for (const n of [3, 4, 5]) {
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

// THE STEP LIST, WRITTEN DOWN ONCE. It was spelled out inline in four separate
// assertions, which is how `contractor_status` becoming its OWN step on 2026-08-21
// managed to leave three of them silently checking only three of the four groups —
// a coverage assertion that no longer covers everything still reads as coverage.
// Hardcoded on purpose rather than derived from INSTRUCTOR_DOCUMENTS: a list built
// from the module would shrink with it and could never notice a step going missing.
// The next assertion is what keeps this honest.
const ALL_STEPS = ['contractor_status', 'agreement', 'policies', 'additional'];
eq('this test knows about every step the module declares',
  [...new Set(INSTRUCTOR_DOCUMENTS.map((d) => d.step))].sort().join(','),
  [...ALL_STEPS].sort().join(','));

eq('the four groups cover every key',
  ALL_STEPS.reduce((n, s) => n + documentKeysForStep(s).length, 0),
  DOCUMENT_KEYS.length);
// Screen 3 is ONE document on its own screen, which is what makes switching that
// single document off drop a whole step — the case gateCheck.ts has to mirror.
eq('screen 3 reads one', documentKeysForStep('contractor_status').length, 1);
eq('screen 5 reads three', documentKeysForStep('policies').length, 3);
eq('screen 6 offers three', documentKeysForStep('additional').length, 3);
// ...and shows all three, because nothing on it defaults off any more.
// documentKeysForStep is what EXISTS; enabledDocumentKeysForStep is what an
// instructor is actually asked for, and there is no longer a gap between them for
// an untouched provider. The gap was the default-off document.
eq('screen 6 shows all three by default',
  enabledDocumentKeysForStep({}, 'additional').join(),
  'mandatory_reporter_ack,photo_video_release,vehicle_driving_ack');
eq('no step has a hidden document for an untouched provider',
  ALL_STEPS
    .filter((s) => enabledDocumentKeysForStep({}, s).length !== documentKeysForStep(s).length)
    .length, 0);
// EACH SCREEN'S DOCUMENTS STAY ON THAT SCREEN. contractor_status was grouped onto
// Screen 6 in its first incarnation (20260813a) and has its own step now, so a
// config value for it must not move a document onto or off any other screen.
eq('switching contractor_status off leaves screen 6 alone',
  enabledDocumentKeysForStep({ contractor_status: false }, 'additional').length, 3);
eq('switching contractor_status off leaves screen 5 alone',
  enabledDocumentKeysForStep({ contractor_status: false }, 'policies').length, 3);
eq('...and it is screen 3 that empties',
  enabledDocumentKeysForStep({ contractor_status: false }, 'contractor_status').length, 0);

// --- THE FIFTH, SIXTH AND SEVENTH COPIES: the wizard screens themselves ------
//
// Screen3ORS, Screen5Policies and Screen6Additional EACH HARDCODE their own list of
// the keys they render, rather than calling documentKeysForStep. That is three more
// copies of this file's step grouping, and until now nothing pinned any of them.
//
// THIS IS NOT A HYPOTHETICAL. Deleting contractor_status from this file and from
// the server mirror left Screen6Additional still listing it in ALL_DOC_KEYS, and
// the whole suite plus the production build stayed green. The consequence was NOT
// a dead reference: the screen asks isDocumentEnabled about the key, the answer
// for a key nothing knows is "absent means ON", so the section would have rendered
// for EVERY provider; the fetch would 404 because no such document was ever
// published; and loadAll's 404 branch sets a screen-wide error and returns BEFORE
// setDocs — so every instructor reaching Screen 6 would get the red "your program
// hasn't published these documents yet" box instead of the form, with the three
// real documents hidden and no way to finish onboarding. Found by grep, not by a
// test, which is why this block exists.
//
// EACH SCREEN'S OWN DECLARED LIST IS PARSED, not filtered against DOCUMENT_KEYS.
// The first version of this block scanned for quoted literals and kept only those
// the library still knows — which silently skips a key the library has DROPPED and
// the screen still lists, i.e. exactly the bug above. A check that cannot fail on
// the case that motivated it is worse than no check, because it reads as coverage.
// Parsed structurally instead, so the screen's list stands on its own and any
// unknown key it holds shows up as a difference.
{
  const screens = [
    // Screen 3 renders ONE document and names it in a single const:
    // `const DOC_KEY = 'contractor_status'`. Pinned for the same reason as the
    // other two, and with a sharper edge: this screen spent its whole life
    // rendering hardcoded platform text with no document behind it, so "the key
    // this file defines" and "the key the screen fetches" have been out of step
    // here before by construction rather than by accident.
    ['Screen3ORS.jsx', 'contractor_status', (src) => {
      const m = /const DOC_KEY\s*=\s*'([a-z_]+)'/.exec(src);
      return m ? [m[1]] : null;
    }],
    // Screen 5 declares objects: `{ key: 'pay_schedule', ack: '...' }`.
    ['Screen5Policies.jsx', 'policies', (src) => {
      const m = /const ALL_DOCS\s*=\s*\[([\s\S]*?)\];/.exec(src);
      return m ? [...m[1].matchAll(/key:\s*'([a-z_]+)'/g)].map((x) => x[1]) : null;
    }],
    // Screen 6 declares an array of CONSTS: `[MANDATORY_KEY, PHOTO_KEY, ...]`,
    // each defined as `const MANDATORY_KEY = 'mandatory_reporter_ack'`, so the
    // identifiers are resolved through that map before comparing.
    ['Screen6Additional.jsx', 'additional', (src) => {
      const m = /const ALL_DOC_KEYS\s*=\s*\[([^\]]*)\]/.exec(src);
      if (!m) return null;
      const consts = Object.fromEntries(
        [...src.matchAll(/const\s+([A-Z0-9_]+)\s*=\s*'([a-z_]+)'/g)].map((x) => [x[1], x[2]]),
      );
      return m[1].split(',').map((s) => s.trim()).filter(Boolean)
        .map((tok) => (/^'/.test(tok) ? tok.replace(/'/g, '') : consts[tok] ?? `UNRESOLVED:${tok}`));
    }],
  ];
  for (const [file, step, parse] of screens) {
    const raw = readFileSync(
      new URL(`../pages/onboarding/screens/${file}`, import.meta.url), 'utf8',
    );
    // COMMENTS STRIPPED FIRST. Both screens now carry a paragraph naming the
    // deleted key, and Screen 6's sits directly above the declaration this parses.
    const src = raw
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/.*$/gm, ' ');
    ok(`${file}: the comment stripper ran and left the code intact`,
      src.length < raw.length && /export default function/.test(src));
    const declared = parse(src);
    // A REFACTOR THAT RENAMES THE LIST MUST FAIL LOUDLY, not quietly stop checking.
    ok(`${file}: its document list was found and parsed`,
      Array.isArray(declared) && declared.length > 0);
    if (Array.isArray(declared)) {
      eq(`${file} renders exactly the '${step}' group, in order`,
        declared.join(','), documentKeysForStep(step).join(','));
    }
  }

  // AND THE KEY IS ACTUALLY FETCHED WITH, not merely declared beside. A `const
  // DOC_KEY` nothing passes to fetchLegalDocument satisfies the parse above and
  // renders a screen that asks the database for nothing — which is precisely the
  // state Screen3ORS was in until 2026-08-21: correct-looking constants, no fetch,
  // hardcoded prose. The other two screens map over their lists to build the fetch,
  // so their declaration IS their fetch; this one names its key separately and
  // therefore needs saying out loud.
  const screen3 = readFileSync(
    new URL('../pages/onboarding/screens/Screen3ORS.jsx', import.meta.url), 'utf8',
  )
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ');
  ok('Screen3ORS fetches its document rather than just naming it',
    /fetchLegalDocument\(\s*DOC_KEY\b/.test(screen3));
  // EXACTLY ONE CONTRACTOR-STATUS CONFIRMATION IN THE WHOLE WIZARD, and it is the
  // one that gets recorded. Removed from Screen 3 on 2026-08-24 (Jessica, walking
  // the flow: "they shouldn't confirm their status as an independent contractor
  // twice"). The asymmetry is why THIS one went: Screen 3's box stored nothing,
  // Screen 4's is a NOT NULL column beside the signature, timestamp and IP.
  //
  // Pinned as a PAIR, in both directions, because either half alone is a defect:
  // a box back on Screen 3 restores the double ask, and losing Screen 4's box
  // silently drops the only attestation there is.
  ok('Screen 3 asks for no acknowledgement of its own',
    !/type="checkbox"/.test(screen3));

  // --- THE PHOTO RELEASE IS THE ONE BOX THAT MAY BE REFUSED -------------------
  //
  // It had THREE required boxes, so consenting to appear in a provider's
  // marketing was a condition of finishing onboarding, and the answer was stored
  // nowhere. Both halves are pinned, because either one alone is the bug:
  // requiring it again re-creates the coercion, and dropping the write makes a
  // refusal invisible to the provider who needs to honour it.
  {
    const s6 = readFileSync(
      new URL('../pages/onboarding/screens/Screen6Additional.jsx', import.meta.url), 'utf8',
    ).replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');

    // THE GATE. Parsed rather than grepped loosely: allAcksChecked is the
    // expression that decides whether Continue works, and the photo consent must
    // not appear anywhere inside it.
    const gate = /const allAcksChecked\s*=([\s\S]*?);/.exec(s6);
    ok('the Continue gate was found', Boolean(gate));
    ok('the photo consent does not gate Continue',
      Boolean(gate) && !/photo/i.test(gate[1]));
    // ...while the ones that ARE conditions of the work still do.
    ok('the driving and mandatory-reporter acks still gate Continue',
      Boolean(gate) && /Vehicle/i.test(gate[1]) && /mandatory/i.test(gate[1]));

    // ONE box, not three.
    const photoBlock = /const photoAcks\s*=[\s\S]*?\n\];/.exec(s6);
    ok('the photo ack list was found', Boolean(photoBlock));
    eq('the photo release asks exactly one thing',
      (photoBlock?.[1] ?? photoBlock?.[0] ?? '').match(/key:/g)?.length ?? 0, 1);

    // AND THE ANSWER IS SENT. Without this the box is merely decorative and a
    // refusal dies in the browser.
    ok('the answer is posted to the server',
      /photo_release_consent:\s*!!photoChecked\[/.test(s6));
    // Only when the release is actually on this provider's screen — otherwise a
    // provider who switched it off would have every instructor recorded as
    // refusing a document they were never shown.
    ok('...and only when the provider has the release switched on',
      /showPhoto\s*\?\s*\{\s*photo_release_consent/.test(s6));

    // The mandatory-reporter tick may not assert training the platform cannot
    // verify — the wording that prompted this, and the reason it read wrong.
    ok('the mandatory-reporter tick claims only what it can evidence',
      !/will complete the mandatory reporting training/i.test(s6));

    // THE BOX MUST START FROM WHAT THEY ALREADY ANSWERED. Found in review: it
    // initialised to false unconditionally, so pressing Back from Screen 7 and
    // resubmitting overwrote a recorded agreement with a refusal — one
    // direction, silently, on a consent record. Every other group on this screen
    // may start blank; this one may not, because its blank state is an answer
    // that gets written.
    ok('the photo consent starts from the stored answer, not from false',
      /useState\([\s\S]{0,220}instructor\?\.photo_release_consent === true/.test(s6));
    // ...and strictly against true, so "never asked" (null) still renders empty.
    ok('...and null is not treated as agreed',
      !/photo_release_consent\s*\)\s*\)/.test(s6)
        && /photo_release_consent === true/.test(s6));
  }

  // --- A STEP THAT WAS NEVER RECORDED MUST FAIL LOUDLY ------------------------
  //
  // submit-acknowledgments used to log a failed step advance and return success
  // on the reasoning "don't fail — acks are written". That is the fail direction
  // backwards: the ack rows are not what lets an instructor finish, the step key
  // is. Swallowing it moves them past a step nothing recorded, and the completion
  // gate then waits forever for a key nobody can write — silent and permanent.
  // Screen 3 was moved onto this function, so the guard submit-ors-certification
  // carried had to come with it.
  {
    const fn = readFileSync(
      new URL('../../supabase/functions/submit-acknowledgments/index.ts', import.meta.url), 'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
    // ANCHORED ON THE ERROR CODE, not on "a return appears nearby". The first
    // version of this matched /stepErr\)\s*\{[\s\S]{0,320}return json\(/, which
    // the OLD broken code satisfied too — the success return sits ~150 characters
    // below the if block, well inside that window. A guard that passes against
    // the bug it was written for is worse than none, and this file has caught
    // itself doing that twice now.
    ok('a failed step advance returns an error rather than success',
      /return json\(\{\s*error:\s*'step_advance_failed'\s*\},\s*500\)/.test(fn));

    // --- NO ONE TENANT'S PROGRAMME SHAPE IN A SHARED WIZARD SCREEN -----------
    //
    // The last screen of onboarding told EVERY provider's instructors that their
    // "summer camp assignments" were waiting. Only J2S runs camps; Jessica hit it
    // walking the flow as an after-school ukulele instructor on 2026-08-24. The
    // screens are shared, so a word that is only true for one tenant is wrong for
    // all the others, and nothing here can be tenant-configured because these
    // strings take no org.
    //
    // Scanned WITH comments stripped: the fix's own comment names the old wording,
    // and this file has twice shipped a grep that matched the explanation of the
    // very thing it guarded.
    const completion = readFileSync(
      new URL('../pages/onboarding/CompletionScreen.jsx', import.meta.url), 'utf8',
    ).replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
    for (const word of ['summer camp', 'journey to steam', 'j2s', 'ukulele', 'steam vip']) {
      ok(`the completion screen does not say "${word}"`,
        !new RegExp(word.replace(/ /g, '\\s+'), 'i').test(completion));
    }
    ok('...and success is not also returned for that path',
      !/Don't fail\s*[-—]\s*acks are written/i.test(fn));
    ok('...and the contractor-status step is one this function knows',
      /contractor_status:\s*\{\s*key:\s*'ors_certification'/.test(fn));
  }
  ok('Continue is still blocked until the document is ready',
    /disabled=\{[^}]*doc\.phase !== 'ready'/.test(screen3));
  {
    const s4 = readFileSync(
      new URL('../pages/onboarding/screens/Screen4Agreement.jsx', import.meta.url), 'utf8',
    ).replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
    ok('...and the agreement still carries the one that is recorded',
      /key:\s*'confirm_contractor_status'/.test(s4));
  }

  // AND THE PROVIDER'S NAME COMES FROM THE CONTEXT, NOT FROM A PROP. WizardHost
  // renders every screen with one fixed bundle — slug, instructor, onboarding,
  // onAdvance, onBack — so ANY other value a screen declares as a prop silently
  // resolves to its default forever. This screen shipped with `orgName = ''` as a
  // prop, which meant the "not published yet" message could never name the
  // provider: the single thing that message exists to do, dead on arrival, with no
  // error and nothing in the UI to notice. Found in review, not by a test.
  //
  // Both halves asserted, because fixing this by passing the prop from WizardHost
  // instead would work today and diverge from Screens 4 and 6 tomorrow. One way to
  // read org config in this wizard.
  ok('Screen3ORS reads orgName from the onboarding config',
    /const\s*\{[^}]*\borgName\b[^}]*\}\s*=\s*useOnboardingConfig\(\)/.test(screen3));
  ok('...and does not take it as a prop, which WizardHost never passes',
    !/function Screen3ORS\([^)]*\borgName\b/.test(screen3));
}

// The wizard/gate contract: a screen with nothing left must be DROPPED, not
// rendered empty — and dropped server-side too, or the step key is never written
// and onboarding can never reach 'complete'.
ok('contractor status required by default', stepHasEnabledDocuments({}, 'contractor_status'));
ok('policies required by default', stepHasEnabledDocuments({}, 'policies'));
ok('additional required by default', stepHasEnabledDocuments({}, 'additional'));
// THE ONE-DOCUMENT SCREEN. Screens 5 and 6 need every document off before they
// empty; this one empties on a single toggle, so it is the cheapest way for a
// provider to reach a state where gateCheck must stop requiring a step. If
// gateCheck.ts does not mirror this exact predicate, that provider's instructors
// finish every screen and never reach 'complete'.
ok('switching the one document off drops screen 3',
  !stepHasEnabledDocuments({ contractor_status: false }, 'contractor_status'));
ok('...and leaves screens 5 and 6 standing',
  stepHasEnabledDocuments({ contractor_status: false }, 'policies')
    && stepHasEnabledDocuments({ contractor_status: false }, 'additional'));
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
