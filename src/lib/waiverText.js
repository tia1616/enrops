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

/** True if this content still carries a token - used to explain the editor. */
export function hasOrgToken(content) {
  return typeof content === 'string' && ORG_TOKEN.test(content);
}
