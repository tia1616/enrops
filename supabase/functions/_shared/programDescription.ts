// What a program's description becomes when its class is matched or changed.
//
// Pure, so it is tested (tests/programDescription.test.ts) and shared by any
// path that moves a program to another class. The rule (Jessica, 2026-11-12:
// "if the class is named wonders of the world, it should have the description"):
//
//  - CHANGING class (the program had one): the new class's description replaces
//    the old one. The old text described the old class - that is the bug this
//    exists to stop (12 prod programs showed another class's blurb). If the new
//    class has no description, the program gets none: no description beats the
//    wrong class's.
//  - FIRST match (no class before): the program's description is the operator's
//    own words, written for this program, so it is kept. Only an empty one is
//    filled from the class.
export function descriptionAfterClassChange(opts: {
  isFirstMatch: boolean;
  current: string | null | undefined;
  target: string | null | undefined;
}): string | null {
  const clean = (v: string | null | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const current = clean(opts.current);
  const target = clean(opts.target);
  if (opts.isFirstMatch) return current ?? target;
  return target;
}
