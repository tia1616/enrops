// Unit tests for the HTML <-> editable-text round-trip.
//
// This module had NO tests, despite being the thing every authored email body and
// (as of 2026-08-10) the confirmation-page block passes through. These cover the
// properties those surfaces actually depend on, not the whole module:
//
//   1. round-trip STABILITY - html -> editable -> html must be a fixed point, or a
//      dirty-check that compares emitted HTML against stored HTML reports "unsaved
//      changes" the moment an editor mounts and nobody ever reaches a clean state.
//   2. link SANITIZING - the confirmation page renders this HTML with
//      dangerouslySetInnerHTML, so javascript:/data: destinations must not survive.
//   3. operator-typed angle brackets must be escaped, not emitted as live markup.
//   4. empty in -> empty out, so a cleared editor stores NULL rather than a blank
//      block that renders an empty card.
import { editableToHtml, htmlToEditable, stripHtml } from './bodyEditorUtils.js';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? ` -> ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

// --- 1. round-trip stability -------------------------------------------------
// The exact shape the confirmation-page fixture stores.
const shopBlock = '<p>Need supplies before your first class? <a href="https://riverbendarts.org/shop">Visit our shop</a> and we will have everything ready on day one.</p>';
eq('round-trip: link paragraph is a fixed point', editableToHtml(htmlToEditable(shopBlock)), shopBlock);

const twoParas = '<p>First paragraph.</p><p>Second paragraph.</p>';
eq('round-trip: two paragraphs stable', editableToHtml(htmlToEditable(twoParas)), twoParas);

const bolded = '<p>Bring a <strong>notebook</strong> and a <em>pencil</em>.</p>';
eq('round-trip: bold + italic stable', editableToHtml(htmlToEditable(bolded)), bolded);

// --- 2. link sanitizing ------------------------------------------------------
ok('javascript: destination collapses to #',
  editableToHtml('[tap here](javascript:alert(1))').includes('href="#"'),
  editableToHtml('[tap here](javascript:alert(1))'));

ok('javascript: destination does not survive anywhere in the output',
  !/javascript:/i.test(editableToHtml('[tap here](javascript:alert(1))')));

ok('data: destination collapses to #',
  editableToHtml('[x](data:text/html;base64,PHNjcmlwdD4=)').includes('href="#"'));

ok('a bare domain is NOT auto-schemed by this layer (the editor adds https before calling in)',
  editableToHtml('[shop](riverbendarts.org)').includes('href="#"'));

ok('https destination is kept verbatim',
  editableToHtml('[shop](https://riverbendarts.org/shop)').includes('href="https://riverbendarts.org/shop"'));

ok('mailto destination is allowed',
  editableToHtml('[email us](mailto:hello@riverbendarts.org)').includes('href="mailto:hello@riverbendarts.org"'));

// --- 3. operator-typed markup is escaped ------------------------------------
const typedScript = editableToHtml('Watch out for <script>alert(1)</script> here');
ok('typed <script> is entity-escaped, not emitted as a tag',
  typedScript.includes('&lt;script&gt;') && !/<script/i.test(typedScript),
  typedScript);

eq('escaped angle brackets survive the round trip as literal text',
  htmlToEditable(editableToHtml('a < b and c > d')), 'a < b and c > d');

// --- 4. empty handling -------------------------------------------------------
eq('empty string in, empty string out', editableToHtml(''), '');
eq('whitespace-only produces no markup', editableToHtml('   \n  \n '), '');
eq('htmlToEditable of empty is empty', htmlToEditable(''), '');
eq('htmlToEditable of null-ish is empty', htmlToEditable(undefined), '');

// --- stripHtml, used for the plain-text half of emails ----------------------
eq('stripHtml drops tags and decodes escaped brackets',
  stripHtml('<p>a &lt;b&gt; c</p>'), 'a <b> c');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
