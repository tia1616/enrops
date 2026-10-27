// The add / manage form for one document, opened from a partner's page
// (admin/PartnerRecord). Always for ONE partner: the page it is opened from.
//
// Adding: the kind is fixed when it comes from a requirement row ("Upload" on a
// missing Insurance certificate), otherwise picked. It goes to this partner, or
// to every partner when the provider says so.
//
// Managing a saved document: upload a new version, change its dates, or remove
// it. Its kind and who it is shown to are NOT editable (Jessica 2026-10-27:
// Edit on a certificate, with the kind changed to agreement, turned two parks'
// certificates into agreements and deleted the certificate files). A different
// document is added, never made by editing another. updateProviderDocument
// enforces the same thing for any other caller.

import { useState } from "react";
import {
  DOC_TYPES, docTypeLabel, blankDraft, draftFromRow, draftProblem, fileProblem, formatDate,
} from "../../lib/providerDocumentLogic.js";

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

  function changeType(key) {
    setDraft((d) => {
      const nextDefault = DOC_TYPES.find((t) => t.key === key)?.defaultTitle ?? "";
      // Only "Other document" shows a Name box, so every other kind takes its
      // own name; a name typed for "Other" must not ride along hidden.
      const title = key === "other" ? (d.doc_type === "other" ? d.title : "") : nextDefault;
      return { ...d, doc_type: key, title, no_expiry: key === "insurance" ? false : d.no_expiry };
    });
  }

  function onFileChange(e) {
    const f = e.target.files?.[0] ?? null;
    const p = fileProblem(f);
    setFileError(p ?? "");
    setFile(p ? null : f);
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
    if (!window.confirm(`Remove "${editing.title}"?${shared} This can't be undone.`)) return;
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

      {/* Only "Other document" needs a name; the rest are named by their kind. */}
      {draft.doc_type === "other" && (
        <>
          <label style={{ ...lbl, marginTop: 16 }}>Name</label>
          <input type="text" value={draft.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. W-9" style={input} />
        </>
      )}

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
              ? `This replaces ${editing.original_filename || "the current file"}. Partners will see the new one.`
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
