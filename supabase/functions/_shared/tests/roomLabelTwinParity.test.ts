// Twin-parity guard for the room label, in the spirit of
// platformFooterTwinParity.test.ts - but this pair can be EXECUTED on both
// sides rather than compared as text, because src/lib/roomLabel.js is plain ESM
// with no imports, so Deno can load it directly. That makes this a real
// behavioural parity test: the same table of inputs is pushed through both
// copies and the outputs must be identical.
//
// Why the pair exists at all: the browser (instructor portal, admin roster) and
// Deno (roster email, offer emails, patch offer, reminder cron, sub email) cannot
// import each other, and on 2026-08-25 every one of those surfaces had its own
// opinion about which room column to read and how to word it. If these two ever
// disagree, an instructor's portal and their email say different rooms - the
// exact failure the shared rule was created to end.
//
// If this fails: make the two files agree. Do not loosen the comparison.

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { roomDisplay as edge, venueLabel as edgeVenue } from '../roomLabel.ts';

const WEB = new URL('../../../../src/lib/roomLabel.js', import.meta.url);
const { roomDisplay: web, venueLabel: webVenue } = await import(WEB.href);

// Every literal here is a value that is actually in the live J2S data, plus the
// empty/whitespace/undefined cases that decide whether a label renders at all.
const CASES: Array<[unknown, unknown]> = [
  ['Community Room A', 'Community Room B'],
  [null, 'Community Room B'],
  ['', 'Kindergarten room'],
  ['   ', 'Kindergarten room'],
  [null, null],
  [undefined, undefined],
  ['', '  '],
  ['9', null],
  ['203', null],
  ['Room 111', null],
  ['C102', null],
  ['Makerspace', null],
  ['Stage', null],
  ['Kindy Tables', null],
  [null, 'Computer Lab'],
  ['  9  ', null],
  [null, '  Makerspace '],
  [4, null],
  ['1', 'Kindergarten room'],
];

Deno.test('the Deno and browser room labels agree on every real value', () => {
  for (const [classRoom, siteRoom] of CASES) {
    const e = edge(classRoom as string | null, siteRoom as string | null);
    const w = web(classRoom, siteRoom);
    assertEquals(
      w,
      e,
      `roomDisplay(${JSON.stringify(classRoom)}, ${JSON.stringify(siteRoom)}) ` +
      `differs: browser gave ${JSON.stringify(w)}, edge gave ${JSON.stringify(e)}. ` +
      'src/lib/roomLabel.js and _shared/roomLabel.ts have drifted.',
    );
  }
});

// Guards the guard. If both copies were broken the same way - or if an import
// silently resolved to something that returns undefined for everything - the
// loop above would compare undefined to undefined and pass while proving
// nothing. These pin the two behaviours that are actually load-bearing.
Deno.test('the shared rule still prefers the class room', () => {
  assertEquals(edge('Community Room A', 'Community Room B'), 'Community Room A');
  assertEquals(edge(null, 'Community Room B'), 'Community Room B');
});

Deno.test('the shared rule still says the word Room exactly once', () => {
  assertEquals(edge('9', null), 'Room 9');
  assertEquals(edge('Room 111', null), 'Room 111');
  assertEquals(edge('Makerspace', null), 'Makerspace');
  assertEquals(edge(null, null), null);
});

// venueLabel joins the site to the room, and four family-facing surfaces print
// it - the parent portal on the browser side, the payment confirmation, the
// welcome mail and the message-families notice on the Deno side. So the
// SEPARATOR is now a cross-runtime contract exactly as the wording already was.
const VENUE_CASES: Array<[unknown, unknown, unknown]> = [
  ['Alameda Elementary', 'Room 104', null],
  ['Ainsworth', '9', null],
  ['Maplewood Elementary', null, 'Room 12'],
  ['Happy Valley Library', 'Community Room A', 'Community Room B'],
  ['Jackson', null, null],
  [null, '9', null],
  [null, null, null],
  ['   ', '9', null],
  ['Jackson', '  ', '  '],
  ['Zellerbach Admin Center', null, '303-304'],
  [undefined, undefined, undefined],
];

Deno.test('the Deno and browser venue labels agree on every real value', () => {
  for (const [site, classRoom, siteRoom] of VENUE_CASES) {
    const e = edgeVenue(site as string | null, classRoom as string | null, siteRoom as string | null);
    const w = webVenue(site, classRoom, siteRoom);
    assertEquals(
      w,
      e,
      `venueLabel(${JSON.stringify(site)}, ${JSON.stringify(classRoom)}, ${JSON.stringify(siteRoom)}) ` +
      `differs: browser gave ${JSON.stringify(w)}, edge gave ${JSON.stringify(e)}. ` +
      'src/lib/roomLabel.js and _shared/roomLabel.ts have drifted.',
    );
  }
});

Deno.test('venueLabel keeps the precedence and drops empty halves cleanly', () => {
  assertEquals(edgeVenue('Ainsworth', '9', null), 'Ainsworth · Room 9');
  assertEquals(edgeVenue('Happy Valley Library', 'Community Room A', 'Community Room B'),
    'Happy Valley Library · Community Room A');
  assertEquals(edgeVenue('Jackson', null, null), 'Jackson');
  assertEquals(edgeVenue(null, null, null), null);
});
