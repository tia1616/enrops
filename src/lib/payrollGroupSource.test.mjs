// src/lib/payrollGroupSource.test.mjs
//
// THE INVARIANT: nothing on the payroll screen may read a FIRST-ROW property of a
// pay group as if it described the whole group.
//
// WHY THIS EXISTS. Payroll.jsx groups pay rows by
// `${effective_instructor_id}|${kind}:${targetId}` — and that key does NOT include
// `source`. So when one person is both the regular teacher and the sub for the same
// program, their rows land in ONE group carrying both kinds of day. The group object
// is built from whichever row arrived first (the query orders by session_date DESC),
// which means `g.source` and `g.originalInstructor` describe the most recent session,
// not the group.
//
// This exact bug class has now been found THREE times in the same file:
//
//   2026-08-17  /code-review: `g.source === 'regular'` gated the distance bonus at
//               three display sites, so a mixed week dropped the bonus out of the
//               displayed total while the server still paid it (under-stated — money)
//   2026-08-17  /code-review: after that was fixed, `g.source === 'sub'` was STILL
//               deciding the header "Sub" badge and the "Subbing for X" line. A week
//               of mostly regular days read "Sub" if the latest session was a sub
//               day, and the badge silently vanished when a later regular day arrived
//   2026-08-17  my own fix for the above read `r.originalInstructor` on the ROWS —
//               but rows carry `original_instructor_id` and the name map lives in the
//               loader scope, so "Subbing for X" would have disappeared FOREVER.
//               Caught by re-reading the diff, not by any test
//
// Every one of them built clean, type-checked and passed the suite. None was visible
// in the change that caused it. That is what a source-level guard is for.
//
// WHAT IT CHECKS. Comments and string literals are stripped FIRST, because this file
// deliberately discusses `g.source` in prose and a naive grep would match its own
// explanation — the recurring "grep that lies" mistake. Then:
//
//   1. no `g.source` read survives in executable code
//   2. no `g.originalInstructor` read survives in executable code
//   3. the replacements are still DERIVED FROM THE ROWS (a `.filter` over g.rows on
//      r.source), so reverting to the group property fails here rather than shipping
//   4. `subbedForOne` still requires the sub days to agree on ONE person
//
// WHAT IT DOES NOT CHECK. It cannot tell you that a NEW group-level property is
// first-row-derived — that needs a human reading the groupMap loop. It also cannot
// prove the badge renders; that was verified in the authed UI on staging.
//
// If the grouping key ever gains `source`, groups stop mixing by construction, this
// whole class dies, and this file should be deleted rather than worked around.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const PAYROLL = join(here, '..', 'pages', 'admin', 'Payroll.jsx');
const src = readFileSync(PAYROLL, 'utf8');

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};

// Strip block comments, line comments and string/template literals. Order matters:
// comments first, because a comment can contain an apostrophe that would otherwise
// open a bogus string and swallow the rest of the file.
function executableOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* ... */  and JSX {/* ... */} bodies
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')  // // ...   (the [^:] keeps http:// intact)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

const code = executableOnly(src);

// Sanity-check the stripper itself, or every assertion below is vacuously true.
// These two must survive stripping (they are real code), and the prose must not.
ok(/const\s+hasSubDay\s*=/.test(code),
  'stripper keeps executable code (hasSubDay declaration still visible)');
ok(!/recurring .grep that lies. mistake/.test(code),
  'stripper removes comment prose');

// 1 + 2 — the two first-row properties must not be READ anywhere in code.
// `source:` and `originalInstructor:` as object KEYS in the groupMap literal are
// fine and expected; it is the `g.`-qualified reads that are the bug.
const sourceReads = [...code.matchAll(/\bg\.source\b/g)];
ok(sourceReads.length === 0,
  'no g.source read in executable code',
  sourceReads.length ? `found ${sourceReads.length}. Derive it from g.rows instead - see the decorate pass.` : '');

const origReads = [...code.matchAll(/\bg\.originalInstructor\b/g)];
ok(origReads.length === 0,
  'no g.originalInstructor read in executable code',
  origReads.length ? `found ${origReads.length}. Resolve per-row in the decorate pass, where instById is in scope.` : '');

// Same check for the destructured alias, in case someone writes `const { source } = g`.
ok(!/const\s*\{[^}]*\bsource\b[^}]*\}\s*=\s*g\b/.test(code),
  'g.source is not destructured out of the group either');

// 3 — the replacement must still be derived FROM THE ROWS. If someone "simplifies"
// hasSubDay back to the group property, 1 and 2 catch it; this catches the subtler
// case of keeping the name while changing what feeds it.
ok(/g\.rows\.filter\(\s*\(\s*r\s*\)\s*=>\s*r\.source\s*===/.test(code),
  'hasSubDay/subRows are derived from g.rows on r.source');

ok(/\bhasSubDay\b/.test(code) && /\bsubbedForOne\b/.test(code),
  'both row-derived replacements are still present');

// The badge must render off the derived value, not a re-introduced group property.
// ANCHORED ON THE ASSIGNMENT, not on `g.hasSubDay` appearing somewhere in the file:
// the first version of this line just looked for the identifier, and it stayed green
// during the mutation check while the badge itself had been switched back to
// `g.source` — because the "Subbing for" line below also reads g.hasSubDay. An
// assertion has to name the thing it actually checks.
// This one pins STRUCTURE, not correctness: re-deriving `g.rows.some(...)` inline in
// the component would also be right, and this assertion would still fail it. That is
// deliberate — keeping the derivation in the decorate pass is what stops a second
// copy appearing, which is how the three incidents above started. If you genuinely
// want it inline, change this line and say why in the diff.
ok(/sourceBadge\s*=\s*g\.hasSubDay\b/.test(code),
  'the Sub badge itself is assigned from g.hasSubDay');

// 4 — a name may only be shown when every sub day agrees on one person. The
// uniqueness test is the whole point: without it we are back to naming whichever
// teacher the first row happened to mention.
ok(/origIds\.length\s*===\s*1/.test(code),
  'subbedForOne requires exactly one distinct original instructor');

// The distance bonus - the money half of the same class, fixed first. Kept here so
// the two halves cannot drift apart again.
ok(/g\.rows\.find\(\s*\(\s*r\s*\)\s*=>\s*r\.source\s*===/.test(code),
  'the distance bonus still samples a REGULAR row from g.rows, not g.source');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
