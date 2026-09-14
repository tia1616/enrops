// READING A GRADE OFF A SPREADSHEET. One rule, one place.
//
// This existed twice - identically, and identically wrong - in
// admin-import-program-roster and admin-import-camp-roster. Both stripped every
// non-digit and ran parseInt, which turns "K" into an empty string and then into
// NaN, so the function returned null and the child imported WITH NO GRADE.
//
// That is not an edge case, it is the common case. A primary school's roster
// column says K, not 0, and the add-a-student box in Rosters.jsx literally
// placeholders "K, 1, 2…" - so the product asked for the one spelling it then
// discarded. Consistent with prod: the three French International children
// imported on 2026-09-14 with no grade are all 5 years old, which is
// Kindergarten. Found while fixing the blank grades it produces.
//
// THE VOCABULARY IS lib/grades.js's: 0 is Kindergarten, negative is Pre-K. Edge
// functions cannot import from src/ (Deno, not Vite), so this is the Deno-side
// twin of that convention rather than a fifth independent spelling of it. If the
// two ever need to diverge, they do not - fix both.
//
// Returns null for anything it cannot read, because the caller's column is
// optional and a wrong grade is worse than an absent one.
export function parseGrade(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;

  // Words FIRST. The digit strip below is what destroyed them.
  // Separators removed so "Pre-K", "pre k" and "PRE_K" all land together.
  const word = String(v).trim().toLowerCase().replace(/[\s._-]/g, '');
  // "prek" is tested before "k" - the k-test would otherwise never see it,
  // and a pre-schooler would import as a kindergartener.
  if (['prek', 'pk', 'prekindergarten', 'preschool'].includes(word)) return -1;
  if (['k', 'kinder', 'kindergarten', 'kg'].includes(word)) return 0;

  // Then the numeric spellings, including "1st" / "Grade 3" / " 4 ".
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  if (Number.isNaN(n)) return null;
  if (n < -1 || n > 16) return null; // sanity bounds (K=0, pre-K=-1)
  return n;
}
