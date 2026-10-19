// Pure wording for partner portal access, testable without Supabase.

import { formatDate } from "./providerDocumentLogic.js";

function dateOnly(ts) {
  return ts ? String(ts).slice(0, 10) : null;
}

/**
 * Where a person stands, in words, from their partner_portal_access row.
 * Keys off the timestamps the database writes, never off a guess:
 * last_signed_in_at is stamped by partner_portal_memberships() on every portal
 * load, last_link_sent_at by the sign-in email function after a send.
 */
export function accessStatus(row) {
  if (row?.last_signed_in_at) {
    return { tone: "good", label: `Signed in ${formatDate(dateOnly(row.last_signed_in_at))}` };
  }
  if (row?.last_link_sent_at) {
    return { tone: "warn", label: `Link sent ${formatDate(dateOnly(row.last_link_sent_at))}, not signed in yet` };
  }
  return { tone: "neutral", label: "No sign-in link sent yet" };
}

/** Contacts that can still be given access: not already granted. */
export function contactsWithoutAccess(contacts, grants) {
  const granted = new Set((grants || []).map((g) => g.contact_id));
  return (contacts || []).filter((c) => !granted.has(c.id));
}

// --- Instructor checklist (partner_portal_instructors) ----------------------

// Background check status words, keyed by every value
// public.partner_portal_instructors() can return. The first four come from
// private.document_expiry_status(), the same rule documents use, so they share
// Arielle's words (Oct 16 brief): Current / Expiring in 30 days / Expired.
export const CHECK_STATUS = {
  current: { label: "Current", tone: "good" },
  expiring_soon: { label: "Expiring in 30 days", tone: "warn" },
  expired: { label: "Expired", tone: "bad" },
  no_expiry: { label: "Current", tone: "good" },
  missing: { label: "Missing", tone: "bad" },
  in_review: { label: "In review", tone: "neutral" },
  date_missing: { label: "Date not on file", tone: "warn" },
};

const MISSING = { label: "Missing", tone: "bad" };

/**
 * The checklist lines for one instructor, in display order. Each line is
 * { key, title, badge: {label, tone}, detail }. Empty for an instructor who has
 * not given permission: the portal shows a single "permission pending" line.
 * Never says "cleared", "safe" or that enrops verified anything (copy rules).
 */
export function instructorChecklist(row) {
  if (!row?.shared) return [];
  const status = CHECK_STATUS[row.background_check_status] ?? CHECK_STATUS.in_review;
  const checkDetail = [];
  if (row.background_check_completed_on) checkDetail.push(`Completed ${formatDate(row.background_check_completed_on)}`);
  if (row.background_check_expires_on) {
    checkDetail.push(
      `${row.background_check_status === "expired" ? "Expired" : "Renews"} ${formatDate(row.background_check_expires_on)}`,
    );
  }
  const vendor = (row.background_check_vendor || "").trim();
  if (vendor && row.background_check_completed_on) checkDetail.push(`${vendor}-verified`);

  const dated = (key, title, date, verb) => ({
    key,
    title,
    badge: date ? CHECK_STATUS.current : MISSING,
    detail: date ? `${verb} ${formatDate(date)}` : "",
  });

  return [
    { key: "background_check", title: "Background check", badge: status, detail: checkDetail.join(" · ") },
    dated("training", "Training", row.training_completed_on, "Completed"),
    dated("code_of_conduct", "Code of conduct", row.code_of_conduct_on, "Signed"),
    dated("mandatory_reporter", "Mandatory reporter", row.mandatory_reporter_on, "Acknowledged"),
    dated("agreement", "Contractor agreement", row.agreement_signed_on, "Signed"),
  ];
}
