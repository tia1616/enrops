// src/lib/rosterEmailPayload.test.mjs
//
// THE INVARIANT: the roster send screen and the two roster edge functions must
// agree on the NAME of every key on the wire.
//
// WHY THIS EXISTS. From at least 29 June until 3 September 2026, the operator's
// typed note never reached a single school. EmailRosterModal POSTed it as
// `body` and the typed subject as `subject`; email-program-roster reads the note
// from `message` and builds the subject itself, and read neither key that was
// sent. So an operator typed a subject and a message, pressed Send, got a
// SUCCESS screen, and the school received the platform's default email with none
// of it. The camp twin had the identical fault.
//
// Nothing failed. Both sides were valid JavaScript, so the build passed, the
// type-check passed, every test passed, and the function returned 200 - it had
// succeeded at sending the email it thought it was asked for. A JSON payload is
// a contract with no compiler behind it: an extra key is silently dropped and a
// missing one silently defaults.
//
// It was found only because Jeff sent a roster email TO HIMSELF and noticed his
// message was missing. Measured on prod at the time: of the 12 roster emails the
// platform had ever sent, 4 of them by a person pressing Send, ZERO carried a
// note.
//
// WHAT IT CHECKS. Both sides are DERIVED FROM SOURCE, never retyped here:
//   * the keys the modal sends - parsed out of its own JSON.stringify payloads
//   * the keys each function reads - parsed out of its own `body.<key>` reads
// and it asserts they match IN BOTH DIRECTIONS. A key the modal sends that
// nobody reads is the 3 September bug. A key a function reads that nobody sends
// is the same bug pointing the other way (a feature that silently does nothing).
//
// Because both sides are derived, renaming a key on EITHER side in step keeps
// this green, and renaming it on ONE side goes red immediately. That is the
// whole point: no build, type-check or HTTP status can tell you these disagree.
//
// WHAT IT DOES NOT CHECK. That the function does anything USEFUL with a key it
// reads, or that the value's SHAPE is right. Only the names.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = join(here, '..', '..');

const modalSrc = readFileSync(join(repo, 'src', 'pages', 'admin', 'EmailRosterModal.jsx'), 'utf8');
const programSrc = readFileSync(join(repo, 'supabase', 'functions', 'email-program-roster', 'index.ts'), 'utf8');
const campSrc = readFileSync(join(repo, 'supabase', 'functions', 'email-camp-roster', 'index.ts'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const sorted = (s) => [...s].sort().join(', ');

// Comments are stripped BEFORE any key is extracted. The send payload carries a
// long explanatory comment that names `message` and `body` in prose, and a
// parser that read those as keys would report the contract as satisfied by the
// very sentence describing how it was broken.
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// Brace-matched so it does not depend on formatting or on how many keys there
// are. Returns the inside of every `JSON.stringify({ ... })` in the file.
function payloadObjects(src) {
  const out = [];
  const needle = 'JSON.stringify({';
  let i = 0;
  for (;;) {
    const start = src.indexOf(needle, i);
    if (start === -1) break;
    let depth = 0;
    let j = start + needle.length - 1; // sits on the '{'
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) break; }
    }
    out.push(src.slice(start + needle.length, j));
    i = j + 1;
  }
  return out;
}

// `[target.bodyKey]: target.id` is a COMPUTED key: one modal serves both
// functions and fills in program_id or camp_session_id at runtime. It is
// recorded as the marker below and resolved per function, rather than being
// mistaken for a literal named "target".
const ID_KEY = '<computed id key>';

function keysOf(objectBody) {
  const src = stripComments(objectBody);
  const keys = new Set();
  if (/\[\s*target\.bodyKey\s*\]\s*:/.test(src)) keys.add(ID_KEY);
  for (const m of src.matchAll(/(?:^|[{,])\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) keys.add(m[1]);
  return keys;
}

function readsOf(fnSrc) {
  const keys = new Set();
  for (const m of stripComments(fnSrc).matchAll(/\bbody\.([A-Za-z_][A-Za-z0-9_]*)/g)) keys.add(m[1]);
  return keys;
}

const payloads = payloadObjects(modalSrc);
ok(payloads.length === 2, 'the modal has exactly two payloads (preview + send)',
  `found ${payloads.length}; if a third was added, decide which function reads it and extend this test`);

// Identify them by their own `mode`, not by source order.
const byMode = {};
for (const p of payloads) {
  const m = stripComments(p).match(/mode:\s*["'](\w+)["']/);
  if (m) byMode[m[1]] = keysOf(p);
}
ok(!!byMode.preview && !!byMode.send, 'both payloads declare a mode',
  `modes found: ${Object.keys(byMode).join(', ') || 'none'}`);

const programReads = readsOf(programSrc);
const campReads = readsOf(campSrc);

// The id key is the one legitimate asymmetry between the two functions.
const PROGRAM_ID = 'program_id';
const CAMP_ID = 'camp_session_id';
ok(programReads.has(PROGRAM_ID), 'email-program-roster reads program_id');
ok(campReads.has(CAMP_ID), 'email-camp-roster reads camp_session_id');

// Apart from the id, the two functions are mirrors. If they ever diverge, this
// test's "sent to both" assumption stops holding and it says so instead of
// quietly checking the wrong thing.
const progNoId = new Set([...programReads].filter((k) => k !== PROGRAM_ID));
const campNoId = new Set([...campReads].filter((k) => k !== CAMP_ID));
ok(sorted(progNoId) === sorted(campNoId),
  'the two roster functions read the same keys apart from their id',
  `program: ${sorted(progNoId)}\n      camp:    ${sorted(campNoId)}`);

for (const [mode, sentRaw] of Object.entries(byMode)) {
  for (const [fnName, reads, idKey] of [
    ['email-program-roster', programReads, PROGRAM_ID],
    ['email-camp-roster', campReads, CAMP_ID],
  ]) {
    // Resolve the computed key to the one this function actually reads.
    const sent = new Set([...sentRaw].map((k) => (k === ID_KEY ? idKey : k)));

    const unread = [...sent].filter((k) => !reads.has(k));
    ok(unread.length === 0,
      `${mode}: every key the modal sends is read by ${fnName}`,
      unread.length ? `NOBODY READS: ${unread.join(', ')} -- this is the 3 Sept bug. Either the function is `
        + `missing the read, or the modal is sending a name nothing looks for, in which case the operator's `
        + `input is being silently discarded.` : '');
  }
}

// The send payload specifically: the operator's note must travel under the name
// the functions read. Asserted on its own so the failure NAMES the bug rather
// than appearing as an anonymous set difference.
const sendKeys = byMode.send ?? new Set();
ok(sendKeys.has('message'),
  'the send payload carries the operator note as `message`',
  'The functions read the note from `body.message`. Sending it under any other name means the operator '
  + 'types a note, sees a success screen, and the school receives the default email without it.');

// The two names that were actually being sent, pinned as regressions. `body` is
// deliberately checked only INSIDE the payload: `body: JSON.stringify(...)` is
// the fetch option and is correct, so a naive whole-file search would be a
// permanent false alarm.
for (const dead of ['subject', 'body']) {
  ok(!sendKeys.has(dead),
    `the send payload does not carry a \`${dead}\` key`,
    `\`${dead}\` is read by NEITHER roster function. It was sent for months and silently dropped. `
    + (dead === 'subject'
      ? 'Each function builds the subject itself from the class; showing the operator the real one means '
        + 'returning it from the PREVIEW, not sending one.'
      : 'The operator note travels as `message`.'));
}

// Reverse direction: a key a function reads that nobody sends is the same defect
// pointing the other way. `confirm_duplicate`-style keys added to a function and
// never wired up look identical to a working feature.
const everSent = new Set([...(byMode.send ?? []), ...(byMode.preview ?? [])]);
for (const [fnName, reads, idKey] of [
  ['email-program-roster', programReads, PROGRAM_ID],
  ['email-camp-roster', campReads, CAMP_ID],
]) {
  const sendable = new Set([...everSent].map((k) => (k === ID_KEY ? idKey : k)));
  const unsent = [...reads].filter((k) => !sendable.has(k));
  ok(unsent.length === 0,
    `every key ${fnName} reads is sent by the modal`,
    unsent.length ? `NEVER SENT: ${unsent.join(', ')} -- the function has a feature no caller can reach. `
      + `Either wire it up in the modal or delete the read.` : '');
}

console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
