// /admin/partner-documents/:partnerId - one partner's page in the provider's
// Partner portal admin (Jessica 2026-10-27: "I click on a partner name, and see
// a list of needed and provided documents, and I should see basically the same
// info that they see about us").
//
// The record in the middle IS the partner's view: ProviderRecord.jsx, the same
// components the partner's portal renders, counted by the same providerSummary().
// The provider's buttons sit on its rows: Upload on a missing requirement (the
// kind already set, so a file can't land in the wrong slot), View and Manage on
// a document. Below it, the two things that are this partner's alone: what they
// require, and who at the partner can log in.
//
// Role is gated by AdminLayout (the Partner portal nav item, gate "settings",
// matches this path by prefix); writes by provider_documents RLS and the bucket
// policies (can_admin_org). The reads are the ones the partner's own page makes,
// which also allow the provider's owner/admin.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import ModalShell from "../../components/ModalShell.jsx";
import ProviderDocumentForm from "./ProviderDocumentForm.jsx";
import PartnerLoginsSection from "./PartnerLoginsSection.jsx";
import PartnerRequirementsSection from "./PartnerRequirementsSection.jsx";
import { DocumentsTable, InstructorGrid, RecordSummary } from "../partner/ProviderRecord.jsx";
import { todayIso } from "../partner/partnerShared.jsx";
import { usePermissions } from "../../lib/permissions.js";
import { listPartnerInstructors, listPartnerRequirements } from "../../lib/partnerPortal.js";
import { providerSummary, requiredKeys, REQUIREMENTS } from "../../lib/partnerPortalLogic.js";
import {
  listProviderDocuments, listPartners, createProviderDocument, updateProviderDocument,
  deleteProviderDocument, openDocumentInNewTab,
} from "../../lib/providerDocuments.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const MUTED = "#6b6b6b";
const GREEN_BG = "#f0fdf4";
const GREEN_INK = "#166534";

const linkBtn = { background: "none", border: "none", padding: 0, color: BRIGHT, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" };
const primaryBtn = { padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" };

const DOC_FOR = Object.fromEntries(REQUIREMENTS.filter((r) => r.doc).map((r) => [r.key, r.doc]));

export default function PartnerRecord() {
  const { partnerId } = useParams();
  const { org } = useOutletContext();
  const perm = usePermissions();
  const canManage = perm.canManageSettings;

  const [partner, setPartner] = useState(undefined); // undefined = loading, null = not this provider's
  const [docs, setDocs] = useState(null);
  const [instructors, setInstructors] = useState(null);
  // undefined = loading, null = could not load (everything then counts as
  // required, as on the partner's own page).
  const [requirements, setRequirements] = useState(undefined);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [form, setForm] = useState(null); // null | { editing: row|null, kind: string|null }
  const opening = useRef(false);

  function flash(msg) { setToast(msg); setTimeout(() => setToast(""), 3500); }

  async function loadDocs() {
    try {
      setDocs(await listProviderDocuments(org.id));
      setError("");
    } catch (err) {
      setError(`Couldn't load your documents: ${err?.message ?? "unknown error"}`);
      setDocs((prev) => prev ?? []);
    }
  }

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    setPartner(undefined); setDocs(null); setInstructors(null); setRequirements(undefined); setError(""); setForm(null);
    listPartners(org.id)
      .then((ps) => { if (!cancelled) setPartner(ps.find((p) => p.id === partnerId) ?? null); })
      .catch((err) => { if (!cancelled) { setPartner(null); setError(`Couldn't load this partner: ${err?.message ?? "unknown error"}`); } });
    listProviderDocuments(org.id)
      .then((d) => { if (!cancelled) setDocs(d); })
      .catch((err) => { if (!cancelled) { setDocs([]); setError(`Couldn't load your documents: ${err?.message ?? "unknown error"}`); } });
    listPartnerInstructors(partnerId)
      .then((r) => { if (!cancelled) setInstructors(r); })
      .catch((err) => { if (!cancelled) { setInstructors([]); setError(`Couldn't load instructors: ${err?.message ?? "unknown error"}`); } });
    listPartnerRequirements(partnerId)
      .then((r) => { if (!cancelled) setRequirements(r); })
      .catch(() => { if (!cancelled) setRequirements(null); });
    return () => { cancelled = true; };
  }, [org?.id, partnerId]);

  const shown = useMemo(() => (docs ?? []).filter((d) => !d.partner_id || d.partner_id === partnerId), [docs, partnerId]);

  if (partner === undefined) {
    return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>;
  }
  if (partner === null) {
    return (
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "40px 0", textAlign: "center", color: MUTED }}>
        {error || "This partner isn't in your list."}{" "}
        <Link to="/admin/partner-documents" style={{ color: BRIGHT, fontWeight: 600 }}>Back to Partner portal</Link>
      </div>
    );
  }

  const today = todayIso();
  const orgName = org.name;
  const loading = docs === null || instructors === null || requirements === undefined;
  const s = loading ? null : providerSummary({
    docs: shown, instructors, partnerId, orgName, today, required: requiredKeys(requirements),
  });

  async function open(d) {
    // A second click while the file is on its way would open it twice.
    if (opening.current) return;
    opening.current = true;
    setError("");
    try {
      const problem = await openDocumentInNewTab(d.storage_path);
      if (problem) setError(problem);
    } finally {
      opening.current = false;
    }
  }

  async function save(draft, file) {
    const thisForm = form;
    const editing = thisForm?.editing ?? null;
    if (editing) await updateProviderDocument(editing, draft, file);
    else await createProviderDocument(org.id, draft, file);
    // Close only the form this save came from.
    setForm((current) => (current === thisForm ? null : current));
    flash(editing ? "Saved." : "Document added.");
    await loadDocs();
  }

  async function remove(row) {
    const thisForm = form;
    await deleteProviderDocument(row);
    setForm((current) => (current === thisForm ? null : current));
    flash("Document removed.");
    await loadDocs();
  }

  const actions = ({ d, requirementKey }) => {
    if (d) {
      return (
        <span style={{ display: "inline-flex", gap: 14 }}>
          <button type="button" style={linkBtn} onClick={() => open(d)}>View</button>
          {canManage && <button type="button" style={linkBtn} onClick={() => setForm({ editing: d, kind: null })}>Manage</button>}
        </span>
      );
    }
    return canManage && requirementKey && DOC_FOR[requirementKey]
      ? <button type="button" style={linkBtn} onClick={() => setForm({ editing: null, kind: DOC_FOR[requirementKey] })}>Upload</button>
      : null;
  };

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "8px 0 40px" }}>
      <Link to="/admin/partner-documents" style={{ fontSize: 13, color: MUTED, textDecoration: "none" }}>← All partners</Link>
      <h1 style={{ margin: "8px 0 4px", color: PURPLE, fontSize: 24, fontWeight: 700 }}>{partner.partner_name}</h1>
      <p style={{ color: MUTED, fontSize: 14, marginTop: 0, lineHeight: 1.5, maxWidth: 620 }}>
        This is what {partner.partner_name} sees when they log in. Upload what's missing and keep each document current
        here; background checks and training come from each instructor's record.
      </p>
      {partner.inactive && (
        <div style={{ marginTop: 8, fontSize: 13, color: "#92400e" }}>This partner is archived, so no one there can see this until it's active again.</div>
      )}

      {error && <div role="alert" style={{ marginTop: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}
      {toast && <div role="status" style={{ marginTop: 16, padding: "10px 12px", background: GREEN_BG, border: "1px solid #bbf7d0", borderRadius: 8, color: GREEN_INK, fontSize: 13 }}>{toast}</div>}

      {loading ? (
        <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>
      ) : (
        <>
          <RecordSummary s={s} />
          <DocumentsTable
            s={s} orgName={orgName} today={today} onOpen={open}
            viewer="provider" partnerName={partner.partner_name} renderActions={actions}
          />
          {canManage && (
            <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
              <button type="button" style={primaryBtn} onClick={() => setForm({ editing: null, kind: null })}>Add another document</button>
            </div>
          )}
          {/* Keyed on the partner: a picked cell must never carry over. */}
          <InstructorGrid
            key={partnerId} s={s} instructors={instructors} orgName={orgName} today={today}
            viewer="provider" partnerName={partner.partner_name}
          />
        </>
      )}

      {requirements !== undefined && (
        <PartnerRequirementsSection partner={partner} rows={requirements} canManage={canManage} onChange={setRequirements} />
      )}

      <PartnerLoginsSection key={partnerId} org={org} partner={partner} canManage={canManage} onMessage={flash} />

      {form && (
        <ModalShell title={form.editing ? "Manage document" : `Add a document for ${partner.partner_name}`} onClose={() => setForm(null)} maxWidth={560}>
          <ProviderDocumentForm
            partner={partner} editing={form.editing} kind={form.kind}
            onCancel={() => setForm(null)} onSave={save} onRemove={remove}
          />
        </ModalShell>
      )}
    </div>
  );
}
