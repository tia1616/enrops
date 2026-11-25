// The partner sign-in / invite email's words (Jessica 2026-11-25: "invites
// with a personal note"), pure so they can be tested without starting the
// function's server. NO EM DASHES.

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * What the portal holds, in plain words. `orgName` and `forWhom` arrive
 * ALREADY ESCAPED (the caller builds them for HTML).
 */
export function partnerPortalWhat(orgName: string, forWhom: string, severalProviders: boolean): string {
  return severalProviders
    ? `The providers you work with share their work at your sites with you${forWhom}: each class with its enrollment and roster, a summary when a class finishes, flyers and graphics to share, and their safety record (insurance, agreements and instructor checks).`
    : `${orgName} shares its work at your sites with you${forWhom}: each class with its enrollment and roster, a summary when a class finishes, flyers and graphics to share, and its safety record (insurance, agreements and instructor checks).`;
}

/** The provider's note: escaped, line breaks kept. Empty note, nothing. */
export function partnerNoteBlock(note: string, orgName: string, accent: string): string {
  if (!note) return '';
  return `<div style="margin:0 0 22px;padding:14px 16px;background:#faf9ff;border-left:4px solid ${esc(accent)};border-radius:6px;">
      <div style="font-size:12px;font-weight:700;color:#6b6880;margin-bottom:6px;">A note from ${esc(orgName)}</div>
      <div style="font-size:15px;color:#1A1530;line-height:1.6;">${esc(note).replace(/\n/g, '<br>')}</div>
    </div>`;
}

/** The note as sent: only from the provider's own owner/admin, trimmed, capped at 1000. */
export function cleanPartnerNote(raw: unknown, fromProviderAdmin: boolean): string {
  if (!fromProviderAdmin || typeof raw !== 'string') return '';
  return raw.replace(/\r\n?/g, '\n').trim().slice(0, 1000);
}
