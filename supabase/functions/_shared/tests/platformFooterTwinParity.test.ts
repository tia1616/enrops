// Twin-parity guard.
//
// surfaceForAutomation exists TWICE: here in Deno for the cron, and in
// src/components/PlatformFooterLine.jsx for the admin preview. They cannot
// import each other (Vite and Deno bundle roots), and the doc comment on each
// says they must stay identical — but nothing enforced it, so they drifted:
// the web copy was shipped missing the `audience === 'partners'` branch, and
// every static gate passed. Previewing a partner automation showed
// ?src=reminder while the real send emitted ?src=partner-recap.
//
// This reads both files as text and compares the ORDERED list of decision
// lines inside each function. It is deliberately crude — it does not execute
// the JSX — but it fails on exactly the drift that actually happened, which no
// unit test of either side alone could see.
//
// If this fails: make the two functions agree. Do not "fix" it by loosening
// the comparison.

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';

const EDGE = new URL('../platformFooter.ts', import.meta.url);
const WEB = new URL('../../../../src/components/PlatformFooterLine.jsx', import.meta.url);

/**
 * Pull the ordered decision lines out of a surfaceForAutomation body:
 * every `if (...) return ...;` plus the final bare `return ...;`.
 * TypeScript parameter annotations and comments are stripped so the two
 * languages compare equal.
 */
function decisionLines(source: string): string[] {
  const start = source.indexOf('export function surfaceForAutomation');
  if (start < 0) throw new Error('surfaceForAutomation not found');
  // Walk from the first { after the signature to its matching }.
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  return source
    .slice(open + 1, end)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .filter((l) => l.startsWith('if ') || l.startsWith('return ') || l.startsWith('const '))
    .map((l) => l.replace(/\s+/g, ' '));
}

Deno.test('the edge and web surfaceForAutomation implementations agree', async () => {
  const edge = decisionLines(await Deno.readTextFile(EDGE));
  const web = decisionLines(await Deno.readTextFile(WEB));
  assertEquals(
    web,
    edge,
    'src/components/PlatformFooterLine.jsx and _shared/platformFooter.ts have ' +
    'drifted. The admin preview would show a different ?src= than the real send.',
  );
});

/**
 * Pull the surface map entries (`key: 'value',`) out of
 * PLATFORM_FOOTER_SURFACES, ignoring comments and whitespace.
 */
function surfaceEntries(source: string): string[] {
  const start = source.indexOf('PLATFORM_FOOTER_SURFACES');
  const open = source.indexOf('{', start);
  const end = source.indexOf('}', open);
  return source
    .slice(open + 1, end)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l) => l.replace(/\s+/g, '').replace(/,$/, ''))
    .filter(Boolean);
}

// The surface VOCABULARY has to match too, not just the mapping function. A key
// present in one twin and missing in the other resolves to 'unknown' on that
// side — the same silent-drift shape, one level down.
Deno.test('the edge and web surface vocabularies agree', async () => {
  const edge = surfaceEntries(await Deno.readTextFile(EDGE));
  const web = surfaceEntries(await Deno.readTextFile(WEB));
  assertEquals(
    web,
    edge,
    'PLATFORM_FOOTER_SURFACES has drifted between the twins. A surface missing ' +
    'from one side resolves to ?src=unknown there.',
  );
});

// Guards the vocabulary guard. Without this, an empty or comment-only map body
// makes surfaceEntries return [] on BOTH sides, and [] === [] passes — the test
// would report green while checking nothing.
Deno.test('the vocabulary extractor actually found the surfaces', async () => {
  const edge = surfaceEntries(await Deno.readTextFile(EDGE));
  assertEquals(edge.length >= 10, true, `expected >=10 surfaces, got ${edge.length}`);
  for (const key of ['regPage', 'accountReady', 'embed']) {
    assertEquals(edge.some((e) => e.startsWith(`${key}:`)), true, `missing ${key}`);
  }
});

/** sRGB relative luminance (WCAG 2.x). */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const chan = (i: number) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
}

function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Pull a `NAME = '#RRGGBB'` or `name: '#RRGGBB'` token out of a source file. */
function colorToken(source: string, name: string): string {
  const m = source.match(new RegExp(`${name}\\s*[:=]\\s*'(#[0-9A-Fa-f]{6})'`));
  if (!m) throw new Error(`colour token ${name} not found`);
  return m[1];
}

// The tone->colour tokens live in BOTH twins. Nothing pinned them together, so
// a rebrand touching one file would leave the other behind — and a drift toward
// a lighter value would silently undo the contrast fix that made these two
// tones exist in the first place. This pins the values AND the ratios.
Deno.test('the light/dark link colours agree across the twins', async () => {
  const edgeSrc = await Deno.readTextFile(EDGE);
  const webSrc = await Deno.readTextFile(WEB);
  assertEquals(colorToken(webSrc, 'ENROPS_PURPLE'), colorToken(edgeSrc, 'light'),
    'the light-background link colour differs between the twins');
  assertEquals(colorToken(webSrc, 'ENROPS_VIOLET'), colorToken(edgeSrc, 'dark'),
    'the dark-background link colour differs between the twins');
});

// The suite had no contrast assertion at all, which is how a dark-background
// violet shipped onto white email cards at 2.97:1. 4.5:1 is the AA threshold
// for the 11-12px this line renders at.
Deno.test('both tones clear AA against the background they are for', async () => {
  const edgeSrc = await Deno.readTextFile(EDGE);
  const onWhite = contrast(colorToken(edgeSrc, 'light'), '#ffffff');
  const onDark = contrast(colorToken(edgeSrc, 'dark'), '#1A1530');
  assertEquals(onWhite >= 4.5, true, `light tone on white is ${onWhite.toFixed(2)}:1, needs 4.5`);
  assertEquals(onDark >= 4.5, true, `dark tone on #1A1530 is ${onDark.toFixed(2)}:1, needs 4.5`);
});

// Guards the guard: if either function is renamed or restructured so the
// extractor finds nothing, the parity test above would pass vacuously.
Deno.test('the parity extractor actually found the decision lines', async () => {
  const edge = decisionLines(await Deno.readTextFile(EDGE));
  assertEquals(edge.length >= 5, true, `expected >=5 decision lines, got ${edge.length}`);
  assertEquals(edge.some((l) => l.includes("'partners'")), true);
  assertEquals(edge.some((l) => l.includes("recipientRole === 'instructor'")), true);
});
