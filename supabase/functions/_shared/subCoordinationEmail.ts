// The email sent when a sub ACCEPTS: TO the regular instructor + the sub, CC the
// other instructors on the class + the org's alert inbox.
//
// ONE builder, used by respond-to-sub-offer for the real send and by
// tenant-sender for the Email sender page's preview, so the preview cannot say
// something the real email does not. Pure: no I/O, no env.

export interface SubCoordinationEmailInput {
  regularFirst: string;
  subFirst: string;
  curriculumName: string;
  locationName: string | null;
  friendlyDate: string;
  portalUrl: string;
  /** organizations.sub_coordination_notes, plain text. Blank skips the paragraph. */
  coordinationNotes: string;
  /** From subSignOff(). Plain text. */
  signOff: string;
}

function esc(s: string | null | undefined) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildSubCoordinationEmail(i: SubCoordinationEmailInput): { subject: string; html: string; text: string } {
  const notes = (i.coordinationNotes || '').trim();
  const className = i.curriculumName || 'this class';
  const where = i.locationName ? ` at ${i.locationName}` : '';

  const subject = `Coordinating ${i.friendlyDate.replace(/^[A-Za-z]+, /, '')} — ${i.curriculumName || 'sub day'}${where}`;

  // Escape first, then turn the admin's line breaks into <br>: the note is typed
  // in a multi-line box and would otherwise collapse into one line.
  const notesHtml = notes
    ? `<p style="font-size:15px;line-height:1.55;margin:0 0 14px;">${esc(notes).replace(/\r?\n/g, '<br>')}</p>`
    : '';

  const html = `<!doctype html>
<html><body style="margin:0;background:#FBFBFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;">Hi ${esc(i.regularFirst)} and ${esc(i.subFirst)},</p>
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;"><strong>${esc(i.subFirst)}</strong> is covering <strong>${esc(i.regularFirst)}</strong>'s class for <strong>${esc(className)}</strong>${i.locationName ? ` at <strong>${esc(i.locationName)}</strong>` : ''} on <strong>${esc(i.friendlyDate)}</strong>.</p>
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;">You are both copied on this email so you can communicate. You can exchange phone numbers if you'd like.</p>
    ${notesHtml}
    <p style="font-size:14px;line-height:1.55;margin:0 0 18px;color:#6b6b6b;">${esc(i.subFirst)} — the roster and lesson plan are in your portal: <a href="${esc(i.portalUrl)}" style="color:#1C004F;">${esc(i.portalUrl)}</a></p>
    <p style="font-size:14px;line-height:1.55;margin:18px 0 0;">Please let me know if you have any questions.</p>
    <p style="font-size:14px;line-height:1.55;margin:14px 0 0;">— ${esc(i.signOff)}</p>
  </div>
</body></html>`;

  const text = [
    `Hi ${i.regularFirst} and ${i.subFirst},`,
    ``,
    `${i.subFirst} is covering ${i.regularFirst}'s class for ${className}${where} on ${i.friendlyDate}.`,
    ``,
    `You are both copied on this email so you can communicate. You can exchange phone numbers if you'd like.`,
    ``,
    ...(notes ? [notes, ``] : []),
    `${i.subFirst} — the roster and lesson plan are in your portal: ${i.portalUrl}`,
    ``,
    `Please let me know if you have any questions.`,
    ``,
    `— ${i.signOff}`,
  ].join('\n');

  return { subject, html, text };
}
