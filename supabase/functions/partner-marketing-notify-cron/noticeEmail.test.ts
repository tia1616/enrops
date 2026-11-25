// Pins the flyer emails' words. Who gets what is the database's job
// (partner_marketing_notices_due, 20261125v).

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { itemsPhrase, typesText, askLine, mediaLine, renderAsk, renderMedia, groupKey, type NoticeRow } from "./noticeEmail.ts";

const brand = { org_name: "enrops", logo_url: null, primary_color: "#5847C9", page_bg_color: "#f5f3ee" };
const base: NoticeRow = {
  kind: "media", organization_id: "o", provider_name: "Journey to STEAM", partner_id: "p",
  partner_name: "Happy Valley Parks and Rec", item_key: "flyer", media_id: "m1",
  class_title: "Super Mario Game Makers", site: "Happy Valley Library",
  file_types: null, needs_logo: null, needs_accessible: null, note: null, to_emails: ["k@x.org"],
};
const ask: NoticeRow = { ...base, kind: "ask", media_id: null, class_title: null, site: null, file_types: ["pdf", "png"], needs_logo: true, needs_accessible: true, note: "Letter size please" };

Deno.test("phrases", () => {
  assertEquals(itemsPhrase(["flyer"]), "flyers");
  assertEquals(itemsPhrase(["flyer"], 1), "a flyer");
  assertEquals(itemsPhrase(["social_graphic", "flyer"]), "flyers and social graphics");
  assertEquals(typesText(["pdf"]), "PDF");
  assertEquals(typesText(["pdf", "jpg", "png"]), "PDF, JPG or PNG");
});

Deno.test("ask lines say what was asked", () => {
  assertEquals(askLine(ask), "Flyer for each class, as PDF or PNG, with Happy Valley Parks and Rec logo on it, accessible (ADA)");
  assertEquals(askLine({ ...ask, item_key: "social_graphic", needs_logo: false, needs_accessible: false, file_types: ["png"] }), "Social graphic for each class, as PNG");
});

Deno.test("ask email to the provider", () => {
  const { subject, text, html } = renderAsk(brand, [ask, { ...ask, item_key: "social_graphic", note: null, needs_accessible: false }], "https://enrops.com");
  assertEquals(subject, "Happy Valley Parks and Rec asked for flyers and social graphics");
  assert(text.includes('Flyer note from Happy Valley Parks and Rec: "Letter size please"'));
  assert(text.includes("https://enrops.com/admin/partner-documents/p#classes"));
  assert(!/[—–]/.test(subject + text + html), "no em or en dashes");
});

Deno.test("media email to the partner", () => {
  const one = renderMedia(brand, [base], "https://enrops.com");
  assertEquals(one.subject, "Journey to STEAM added a flyer for your class");
  assertEquals(mediaLine(base), "Super Mario Game Makers (Happy Valley Library): flyer");
  assert(one.text.includes("https://enrops.com/partner/p#classes"));
  const three = renderMedia(brand, [base, { ...base, media_id: "m2", class_title: "LEGO" }, { ...base, media_id: "m3", item_key: "social_graphic" }], "https://enrops.com");
  assertEquals(three.subject, "Journey to STEAM added 3 flyers and social graphics for your classes");
  assert(!/[—–]/.test(three.subject + three.text + three.html), "no em or en dashes");
});

Deno.test("names are escaped in html", () => {
  const { html } = renderMedia(brand, [{ ...base, class_title: "<b>x</b>" }], "https://enrops.com");
  assert(!html.includes("<b>x</b>"));
});

Deno.test("one email per provider + partner + kind", () => {
  assertEquals(groupKey(base), groupKey({ ...base, media_id: "m9", item_key: "social_graphic" }));
  assert(groupKey(base) !== groupKey(ask));
});

// The migration's safety lines (20261125v).
Deno.test("migration: nothing old is announced, nobody else can read the queue", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20261125v_partner_marketing_notices.sql", import.meta.url));
  assert(sql.includes("update public.partner_marketing_asks set provider_notified_at = now() where provider_notified_at is null;"));
  assert(sql.includes("update public.class_media set partner_notified_at = now() where partner_notified_at is null;"));
  assert(sql.includes("revoke all on function public.partner_marketing_notices_due() from public, anon, authenticated;"));
  assert(sql.includes("having max(a.updated_at) < now() - interval '10 minutes'"), "asks wait for a quiet 10 minutes");
  assert(sql.includes("having max(r.created_at) < now() - interval '10 minutes'"), "uploads wait for a quiet 10 minutes");
  assert(sql.includes("pr.status in ('open', 'draft')"), "flyers on not-open-yet classes are announced");
  assert(sql.includes("(pa.site_ids is null or r.location_id = any(pa.site_ids))"), "site-limited logins hear only their sites");
});
