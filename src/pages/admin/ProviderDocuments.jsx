// /admin/partner-documents - the papers a provider keeps on file for its
// partners: certificates of insurance, partner agreements, and anything a
// partner's own agreement asks for. Partner portal, chunk 1: the record and this
// entry screen. Partners will read these from their portal (chunk 2).
//
// Background checks, training and CPR are NOT entered here. They are per
// instructor and already recorded on each instructor's onboarding record; the
// partner view reads them there.
//
// Owners and admins add, edit and delete (provider_documents RLS:
// can_admin_org). Everyone else on the team can look. Expiry status comes from
// the database (provider_documents_with_status), never from a date comparison
// here, so this screen and the partner view always agree.

import { useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import ModalShell from "../../components/ModalShell.jsx";
import { usePermissions } from "../../lib/permissions.js";
import {
  DOC_TYPES, EXPIRY_STATUS, docTypeLabel, blankDraft, draftFromRow, draftProblem,
  fileProblem, groupByAudience, formatDate,
} from "../../lib/providerDocumentLogic.js";
import {
  listProviderDocuments, listPartners, createProviderDocument, updateProviderDocument,
  deleteProviderDocument, signedDocumentUrl,
} from "../../lib/providerDocuments.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const GREEN_BG = "#f0fdf4";
const GREEN_INK = "#166534";

const TONE = {
  good: { bg: "#f0fdf4", ink: "#166534", border: "#bbf7d0" },
  warn: { bg: "#fffbeb", ink: "#92400e", border: "#fde68a" },
  bad: { bg: "#fef2f2", ink: "#991b1b", border: "#fecaca" },
  neutral: { bg: "#f5f5f4", ink: "#57534e", border: "#e7e5e4" },
};

const lbl = { display: "block", fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 };
const hint = { fontSize: 12.5, color: MUTED, marginTop: 6, lineHeight: 1.5 };
const input = { width: "100%", padding: "10px 12px", border: `1.5px solid ${RULE}`, borderRadius: 8, fontSize: 14, color: INK, background: "#fff", fontFamily: "inherit", boxSizing: "border-box" };
const linkBtn = { background: "none", border: "none", padding: 0, color: BRIGHT, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" };

function primaryBtn(disabled) {
  return { padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 };
}
function secondaryBtn() {
  return { padding: "9px 16px", background: "#fff", color: INK, border: `1.5px solid ${RULE}`, borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" };
}

function StatusBadge({ status }) {
  const s = EXPIRY_STATUS[status] ?? EXPIRY_STATUS.no_expiry;
  const t = TONE[s.tone];
  return (
    <span style={{ display: "inline-block", padding: "2px 9px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: t.bg, color: t.ink, border: `1px solid ${t.border}`, whiteSpace: "nowrap" }}>
      {s.label}
    </span>
  );
}

function expiryLine(row) {
  if (!row.expires_on) return "Doesn't expire";
  return row.expiry_status === "expired" ? `Expired ${formatDate(row.expires_on)}` : `Expires ${formatDate(row.expires_on)}`;
}

function DocumentRow({ row, canManage, onOpen, onEdit, onDelete, busy }) {
  const isInsurance = row.doc_type === "insurance";
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start", justifyContent: "space-between", padding: "14px 0", borderTop: `1px solid ${RULE}`, flexWrap: "wrap" }}>
      <div style={{ minWidth: 0, flex: "1 1 260px" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 14.5, fontWeight: 600, color: INK }}>{row.title}</span>
          <StatusBadge status={row.expiry_status} />
        </div>
        <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5 }}>
          {docTypeLabel(row.doc_type)} · {expiryLine(row)}
          {row.received_on ? ` · Received ${formatDate(row.received_on)}` : ""}
        </div>
        {isInsurance && (
          <div style={{ fontSize: 13, color: MUTED, marginTop: 2, lineHeight: 1.5 }}>
            {[row.insurer, row.policy_number ? `Policy ${row.policy_number}` : null, row.coverage_notes].filter(Boolean).join(" · ")}
            {(row.insurer || row.policy_number || row.coverage_notes) ? " · " : ""}
            {row.abuse_coverage ? "Includes abuse and molestation coverage" : "Abuse and molestation coverage not marked"}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexShrink: 0, paddingTop: 2 }}>
        <button type="button" style={linkBtn} onClick={() => onOpen(row)} disabled={busy}>Open</button>
        {canManage && <button type="button" style={linkBtn} onClick={() => onEdit(row)} disabled={busy}>Edit</button>}
        {canManage && <button type="button" style={{ ...linkBtn, color: "#a13a3a" }} onClick={() => onDelete(row)} disabled={busy}>Delete</button>}
      </div>
    </div>
  );
}

function DocumentForm({ editing, partners, onCancel, onSave }) {
  const [draft, setDraft] = useState(() => (editing ? draftFromRow(editing) : blankDraft("insurance")));
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const activePartners = partners.filter((p) => !p.inactive || p.id === draft.partner_id);
  const isInsurance = draft.doc_type === "insurance";
  const problem = draftProblem(draft, { hasFile: !!file || !!editing });

  function set(field, value) { setDraft((d) => ({ ...d, [field]: value })); }

  function changeType(key) {
    setDraft((d) => {
      const oldDefault = DOC_TYPES.find((t) => t.key === d.doc_type)?.defaultTitle ?? "";
      const nextDefault = DOC_TYPES.find((t) => t.key === key)?.defaultTitle ?? "";
      // Only replace the name if the person hasn't typed their own.
      const title = !d.title.trim() || d.title === oldDefault ? nextDefault : d.title;
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
    if (problem || saving) return;
    setSaving(true); setError("");
    try {
      await onSave(draft, file);
    } catch (err) {
      setError(err?.message ? `Couldn't save: ${err.message}` : "Couldn't save the document. Please try again.");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ padding: 20 }}>
      <label style={lbl}>What kind of document</label>
      <select value={draft.doc_type} onChange={(e) => changeType(e.target.value)} style={input}>
        {DOC_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
      </select>

      <label style={{ ...lbl, marginTop: 16 }}>Name</label>
      <input type="text" value={draft.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Facility use agreement" style={input} />

      <label style={{ ...lbl, marginTop: 16 }}>Shown to</label>
      <select value={draft.partner_id} onChange={(e) => set("partner_id", e.target.value)} style={input}>
        <option value="">Every partner</option>
        {activePartners.map((p) => <option key={p.id} value={p.id}>{p.partner_name}</option>)}
      </select>
      <div style={hint}>
        {isInsurance
          ? "A certificate is usually made out to one partner. Pick that partner so only they see it."
          : "Pick a partner if this document is only for them."}
      </div>

      <label style={{ ...lbl, marginTop: 16 }}>File</label>
      <input type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" onChange={onFileChange} style={{ fontSize: 13 }} />
      <div style={hint}>
        {editing && !file
          ? `Current file: ${editing.original_filename || "on file"}. Choose a new one only to replace it.`
          : "PDF, JPG or PNG, up to 10 MB."}
      </div>
      {fileError && <div style={{ ...hint, color: "#991b1b" }}>{fileError}</div>}

      <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 180px" }}>
          <label style={lbl}>Received</label>
          <input type="date" value={draft.received_on} onChange={(e) => set("received_on", e.target.value)} style={input} />
        </div>
        <div style={{ flex: "1 1 180px" }}>
          <label style={lbl}>Starts</label>
          <input type="date" value={draft.effective_on} onChange={(e) => set("effective_on", e.target.value)} style={input} />
        </div>
      </div>

      <label style={{ ...lbl, marginTop: 16 }}>Expires</label>
      <input type="date" value={draft.no_expiry ? "" : draft.expires_on} disabled={draft.no_expiry} onChange={(e) => set("expires_on", e.target.value)} style={{ ...input, opacity: draft.no_expiry ? 0.5 : 1 }} />
      {!isInsurance && (
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 13, color: INK, cursor: "pointer" }}>
          <input type="checkbox" checked={draft.no_expiry} onChange={(e) => set("no_expiry", e.target.checked)} />
          This document doesn't expire
        </label>
      )}
      <div style={hint}>It's on the document. This is how partners know it's still current.</div>

      {isInsurance && (
        <div style={{ borderTop: `1px solid ${RULE}`, marginTop: 20, paddingTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 12 }}>From the certificate</div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5, color: INK, cursor: "pointer", fontWeight: 600 }}>
            <input type="checkbox" checked={draft.abuse_coverage} onChange={(e) => set("abuse_coverage", e.target.checked)} />
            Includes abuse and molestation coverage
          </label>
          <div style={hint}>Partners working with children usually ask for this. It's listed on the certificate if you have it.</div>

          <label style={{ ...lbl, marginTop: 16 }}>Insurance company</label>
          <input type="text" value={draft.insurer} onChange={(e) => set("insurer", e.target.value)} style={input} />

          <label style={{ ...lbl, marginTop: 16 }}>Policy number</label>
          <input type="text" value={draft.policy_number} onChange={(e) => set("policy_number", e.target.value)} style={input} />

          <label style={{ ...lbl, marginTop: 16 }}>Coverage amounts</label>
          <input type="text" value={draft.coverage_notes} onChange={(e) => set("coverage_notes", e.target.value)} placeholder="e.g. $1M per incident, $3M total" style={input} />
        </div>
      )}

      {error && <div style={{ marginTop: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 20, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12.5, color: MUTED, flex: "1 1 200px" }}>{problem && !saving ? problem : ""}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={onCancel} style={secondaryBtn()} disabled={saving}>Cancel</button>
          <button type="submit" style={primaryBtn(!!problem || saving)} disabled={!!problem || saving}>
            {saving ? "Saving…" : editing ? "Save changes" : "Add document"}
          </button>
        </div>
      </div>
    </form>
  );
}

export default function ProviderDocuments() {
  const { org } = useOutletContext();
  const perm = usePermissions();
  const canManage = perm.canManageSettings;

  const [docs, setDocs] = useState(null);
  const [partners, setPartners] = useState([]);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [form, setForm] = useState(null); // null | { editing: row|null }
  const [busyId, setBusyId] = useState(null);

  function flash(msg) { setToast(msg); setTimeout(() => setToast(""), 3500); }

  async function load() {
    if (!org?.id) return;
    try {
      const [d, p] = await Promise.all([listProviderDocuments(org.id), listPartners(org.id)]);
      setDocs(d);
      setPartners(p);
      setError("");
    } catch (err) {
      setError(`Couldn't load your documents: ${err?.message ?? "unknown error"}`);
      setDocs((prev) => prev ?? []);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [org?.id]);

  const groups = useMemo(() => groupByAudience(docs ?? [], partners), [docs, partners]);

  async function open(row) {
    // Open the tab synchronously so the browser doesn't treat it as a popup.
    const tab = window.open("", "_blank");
    try {
      const url = await signedDocumentUrl(row.storage_path);
      if (!url) throw new Error("no link");
      if (tab) tab.location.href = url; else window.location.href = url;
    } catch (err) {
      if (tab) tab.close();
      setError(`Couldn't open that file: ${err?.message ?? "unknown error"}`);
    }
  }

  async function save(draft, file) {
    const editing = form?.editing ?? null;
    if (editing) await updateProviderDocument(editing, draft, file);
    else await createProviderDocument(org.id, draft, file);
    setForm(null);
    flash(editing ? "Document updated." : "Document added.");
    await load();
  }

  async function remove(row) {
    if (!window.confirm(`Delete "${row.title}"? Partners will no longer see it. This can't be undone.`)) return;
    setBusyId(row.id); setError("");
    try {
      await deleteProviderDocument(row);
      flash("Document deleted.");
      await load();
    } catch (err) {
      setError(`Couldn't delete: ${err?.message ?? "unknown error"}`);
    } finally {
      setBusyId(null);
    }
  }

  if (docs === null) {
    return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>;
  }

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "8px 0 40px" }}>
      <Link to="/admin/settings" style={{ fontSize: 13, color: MUTED, textDecoration: "none" }}>← Settings</Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: "8px 0 4px", color: PURPLE, fontSize: 24, fontWeight: 700 }}>Documents for partners</h1>
          <p style={{ color: MUTED, fontSize: 14, marginTop: 0, lineHeight: 1.5, maxWidth: 580 }}>
            The papers your partners need from you: your insurance certificate, your agreement with them, and anything
            their agreement asks for. Partners will see these in their portal. Background checks and training come from
            each instructor's record, so you don't add them here.
          </p>
        </div>
        {canManage && (
          <button type="button" onClick={() => setForm({ editing: null })} style={primaryBtn(false)}>Add a document</button>
        )}
      </div>

      {error && <div style={{ marginTop: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}
      {toast && <div style={{ marginTop: 16, padding: "10px 12px", background: GREEN_BG, border: "1px solid #bbf7d0", borderRadius: 8, color: GREEN_INK, fontSize: 13 }}>{toast}</div>}

      {groups.length === 0 ? (
        <div style={{ marginTop: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: "28px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>No documents yet</div>
          <div style={{ ...hint, maxWidth: 440, margin: "6px auto 0" }}>
            {canManage
              ? "Start with your certificate of insurance. If your insurer made one out to each partner, add each one and pick that partner."
              : "An owner or admin on your team can add your insurance certificate and partner agreements here."}
          </div>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.key} style={{ marginTop: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: "16px 20px 6px" }}>
            <h2 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 700, color: INK }}>{g.label}</h2>
            {g.rows.map((row) => (
              <DocumentRow
                key={row.id}
                row={row}
                canManage={canManage}
                busy={busyId === row.id}
                onOpen={open}
                onEdit={(r) => setForm({ editing: r })}
                onDelete={remove}
              />
            ))}
          </section>
        ))
      )}

      {form && (
        <ModalShell title={form.editing ? "Edit document" : "Add a document"} onClose={() => setForm(null)} maxWidth={560}>
          <DocumentForm editing={form.editing} partners={partners} onCancel={() => setForm(null)} onSave={save} />
        </ModalShell>
      )}
    </div>
  );
}
