// The add / manage form for one document, opened from a partner's page
// (admin/PartnerRecord). Always for ONE partner: the page it is opened from.
//
// Adding: the kind is fixed when it comes from a requirement row ("Upload" on a
// missing Insurance certificate), otherwise picked. It goes to this partner, or
// to every partner when the provider says so.
//
// Every document has a Name, shown to partners. A new one takes it from the
// file name (titleFromFilename) unless the kind has its own default
// (certificate, business license); it is always editable.
//
// Managing a saved document: rename it, upload a new version, change its
// dates, or remove it. Its kind and who it is shown to are NOT editable (Jessica 2026-10-27:
// Edit on a certificate, with the kind changed to agreement, turned two parks'
// certificates into agreements and deleted the certificate files). A different
// document is added, never made by editing another. updateProviderDocument
// enforces the same thing for any other caller.

import { useRef, useState } from "react";
import {
  DOC_TYPES, docTypeLabel, blankDraft, draftFromRow, draftProblem, fileProblem, formatDate, titleFromFilename,
} from "../../lib/providerDocumentLogic.js";

// What a good name looks like, per kind.
const NAME_PLACEHOLDER = {
  insurance: "e.g. Certificate of liability insurance",
  agreement: "e.g. Scope of Work: Winter Classes 2027",
  business_license: "e.g. City of West Linn business license",
  other: "e.g. W-9",
};

const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const BRIGHT = "#5847C9";

const lbl = { display: "block", fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 };
const hint = { fontSize: 12.5, color: MUTED, marginTop: 6, lineHeight: 1.5 };
const input = { width: "100%", padding: "10px 12px", border: `1.5px solid ${RULE}`, borderRadius: 8, fontSize: 14, color: INK, background: "#fff", fontFamily: "inherit", boxSizing: "border-box" };
const fixed = { fontSize: 14, color: INK, padding: "2px 0" };

function primaryBtn(disabled) {
  return { padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 };
}
function secondaryBtn() {
  return { padding: "9px 16px", background: "#fff", color: INK, border: `1.5px solid ${RULE}`, borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" };
}

/**
 * `partner` is { id, partner_name } of the page this is opened from.
 * Add:    editing = null, kind = a DOC_TYPES key to fix the kind, or null to pick.
 * Manage: editing = the saved row; onRemove deletes it.
 */
export default function ProviderDocumentForm({ partner, editing, kind, onCancel, onSave, onRemove }) {
  const [draft, setDraft] = useState(() => {
    if (editing) return draftFromRow(editing);
    return { ...blankDraft(kind || "insurance"), partner_id: partner.id };
  });
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState("");
  const [busy, setBusy] = useState(""); // "" | "save" | "remove"
  const [error, setError] = useState("");

  const isInsurance = draft.doc_type === "insurance";
  const problem = draftProblem(draft, { hasFile: !!file || !!editing });
  // A renewal nearly always has a new expiry date; say so rather than save the old one silently.
  const staleExpiry = !!(editing && file && editing.expires_on && draft.expires_on === editing.expires_on);

  function set(field, value) { setDraft((d) => ({ ...d, [field]: value })); }

  // The name this form filled in itself (a kind's default, or one taken from
  // the file). A name the person typed is never replaced; one we filled in is.
  const autoTitle = useRef(editing ? null : draft.title);

  function isAutoTitle(title) {
    return !title.trim() || title === autoTitle.current;
  }

  function changeType(key) {
    setDraft((d) => {
      if (!isAutoTitle(d.title)) return { ...d, doc_type: key, no_expiry: key === "insurance" ? false : d.no_expiry };
      const nextDefault = DOC_TYPES.find((t) => t.key === key)?.defaultTitle ?? "";
      const title = nextDefault || (file ? titleFromFilename(file.name) : "");
      autoTitle.current = title;
      return { ...d, doc_type: key, title, no_expiry: key === "insurance" ? false : d.no_expiry };
    });
  }

  function onFileChange(e) {
    const f = e.target.files?.[0] ?? null;
    const p = fileProblem(f);
    setFileError(p ?? "");
    setFile(p ? null : f);
    // A new document with no name yet takes it from the file. Renewing an
    // existing one keeps its name (the file name is often a broker's code).
    if (!p && f && !editing) {
      setDraft((d) => {
        const kindDefault = DOC_TYPES.find((t) => t.key === d.doc_type)?.defaultTitle ?? "";
        if (!isAutoTitle(d.title) || (kindDefault && d.title === kindDefault)) return d;
        const title = titleFromFilename(f.name);
        autoTitle.current = title;
        return { ...d, title };
      });
    }
  }

  async function submit(e) {
    e.preventDefault();
    if (problem || busy) return;
    setBusy("save"); setError("");
    try {
      await onSave(draft, file);
    } catch (err) {
      setError(err?.message ? `Couldn't save: ${err.message}` : "Couldn't save the document. Please try again.");
      setBusy("");
    }
  }

  async function remove() {
    if (busy) return;
    const shared = !editing.partner_id ? " It's shared with every partner, so it goes from all of them." : "";
    const history = editing.versions?.length ? ` Its ${editing.versions.length} earlier version${editing.versions.length === 1 ? "" : "s"} go too.` : "";
    if (!window.confirm(`Remove "${editing.title}"?${shared}${history} This can't be undone.`)) return;
    setBusy("remove"); setError("");
    try {
      await onRemove(editing);
    } catch (err) {
      setError(`Couldn't remove it: ${err?.message ?? "unknown error"}`);
      setBusy("");
    }
  }

  const audience = draft.partner_id ? `${partner.partner_name} only` : "Every partner";

  return (
    <form onSubmit={submit} style={{ padding: 20 }}>
      <label style={lbl}>What kind of document</label>
      {editing || kind ? (
        <div style={fixed}>{docTypeLabel(draft.doc_type)}</div>
      ) : (
        <select value={draft.doc_type} onChange={(e) => changeType(e.target.value)} style={input}>
          {DOC_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      )}

      {/* Every document has a name partners can tell apart (2026-11-19): two
          agreements both called "Partner agreement" read as a duplicate. */}
      <label htmlFor="provider-doc-name" style={{ ...lbl, marginTop: 16 }}>Name</label>
      <input
        id="provider-doc-name" type="text" value={draft.title}
        onChange={(e) => set("title", e.target.value)}
        placeholder={NAME_PLACEHOLDER[draft.doc_type] ?? "e.g. W-9"} style={input}
      />
      <div style={hint}>
        {editing ? "This is the name partners see." : "This is the name partners see. It fills in from the file you choose; change it to anything clearer."}
      </div>

      <label style={{ ...lbl, marginTop: 16 }}>Shown to</label>
      {editing ? (
        <div style={fixed}>{audience}</div>
      ) : (
        <>
          <select value={draft.partner_id} onChange={(e) => set("partner_id", e.target.value)} style={input}>
            <option value={partner.id}>{partner.partner_name} only</option>
            <option value="">Every partner</option>
          </select>
          <div style={hint}>
            {!draft.partner_id
              ? "Every partner you work with will see this same file."
              : isInsurance
                ? "A certificate is usually made out to one partner. Choose every partner only for one that names no one."
                : "Choose every partner only when this same file is meant for all of them."}
          </div>
        </>
      )}

      <label style={{ ...lbl, marginTop: 16 }}>{editing ? "Upload a new version" : "File"}</label>
      <input type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" onChange={onFileChange} style={{ fontSize: 13 }} />
      <div style={hint}>
        {editing
          ? (file
              ? `Partners will see the new one. ${editing.original_filename || "The current file"} stays under Earlier versions.`
              : `On file now: ${editing.original_filename || "a file"}. Only choose one to replace it, for example when it's renewed.`)
          : "PDF, JPG or PNG, up to 10 MB."}
      </div>
      {fileError && <div style={{ ...hint, color: "#991b1b" }}>{fileError}</div>}

      <label style={{ ...lbl, marginTop: 16 }}>Expires</label>
      <input type="date" value={draft.no_expiry ? "" : draft.expires_on} disabled={draft.no_expiry} onChange={(e) => set("expires_on", e.target.value)} style={{ ...input, opacity: draft.no_expiry ? 0.5 : 1 }} />
      {!isInsurance && (
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 13, color: INK, cursor: "pointer" }}>
          <input type="checkbox" checked={draft.no_expiry} onChange={(e) => set("no_expiry", e.target.checked)} />
          This document doesn't expire
        </label>
      )}
      <div style={{ ...hint, color: staleExpiry ? "#92400e" : MUTED }}>
        {staleExpiry
          ? `Still ${formatDate(editing.expires_on)}? A renewed document usually has a new expiry date.`
          : "It's on the document. This is how partners know it's still current."}
      </div>

      {error && <div role="alert" style={{ marginTop: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 20, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12.5, color: MUTED, flex: "1 1 200px" }}>{problem && !busy ? problem : ""}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={onCancel} style={secondaryBtn()} disabled={!!busy}>Cancel</button>
          <button type="submit" style={primaryBtn(!!problem || !!busy)} disabled={!!problem || !!busy}>
            {busy === "save" ? "Saving…" : editing ? "Save changes" : "Add document"}
          </button>
        </div>
      </div>

      {editing && onRemove && (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${RULE}` }}>
          <button type="button" onClick={remove} disabled={!!busy} style={{ background: "none", border: "none", padding: 0, color: "#a13a3a", fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
            {busy === "remove" ? "Removing…" : "Remove this document"}
          </button>
        </div>
      )}
    </form>
  );
}
