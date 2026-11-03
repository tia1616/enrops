// The words of the Monday digest, kept pure so they can be tested. What is
// listed is decided in the database (partner_digest_due, 20261102d).

import { esc } from "../_shared/escapeHtml.ts";

export interface DigestRow {
  access_id: string;
  partner_id: string;
  partner_name: string;
  to_email: string;
  week_of: string;
  provider_name: string;
  kind: "expiring" | "expired" | "stopped_sharing";
  label: string | null;
  item_date: string; // YYYY-MM-DD
}

/** "Jan 17, 2027" from YYYY-MM-DD, without a timezone shift. */
export function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

/** One line per item, in the host's words. */
export function lineFor(r: DigestRow): string {
  const what = (r.label || "").trim() || "An item";
  if (r.kind === "stopped_sharing") return `${what} stopped sharing their status with you`;
  if (r.kind === "expired") return `${what} expired ${formatDay(r.item_date)}`;
  return r.item_date === r.week_of ? `${what} expires today` : `${what} expires ${formatDay(r.item_date)}`;
}

/** Spec v3 copy: "Your providers this week: {n} expiring, {m} expired". */
export function subjectFor(rows: DigestRow[]): string {
  const n = rows.filter((r) => r.kind === "expiring").length;
  const m = rows.filter((r) => r.kind === "expired").length;
  return `Your providers this week: ${n} expiring, ${m} expired`;
}

/** Rows grouped by provider, providers in name order, items in the order given. */
export function byProvider(rows: DigestRow[]): [string, DigestRow[]][] {
  const map = new Map<string, DigestRow[]>();
  for (const r of rows) {
    if (!map.has(r.provider_name)) map.set(r.provider_name, []);
    map.get(r.provider_name)!.push(r);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

const FOOTER = "enrops displays verification status from each provider's record; it does not run or certify checks.";

export function renderDigest(
  brand: { org_name: string; logo_url: string | null; primary_color: string; page_bg_color: string },
  rows: DigestRow[],
  siteUrl: string,
): { subject: string; html: string; text: string } {
  const subject = subjectFor(rows);
  const link = `${siteUrl}/partner`;
  const groups = byProvider(rows);
  const groupsHtml = groups.map(([provider, items]) =>
    `<h2 style="font-size:16px;color:#1a1a1a;margin:20px 0 6px;">${esc(provider)}</h2>` +
    `<table style="width:100%;border-collapse:collapse;">` +
    items.map((r) => `<tr><td style="padding:6px 0;border-bottom:1px solid #eee;font-size:15px;color:#1a1a1a;">${esc(lineFor(r))}</td></tr>`).join("") +
    `</table>`
  ).join("");
  const logo = brand.logo_url
    ? `<img src="${esc(brand.logo_url)}" alt="${esc(brand.org_name)}" style="max-height:48px;display:block;margin:0 auto 20px;" />`
    : "";
  const html = `<!doctype html><html><body style="margin:0;background:${esc(brand.page_bg_color)};padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;">
    ${logo}
    <h1 style="font-size:20px;color:${esc(brand.primary_color)};margin:0 0 4px;">${esc(subject)}</h1>
    <p style="font-size:14px;color:#6b6b6b;margin:0;">${esc(rows[0]?.partner_name ?? "")}</p>
    ${groupsHtml}
    <a href="${esc(link)}" style="display:inline-block;margin-top:22px;background:${esc(brand.primary_color)};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:15px;font-weight:600;">See your providers</a>
    <p style="font-size:12px;color:#6b6b6b;line-height:1.5;margin:20px 0 0;">${esc(FOOTER)}</p>
  </div></body></html>`;
  const text = `${subject}\n${rows[0]?.partner_name ?? ""}\n\n` +
    groups.map(([provider, items]) => `${provider}\n` + items.map((r) => `- ${lineFor(r)}`).join("\n")).join("\n\n") +
    `\n\nSee your providers: ${link}\n\n${FOOTER}\n`;
  return { subject, html, text };
}
