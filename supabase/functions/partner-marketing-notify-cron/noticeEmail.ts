// The words of the two flyer emails (20261125v), kept pure so they can be
// tested. Who gets what is decided in the database
// (partner_marketing_notices_due). NO EM DASHES.
//
//   ask   -> the provider's owners and admins: "<partner> asked for flyers"
//   media -> the partner's logins: "<provider> added 3 flyers for your classes"

import { esc } from "../_shared/escapeHtml.ts";

export interface NoticeRow {
  kind: "ask" | "media";
  organization_id: string;
  provider_name: string;
  partner_id: string | null;
  partner_name: string | null;
  item_key: "flyer" | "social_graphic";
  media_id: string | null;
  class_title: string | null;
  site: string | null;
  file_types: string[] | null;
  needs_logo: boolean | null;
  needs_accessible: boolean | null;
  note: string | null;
  updated_at: string | null; // ask only: the version read, for the claim
  to_emails: string[];
}

const ITEM = {
  flyer: { one: "flyer", many: "flyers", Label: "Flyer" },
  social_graphic: { one: "social graphic", many: "social graphics", Label: "Social graphic" },
} as const;

const TYPE = { pdf: "PDF", jpg: "JPG", png: "PNG" } as Record<string, string>;

/** "flyers and social graphics" / "flyers" / "a social graphic". */
export function itemsPhrase(keys: string[], count?: number): string {
  const uniq = [...new Set(keys)].filter((k) => k in ITEM) as (keyof typeof ITEM)[];
  uniq.sort((a, b) => (a === "flyer" ? -1 : b === "flyer" ? 1 : 0));
  if (uniq.length === 1) return count === 1 ? `a ${ITEM[uniq[0]].one}` : ITEM[uniq[0]].many;
  return uniq.map((k) => ITEM[k].many).join(" and ");
}

/** "PDF or PNG". */
export function typesText(types: string[] | null): string {
  const t = (types ?? []).map((x) => TYPE[x] ?? x.toUpperCase());
  if (t.length <= 1) return t.join("");
  return `${t.slice(0, -1).join(", ")} or ${t[t.length - 1]}`;
}

/** One line per thing the partner asked for, in plain words. */
export function askLine(r: NoticeRow): string {
  const parts = [`${ITEM[r.item_key].Label} for each class, as ${typesText(r.file_types)}`];
  if (r.needs_logo) parts.push(`with ${r.partner_name ?? "their"} logo on it`);
  if (r.needs_accessible) parts.push("accessible (ADA)");
  return parts.join(", ");
}

/** One line per file added: "Super Mario Game Makers (Happy Valley Library): flyer". */
export function mediaLine(r: NoticeRow): string {
  const where = r.site ? ` (${r.site})` : "";
  return `${r.class_title || "A class"}${where}: ${ITEM[r.item_key].one}`;
}

type Brand = { org_name: string; logo_url: string | null; primary_color: string; page_bg_color: string };

function page(brand: Brand, heading: string, intro: string, lines: string[], extra: string | null, button: string, link: string): string {
  const logo = brand.logo_url
    ? `<img src="${esc(brand.logo_url)}" alt="${esc(brand.org_name)}" style="max-height:48px;display:block;margin:0 auto 20px;" />`
    : "";
  return `<!doctype html><html><body style="margin:0;background:${esc(brand.page_bg_color)};padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;">
    ${logo}
    <h1 style="font-size:20px;color:${esc(brand.primary_color)};margin:0 0 10px;">${esc(heading)}</h1>
    <p style="font-size:15px;color:#1a1a1a;line-height:1.5;margin:0 0 10px;">${esc(intro)}</p>
    <table style="width:100%;border-collapse:collapse;">${lines.map((l) =>
      `<tr><td style="padding:6px 0;border-bottom:1px solid #eee;font-size:15px;color:#1a1a1a;">${esc(l)}</td></tr>`).join("")}</table>
    ${extra ? `<p style="font-size:14px;color:#1a1a1a;line-height:1.5;margin:14px 0 0;">${esc(extra)}</p>` : ""}
    <a href="${esc(link)}" style="display:inline-block;margin-top:22px;background:${esc(brand.primary_color)};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:15px;font-weight:600;">${esc(button)}</a>
  </div></body></html>`;
}

/** To the provider: the partner asked. `rows` = one provider + one partner, kind 'ask'. */
export function renderAsk(brand: Brand, rows: NoticeRow[], siteUrl: string) {
  const partner = rows[0].partner_name || "A partner";
  const what = itemsPhrase(rows.map((r) => r.item_key));
  const subject = `${partner} asked for ${what}`;
  const intro = `${partner} would like ${what} for your classes at their sites. Here is what they asked for:`;
  const lines = rows.map(askLine);
  const notes = rows.filter((r) => (r.note ?? "").trim()).map((r) => `${ITEM[r.item_key].Label} note from ${partner}: "${r.note!.trim()}"`);
  const extra = notes.length ? notes.join(" ") : null;
  const link = `${siteUrl}/admin/partner-documents/${rows[0].partner_id}#classes`;
  const button = "Add them to your classes";
  const html = page(brand, subject, intro, lines, extra, button, link);
  const text = [subject, "", intro, ...lines.map((l) => `- ${l}`), ...(extra ? ["", extra] : []), "", `${button}: ${link}`, ""].join("\n");
  return { subject, html, text };
}

/** To the partner: the provider added files. `rows` = one provider + one partner, kind 'media'. */
export function renderMedia(brand: Brand, rows: NoticeRow[], siteUrl: string) {
  const provider = rows[0].provider_name || "Your provider";
  const n = rows.length;
  const what = itemsPhrase(rows.map((r) => r.item_key), n);
  const subject = n === 1
    ? `${provider} added ${what} for your class`
    : `${provider} added ${n} ${what.replace(/^a /, "")} for your classes`;
  const intro = n === 1
    ? `${provider} added ${what} you can share or download:`
    : `${provider} added these for classes at your sites, ready to share or download:`;
  const lines = rows.map(mediaLine).sort((a, b) => a.localeCompare(b));
  const link = `${siteUrl}/partner/${rows[0].partner_id}#classes`;
  const button = "See them";
  const html = page(brand, subject, intro, lines, null, button, link);
  const text = [subject, "", intro, ...lines.map((l) => `- ${l}`), "", `${button}: ${link}`, ""].join("\n");
  return { subject, html, text };
}

/** Group key: one email per provider + partner + kind. */
export function groupKey(r: NoticeRow): string {
  return `${r.kind}:${r.organization_id}:${r.partner_id ?? "none"}`;
}
