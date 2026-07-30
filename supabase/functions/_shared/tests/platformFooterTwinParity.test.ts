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

// Guards the guard: if either function is renamed or restructured so the
// extractor finds nothing, the parity test above would pass vacuously.
Deno.test('the parity extractor actually found the decision lines', async () => {
  const edge = decisionLines(await Deno.readTextFile(EDGE));
  assertEquals(edge.length >= 5, true, `expected >=5 decision lines, got ${edge.length}`);
  assertEquals(edge.some((l) => l.includes("'partners'")), true);
  assertEquals(edge.some((l) => l.includes("recipientRole === 'instructor'")), true);
});
