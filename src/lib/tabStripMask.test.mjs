// Pins the TabStrip fade. The defect these exist to stop is a fade on the WRONG
// side - it builds clean, type-checks clean, and the only way to see it is to
// open a phone. The states are: fits (no mask at all), scrolled to the start
// (fade right only), the middle (fade both), the end (fade left only).

import { maskFor, edgesOf, FADE_PX } from './tabStripMask.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}

const fadesLeft = (m) => m.includes(`transparent 0, #000 ${FADE_PX}px`);
const fadesRight = (m) => m.includes(`transparent 100%`);

// --- maskFor -------------------------------------------------------------
ok('a strip that fits gets NO mask (so desktop pays nothing for this)',
  maskFor(true, true) === null);

{
  const m = maskFor(true, false); // at the start, more to the right
  ok('at the start: fades the right only', !fadesLeft(m) && fadesRight(m));
}

{
  const m = maskFor(false, true); // at the end, more to the left
  ok('at the end: fades the left only', fadesLeft(m) && !fadesRight(m));
}

{
  const m = maskFor(false, false); // mid-scroll, more both ways
  ok('mid-scroll: fades both ends', fadesLeft(m) && fadesRight(m));
}

// --- edgesOf -------------------------------------------------------------
ok('content narrower than the box is both start AND end (no mask)',
  (() => { const e = edgesOf({ scrollLeft: 0, scrollWidth: 300, clientWidth: 347 });
    return e.atStart && e.atEnd; })());

ok('a real overflowing strip at rest is at the start, not the end',
  (() => { const e = edgesOf({ scrollLeft: 0, scrollWidth: 498, clientWidth: 347 });
    return e.atStart && !e.atEnd; })());

ok('scrolled fully right reads as the end',
  (() => { const e = edgesOf({ scrollLeft: 151, scrollWidth: 498, clientWidth: 347 });
    return !e.atStart && e.atEnd; })());

ok('mid-scroll is neither end',
  (() => { const e = edgesOf({ scrollLeft: 75, scrollWidth: 498, clientWidth: 347 });
    return !e.atStart && !e.atEnd; })());

// The slack is the point of edgesOf: a browser reporting 150.4 of a 151 max is
// still "at the end", and without this the fade flickers at every scroll stop.
ok('sub-pixel slack still reads as the end',
  edgesOf({ scrollLeft: 150.4, scrollWidth: 498, clientWidth: 347 }).atEnd);
ok('sub-pixel slack still reads as the start',
  edgesOf({ scrollLeft: 0.6, scrollWidth: 498, clientWidth: 347 }).atStart);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
