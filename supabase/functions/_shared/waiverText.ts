// Waiver text rendering, server side.
//
// Deliberate twin of src/lib/waiverText.js — the browser bundle and the Deno
// runtime can't share a module, and these two MUST agree: the frontend renders
// the text a family reads, and this renders the snapshot stored against their
// signature. If they ever disagree, the record of what was agreed to stops
// matching what was on screen. Keep the substitution rule identical; if you
// change one, change the other.
//
// Why substitute at all: waivers store {{org}} where the business name belongs,
// so renaming a business flows through to future signatures instead of leaving
// families agreeing to a contract that names a company that no longer exists.

const ORG_TOKEN = /\{\{\s*org\s*\}\}/g;

export function renderWaiverText(content: string | null | undefined, orgName: string | null | undefined): string {
  if (!content) return '';
  const name = typeof orgName === 'string' ? orgName.trim() : '';
  // A legal document must never show a raw placeholder to a parent, and must
  // never show some other tenant's name — so the fallback is generic wording.
  return content.replace(ORG_TOKEN, name || 'the program provider');
}
