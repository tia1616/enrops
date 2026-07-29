// Waiver text rendering.
//
// A waiver's stored content keeps {{org}} where the business name belongs, and
// the name is substituted when the text is shown or signed. Storing the name
// instead - which is what seeding used to do - freezes it: an operator who
// rebrands, fixes a typo in their business name, or switches from a trading name
// to a legal one is left with families signing an agreement naming a business
// that no longer exists.
//
// Substituting at render is safe because a signature does not depend on the
// stored row. waiver_signatures.waiver_text_snapshot records the exact words the
// family agreed to at the moment they agreed, so changing the template later
// never rewrites history - it only changes what the NEXT family reads.
//
// Every caller must pass the organisation's own name. There is no global here on
// purpose: this file has no idea which tenant it is being used for, and a
// default would be the kind of thing that quietly puts one provider's name on
// another provider's contract.

const ORG_TOKEN = /\{\{\s*org\s*\}\}/g;

/**
 * Render stored waiver content for display or for signing.
 * Content with no token is returned untouched, so this is a no-op for every
 * waiver written before tokens existed.
 */
export function renderWaiverText(content, orgName) {
  if (!content) return '';
  const name = typeof orgName === 'string' ? orgName.trim() : '';
  // No name should not be possible at any real call site, but a legal document
  // must never show "{{org}}" to a parent, so fall back to wording that is at
  // least true rather than to a placeholder or to some other tenant's name.
  return content.replace(ORG_TOKEN, name || 'the program provider');
}

/**
 * Split stored content on the {{org}} token, returning the plain segments
 * BETWEEN the occurrences. A caller that wants to draw the business name
 * differently - bold, highlighted - interleaves its own element between them.
 *
 * Returned as data, not as elements, deliberately: this module is also imported
 * by the signing path, and the one thing that must never happen is markup
 * leaking into waiver_text_snapshot. renderWaiverText above stays the only
 * function the snapshot uses, and it still returns a plain string.
 *
 * segments.length is always occurrences + 1, so the name goes between every
 * adjacent pair.
 */
export function splitOnOrgToken(content) {
  if (!content) return [''];
  return String(content).split(ORG_TOKEN);
}

/**
 * True if this content still carries a token - used to explain the editor.
 *
 * Deliberately NOT the module-level /g regex: `test` on a global regex advances
 * and remembers lastIndex, so repeated calls with the same string alternate
 * true/false. The waiver editor calls this on every render, i.e. every
 * keystroke, so sharing the global one made the "leave {{org}} alone" note blink
 * in and out - an unreliable note being exactly what makes someone type over the
 * token it is warning them about. `replace` above is unaffected; it resets
 * lastIndex per spec.
 */
export function hasOrgToken(content) {
  return typeof content === 'string' && /\{\{\s*org\s*\}\}/.test(content);
}
