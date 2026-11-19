import assert from "node:assert/strict";
import { test } from "node:test";
import { siteRpcArgs, NEW_DISTRICT, NO_DISTRICT } from "./saveSite.js";

const base = { organizationId: "org-1", name: "  Lincoln Elementary  " };

test("an untouched district picker is refused, never saved as 'no district'", () => {
  assert.throws(() => siteRpcArgs({ ...base, districtChoice: "" }), /Choose this location's district/);
  assert.throws(() => siteRpcArgs({ ...base }), /Choose this location's district/);
});

test("blank name is refused", () => {
  assert.throws(() => siteRpcArgs({ ...base, name: "   ", districtChoice: NO_DISTRICT }), /name is required/);
});

test("deliberate no-district sends no district at all", () => {
  const a = siteRpcArgs({ ...base, districtChoice: NO_DISTRICT });
  assert.equal(a.p_district_id, null);
  assert.equal(a.p_new_district_name, null);
  assert.equal(a.p_name, "Lincoln Elementary");
});

test("existing district id passes through", () => {
  const a = siteRpcArgs({ ...base, districtChoice: "dist-9" });
  assert.equal(a.p_district_id, "dist-9");
});

test("new district needs a name, and sends it trimmed", () => {
  assert.throws(() => siteRpcArgs({ ...base, districtChoice: NEW_DISTRICT, newDistrictName: " " }), /name for the new district/);
  const a = siteRpcArgs({ ...base, districtChoice: NEW_DISTRICT, newDistrictName: " Portland Public Schools " });
  assert.equal(a.p_new_district_name, "Portland Public Schools");
  assert.equal(a.p_district_id, null);
});

test("a studio creates no partner", () => {
  const a = siteRpcArgs({ ...base, districtChoice: NO_DISTRICT });
  assert.equal(a.p_at_partner, false);
  assert.equal(a.p_partner_id, null);
});

test("at a school asks for a partner; picking an existing one implies it", () => {
  assert.equal(siteRpcArgs({ ...base, districtChoice: NO_DISTRICT, atPartner: true }).p_at_partner, true);
  const picked = siteRpcArgs({ ...base, districtChoice: NO_DISTRICT, partnerId: "p-1" });
  assert.equal(picked.p_at_partner, true);
  assert.equal(picked.p_partner_id, "p-1");
});

test("blank optional strings become null, not empty strings", () => {
  const a = siteRpcArgs({ ...base, districtChoice: NO_DISTRICT, address: " ", area: "", partnerType: "" });
  assert.equal(a.p_address, null);
  assert.equal(a.p_area, null);
  assert.equal(a.p_partner_type, null);
});

import { writeSiteExtras, SAVED_BY_SAVE_SITE } from "./saveSite.js";

function fakeSupabase(result = { error: null }) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        update(row) {
          return { eq(col, val) { calls.push({ table, row, col, val }); return Promise.resolve(result); } };
        },
      };
    },
  };
}

test("extras: writes only non-blank fields save_site didn't take", async () => {
  const sb = fakeSupabase();
  const err = await writeSiteExtras(sb, "loc-1", {
    name: "X", address: "a", district_id: "d", partner_id: "p", at_partner: true,
    room_number: " Room 4 ", contact_email: "", notes: "   ", food_drink_policy: null,
  });
  assert.equal(err, null);
  assert.equal(sb.calls.length, 1);
  assert.deepEqual(sb.calls[0].row, { room_number: "Room 4" });
  assert.equal(sb.calls[0].val, "loc-1");
});

test("extras: nothing to write means no request at all", async () => {
  const sb = fakeSupabase();
  const err = await writeSiteExtras(sb, "loc-1", { name: "X", room_number: "", notes: "  " });
  assert.equal(err, null);
  assert.equal(sb.calls.length, 0);
});

test("extras: a failed write says the site WAS added", async () => {
  const sb = fakeSupabase({ error: { message: "boom" } });
  const err = await writeSiteExtras(sb, "loc-1", { room_number: "4" });
  assert.match(err, /The location was added/);
});

test("extras never re-writes a field save_site owns", () => {
  for (const k of ["name", "address", "area", "district_id", "partner_id"]) assert.ok(SAVED_BY_SAVE_SITE.has(k));
});
