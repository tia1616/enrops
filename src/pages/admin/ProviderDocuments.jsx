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
import { useOutletContext } from "react-router-dom";
import ModalShell from "../../components/ModalShell.jsx";
import PartnerLoginsSection from "./PartnerLoginsSection.jsx";
import PartnerRequirementsSection from "./PartnerRequirementsSection.jsx";
import { usePermissions } from "../../lib/permissions.js";
import {
  DOC_TYPES, docTypeLabel, blankDraft, draftFromRow, draftProblem,
  fileProblem, groupByAudience, formatDate,
} from "../../lib/providerDocumentLogic.js";
import {
  listProviderDocuments, listPartners, createProviderDocument, updateProviderDocument,
  deleteProviderDocument, openDocumentInNewTab,
} from "../../lib/providerDocuments.js";
import DocumentStatusBadge from "../../components/DocumentStatusBadge.jsx";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const GREEN_BG = "#f0fdf4";
const GREEN_INK = "#166534";

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

const th = { padding: "10px 14px", borderBottom: `1px solid ${RULE}`, fontWeight: 700, whiteSpace: "nowrap" };
const td = { padding: "10px 14px", borderBottom: `1px solid ${RULE}`, verticalAlign: "middle" };

// One document as a table row: partner (on the group's first row only), the
// document and its kind, status, expiry, and the actions.
function DocumentRow({ row, partnerLabel, canManage, onOpen, onEdit, onDelete, busy }) {
  return (
    <tr>
      <td style={{ ...td, fontWeight: 600, color: INK }}>{partnerLabel}</td>
      <td style={td}>
        <div style={{ fontWeight: 600, color: INK }}>{row.title}</div>
        <div style={{ fontSize: 12, color: MUTED }}>{docTypeLabel(row.doc_type)}</div>
      </td>
      <td style={td}><DocumentStatusBadge status={row.expiry_status} /></td>
      <td style={{ ...td, color: MUTED, whiteSpace: "nowrap" }}>{row.expires_on ? formatDate(row.expires_on) : "Doesn't expire"}</td>
      <td style={{ ...td, whiteSpace: "nowrap", textAlign: "right" }}>
        <span style={{ display: "inline-flex", gap: 14 }}>
          <button type="button" style={linkBtn} onClick={() => onOpen(row)} disabled={busy}>Open</button>
          {canManage && <button type="button" style={linkBtn} onClick={() => onEdit(row)} disabled={busy}>Edit</button>}
          {canManage && <button type="button" style={{ ...linkBtn, color: "#a13a3a" }} onClick={() => onDelete(row)} disabled={busy}>Delete</button>}
        </span>
      </td>
    </tr>
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

      {/* Only "Other document" needs a name; the rest are named by their kind
          ("Certificate of insurance"), which changeType keeps in step. */}
      {draft.doc_type === "other" && (
        <>
          <label style={{ ...lbl, marginTop: 16 }}>Name</label>
          <input type="text" value={draft.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. W-9" style={input} />
        </>
      )}

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

      <label style={{ ...lbl, marginTop: 16 }}>Expires</label>
      <input type="date" value={draft.no_expiry ? "" : draft.expires_on} disabled={draft.no_expiry} onChange={(e) => set("expires_on", e.target.value)} style={{ ...input, opacity: draft.no_expiry ? 0.5 : 1 }} />
      {!isInsurance && (
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 13, color: INK, cursor: "pointer" }}>
          <input type="checkbox" checked={draft.no_expiry} onChange={(e) => set("no_expiry", e.target.checked)} />
          This document doesn't expire
        </label>
      )}
      <div style={hint}>It's on the document. This is how partners know it's still current.</div>

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

  // Partners are loaded once: nothing on this screen changes them. Documents
  // reload after every add, edit and delete.
  async function load({ withPartners = false } = {}) {
    if (!org?.id) return;
    try {
      const [d, p] = await Promise.all([
        listProviderDocuments(org.id),
        withPartners ? listPartners(org.id) : Promise.resolve(null),
      ]);
      setDocs(d);
      if (p) setPartners(p);
      setError("");
    } catch (err) {
      setError(`Couldn't load your documents: ${err?.message ?? "unknown error"}`);
      setDocs((prev) => prev ?? []);
    }
  }

  useEffect(() => { load({ withPartners: true }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [org?.id]);

  const groups = useMemo(() => groupByAudience(docs ?? [], partners), [docs, partners]);

  async function open(row) {
    const problem = await openDocumentInNewTab(row.storage_path);
    if (problem) setError(problem);
  }

  async function save(draft, file) {
    const thisForm = form;
    const editing = thisForm?.editing ?? null;
    if (editing) await updateProviderDocument(editing, draft, file);
    else await createProviderDocument(org.id, draft, file);
    // Close only the form this save came from. If it was dismissed while saving
    // and another one opened, leave the new one alone.
    setForm((current) => (current === thisForm ? null : current));
    flash(editing ? "Document updated." : "Document added.");
    await load();
  }

  async function remove(row) {
    if (!window.confirm(`Delete "${row.title}"? This can't be undone.`)) return;
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: "8px 0 4px", color: PURPLE, fontSize: 24, fontWeight: 700 }}>Partner portal</h1>
          <p style={{ color: MUTED, fontSize: 14, marginTop: 0, lineHeight: 1.5, maxWidth: 580 }}>
            What your partners see when they log in: your insurance certificate, your agreement with them, and anything
            else their agreement asks for, plus your instructors at their sites. Background checks and training come
            from each instructor's record, so you don't add them here.
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
        // One table (Jessica 2026-10-26: "a table"), grouped by partner: the
        // partner's name on its first row, its documents soonest-expiring first.
        <section style={{ marginTop: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5, minWidth: 620 }}>
            <thead>
              <tr style={{ textAlign: "left", color: MUTED, fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4 }}>
                <th style={th}>Partner</th>
                <th style={th}>Document</th>
                <th style={th}>Status</th>
                <th style={th}>Expires</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {groups.flatMap((g) => g.rows.map((row, i) => (
                <DocumentRow
                  key={row.id}
                  row={row}
                  partnerLabel={i === 0 ? g.label : ""}
                  canManage={canManage}
                  busy={busyId === row.id}
                  onOpen={open}
                  onEdit={(r) => setForm({ editing: r })}
                  onDelete={remove}
                />
              )))}
            </tbody>
          </table>
        </section>
      )}

      <PartnerRequirementsSection partners={partners} canManage={canManage} />

      <PartnerLoginsSection org={org} partners={partners} canManage={canManage} onMessage={flash} />

      {form && (
        <ModalShell title={form.editing ? "Edit document" : "Add a document"} onClose={() => setForm(null)} maxWidth={560}>
          <DocumentForm editing={form.editing} partners={partners} onCancel={() => setForm(null)} onSave={save} />
        </ModalShell>
      )}
    </div>
  );
}
