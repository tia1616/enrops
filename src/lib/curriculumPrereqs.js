// Parent-facing prerequisite line for a class.
//
// ONE place. The text is typed once, on the curriculum (Curriculum Review ->
// Prerequisites), and every family-facing surface reads it from here: the
// catalog card, and the cart line on the last screen before payment. It was
// being collected for months with a database comment promising it "appears on
// registration page" - and nothing read it, so a Level 2 class looked identical
// to its Level 1 and a parent could not tell Level 1 was not required.
//
// curricula is publicly readable (public_read_curricula), so the anon key works
// and no view is needed. Reads by organization_id, not .in(ids): a long uuid
// list dies past ~100 keys on the PostgREST URL.

// Pure: trims, and treats blank/whitespace as "no prerequisite" so the line
// never renders an empty "Prerequisites:" label.
export function cleanPrereq(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t : null;
}

// rows: [{ id, prerequisites }] -> Map<curriculum_id, text>
export function buildPrereqMap(rows) {
  const m = new Map();
  (rows || []).forEach((r) => {
    const t = cleanPrereq(r?.prerequisites);
    if (r?.id && t) m.set(r.id, t);
  });
  return m;
}

// Returns the same program rows with `prerequisites` set (null when none).
// A program with no curriculum_id, or a curriculum with no text, gets null.
export function withPrerequisites(programs, prereqMap) {
  return (programs || []).map((p) => ({
    ...p,
    prerequisites: (p?.curriculum_id && prereqMap?.get(p.curriculum_id)) || null,
  }));
}

// A year bundle lists Fall, Winter and Spring together. Say each prerequisite
// ONCE: a leg whose text was already shown for an earlier leg gets null. ONE
// rule for the catalog card and the review screen, so they cannot disagree.
// texts: [fall, winter, spring] (any may be null) -> same length, repeats nulled.
export function prereqsOncePerBundle(texts) {
  const seen = new Set();
  return (texts || []).map((t) => {
    const c = cleanPrereq(t);
    if (!c || seen.has(c)) return null;
    seen.add(c);
    return c;
  });
}

// Soft-fails: a read error returns an empty map and the page renders as it did
// before. The line is a courtesy to the family, never a gate on checkout.
export async function fetchPrereqMap(supabase, orgId) {
  try {
    const { data, error } = await supabase
      .from('curricula')
      .select('id, prerequisites')
      .eq('organization_id', orgId)
      .not('prerequisites', 'is', null);
    if (error) {
      console.warn('[registration] prerequisites unavailable; cards render without them. Cause: %o', error);
      return new Map();
    }
    return buildPrereqMap(data);
  } catch (e) {
    console.warn('[registration] prerequisites unavailable: %o', e);
    return new Map();
  }
}
