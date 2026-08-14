// src/lib/jsxTextComments.js
//
// Detects a {/* comment */} sitting inside a run of JSX prose, which deletes the
// space around it at compile time. See jsxTextComments.test.mjs for the incident
// this exists for (ClassSchedule.jsx:175, "Upload yourschedule", 2026-08-13).
//
// A pure function on a source string so the test can assert its RETURN VALUE
// rather than grep the repo and hope.

// Prose on the left: a letter, digit, or the punctuation that ends a clause.
// Explicitly NOT > } { ( [ = , ; : which mean the neighbour is markup or code —
// and NOT `)` either, because `catch (_e) { /* ignore */ }` is by far the most
// common {/* */} in this repo and a check that flags 19 of those on its first
// run is a check somebody deletes.
const PROSE_LEFT = /[A-Za-z0-9.!?'"”’—-]$/;
// Prose on the right: a letter or digit. A tag, brace or quote is not a joinable word.
const PROSE_RIGHT = /^[A-Za-z0-9]/;
// An empty JS block after one of these is a statement, not JSX children.
const JS_BLOCK_KEYWORD = /(^|[^A-Za-z0-9_$])(catch|try|finally|else|do)$/;

/**
 * @param {string} src  JSX source text
 * @returns {{line: number, joined: string}[]}  one entry per offending comment,
 *   `joined` being the two words that will render with no space between them.
 */
export function findJoinedProse(src) {
  const hits = [];
  const re = /\{\s*\/\*[\s\S]*?\*\/\s*\}/g;
  for (const m of src.matchAll(re)) {
    const before = src.slice(0, m.index).replace(/\s+$/, '');
    const after = src.slice(m.index + m[0].length).replace(/^\s+/, '');
    if (!before || !after) continue;
    if (JS_BLOCK_KEYWORD.test(before)) continue;
    if (!PROSE_LEFT.test(before) || !PROSE_RIGHT.test(after)) continue;
    hits.push({
      line: src.slice(0, m.index).split('\n').length,
      joined: `${(before.match(/(\S+)$/) || [])[1] || ''}${(after.match(/^(\S+)/) || [])[1] || ''}`,
    });
  }
  return hits;
}
