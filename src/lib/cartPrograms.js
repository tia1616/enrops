// WHICH PROGRAM ROWS A CART ENTRY ACTUALLY REFERS TO.
//
// This exists because the two screens that read the cart were about to answer that
// question differently. StepReview walked the VIP bundle legs; StepStudent looked
// only at `item.program`. Same rule, two spellings, and the surface that disagreed
// was the LAST one before the card - so a VIP family could see a warning on the
// review screen that had never appeared on the form, or the reverse.
//
// It lives in src/lib rather than beside either screen for a second reason: both
// callers are .jsx, which the repo's test runner cannot import
// (scripts/run-src-tests.mjs runs plain node, no JSX loader). The join was the only
// genuinely new logic in the grade-warning change and it had no test at all.
//
// THE CART SHAPE, from CartContext:
//   child.items = [{ program, isVip, vipBundle?: { fall, winter, spring } }]
// `setActiveChildItem` REPLACES the array, so a child holds one item today. These
// functions still treat it as a list, because that is what the field is and reading
// it as a list costs nothing if it ever becomes one.

// Every program row an item refers to: the program itself, plus the VIP bundle's
// three term legs.
//
// A VIP bundle expands into THREE cart lines, one per term, each a different
// program row. `item.program` is only the Fall one, so anything that reads it alone
// is silently ignoring two thirds of what the family is buying.
//
// Deduped by identity, because the Fall leg and `item.program` are usually the same
// row and a caller counting matches should not see it twice.
export function programsInItem(item) {
  if (!item) return [];
  const out = [];
  const seen = new Set();
  const push = (p) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  push(item.program);
  const b = item.vipBundle;
  if (b) {
    push(b.fall);
    push(b.winter);
    push(b.spring);
  }
  return out;
}

// Every program row across all of a child's items.
export function programsForChild(child) {
  return (Array.isArray(child?.items) ? child.items : []).flatMap(programsInItem);
}

// The one program row behind a given pricing line.
//
// A pricing line carries the program's NAME and schedule but not its audience
// range, and it is deliberately not gaining one: pricing_snapshot is POSTed to
// create-registration, so every field added to a line crosses the wire to the money
// endpoint. A range that only ever gets read to draw a sentence has no business
// there. The cart already holds the whole program row on the client, so join to it.
//
// Returns null when nothing matches - a restored cart whose programs were refetched
// under new rows, say - so callers render nothing rather than guessing at the wrong
// class.
export function programForLine(child, line) {
  if (!line?.program_id) return null;
  return programsForChild(child).find((p) => p?.id === line.program_id) ?? null;
}
