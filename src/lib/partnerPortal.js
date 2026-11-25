// Partner portal: who at a partner can sign in, and what a signed-in partner
// sees. Authority is the database: partner_portal_access (owner/admin grant and
// remove), private.current_partner_access() (what a partner may read), and
// partner_portal_memberships() (links a grant to the signed-in account by
// email). Nothing here decides access; it calls the paths that do.

import { supabase } from "./supabase";
import { withClearances } from "./partnerPortalLogic.js";

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
 *
 * Each row carries `clearances`: its statuses from another source
 * (partner_portal_clearances, 20261103a), same access rules, shared
 * instructors only. If that read fails the list still loads with none, so a
 * missing clearance can never hide the rest of the record.
 */
export async function listPartnerInstructors(partnerId) {
  const [inst, clr] = await Promise.all([
    supabase.rpc("partner_portal_instructors", { p_partner_id: partnerId }),
    supabase.rpc("partner_portal_clearances", { p_partner_id: partnerId }),
  ]);
  if (inst.error) throw inst.error;
  if (clr.error) console.warn("[partnerPortal] clearances not loaded:", clr.error.message);
  return withClearances(inst.data ?? [], clr.error ? [] : clr.data);
}

/** Where a provider registers families (provider_record_settings, 20261103a); null when not set. */
export async function getRecordSettings(orgId) {
  const { data, error } = await supabase
    .from("provider_record_settings")
    .select("registration_system, registration_system_other")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) {
    console.warn("[partnerPortal] record settings not loaded:", error.message);
    return null;
  }
  return data ?? null;
}

/** Owner/admin only; false = refused. */
export async function setRegistrationSystem(orgId, system, other) {
  const { data, error } = await supabase.rpc("set_registration_system", { p_org: orgId, p_system: system, p_other: other || null });
  if (error) throw error;
  if (data !== true) throw new Error("Only an owner or admin can change this.");
}

/** An instructor's statuses from another source, for the provider's own instructor record. */
export async function listInstructorClearances(instructorId) {
  const { data, error } = await supabase
    .from("instructor_clearances")
    .select("id, check_type, clearance_body, clearance_body_other, item_name, scope, completed_on, expires_on, entered_at")
    .eq("instructor_id", instructorId)
    .order("completed_on", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * Every agency name this provider has typed before, for "Another agency"
 * suggestions (Jessica 2026-11-04: typed agencies join the list). Read
 * through the provider's own rows, so it is per provider.
 */
export async function listAgencyNames(orgId) {
  const { data, error } = await supabase
    .from("instructor_clearances")
    .select("clearance_body_other")
    .eq("organization_id", orgId)
    .not("clearance_body_other", "is", null);
  if (error) return [];
  return [...new Set((data ?? []).map((r) => r.clearance_body_other.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export async function addInstructorClearance(instructorId, f) {
  const { data, error } = await supabase.rpc("add_instructor_clearance", {
    p_instructor_id: instructorId, p_check_type: f.check_type, p_clearance_body: f.clearance_body,
    p_clearance_body_other: f.clearance_body === "other" ? f.clearance_body_other : null,
    p_item_name: f.check_type === "training" ? f.item_name : null,
    p_scope: f.scope || null, p_completed_on: f.completed_on, p_expires_on: f.expires_on || null,
  });
  if (error) throw error;
  return data;
}

export async function removeInstructorClearance(id) {
  const { data, error } = await supabase.rpc("remove_instructor_clearance", { p_id: id });
  if (error) throw error;
  if (data !== true) throw new Error("Only an owner or admin can remove this.");
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
// Refused writes (20261119p): a viewer login, a provider after the partner took
// its list over, or no access. One sentence for all three; the page already
// says which applies.
const REQUIREMENT_REFUSED = "You can't change this list. Refresh the page to see who can.";

export async function setPartnerRequirement(partnerId, key, required) {
  const { data, error } = await supabase.rpc("set_partner_requirement", {
    p_partner_id: partnerId,
    p_requirement_key: key,
    p_required: required,
  });
  if (error) throw error;
  if (data !== true) throw new Error(REQUIREMENT_REFUSED);
}

/**
 * What the partner requires for one item, in its own words, and where that is
 * written (20261104b). Empty detail clears it. Owner/admin only; false = refused.
 */
export async function setPartnerRequirementDetail(partnerId, key, detail, source) {
  const { data, error } = await supabase.rpc("set_partner_requirement_detail", {
    p_partner_id: partnerId, p_requirement_key: key, p_detail: detail || null, p_source: source || null,
  });
  if (error) throw error;
  if (data !== true) throw new Error(REQUIREMENT_REFUSED);
}

/**
 * May this login change the partner's list, and has the partner taken it over
 * (20261119p)? null when the caller may not see this partner at all.
 */
export async function getRequirementsControl(partnerId) {
  const { data, error } = await supabase.rpc("partner_requirements_control", { p_partner_id: partnerId });
  if (error) throw error;
  return data?.[0] ?? null;
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

/**
 * The decision panel for one partner (20261102b): { can_decide,
 * requirements_version, last_title, decisions[] newest first }. null when
 * this login may not see that partner's decisions.
 */
export async function getPartnerDecisions(partnerId) {
  const { data, error } = await supabase.rpc("partner_decisions", { p_partner_id: partnerId });
  if (error) throw error;
  return data ?? null;
}

/** Record a decision. Host admin of that partner only; the database refuses anyone else. */
export async function recordPartnerDecision(partnerId, { decision, note, title }) {
  const { data, error } = await supabase.rpc("record_partner_decision", {
    p_partner_id: partnerId, p_decision: decision, p_note: note || null, p_title: title,
  });
  if (error) throw error;
  return data;
}

// --- Invites (20261105a; OFF until platform_settings 'partner_invites') -----

/** Whether invites are open. False on any error, so a failure hides the feature. */
export async function invitesEnabled() {
  const { data, error } = await supabase.rpc("partner_invites_enabled");
  return !error && data === true;
}

/** The partners this signed-in person is a host_admin for (their own grants only, by RLS). */
export async function myHostAdminPartners(userId) {
  const { data, error } = await supabase
    .from("partner_portal_access")
    .select("partner_id, role, partner:partners(partner_name, inactive)")
    .eq("auth_user_id", userId)
    .eq("role", "host_admin");
  if (error) return [];
  return (data ?? []).filter((a) => !a.partner?.inactive);
}

/** One partner's invitations, newest first (that partner's logins only). */
export async function listInvitations(partnerId) {
  const { data, error } = await supabase.rpc("partner_invitations_for", { p_partner_id: partnerId });
  if (error) throw error;
  return data ?? [];
}

/** Save or send invitations: { action: "save"|"send", partner_id, emails, business_name, message } or { action: "send", invitation_id }. */
export async function sendInvitations(body) {
  const { data, error } = await supabase.functions.invoke("partner-invites", { body });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error || error.message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

/** What an invite link shows: { host_name, business_name, invited_email, state, expires_at, categories } or null. */
export async function previewInvitation(token) {
  const { data, error } = await supabase.rpc("partner_invitation_preview", { p_token: token });
  if (error) throw error;
  return (data ?? [])[0] ?? null;
}

/** Share the provider's record with the host. Returns the new partner id. */
export async function acceptInvitation(token, orgId) {
  const { data, error } = await supabase.rpc("accept_partner_invitation", { p_token: token, p_org: orgId, p_consent: true });
  if (error) throw error;
  return data;
}

/** "Not now", with an optional note to the host. */
export async function declineInvitation(token, note) {
  const { data, error } = await supabase.rpc("decline_partner_invitation", { p_token: token, p_note: note || null });
  if (error) throw error;
  return data === true;
}

// --- Classes at a partner's sites (20261119a) --------------------------------

/**
 * Every class and camp at this partner's sites that has not ended, with
 * enrolled / max and where that count comes from. Same access as the
 * instructor list (the partner's logins, by site; the provider's owner/admin).
 */
export async function listPartnerClasses(partnerId) {
  const { data, error } = await supabase.rpc("partner_portal_classes", { p_partner_id: partnerId });
  if (error) throw error;
  return data ?? [];
}

/**
 * One class's roster: name, grade, homeroom, dismissal. Nothing else exists
 * in the response. A partner's open is logged by the database in this call.
 */
export async function getClassRoster(partnerId, kind, classId) {
  const { data, error } = await supabase.rpc("partner_portal_class_roster", { p_partner_id: partnerId, p_kind: kind, p_class_id: classId });
  if (error) throw error;
  return data ?? [];
}

/**
 * One class's end-of-term summary (20261125t): { sessions: [{ date, status }],
 * money: { children, paid_cents } | null }. status is held / cancelled /
 * upcoming / not_confirmed. money is null when families did not register
 * through enrops. null overall when this login may not see the class.
 */
export async function getClassSummary(partnerId, kind, classId) {
  const { data, error } = await supabase.rpc("partner_portal_class_summary", { p_partner_id: partnerId, p_kind: kind, p_class_id: classId });
  if (error) throw error;
  return data ?? null;
}

/**
 * The provider's registration questions, for "is there a Dismissal column"
 * (asksDismissal). null when the read fails, which shows the column.
 */
export async function getRegistrationFields(orgId, programId) {
  const { data, error } = await supabase.rpc("get_active_registration_fields", { p_org_id: orgId, p_program_id: programId ?? null });
  if (error) {
    console.warn("[partnerPortal] registration questions not loaded; showing dismissal:", error.message);
    return null;
  }
  return data ?? [];
}

/**
 * Does this partner see what families paid (20261125u)? Revenue-split
 * partners only; off by default. Provider side only (partners has no
 * partner-login read).
 */
export async function getShowFamilyPayments(orgId, partnerId) {
  const { data, error } = await supabase.from("partners")
    .select("show_family_payments").eq("organization_id", orgId).eq("id", partnerId).maybeSingle();
  if (error) throw error;
  return !!data?.show_family_payments;
}

/** Turn it on or off. Throws when no row changed (not this provider's partner, or refused). */
export async function setShowFamilyPayments(orgId, partnerId, on) {
  const { data, error } = await supabase.from("partners")
    .update({ show_family_payments: !!on }).eq("organization_id", orgId).eq("id", partnerId)
    .select("show_family_payments");
  if (error) throw error;
  if (!data?.length) throw new Error("Couldn't save. Only an owner or admin can change this.");
  return !!data[0].show_family_payments;
}

/** The provider types a count for a class it registers outside enrops. Owner/admin only; false = refused. */
export async function setReportedEnrollment(kind, classId, enrolled) {
  const { data, error } = await supabase.rpc("set_reported_enrollment", { p_kind: kind, p_class_id: classId, p_enrolled: enrolled });
  if (error) throw error;
  if (data !== true) throw new Error("Only an owner or admin can enter a count, and only for a class you register outside enrops.");
  return true;
}

/**
 * Reminder emails enrops sent this provider about items this partner can see
 * (20261119d), newest first. Recipients are a count only.
 */
export async function listPartnerEmailsSent(partnerId) {
  const { data, error } = await supabase.rpc("partner_portal_emails_sent", { p_partner_id: partnerId });
  if (error) throw error;
  return data ?? [];
}

/** The businesses this person can accept for: owner or admin. */
export async function myAdminOrgs(userId) {
  const { data, error } = await supabase
    .from("org_members")
    .select("organization_id, role, organization:organizations(name)")
    .eq("auth_user_id", userId)
    .in("role", ["owner", "admin"]);
  if (error) return [];
  return (data ?? []).map((m) => ({ id: m.organization_id, name: m.organization?.name ?? "Your business" }));
}
