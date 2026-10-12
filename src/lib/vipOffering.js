// May this business sell a year bundle at this school?
//
// The registration page used to offer a year bundle from data shape alone (a
// fall class with a winter and spring class at the same school and weekday).
// create-registration only SELLS one when the business has bundles switched on,
// with a price set, at a school it has not excluded - organizations.vip_offering,
// published to the page as public_org_directory.vip_offering_public
// (20261012a). Without this the page could offer a full-year option the server
// then refused, after the family had filled in the whole form.
//
// TWIN of the first and last checks in create-registration's year-bundle block
// (supabase/functions/create-registration/index.ts, "THE YEAR BUNDLE, server
// side"). Deno cannot import this module. If one changes, change the other.
//
// `vipPublic` null/undefined - including a failed read - means NO bundle. The
// page offering less than the server would sell is a missed upsell; offering
// more is a family refused at the last step.
export function vipBundleAllowed(vipPublic, locationId) {
  if (!vipPublic || vipPublic.enabled !== true) return false;
  const price = Number(vipPublic.price_cents);
  if (!Number.isInteger(price) || price <= 0) return false;
  const excluded = Array.isArray(vipPublic.excluded_location_ids)
    ? vipPublic.excluded_location_ids.map(String)
    : [];
  return !excluded.includes(String(locationId));
}
