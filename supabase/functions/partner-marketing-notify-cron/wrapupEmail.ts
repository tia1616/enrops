// The words of the "class finished" email (20261125w), pure so they can be
// tested. What each person may see is decided in the database
// (partner_class_wrapups_due reads AS that login), so this file only says it.
// NO EM DASHES.
//
//   to a partner login: "Super Mario Game Makers has finished: the summary is ready"
//   the provider's copy: "Copy: Happy Valley Parks and Rec got the end-of-class summary"

import { esc } from "../_shared/escapeHtml.ts";

export interface WrapupRow {
  access_id: string;
  organization_id: string;
  provider_name: string;
  partner_id: string;
  partner_name: string;
  to_email: string;
  to_name: string | null;
  class_kind: "class" | "camp";
  class_id: string;
  title: string | null;
  site: string | null;
  first_date: string | null;
  last_date: string | null;
  count_source: "enrops" | "provider" | "partner";
  enrolled: number | null;
  summary: {
    sessions?: { date: string; status: string }[];
    money?: { children: number; paid_cents: number } | null;
  } | null;
}

type Brand = { org_name: string; logo_url: string | null; primary_color: string; page_bg_color: string };

/** "Sep 15" from YYYY-MM-DD, no timezone shift. */
export function monthDay(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "8 of 8 sessions held", "7 of 8 sessions held, 1 not confirmed yet, 1 cancelled". */
export function sessionsLine(sessions: { status: string }[] | undefined): string {
  const list = sessions ?? [];
  if (!list.length) return "No session dates on file";
  const n = (s: string) => list.filter((x) => x.status === s).length;
  const scheduled = list.length - n("cancelled");
  const parts = [`${n("held")} of ${scheduled} ${scheduled === 1 ? "session" : "sessions"} held`];
  if (n("not_confirmed")) parts.push(`${n("not_confirmed")} not confirmed yet`);
  if (n("cancelled")) parts.push(`${n("cancelled")} cancelled`);
  return parts.join(", ");
}

export function dollars(cents: number): string {
  return (Number(cents || 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** The lines under one class's name, each a true sentence for what this login sees. */
export function classLines(r: WrapupRow): string[] {
  const dates = r.first_date && r.last_date && r.first_date !== r.last_date
    ? `${monthDay(r.first_date)} to ${monthDay(r.last_date)}`
    : monthDay(r.last_date ?? r.first_date);
  const lines = [[dates, sessionsLine(r.summary?.sessions)].filter(Boolean).join(" · ")];
  const enrolled = Number(r.enrolled);
  if (r.count_source !== "partner" && Number.isInteger(enrolled) && r.enrolled != null) {
    lines.push(`${enrolled} ${enrolled === 1 ? "child" : "children"} on the roster`);
  }
  const money = r.summary?.money;
  if (money) {
    const paid = Number(money.children || 0);
    lines.push(paid === 0
      ? "No payments from families."
      : `Families paid ${dollars(money.paid_cents)}, after discounts and refunds (${paid} ${paid === 1 ? "child" : "children"} paid).`);
  }
  return lines;
}

function page(brand: Brand, heading: string, intro: string, rows: WrapupRow[], foot: string, button: string, link: string): string {
  const logo = brand.logo_url
    ? `<img src="${esc(brand.logo_url)}" alt="${esc(brand.org_name)}" style="max-height:48px;display:block;margin:0 auto 20px;" />`
    : "";
  const blocks = rows.map((r) =>
    `<div style="padding:10px 0;border-bottom:1px solid #eee;">` +
    `<div style="font-size:15px;font-weight:600;color:#1a1a1a;">${esc(r.title || "A class")}${r.site ? ` <span style="font-weight:400;color:#6b6b6b;">at ${esc(r.site)}</span>` : ""}</div>` +
    classLines(r).map((l) => `<div style="font-size:14px;color:#1a1a1a;line-height:1.5;">${esc(l)}</div>`).join("") +
    `</div>`).join("");
  return `<!doctype html><html><body style="margin:0;background:${esc(brand.page_bg_color)};padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;">
    ${logo}
    <h1 style="font-size:20px;color:${esc(brand.primary_color)};margin:0 0 10px;">${esc(heading)}</h1>
    <p style="font-size:15px;color:#1a1a1a;line-height:1.5;margin:0 0 6px;">${esc(intro)}</p>
    ${blocks}
    <a href="${esc(link)}" style="display:inline-block;margin-top:22px;background:${esc(brand.primary_color)};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:15px;font-weight:600;">${esc(button)}</a>
    <p style="font-size:12px;color:#6b6b6b;line-height:1.5;margin:20px 0 0;">${esc(foot)}</p>
  </div></body></html>`;
}

function text(heading: string, intro: string, rows: WrapupRow[], foot: string, button: string, link: string): string {
  return [heading, "", intro, "",
    ...rows.flatMap((r) => [`${r.title || "A class"}${r.site ? ` at ${r.site}` : ""}`, ...classLines(r).map((l) => `  ${l}`), ""]),
    `${button}: ${link}`, "", foot, ""].join("\n");
}

const PARTNER_FOOT = "Each class stays in your portal for 60 days after it ends, with its roster, session dates and a download for your records.";

/** To one partner login: the classes at its sites that just finished. */
export function renderWrapup(brand: Brand, rows: WrapupRow[], siteUrl: string) {
  const provider = rows[0].provider_name || "Your provider";
  const subject = rows.length === 1
    ? `${rows[0].title || "A class"} has finished: the summary is ready`
    : `${rows.length} classes have finished: the summaries are ready`;
  const intro = rows.length === 1
    ? `${provider} finished a class at your site. Here is how it went:`
    : `${provider} finished ${rows.length} classes at your sites. Here is how they went:`;
  const link = `${siteUrl}/partner/${rows[0].partner_id}#classes`;
  return {
    subject,
    html: page(brand, subject, intro, rows, PARTNER_FOOT, "See the summary", link),
    text: text(subject, intro, rows, PARTNER_FOOT, "See the summary", link),
  };
}

/** "Kacy Cullen and Stephani Hern", "A, B and C". */
export function namesList(names: string[]): string {
  const n = [...new Set(names.map((x) => x.trim()).filter(Boolean))];
  if (n.length <= 1) return n[0] ?? "their portal logins";
  return `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

/** The provider's copy: who at the partner was told, and what they saw. */
export function renderWrapupCopy(brand: Brand, rows: WrapupRow[], toldNames: string[], siteUrl: string) {
  const partner = rows[0].partner_name || "Your partner";
  const subject = rows.length === 1
    ? `Copy: ${partner} got the summary for ${rows[0].title || "a class"}`
    : `Copy: ${partner} got the summaries for ${rows.length} classes`;
  const intro = `enrops emailed ${namesList(toldNames)} at ${partner} this end-of-class summary, two days after the last session. Here is what they saw:`;
  const foot = "Partners get this for every class that finishes at their sites. They see what families paid only if you turned that on for them, on the partner's Classes tab.";
  const link = `${siteUrl}/admin/partner-documents/${rows[0].partner_id}#classes`;
  return {
    subject,
    html: page(brand, subject, intro, rows, foot, "Open their Classes tab", link),
    text: text(subject, intro, rows, foot, "Open their Classes tab", link),
  };
}
