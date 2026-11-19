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
