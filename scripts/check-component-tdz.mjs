// CATCHES A `const` READ BEFORE ITS OWN DECLARATION IN A COMPONENT BODY.
//
// Why this exists. 2026-09-22, MessageFamiliesModal: a fix round added
//   const audienceLocked = sending || batchPending;
// near the top of the component, while `sending` was declared three hundred
// lines lower, just above the return. Same function scope, so every render
// threw `ReferenceError: Cannot access 'sending' before initialization` and the
// whole admin page fell to the error boundary.
//
// NOTHING IN THE REPO SAW IT. `npm run build` is happy - it is valid
// JavaScript, and a bundler will not reorder it. `npm test` is happy - the
// suite is plain node files with no DOM, so no component is ever mounted. There
// is no ESLint config. It would have reached a human as "the screen is blank".
//
// WHAT IT CHECKS, narrowly, so it does not cry wolf: inside the top-level
// statement list of a function whose name starts with a capital (a component),
// an identifier referenced DIRECTLY in that list - never inside a nested
// function, which runs later and is the normal, correct way to reference a
// later binding - that resolves to a `const`/`let`/`class` declared further
// down the same list. That is the temporal dead zone, and it is always a crash.
//
// Run by `npm test` and CI.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

const traverse = _traverse.default ?? _traverse;
const srcRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

function jsxFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...jsxFiles(full));
    else if (name.endsWith('.jsx')) found.push(full);
  }
  return found;
}

// The declarations a function body makes, in source order, with the statement
// index each one becomes usable at.
function bindingsInBody(body) {
  const declaredAt = new Map();
  body.forEach((stmt, i) => {
    if (stmt.type !== 'VariableDeclaration') return;
    if (stmt.kind === 'var') return;          // var hoists; not a TDZ
    for (const d of stmt.declarations) {
      collectNames(d.id, (name) => {
        if (!declaredAt.has(name)) declaredAt.set(name, i);
      });
    }
  });
  return declaredAt;
}

function collectNames(node, add) {
  if (!node) return;
  if (node.type === 'Identifier') add(node.name);
  else if (node.type === 'ObjectPattern') for (const p of node.properties) collectNames(p.value ?? p.argument, add);
  else if (node.type === 'ArrayPattern') for (const e of node.elements) collectNames(e, add);
  else if (node.type === 'AssignmentPattern') collectNames(node.left, add);
  else if (node.type === 'RestElement') collectNames(node.argument, add);
}

const problems = [];

for (const file of jsxFiles(srcRoot)) {
  const src = readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parse(src, { sourceType: 'module', plugins: ['jsx'] });
  } catch (e) {
    problems.push({ file, line: 0, name: '(parse)', detail: e.message });
    continue;
  }

  traverse(ast, {
    Function(path) {
      const id = path.node.id?.name ?? path.parent?.id?.name ?? '';
      // Components and hooks only - a capital first letter, or `useSomething`.
      if (!/^[A-Z]/.test(id) && !/^use[A-Z]/.test(id)) return;
      const body = path.node.body?.body;
      if (!Array.isArray(body)) return;

      const declaredAt = bindingsInBody(body);
      if (declaredAt.size === 0) return;

      body.forEach((stmt, i) => {
        // A `function foo() {}` statement is a body that runs LATER, when
        // something calls it - by which time every const below is initialised.
        // Referencing them from in there is normal and correct. (Nested arrow
        // and function EXPRESSIONS are skipped by the visitor below; a bare
        // declaration has to be skipped here, because traverse never visits the
        // node it is rooted at.)
        if (stmt.type === 'FunctionDeclaration') return;
        path.get('body.body.' + i).traverse({
          // A nested function's body runs later, so a reference inside one to a
          // binding declared further down is correct and extremely common
          // (every event handler does it). Skip them entirely.
          Function(inner) { inner.skip(); },
          Identifier(ref) {
            const name = ref.node.name;
            const at = declaredAt.get(name);
            if (at === undefined || at <= i) return;
            if (!ref.isReferencedIdentifier()) return;
            // The declaration statement itself contains the binding's own id.
            const binding = ref.scope.getBinding(name);
            if (!binding || binding.scope.block !== path.node) return;
            problems.push({
              file,
              line: ref.node.loc?.start.line ?? 0,
              name,
              detail: `read in ${id} at statement ${i}, declared at statement ${at}`
                + ` (line ${body[at].loc?.start.line ?? '?'})`,
            });
          },
        });
      });
    },
  });
}

if (problems.length) {
  console.error('\nTEMPORAL DEAD ZONE - these crash on every render:\n');
  for (const p of problems) {
    console.error(`  ${p.file.replace(srcRoot, 'src')}:${p.line}  '${p.name}'  ${p.detail}`);
  }
  console.error(`\n${problems.length} problem(s). Move the declaration above its first use.\n`);
  process.exit(1);
}

console.log('component TDZ check: clean');
