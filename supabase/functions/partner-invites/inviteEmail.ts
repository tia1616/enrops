// The invitation email (spec v3 H4, words exactly where the spec gives them),
// kept pure so it can be tested. Sent "{Host name} via enrops" from enrops's
// verified address, replies to the inviting host admin.

import { esc } from "../_shared/escapeHtml.ts";

export interface InviteForEmail {
  host_name: string;
  inviter_name: string | null;
  business_name_as_typed: string;
  message: string | null;
}

export type InviteKind = "invite" | "reminder";

export function inviteSubject(inv: InviteForEmail, kind: InviteKind): string {
  const s = `${inv.host_name} invites you to share your safety record`;
  return kind === "reminder" ? `Reminder: ${s}` : s;
}

/** Spec v3 H4 "Body opening", verbatim with the host's name. */
export function inviteOpening(host: string): string {
  return `${host} uses enrops to see the status of every outside provider's insurance, agreements and screening in one place. ` +
    `You keep your own record; ${host} sees only the status you choose to share, never a background report. ` +
    `It works with whatever registration system you already use.`;
}

export function renderInvite(
  brand: { logo_url: string | null; primary_color: string; page_bg_color: string },
  inv: InviteForEmail,
  link: string,
  kind: InviteKind,
): { subject: string; html: string; text: string } {
  const subject = inviteSubject(inv, kind);
  const opening = inviteOpening(inv.host_name);
  const from = (inv.inviter_name || "").trim();
  const note = (inv.message || "").trim();
  const logo = brand.logo_url ? `<img src="${esc(brand.logo_url)}" alt="enrops" style="max-height:40px;display:block;margin:0 auto 20px;" />` : "";
  const html = `<!doctype html><html><body style="margin:0;background:${esc(brand.page_bg_color)};padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;">
    ${logo}
    <h1 style="font-size:20px;color:${esc(brand.primary_color)};margin:0 0 12px;">${esc(subject)}</h1>
    <p style="font-size:15px;color:#1a1a1a;line-height:1.5;margin:0 0 16px;">${esc(opening)}</p>
    ${note ? `<p style="font-size:15px;color:#1a1a1a;line-height:1.5;margin:0 0 16px;padding:12px;background:#f6f5fb;border-radius:8px;">${esc(note)}${from ? `<br><span style="color:#6b6b6b;">${esc(from)}</span>` : ""}</p>` : ""}
    <a href="${esc(link)}" style="display:inline-block;background:${esc(brand.primary_color)};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:15px;font-weight:600;">See the invitation</a>
    <p style="font-size:13px;color:#6b6b6b;line-height:1.5;margin:20px 0 0;">Reply to this email to reach ${esc(from || inv.host_name)}.</p>
  </div></body></html>`;
  const text = `${subject}\n\n${opening}\n\n` + (note ? `${note}${from ? `\n${from}` : ""}\n\n` : "") +
    `See the invitation: ${link}\n\nReply to this email to reach ${from || inv.host_name}.\n`;
  return { subject, html, text };
}

/** Which reminder (if any) is due for a sent invitation, by days since sending. */
export function reminderDue(sentAt: string, r1: string | null, r2: string | null, now: Date): 1 | 2 | null {
  const days = (now.getTime() - new Date(sentAt).getTime()) / 86_400_000;
  if (days >= 7 && !r2) return 2;
  if (days >= 3 && !r1 && days < 7) return 1;
  return null;
}

/** One address per line or comma; trimmed, lowercased, de-duplicated; null = something isn't an email. */
export function parseEmails(raw: string): string[] | null {
  const list = [...new Set(String(raw || "").split(/[\n,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (list.length === 0 || list.length > 20) return null;
  return list.every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) ? list : null;
}
