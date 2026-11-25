// Pins the end-of-class email's words (20261125w). Who sees what is the
// database's job (partner_class_wrapups_due reads as each login).
import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { sessionsLine, classLines, renderWrapup, renderWrapupCopy, namesList, type WrapupRow } from "./wrapupEmail.ts";

const brand = { org_name: "enrops", logo_url: null, primary_color: "#5847C9", page_bg_color: "#f5f3ee" };
const held = (n: number) => Array.from({ length: n }, (_, i) => ({ date: `2026-09-${String(10 + i).padStart(2, "0")}`, status: "held" }));
const row: WrapupRow = {
  access_id: "a1", organization_id: "o", provider_name: "Journey to STEAM", partner_id: "p", partner_name: "Happy Valley Parks and Rec",
  to_email: "k@x.org", to_name: "Kacy Cullen", class_kind: "class", class_id: "c1", title: "Super Mario Game Makers", site: "Happy Valley Library",
  first_date: "2026-09-15", last_date: "2026-11-03", count_source: "enrops", enrolled: 6,
  summary: { sessions: held(8), money: { children: 6, paid_cents: 168600 } },
};

Deno.test("sessions line", () => {
  assertEquals(sessionsLine(held(8)), "8 of 8 sessions held");
  assertEquals(sessionsLine([...held(6), { date: "x", status: "not_confirmed" }, { date: "y", status: "cancelled" }]), "6 of 7 sessions held, 1 not confirmed yet, 1 cancelled");
  assertEquals(sessionsLine([]), "No session dates on file");
});

Deno.test("class lines: money only when the summary carries it", () => {
  assertEquals(classLines(row), ["Sep 15 to Nov 3 · 8 of 8 sessions held", "6 children on the roster", "Families paid $1,686.00, after discounts and refunds (6 children paid)."]);
  const noMoney = classLines({ ...row, summary: { sessions: held(8), money: null } });
  assertEquals(noMoney.length, 2);
  assert(!noMoney.join(" ").includes("$"), "no money line when not shared");
  const partnerRun = classLines({ ...row, count_source: "partner", enrolled: null, summary: { sessions: held(8), money: null } });
  assertEquals(partnerRun, ["Sep 15 to Nov 3 · 8 of 8 sessions held"]);
});

Deno.test("partner email", () => {
  const one = renderWrapup(brand, [row], "https://enrops.com");
  assertEquals(one.subject, "Super Mario Game Makers has finished: the summary is ready");
  assert(one.text.includes("https://enrops.com/partner/p#classes"));
  const two = renderWrapup(brand, [row, { ...row, class_id: "c2", title: "LEGO" }], "https://enrops.com");
  assertEquals(two.subject, "2 classes have finished: the summaries are ready");
  assert(!/[—–]/.test(one.subject + one.text + one.html + two.text), "no em or en dashes");
});

Deno.test("provider copy names who was told", () => {
  const c = renderWrapupCopy(brand, [row], ["Kacy Cullen", "Stephani Hern"], "https://enrops.com");
  assertEquals(c.subject, "Copy: Happy Valley Parks and Rec got the summary for Super Mario Game Makers");
  assert(c.text.includes("enrops emailed Kacy Cullen and Stephani Hern at Happy Valley Parks and Rec"));
  assert(c.text.includes("/admin/partner-documents/p#classes"));
  assertEquals(namesList(["A", "B", "C"]), "A, B and C");
  assert(!/[—–]/.test(c.subject + c.text + c.html));
});

Deno.test("names are escaped in html", () => {
  const { html } = renderWrapup(brand, [{ ...row, title: "<b>x</b>" }], "https://enrops.com");
  assert(!html.includes("<b>x</b>"));
});

Deno.test("migration: read as the login, signed-in logins only, 2 to 9 days, working hours", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20261125w_partner_class_wrapup.sql", import.meta.url));
  assert(sql.includes("where pa.auth_user_id is not null"));
  assert(sql.includes("pc.last_date between v_today - 9 and v_today - 2"));
  assert(sql.includes("not between 9 and 17"));
  assert(sql.includes("public.partner_portal_class_summary(a.partner_id, pc.kind, pc.class_id)"));
  assert(sql.includes("revoke all on function public.partner_class_wrapups_due(date) from public, anon, authenticated;"));
  assert(sql.includes("revoke all on public.partner_class_wrapup_sends from public, anon, authenticated;"));
});
