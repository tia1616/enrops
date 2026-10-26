// The pure rules for provider documents (the papers a provider keeps on file for
// its partners). Split from providerDocuments.js, which talks to Supabase, so
// these can be tested without a client - the same split as classPhotoLogic.js.
//
// Nothing here decides who may see or change a document. That is the
// provider_documents RLS and the provider-documents bucket. Expiry STATUS is not
// computed here either: it comes from private.document_expiry_status() through
// provider_documents_with_status, so the admin screen, the partner view and the
// alert job can never disagree about what "expires soon" means.

export const DOC_TYPES = [
  { key: "insurance", label: "Insurance certificate", defaultTitle: "Certificate of liability insurance" },
  { key: "agreement", label: "Partner agreement", defaultTitle: "Partner agreement" },
  { key: "business_license", label: "Business license", defaultTitle: "Business license" },
  { key: "other", label: "Other document", defaultTitle: "" },
];

export function docTypeLabel(key) {
  return DOC_TYPES.find((t) => t.key === key)?.label ?? "Document";
}

// Words for the status the database returns. Keyed by the exact values
// private.document_expiry_status() can produce.
//
// ARIELLE'S SIX CHIP WORDS (spec v3, Oct 19, used exactly): Current / Expiring
// in 30 days / Expired or Missing / In review / Host-run / Not required.
// "Expired or Missing" is ONE label on purpose, so a failed check can never be
// told apart from a lapsed one. A document that never expires is on file and
// valid, so it is Current; "No expiry date" is shown beside it, not as the chip.
// "Expiring in 30 days" is true only while expiring_soon means within 30 days
// (20261012b), so change both together.
export const EXPIRED_OR_MISSING = { label: "Expired or Missing", tone: "bad" };
export const EXPIRY_STATUS = {
  current: { label: "Current", tone: "good" },
  expiring_soon: { label: "Expiring in 30 days", tone: "warn" },
  expired: EXPIRED_OR_MISSING,
  no_expiry: { label: "Current", tone: "good" },
};

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // matches the bucket's file_size_limit
const ALLOWED = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

function extFromName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

/** The file extension to store under, or null when the file is not a type the bucket accepts. */
export function storedExtension(file) {
  if (!file) return null;
  if (ALLOWED[file.type]) return ALLOWED[file.type];
  // Some browsers send an empty type for a PDF dragged from certain apps.
  const ext = extFromName(file.name);
  if (ext === "pdf") return "pdf";
  if (ext === "jpg" || ext === "jpeg") return "jpg";
  if (ext === "png") return "png";
  return null;
}

/** A person-facing reason the file cannot be used, or null when it is fine. */
export function fileProblem(file) {
  if (!file) return null;
  if (!storedExtension(file)) return "Use a PDF, or a JPG or PNG photo of the document.";
  if (file.size > MAX_FILE_BYTES) return "That file is over 10 MB. Try a smaller scan or a PDF.";
  return null;
}

/**
 * Where the file lives in the bucket. The first folder MUST be the provider's id:
 * the bucket's upload policy and the table's path constraint both key on it.
 */
export function storagePathFor(orgId, file, id) {
  const ext = storedExtension(file) || "pdf";
  return `${orgId}/${id}.${ext}`;
}

/** An empty form for a new document. */
export function blankDraft(type = "insurance") {
  const t = DOC_TYPES.find((d) => d.key === type) ?? DOC_TYPES[0];
  return {
    doc_type: t.key,
    title: t.defaultTitle,
    partner_id: "", // "" = every partner
    received_on: "",
    effective_on: "",
    expires_on: "",
    no_expiry: false,
  };
}

// A document is the file, who it's for, and when it expires (Jessica
// 2026-10-26, 20261026b). Nothing is typed off it: the partner reads the
// certificate itself. received_on / effective_on stay in the table but the
// form no longer asks for them.

/** A form pre-filled from a saved row, for editing. */
export function draftFromRow(row) {
  return {
    doc_type: row.doc_type,
    title: row.title ?? "",
    partner_id: row.partner_id ?? "",
    received_on: row.received_on ?? "",
    effective_on: row.effective_on ?? "",
    expires_on: row.expires_on ?? "",
    no_expiry: row.doc_type !== "insurance" && !row.expires_on,
  };
}

/**
 * The first thing wrong with the form, in words, or null when it can be saved.
 * `hasFile` is true when a file is chosen now or the document already has one.
 * Mirrors the table's CHECK constraints so the person hears about a problem
 * before the database refuses it.
 */
export function draftProblem(draft, { hasFile }) {
  if (!DOC_TYPES.some((t) => t.key === draft.doc_type)) return "Choose what kind of document this is.";
  if (!draft.title || !draft.title.trim()) return "Give the document a name.";
  if (!hasFile) return "Attach the document file.";
  if (draft.doc_type === "insurance" && !draft.expires_on) return "Insurance needs an expiry date. It's on the certificate, usually under \"Policy exp\".";
  if (draft.doc_type !== "insurance" && !draft.no_expiry && !draft.expires_on) return "Add the expiry date, or tick \"This document doesn't expire\".";
  if (draft.effective_on && draft.expires_on && draft.expires_on < draft.effective_on) return "The expiry date is before the start date.";
  return null;
}

/** The columns to write. */
export function rowFromDraft(draft) {
  const keepExpiry = draft.doc_type === "insurance" || !draft.no_expiry;
  return {
    doc_type: draft.doc_type,
    title: draft.title.trim(),
    partner_id: draft.partner_id || null,
    received_on: draft.received_on || null,
    effective_on: draft.effective_on || null,
    expires_on: keepExpiry ? (draft.expires_on || null) : null,
  };
}

/** Soonest expiry first; a document with no expiry date sorts last. */
export function compareByExpiry(a, b) {
  return (a.expires_on || "9999-12-31").localeCompare(b.expires_on || "9999-12-31");
}

/**
 * Group documents by who sees them: "Every partner" first, then each partner by
 * name. A row whose partner is missing from `partners` (archived, or not loaded)
 * still appears, under a neutral label, so nothing on file is ever hidden.
 */
export function groupByAudience(rows, partners) {
  const names = new Map((partners || []).map((p) => [p.id, p.partner_name]));
  const groups = new Map();
  for (const r of rows || []) {
    const key = r.partner_id || "all";
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: key === "all" ? "Every partner" : (names.get(key) ?? "A partner no longer in your list"),
        rows: [],
      });
    }
    groups.get(key).rows.push(r);
  }
  const all = groups.get("all");
  const rest = [...groups.values()].filter((g) => g.key !== "all").sort((a, b) => a.label.localeCompare(b.label));
  for (const g of groups.values()) {
    g.rows.sort(compareByExpiry);
  }
  return all ? [all, ...rest] : rest;
}

/** "Jan 17, 2027" from a YYYY-MM-DD date, without a timezone shift. */
export function formatDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
