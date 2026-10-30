// Partner portal: who at a partner can sign in, and what a signed-in partner
// sees. Authority is the database: partner_portal_access (owner/admin grant and
// remove), private.current_partner_access() (what a partner may read), and
// partner_portal_memberships() (links a grant to the signed-in account by
// email). Nothing here decides access; it calls the paths that do.

import { supabase } from "./supabase";

/** Every grant this provider has made, with the contact and partner it belongs to. */
export async function listPortalAccess(orgId) {
  const { data, error } = await supabase
    .from("partner_portal_access")
    .select("id, partner_id, contact_id, role, site_ids, auth_user_id, last_link_sent_at, last_signed_in_at, created_at, contact:partner_contacts(contact_name, contact_email), partner:partners(partner_name, inactive)")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Partner contacts that could be given access: linked to a partner and with an email. */
export async function listGrantableContacts(orgId) {
  const { data, error } = await supabase
    .from("partner_contacts")
    .select("id, partner_id, contact_name, contact_email")
    .eq("organization_id", orgId)
    .not("partner_id", "is", null)
    .not("contact_email", "is", null)
    .order("contact_name", { ascending: true });
  if (error) throw error;
  return (data ?? []).filter((c) => (c.contact_email || "").trim());
}

/**
 * Give one partner contact access. The database fills in the provider and partner from the contact.
 * `siteIds` null = every site of the partner; otherwise only those sites
 * (checked against the partner by the insert guard, 20261030a).
 */
export async function grantPortalAccess(orgId, contactId, role = "host_admin", siteIds = null) {
  const { error } = await supabase
    .from("partner_portal_access")
    // organization_id is sent for readability only: the insert trigger overwrites
    // it (and partner_id) from the contact before the RLS check runs.
    .insert({ contact_id: contactId, organization_id: orgId, role, site_ids: siteIds });
  if (error) throw error;
}

/** Change which sites an existing login sees (null = every site). Owner/admin only; false = refused. */
export async function setPortalAccessSites(accessId, siteIds) {
  const { data, error } = await supabase.rpc("set_partner_access_sites", { p_access_id: accessId, p_site_ids: siteIds });
  if (error) throw error;
  if (data !== true) throw new Error("Only an owner or admin can change which sites a login sees.");
}

/** One partner's sites (program locations), archived ones included so a saved choice still has a name. */
export async function listPartnerSites(orgId, partnerId) {
  const { data, error } = await supabase
    .from("program_locations")
    .select("id, name, archived")
    .eq("organization_id", orgId)
    .eq("partner_id", partnerId)
    .order("name", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function removePortalAccess(id) {
  const { error } = await supabase.from("partner_portal_access").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Where a partner lands after signing in: the neutral partner home, which lists
 * every provider sharing with them (spec v3 H1). Not provider-branded, because
 * a partner works with many providers. /:slug/partner still works and forwards
 * here.
 */
export function partnerPortalUrl() {
  return `${window.location.origin}/partner`;
}

/**
 * Email a sign-in link. Used by the provider's admin ("Send sign-in link") and by
 * the partner on the portal's sign-in form. The function sends only the partner
 * email, only when the address holds a grant from this provider; otherwise it
 * quietly does nothing.
 *
 * Resolves the outcome ('sent' | 'no_access' | 'suppressed_on_staging') when the
 * caller is one of the provider's owners/admins, and null for anyone else - the
 * public form is never told whether an address has access.
 */
//
// `org` null = the neutral partner home's sign-in: any provider's grant counts,
// and the email speaks as that provider (or as enrops when several share).
export async function sendPartnerSignInLink(org, email) {
  const body = { email, redirect_to: partnerPortalUrl(), context: "partner" };
  if (org?.id) body.org_id = org.id;
  const { data, error } = await supabase.functions.invoke("auth-send-magic-link", { body });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data?.partner_link ?? null;
}

/** The signed-in person's partner grants (links an unclaimed one on first sign-in). */
export async function myPartnerMemberships() {
  const { data, error } = await supabase.rpc("partner_portal_memberships");
  if (error) throw error;
  return data ?? [];
}

/**
 * The provider's instructors at one partner's sites, with checklist dates.
 * The database decides who may call it (that partner's logins, or the
 * provider's owner/admin) and blanks every detail an instructor has not given
 * permission to share. Never includes the background check report.
 */
export async function listPartnerInstructors(partnerId) {
  const { data, error } = await supabase.rpc("partner_portal_instructors", { p_partner_id: partnerId });
  if (error) throw error;
  return data ?? [];
}

/**
 * What one partner requires: every requirement key with `required`, defaults
 * applied by the database (partner_requirements_for, 20261026a). Readable by
 * the provider's members and that partner's own logins; empty for anyone else.
 */
export async function listPartnerRequirements(partnerId) {
  const { data, error } = await supabase.rpc("partner_requirements_for", { p_partner_id: partnerId });
  if (error) throw error;
  return data ?? [];
}

/** Turn one requirement on or off for a partner. Owner/admin only; false = refused. */
export async function setPartnerRequirement(partnerId, key, required) {
  const { data, error } = await supabase.rpc("set_partner_requirement", {
    p_partner_id: partnerId,
    p_requirement_key: key,
    p_required: required,
  });
  if (error) throw error;
  if (data !== true) throw new Error("Only an owner or admin can change what a partner requires.");
}

/**
 * The partner view log (audit_events). Best-effort and silent: the database
 * refuses anything this partner may not log, and a failed write must never get
 * in the way of the records. Errors go to the console only, by design.
 * Never rejects; returned so a caller about to leave the page can wait for it.
 */
export function logPartnerPortalEvent(partnerId, action, documentId = null) {
  return supabase
    .rpc("log_partner_portal_event", { p_partner_id: partnerId, p_action: action, p_document_id: documentId })
    .then(({ error }) => { if (error) console.warn("[partner log]", error.message); });
}
