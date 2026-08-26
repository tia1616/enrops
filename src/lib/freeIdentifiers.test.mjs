// src/lib/freeIdentifiers.test.mjs
//
// THE INVARIANT: no file under src/ may reference a name that is never defined.
//
// WHY THIS EXISTS. On 2026-08-25 a family emailed to say a sign-in link "doesn't
// work". The link worked; it signed her in. The dashboard it landed on rendered
//
//     <SectionLabel>From {org?.name || 'your provider'}</SectionLabel>
//
// inside TodayTab, a module-level sibling of Dashboard — so `org` was not in
// scope there at all. Optional chaining does NOT guard an undeclared identifier,
// only a missing property, so this threw ReferenceError. ChunkErrorBoundary
// deliberately rethrows anything that is not a chunk-load failure, so the whole
// React tree unmounted and she got a white page. It had been live since
// 2026-07-24, and 39 of 183 family accounts were hitting it.
//
// WHY NOTHING CAUGHT IT. There is no ESLint in this repo, so `no-undef` has
// never run. Vite does not resolve free identifiers either — a bare name is
// assumed to be a runtime global and is emitted untouched, so the build, the
// bundle and `npm test` were all green while the page was dead.
//
// The bug is invisible in review because the broken line LOOKS defensive: the
// `?.` and the `||` fallback both read as care. And it is invisible in testing
// because it needs data — the notification feed only renders for a family who
// has been sent an automation email, so four out of five accounts looked fine.
//
// It is not a one-off. On its first run this check also found `setDraft` in
// LocationsList's EditCard — same shape, an onClick handler calling a setter the
// component never received, live on prod since 2026-06-06.
//
// WHAT IT CHECKS. Every .js/.jsx file under src/ is parsed with @babel/parser
// and Babel's own scope tracker reports the Program scope's `globals` — exactly
// the set of identifiers referenced but never bound. Anything in that set which
// is not a real runtime global is a bug. The list is derived from the AST, never
// retyped, so it cannot drift from the code.
//
// WHAT IT DOES NOT CHECK. It cannot tell a typo from a legitimate new browser
// API. If you add one, add it to RUNTIME_GLOBALS with a reason — that shows up
// in the diff as a decision somebody made rather than a default nobody noticed.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

// @babel/traverse is CommonJS. Under ESM its default export lands on `.default`
// in some Node/npm layouts and not others; accept both rather than depend on
// which one today's install produced.
const traverse = _traverse.default ?? _traverse;

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// Names the browser or the JS language provides at runtime. A name here is a
// promise that it exists in every environment this code runs in.
const RUNTIME_GLOBALS = new Set([
  // Language built-ins
  'Array', 'Boolean', 'Date', 'Error', 'Infinity', 'Intl', 'JSON', 'Map', 'Math',
  'NaN', 'Number', 'Object', 'Promise', 'RegExp', 'Set', 'String', 'Symbol',
  'WeakMap', 'WeakSet', 'BigInt', 'Proxy', 'Reflect', 'undefined', 'globalThis',
  'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'arguments',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Uint32Array', 'Float32Array',
  'Float64Array', 'ArrayBuffer', 'DataView',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'structuredClone', 'queueMicrotask',
  // DOM / BOM
  'window', 'document', 'navigator', 'location', 'history', 'screen',
  'localStorage', 'sessionStorage', 'console', 'alert', 'confirm', 'prompt',
  'fetch', 'Headers', 'Request', 'Response', 'AbortController', 'AbortSignal',
  'URL', 'URLSearchParams', 'FormData', 'Blob', 'File', 'FileReader',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
  'ResizeObserver', 'IntersectionObserver', 'MutationObserver',
  'Image', 'Audio', 'Event', 'CustomEvent', 'EventTarget', 'DOMParser',
  'XMLHttpRequest', 'WebSocket', 'MessageChannel', 'BroadcastChannel',
  'crypto', 'performance', 'atob', 'btoa', 'matchMedia', 'getComputedStyle',
  'createImageBitmap', 'OffscreenCanvas', 'CSS', 'Notification',
  'TextEncoder', 'TextDecoder', 'caches', 'indexedDB',
  'HTMLElement', 'Element', 'Node', 'NodeList', 'DocumentFragment',
  // Node — reached only by the .test.mjs files and build-time scripts in src/
  'process', 'Buffer', '__dirname', '__filename', 'require', 'module', 'exports',
]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(jsx|js)$/.test(name)) out.push(full);
  }
  return out;
}

// Exported so a caller can point this at one file. The test below runs it over
// all of src/; freeIdentifiersIn is also what makes the check itself testable.
export function freeIdentifiersIn(code, label = '<inline>') {
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx'] });
  const found = new Set();
  traverse(ast, {
    Program(path) {
      for (const name of Object.keys(path.scope.globals)) {
        if (!RUNTIME_GLOBALS.has(name)) found.add(name);
      }
    },
  });
  return { label, names: [...found].sort() };
}

let pass = 0;
let fail = 0;
function check(desc, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS  ${desc}`); }
  else { fail++; console.error(`FAIL  ${desc}${detail ? `\n      ${detail}` : ''}`); }
}

// --- The check itself must be able to fail. ------------------------------
// A scanner that returns "nothing found" because it is silently broken looks
// exactly like a clean tree. These two cases are the difference, and they are
// the real bugs this was written for, reduced to their smallest form.
const ORG_BUG = `
  import React from 'react';
  function Parent({ org }) { return <Child />; }
  function Child() { return <p>From {org?.name || 'x'}</p>; }
`;
check(
  'catches the TodayTab bug (a sibling component reading `org`)',
  freeIdentifiersIn(ORG_BUG).names.includes('org'),
  `got: ${JSON.stringify(freeIdentifiersIn(ORG_BUG).names)}`,
);

const SETTER_BUG = `
  import React, { useState } from 'react';
  function Parent() { const [d, setD] = useState(null); return <Card d={d} />; }
  function Card({ d }) { return <button onClick={() => setD(1)}>go</button>; }
`;
check(
  'catches the EditCard bug (a child calling a setter it never received)',
  freeIdentifiersIn(SETTER_BUG).names.includes('setD'),
  `got: ${JSON.stringify(freeIdentifiersIn(SETTER_BUG).names)}`,
);

check(
  'does not flag real runtime globals',
  freeIdentifiersIn(`const a = window.location; console.log(JSON.stringify(a), Date.now());`).names.length === 0,
);

check(
  'does not flag imports, props, or hoisted declarations',
  freeIdentifiersIn(`
    import { useState } from 'react';
    export default function A({ b }) { const [c] = useState(); return d(b, c); }
    function d(x, y) { return x + y; }
  `).names.length === 0,
);

// --- The tree ------------------------------------------------------------
const offenders = [];
let parsed = 0;
for (const file of walk(SRC)) {
  const rel = relative(SRC, file).replace(/\\/g, '/');
  let result;
  try {
    result = freeIdentifiersIn(readFileSync(file, 'utf8'), rel);
  } catch (err) {
    // A parse failure is a real failure, not a skip: it means this file was
    // NOT checked, and a silent skip is how a scanner starts lying.
    offenders.push(`${rel}: could not parse - ${err.message}`);
    continue;
  }
  parsed++;
  if (result.names.length > 0) offenders.push(`${rel}: ${result.names.join(', ')}`);
}

check(
  `scanner actually read the tree (parsed ${parsed} files)`,
  parsed > 100,
  `only parsed ${parsed} files - the walk is probably pointed at the wrong directory`,
);

check(
  'no file under src/ references an undefined name',
  offenders.length === 0,
  offenders.length
    ? `${offenders.length} file(s):\n      ${offenders.join('\n      ')}\n\n`
      + '      Each name above is referenced but never defined in that file. It will throw\n'
      + '      ReferenceError the moment that line runs. Usually a value that belongs to a\n'
      + '      PARENT component and needs passing down as a prop. If it is genuinely a\n'
      + '      runtime global, add it to RUNTIME_GLOBALS with a reason.'
    : '',
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
