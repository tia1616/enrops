// Pure wording for partner portal access, testable without Supabase.

import { formatDate, EXPIRY_STATUS, EXPIRED_OR_MISSING } from "./providerDocumentLogic.js";

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

// Spec v3's six chip words, used exactly (see EXPIRY_STATUS in
// providerDocumentLogic.js). Keyed by every value
// public.partner_portal_instructors() returns: the first four come from
// private.document_expiry_status(), the same rule documents use. "missing"
// covers a check never started AND a result that is not clear, so both read
// "Expired or Missing" and a failed check never gets its own word.
export const CHECK_STATUS = {
  ...EXPIRY_STATUS,
  missing: EXPIRED_OR_MISSING,
  in_review: { label: "In review", tone: "review" },
};

const CURRENT = EXPIRY_STATUS.current;

/** The line under every chip (spec v3: every chip carries "as of" and its source). */
function provenance(asOf, source) {
  return [asOf ? `as of ${formatDate(asOf)}` : null, source ? `Source: ${source}` : null].filter(Boolean).join(" · ");
}

/**
 * The checklist lines for one instructor, in display order. Each line is
 * { key, title, badge: {label, tone}, detail, meta }. `meta` is the "as of"
 * and source line. An instructor who has not given permission gets one line:
 * In review, waiting on their consent (spec v3, P3).
 * `today` (YYYY-MM-DD) dates an "Expired or Missing" chip with nothing behind it.
 * Never says "cleared", "safe" or that enrops checked or verified anything.
 */
export function instructorChecklist(row, orgName, today) {
  if (!row) return [];
  const byProvider = `entered by ${(orgName || "").trim() || "the provider"}`;
  if (!row.shared) {
    return [{
      key: "consent",
      title: "Status",
      badge: CHECK_STATUS.in_review,
      detail: "Waiting on this instructor's consent",
      meta: "",
    }];
  }

  const status = CHECK_STATUS[row.background_check_status] ?? CHECK_STATUS.in_review;
  const checkDetail = [];
  if (row.background_check_completed_on) checkDetail.push(`Completed ${formatDate(row.background_check_completed_on)}`);
  if (row.background_check_expires_on) {
    checkDetail.push(
      `${row.background_check_status === "expired" ? "Expired" : "Renews"} ${formatDate(row.background_check_expires_on)}`,
    );
  }
  if (row.background_check_status === "in_review" && !row.background_check_completed_on) {
    checkDetail.push("Completed date not on file yet");
  }
  const vendor = (row.background_check_vendor || "").trim();
  const checkSource = vendor && row.background_check_completed_on ? `${byProvider} · Screening company: ${vendor}` : byProvider;
  const nothingOnFile = row.background_check_status === "missing";

  const signed = (key, title, date, verb) => ({
    key,
    title,
    badge: date ? CURRENT : EXPIRED_OR_MISSING,
    detail: date ? `${verb} ${formatDate(date)}` : "",
    meta: date ? provenance(date, "signed by the instructor in enrops") : provenance(today, null),
  });

  return [
    {
      key: "background_check",
      title: "Background check",
      badge: status,
      detail: checkDetail.join(" · "),
      meta: nothingOnFile ? provenance(today, null) : provenance(row.background_check_as_of, checkSource),
    },
    {
      key: "training",
      title: "Training",
      badge: row.training_completed_on ? CURRENT : EXPIRED_OR_MISSING,
      detail: row.training_completed_on ? `Completed ${formatDate(row.training_completed_on)}` : "",
      meta: row.training_completed_on ? provenance(row.training_as_of, byProvider) : provenance(today, null),
    },
    signed("code_of_conduct", "Code of conduct", row.code_of_conduct_on, "Signed"),
    signed("mandatory_reporter", "Mandatory reporter", row.mandatory_reporter_on, "Acknowledged"),
    signed("agreement", "Contractor agreement", row.agreement_signed_on, "Signed"),
  ];
}

/** "as of" and source for a provider document (spec v3 display rules). */
export function documentProvenance(doc, orgName) {
  const by = `entered by ${(orgName || "").trim() || "the provider"}`;
  return provenance(doc?.updated_at ? String(doc.updated_at).slice(0, 10) : null, by);
}
