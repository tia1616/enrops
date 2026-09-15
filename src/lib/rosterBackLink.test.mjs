// src/lib/rosterBackLink.test.mjs
//
// THE INVARIANT: the roster's back link goes where the operator came from, says
// where it is going, and cannot be pointed off-site.
//
// WHY THIS EXISTS. /admin/programs/:id/roster has two front doors -- the Rosters
// list and the Programs calendar -- and all three of its back links were hardcoded
// to Programs. Jeff, 2026-09-15: "the only option to go back takes you back to
// programs then I have to click rosters again... I've never needed to go from a
// class roster back to all programs." Working one site's rosters meant paying that
// detour on every class.
//
// The obvious fix -- hardcode /admin/rosters instead -- is the same bug wearing the
// other hat: it strands whoever came from the Programs calendar. So the door is
// carried as ?from= and validated.
//
// IT IS A URL PARAMETER, therefore attacker-supplied. `safeReturnPath` already
// exists for exactly this (it guards the post-sign-in redirect) and is reused
// rather than respelled. These cases are here because the guard is now load-
// bearing in a second place, and because "it is only an admin page" is how an
// open redirect gets shipped: an operator who follows
// /admin/programs/<id>/roster?from=https://evil.example and clicks Back would
// leave enrops entirely, on a page that had just shown them a roster.
//
// WHAT THIS DOES NOT CHECK. That the Rosters list actually passes ?from -- that is
// asserted against the source below, but whether the rendered anchor is reachable
// was verified by clicking it on staging, not here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeReturnPath } from './returnPath.js';

let pass = 0;
let fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
};

// Mirrors ProgramRoster.jsx: one map, exact membership, everything else falls back.
// Asserted against the real source at the bottom of this file so the two cannot
// drift apart.
const BACK_DOORS = {
  '/admin/rosters': '← Back to rosters',
  '/admin/programs': '← Back to programs',
};
const FALLBACK = '/admin/programs';
const backTo = (from) => {
  const requested = safeReturnPath(from, FALLBACK);
  return Object.prototype.hasOwnProperty.call(BACK_DOORS, requested) ? requested : FALLBACK;
};
const backLabel = (to) => BACK_DOORS[to];

// The two real doors.
ok('opened from Rosters, Back returns to Rosters', () => {
  assert.equal(backTo('/admin/rosters'), '/admin/rosters');
  assert.equal(backLabel(backTo('/admin/rosters')), '← Back to rosters');
});

ok('opened from the Programs calendar, Back still returns to Programs', () => {
  // That link passes no ?from, so the fallback is what preserves today's behaviour.
  assert.equal(backTo(null), FALLBACK);
  assert.equal(backLabel(backTo(null)), '← Back to programs');
});

// Gate E: the label must be true in the state that selects it. A link reading
// "programs" that lands on rosters is the same defect, reversed.
// This assertion USED to iterate only the two doors, null, '' and two off-site
// values -- so it never exercised a third same-site path and passed while
// ?from=/admin/finances rendered "Back to programs" pointing at Finances.
// /code-review found that on 2026-09-15. The list below is the fix: every input
// class, including same-site paths that are not doors.
ok('the label always matches the destination', () => {
  const inputs = [
    '/admin/rosters', '/admin/programs',          // the two real doors
    '/admin/finances', '/admin/contacts',          // same-site, NOT a door
    '/admin/rostersXYZ', '/admin/rosters/extra',   // prefix lookalikes
    '/admin/rosters?site=jackson',                 // a door with a query string
    null, '', '   ',                               // absent or empty
    'https://evil.example', '//evil.example',      // off-site
  ];
  for (const from of inputs) {
    const to = backTo(from);
    const said = backLabel(to);
    assert.ok(to in BACK_DOORS, `destination "${to}" is not a known door (from=${JSON.stringify(from)})`);
    assert.equal(said, BACK_DOORS[to],
      `label "${said}" disagrees with destination "${to}" for from=${JSON.stringify(from)}`);
  }
});

ok('a same-site path that is not a door falls back to Programs', () => {
  // The finding itself, pinned. Before the fix this returned /admin/finances
  // under a "Back to programs" label.
  assert.equal(backTo('/admin/finances'), '/admin/programs');
  assert.equal(backLabel(backTo('/admin/finances')), '← Back to programs');
});

ok('a prefix lookalike is not treated as the Rosters door', () => {
  // startsWith('/admin/rosters') matched these and sent people to routes that
  // do not exist, labelled "Back to rosters".
  for (const near of ['/admin/rostersXYZ', '/admin/rosters/extra', '/admin/rosters?site=jackson']) {
    assert.equal(backTo(near), '/admin/programs', `${near} should not be the rosters door`);
  }
});

// The guard, exercised through this caller's own fallback.
//
// The control-character case is BUILT rather than typed. returnPath.js says the
// raw byte is invisible in a diff and prefers the escape; the opposite bit me
// writing this file -- the escape went through a tool that resolved it, so a real
// NUL landed in the source, git classified the file as binary, and it stopped
// being diffable or reviewable at all while still passing. fromCharCode cannot be
// resolved by anything but the JS engine, so it survives every editor and pipe.
const NUL = String.fromCharCode(0);

ok('an off-site ?from cannot steer the back link', () => {
  for (const evil of [
    'https://evil.example/pay',
    '//evil.example',
    '\\/evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    `/admin/rosters${NUL}`,
  ]) {
    assert.equal(backTo(evil), FALLBACK, `${JSON.stringify(evil)} was not rejected`);
  }
});

// Source: the wiring both halves depend on.
ok('the roster page reads ?from through the guard, with the Programs fallback', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const src = readFileSync(join(here, '..', 'pages', 'admin', 'programs', 'ProgramRoster.jsx'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  assert.ok(/safeReturnPath\(\s*searchParams\.get\(["']from["']\)\s*,\s*DEFAULT_DOOR\s*\)/.test(code),
    'must read ?from through safeReturnPath');
  assert.ok(/hasOwnProperty\.call\(BACK_DOORS,\s*requested\)/.test(code),
    'the destination must be an EXACT member of BACK_DOORS, not a prefix or startsWith match');
  assert.ok(/backLabel\s*=\s*BACK_DOORS\[backTo\]/.test(code),
    'the label must be read from the same map as the destination, never computed separately');
  assert.ok(!/to="\/admin\/programs"/.test(code),
    'a hardcoded back-to-programs link is back; every one must use the computed target');

  // The doors this test reasons about must be the doors the page actually has.
  const doors = [...(code.match(/const BACK_DOORS = \{([\s\S]*?)\};/)?.[1] ?? '')
    .matchAll(/["']([^"']+)["']\s*:/g)].map((m) => m[1]).sort();
  assert.deepEqual(doors, Object.keys(BACK_DOORS).sort(),
    'BACK_DOORS in ProgramRoster.jsx has drifted from the set this test checks');
});

ok('the Rosters list passes its own door in the link', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const src = readFileSync(join(here, '..', 'pages', 'admin', 'Rosters.jsx'), 'utf8');
  assert.ok(/\/roster\?from=%2Fadmin%2Frosters/.test(src),
    'the View / print link must carry ?from=/admin/rosters (encoded)');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
