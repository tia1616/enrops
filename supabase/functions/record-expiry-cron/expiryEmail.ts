// The words of the safety-record expiry email, kept pure so they can be tested.
// What is due, and when, is decided in the database (record_expiry_due,
// 20261102c); this only names each item and lays the email out.

import { esc } from "../_shared/escapeHtml.ts";

export interface DueItem {
  organization_id: string;
  subject_type: "document" | "background_check";
  subject_id: string;
  doc_type: string | null;
  title: string | null;
  partner_name: string | null;
  instructor_name: string | null;
  expires_on: string; // YYYY-MM-DD
  days_left: number;
  tier: number;
}

const DOC_LABEL: Record<string, string> = {
  insurance: "Insurance certificate",
  agreement: "Partner agreement",
  business_license: "Business license",
};

/** "Jan 17, 2027" from YYYY-MM-DD, without a timezone shift. */
export function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

/** "Insurance certificate for Happy Valley Parks and Rec", "Riley Davis's background check". */
export function itemLabel(it: DueItem): string {
  if (it.subject_type === "background_check") {
    const name = (it.instructor_name || "").trim() || "An instructor";
    return `${name}'s background check`;
  }
  const base = DOC_LABEL[it.doc_type ?? ""] ?? ((it.title || "").trim() || "A document");
  return it.partner_name ? `${base} for ${it.partner_name}` : base;
}

/** "expires in 30 days, on Jan 17, 2027" / "expires today" / "expired Jan 17, 2027". */
export function whenText(it: DueItem): string {
  if (it.days_left < 0) return `expired ${formatDay(it.expires_on)}`;
  if (it.days_left === 0) return "expires today";
  if (it.days_left === 1) return "expires tomorrow";
  return `expires in ${it.days_left} days, on ${formatDay(it.expires_on)}`;
}

export function subjectFor(items: DueItem[]): string {
  if (items.length === 1) return `${itemLabel(items[0])} ${whenText(items[0])}`;
  return `${items.length} items on your safety record need renewing`;
}

function actionFor(it: DueItem): string {
  return it.subject_type === "document" ? "Upload the renewed one." : "Start a new check.";
}

/** Where the button goes: Partner portal when any document is due, else Instructors. */
export function linkFor(items: DueItem[], siteUrl: string): { href: string; label: string } {
  return items.some((it) => it.subject_type === "document")
    // Not "Partner portal": that is the admin menu's name for this page, but in
    // an email it reads like the partners' side (Jessica 2026-11-02).
    ? { href: `${siteUrl}/admin/partner-documents`, label: "Update your documents" }
    : { href: `${siteUrl}/admin/instructors`, label: "Open Instructors" };
}

export function renderExpiryEmail(
  brand: { org_name: string; logo_url: string | null; primary_color: string; page_bg_color: string },
  items: DueItem[],
  siteUrl: string,
): { subject: string; html: string; text: string } {
  const subject = subjectFor(items);
  const link = linkFor(items, siteUrl);
  const intro = "Your partners see each item's status on your safety record. Renew these so they stay Current.";
  const rowsHtml = items.map((it) =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;font-size:15px;color:#1a1a1a;">` +
    `<strong>${esc(itemLabel(it))}</strong> ${esc(whenText(it))}<br>` +
    `<span style="color:#6b6b6b;font-size:14px;">${esc(actionFor(it))}</span></td></tr>`
  ).join("");
  const logo = brand.logo_url
    ? `<img src="${esc(brand.logo_url)}" alt="${esc(brand.org_name)}" style="max-height:48px;display:block;margin:0 auto 20px;" />`
    : "";
  const html = `<!doctype html><html><body style="margin:0;background:${esc(brand.page_bg_color)};padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;">
    ${logo}
    <h1 style="font-size:20px;color:${esc(brand.primary_color)};margin:0 0 12px;">${esc(subject)}</h1>
    <p style="font-size:15px;color:#1a1a1a;line-height:1.5;margin:0 0 16px;">${esc(intro)}</p>
    <table style="width:100%;border-collapse:collapse;margin:0 0 20px;">${rowsHtml}</table>
    <a href="${esc(link.href)}" style="display:inline-block;background:${esc(brand.primary_color)};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:15px;font-weight:600;">${esc(link.label)}</a>
  </div></body></html>`;
  const text = `${subject}\n\n${intro}\n\n` +
    items.map((it) => `- ${itemLabel(it)} ${whenText(it)}. ${actionFor(it)}`).join("\n") +
    `\n\n${link.label}: ${link.href}\n`;
  return { subject, html, text };
}
