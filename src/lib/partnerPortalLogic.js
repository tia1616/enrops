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
  // Cleared, but the completed date is not entered yet: same chip, own reason.
  awaiting_date: { label: "In review", tone: "review" },
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
  if (row.background_check_status === "awaiting_date") checkDetail.push("Completed date not on file yet");
  else if (row.background_check_status === "in_review") checkDetail.push("Check in progress");
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

// --- Partner home (spec v3 H1): one row per provider ------------------------

// Worst first. A row or a cell takes its worst chip, so a partner reads red
// before anything else (spec v3: "Lapsed rows sort first").
const TONE_RANK = { bad: 0, review: 1, warn: 2, good: 3, neutral: 4 };

/** The worst of a list of chips, or null when there are none. */
export function worstBadge(badges) {
  const list = (badges || []).filter(Boolean);
  if (!list.length) return null;
  return list.reduce((a, b) => ((TONE_RANK[b.tone] ?? 4) < (TONE_RANK[a.tone] ?? 4) ? b : a));
}

function docsFor(docs, partnerId, type) {
  return (docs || []).filter((d) => d.doc_type === type && (!d.partner_id || d.partner_id === partnerId));
}

/**
 * One provider's row on the partner home: insurance, instructors ("6 of 7
 * Current"), training, agreement, business license, last change, and the
 * row's overall rank for sorting. Pure: built from the same document rows and
 * instructor checklist the provider detail page shows, so the two can never
 * disagree.
 */
export function providerSummary({ docs, instructors, partnerId, orgName, today }) {
  const insuranceDocs = docsFor(docs, partnerId, "insurance");
  const agreementDocs = docsFor(docs, partnerId, "agreement");
  const licenseDocs = docsFor(docs, partnerId, "business_license");
  const chipOf = (d) => EXPIRY_STATUS[d.expiry_status] ?? CHECK_STATUS.in_review;

  // Every insurance certificate must be current (a lapsed umbrella is a gap
  // even when the general liability is fine), so insurance takes the WORST.
  // One valid agreement or license is enough, so those take the BEST.
  const bestBadge = (list) => {
    const b = list.map(chipOf);
    if (!b.length) return null;
    return b.reduce((a, c) => ((TONE_RANK[c.tone] ?? 4) > (TONE_RANK[a.tone] ?? 4) ? c : a));
  };
  const insurance = insuranceDocs.length ? worstBadge(insuranceDocs.map(chipOf)) : EXPIRED_OR_MISSING;
  const agreement = bestBadge(agreementDocs) ?? EXPIRED_OR_MISSING;
  const license = bestBadge(licenseDocs) ?? EXPIRED_OR_MISSING;

  const people = (instructors || []).map((row) => instructorChecklist(row, orgName, today));
  const isCurrent = (lines) => lines.every((l) => l.badge.tone === "good" || l.badge.tone === "warn");
  const currentCount = people.filter(isCurrent).length;
  const instructorBadge = people.length ? worstBadge(people.flat().map((l) => l.badge)) : null;
  const training = people.length
    ? worstBadge(people.map((lines) => (lines.find((l) => l.key === "training") ?? lines[0]).badge))
    : null;

  const dates = [
    ...(docs || []).filter((d) => !d.partner_id || d.partner_id === partnerId).map((d) => d.updated_at && String(d.updated_at).slice(0, 10)),
    ...(instructors || []).flatMap((r) => [r.background_check_as_of, r.training_as_of, r.code_of_conduct_on, r.mandatory_reporter_on, r.agreement_signed_on]),
  ].filter(Boolean).sort();
  const lastChange = dates.length ? dates[dates.length - 1] : null;

  const overall = worstBadge([insurance, agreement, instructorBadge, training]);
  return {
    insurance,
    agreement,
    license,
    training,
    instructors: { total: people.length, current: currentCount, badge: instructorBadge },
    lastChange,
    rank: TONE_RANK[overall?.tone] ?? 4,
    sites: [...new Set((instructors || []).flatMap((r) => r.sites || []))].sort(),
  };
}
