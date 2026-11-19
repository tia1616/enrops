// saveSite: the ONE way a new site (program_locations row) is created.
//
// Every "add a location" form calls this: AddSchoolModal, LocationsList and the
// quick program builder. It calls the save_site RPC (migration 20261119b), which
// writes the district, the school partner and the site in ONE transaction. Before
// this, each form had its own copy of the district match-before-create and its own
// slug code, and AddSchoolModal could leave an orphan partner behind when the site
// insert failed.
//
// The district picker values shared by those forms:
//   "" (untouched)     -> refused here, so no form can silently save "no district"
//   NO_DISTRICT        -> a deliberate "follows no district"
//   NEW_DISTRICT       -> create (or reuse, case-insensitively) `newDistrictName`
//   any other string   -> an existing districts.id
//
// Pure arg-building lives in siteRpcArgs so it can be tested without a database.

export const NEW_DISTRICT = "__new__";
export const NO_DISTRICT = "__none__";

const DISTRICT_UNCHOSEN =
  "Choose this location's district — or pick “No district” if it doesn't follow one.";

export function siteRpcArgs({
  organizationId,
  name,
  address = "",
  area = "",
  atPartner = false,
  partnerId = null,
  partnerName = "",
  partnerType = "",
  partnerIsUmbrella = false,
  districtChoice = "",
  newDistrictName = "",
}) {
  const nm = (name ?? "").trim();
  if (!nm) throw new Error("Location name is required.");
  if (districtChoice === "" || districtChoice == null) throw new Error(DISTRICT_UNCHOSEN);

  let districtId = null;
  let newDistrict = null;
  if (districtChoice === NEW_DISTRICT) {
    newDistrict = (newDistrictName ?? "").trim();
    if (!newDistrict) throw new Error("Enter a name for the new district, or pick an existing one.");
  } else if (districtChoice !== NO_DISTRICT) {
    districtId = districtChoice;
  }

  return {
    p_organization_id: organizationId,
    p_name: nm,
    p_address: (address ?? "").trim() || null,
    p_area: (area ?? "").trim() || null,
    p_at_partner: !!atPartner || !!partnerId,
    p_partner_id: partnerId || null,
    p_partner_name: (partnerName ?? "").trim() || null,
    p_partner_type: (partnerType ?? "").trim() || null,
    p_partner_is_umbrella: !!partnerIsUmbrella,
    p_district_id: districtId,
    p_new_district_name: newDistrict,
  };
}

// Returns the full saved program_locations row.
export async function saveSite(supabase, input) {
  const args = siteRpcArgs(input);
  const { data, error } = await supabase.rpc("save_site", args);
  if (error) throw error;
  return data;
}
