// Waiver and policy text rendering.
//
// Two storage shapes live here, and they are NOT interchangeable:
//
//   waivers        - store the {{org}} TOKEN and substitute at render
//                    (renderWaiverText / splitOnOrgToken / hasOrgToken).
//   org_policies   - store the business name ALREADY substituted, because
//                    seed_default_cancellation_policy() bakes it in at
//                    provisioning time. There is no token left to split on,
//                    so highlighting the name means matching the literal
//                    string (splitOnWholeName).
//
// Reaching for the wrong one is silent: splitOnOrgToken on a policy finds no
// token and returns the whole document as a single segment, so the name simply
// never bolds and nobody notices.
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
  //
  // A FUNCTION, NOT A STRING, and that is the whole point. As a string the
  // replacement is a PATTERN: `$&`, `$'`, "$`" and `$$` are substitution
  // directives, so a business called "Kids & Co. $$$" or anything with a
  // backtick or apostrophe-dollar would silently rewrite the sentence around
  // itself — in a signed waiver and, since 2026-08-13, in an instructor's
  // consent checkbox. The function form is passed through verbatim. Same fix in
  // the server twin, supabase/functions/_shared/waiverText.ts.
  return content.replace(ORG_TOKEN, () => name || 'the program provider');
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

/**
 * Split text on STANDALONE occurrences of the business name, returning the
 * segments between them (length = occurrences + 1, same contract as
 * splitOnOrgToken, so callers can interleave the name identically).
 *
 * For text where the name is already substituted - org_policies content, which
 * seed_default_cancellation_policy() bakes the name into at provisioning. There
 * is no {{org}} token left, so splitOnOrgToken would return one segment and the
 * name would silently never bold.
 *
 * A plain String.split(name) bolds any substring hit, so an operator called
 * "Play" would see the fragment lit up inside "Playgrounds" - a rendering glitch
 * on the one screen whose job is to make the document feel carefully theirs.
 * Business names are operator-supplied free text, so short ones are a matter of
 * time.
 *
 * Boundaries are checked by inspecting the neighbouring characters rather than
 * with a \b regex: the name is untrusted text that would have to be escaped, and
 * \b is defined against word characters, so it behaves wrongly for a name that
 * begins or ends with punctuation ("Mrs. Richelle", "Acme Inc."). Matching is
 * case-sensitive on purpose - the stored policy carries the name exactly as
 * substituted, and loosening it would bold unrelated words.
 */
export function splitOnWholeName(text, name) {
  if (!text || !name) return [text ?? ''];
  const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9]/.test(ch);
  const parts = [];
  let segmentStart = 0; // start of the plain text run being accumulated
  let searchFrom = 0;   // independent cursor, so a rejected hit still advances
  for (;;) {
    const at = text.indexOf(name, searchFrom);
    if (at === -1) break;
    const standalone =
      !isWordChar(text[at - 1]) && !isWordChar(text[at + name.length]);
    if (standalone) {
      parts.push(text.slice(segmentStart, at));
      segmentStart = at + name.length;
    }
    searchFrom = at + name.length;
  }
  parts.push(text.slice(segmentStart));
  return parts;
}
