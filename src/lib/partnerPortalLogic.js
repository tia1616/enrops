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
  // Never the screening company's NAME (Arielle 2026-10-29: providers may switch
  // vendors, so the record only says the result came from a screening partner).
  // The vendor field still decides WHETHER to say so.
  const vendor = (row.background_check_vendor || "").trim();
  const checkSource = vendor && row.background_check_completed_on ? `${byProvider} · from the provider's screening partner` : byProvider;
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
    signed("contractor_agreement", "Contractor agreement", row.agreement_signed_on, "Signed"),
  ];
}

// --- What a partner requires (partner_requirements_for, 20261026a) ---------

// Every requirement, in display order. `doc` is the provider_documents type
// that satisfies a business-level requirement; instructor requirements match a
// checklist line key above. The DEFAULTS are not here: they live in the
// database function, the one place that decides them.
export const REQUIREMENTS = [
  { key: "insurance", label: "Insurance certificate", kind: "business", doc: "insurance" },
  { key: "partner_agreement", label: "Partner agreement", kind: "business", doc: "agreement" },
  { key: "business_license", label: "Business license", kind: "business", doc: "business_license" },
  { key: "background_check", label: "Background check", kind: "instructor" },
  { key: "training", label: "Training", kind: "instructor" },
  { key: "code_of_conduct", label: "Code of conduct", kind: "instructor" },
  { key: "mandatory_reporter", label: "Mandatory reporter", kind: "instructor" },
  { key: "contractor_agreement", label: "Contractor agreement", kind: "instructor" },
];

/**
 * The set of required keys from partner_requirements_for() rows. When the
 * list could not be loaded (null), EVERY item counts as required: a host is
 * shown too much rather than having a real gap hidden from it. An EMPTY list
 * means the same: the function always returns every key to anyone allowed to
 * read it, and returns nothing (not an error) to anyone who isn't, so empty is
 * "could not tell", never "requires nothing".
 */
export function requiredKeys(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return new Set(REQUIREMENTS.map((r) => r.key));
  return new Set(rows.filter((r) => r.required).map((r) => r.requirement_key));
}

/** "as of" and source for a provider document (spec v3 display rules). */
export function documentProvenance(doc, orgName) {
  const by = `entered by ${(orgName || "").trim() || "the provider"}`;
  return provenance(doc?.updated_at ? String(doc.updated_at).slice(0, 10) : null, by);
}

// --- The instructor grid (Jessica 2026-10-26: "a table") --------------------

// The date each instructor column shows, and the word under its header saying
// what that date means, so one column never mixes "renews" with "completed".
export const GRID_DATE = {
  background_check: "renews",
  training: "completed",
  code_of_conduct: "signed",
  mandatory_reporter: "acknowledged",
  contractor_agreement: "signed",
};

/** The date behind an instructor cell, by requirement key. */
export function instructorCellDate(row, key) {
  return {
    background_check: row?.background_check_expires_on,
    training: row?.training_completed_on,
    code_of_conduct: row?.code_of_conduct_on,
    mandatory_reporter: row?.mandatory_reporter_on,
    contractor_agreement: row?.agreement_signed_on,
  }[key] ?? null;
}

/**
 * The text in one grid cell. A current item shows a check and its date (the
 * header says what the date means); anything needing attention shows the
 * spec v3 chip word itself, so status is never carried by colour alone.
 */
export function gridCellText(badge, date) {
  if (!badge) return "";
  if (badge.tone === "good") return date ? `✓ ${formatDate(date)}` : "✓ On file";
  if (badge.tone === "warn") return date ? `Expiring ${formatDate(date)}` : badge.label;
  return badge.label;
}

// --- The provider's Partner portal screen: one row per partner --------------

/**
 * The partners the provider has started a portal record for: any partner with
 * a document filed for it alone, or a login. A document shown to EVERY partner
 * doesn't count, or all of a provider's partners (J2S has 94, mostly schools)
 * would be listed. An archived partner stays listed while it still has a
 * document or a login, so nothing on file is hidden. Sorted by name; the rest are
 * reached from the "open another partner" picker.
 */
export function partnersInUse(partners, docs, grants) {
  const used = new Set([
    ...(docs || []).map((d) => d.partner_id).filter(Boolean),
    ...(grants || []).map((g) => g.partner_id).filter(Boolean),
  ]);
  return (partners || [])
    .filter((p) => used.has(p.id))
    .sort((a, b) => (a.partner_name || "").localeCompare(b.partner_name || ""));
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
 * One provider as one partner sees it, measured ONLY against what that partner
 * requires (`required`, a Set from requiredKeys()). Used by the partner home
 * row and the provider detail page, so the two can never disagree.
 *
 *   business:    one entry per REQUIRED business item: { key, label, badge, docs }
 *   alsoOnFile:  documents shown to this partner that no requirement asks for
 *                (listed quietly, never counted, never red)
 *   met / total: required business items that are Current or expiring
 *   instructors: { total, current, badge, columns } - columns are the required
 *                instructor items, in order; "current" means every one of them
 *   overall, rank, lastChange, sites
 */
export function providerSummary({ docs, instructors, partnerId, orgName, today, required }) {
  const need = required instanceof Set ? required : requiredKeys(null);
  const chipOf = (d) => EXPIRY_STATUS[d.expiry_status] ?? CHECK_STATUS.in_review;
  // Every insurance certificate must be current (a lapsed umbrella is a gap
  // even when the general liability is fine), so insurance takes the WORST.
  // One valid agreement or license is enough, so those take the BEST.
  const bestBadge = (list) => {
    const b = list.map(chipOf);
    if (!b.length) return null;
    return b.reduce((a, c) => ((TONE_RANK[c.tone] ?? 4) > (TONE_RANK[a.tone] ?? 4) ? c : a));
  };

  const business = REQUIREMENTS.filter((r) => r.kind === "business" && need.has(r.key)).map((r) => {
    const list = docsFor(docs, partnerId, r.doc);
    const badge = !list.length
      ? EXPIRED_OR_MISSING
      : r.key === "insurance" ? worstBadge(list.map(chipOf)) : bestBadge(list);
    return { key: r.key, label: r.label, badge, docs: list };
  });
  const countedTypes = new Set(business.map((b) => REQUIREMENTS.find((r) => r.key === b.key).doc));
  const alsoOnFile = (docs || []).filter(
    (d) => (!d.partner_id || d.partner_id === partnerId) && !countedTypes.has(d.doc_type),
  );
  const isOk = (badge) => badge?.tone === "good" || badge?.tone === "warn";
  const met = business.filter((b) => isOk(b.badge)).length;

  const columns = REQUIREMENTS.filter((r) => r.kind === "instructor" && need.has(r.key)).map((r) => r.key);
  const people = (instructors || []).map((row) => {
    const lines = instructorChecklist(row, orgName, today);
    // An instructor who has not given permission has one line (consent); it
    // stands for every column.
    return row.shared ? lines.filter((l) => columns.includes(l.key)) : lines;
  });
  const isCurrent = (lines) => lines.every((l) => isOk(l.badge));
  const currentCount = people.filter(isCurrent).length;
  const instructorBadge = people.length ? worstBadge(people.flat().map((l) => l.badge)) : null;

  const dates = [
    ...(docs || []).filter((d) => !d.partner_id || d.partner_id === partnerId).map((d) => d.updated_at && String(d.updated_at).slice(0, 10)),
    ...(instructors || []).flatMap((r) => [r.background_check_as_of, r.training_as_of, r.code_of_conduct_on, r.mandatory_reporter_on, r.agreement_signed_on]),
  ].filter(Boolean).sort();
  const lastChange = dates.length ? dates[dates.length - 1] : null;

  const overall = worstBadge([...business.map((b) => b.badge), instructorBadge]);
  return {
    business,
    alsoOnFile,
    met,
    total: business.length,
    instructors: { total: people.length, current: currentCount, badge: instructorBadge, columns },
    overall,
    lastChange,
    rank: TONE_RANK[overall?.tone] ?? 4,
    sites: [...new Set((instructors || []).flatMap((r) => r.sites || []))].sort(),
  };
}
