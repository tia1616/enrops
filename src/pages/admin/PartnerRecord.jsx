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
import { DocumentsTable, InstructorGrid, RecordSummary, RegistrationLine, RequirementsList } from "../partner/ProviderRecord.jsx";
import PartnerDecision from "../partner/PartnerDecision.jsx";
import ClassesTable from "../partner/ClassesTable.jsx";
import EmailsTheyGet from "../partner/EmailsTheyGet.jsx";
import MarketingAsksSection from "../partner/MarketingAsksSection.jsx";
import ProviderTodo from "./ProviderTodo.jsx";
import { partnerTodo } from "../../lib/partnerTodo.js";
import EmailsSent from "../partner/EmailsSent.jsx";
import { RecordTabRow, RecordTabPanel, RecordSection, useRecordTab, alertFor } from "../partner/RecordTabs.jsx";
import { decisionTag, worstAlert } from "../../lib/recordTabs.js";

// After To do, the partner's five tabs in the partner's order, then the two that only
// the provider has (what this partner requires, and its logins + activity).
// "todo" first: on the provider's own page, what's left to do comes before
// the record itself (2026-11-20).
// Four tabs (Jessica 2026-11-25: "too many tabs... can be grouped better").
// The old tabs are sections now; their #names (and To do's jump buttons) still
// open the right tab and scroll to the section.
const PROVIDER_TABS = ["todo", "classes", "safety", "people"];
const PROVIDER_TAB_ALIASES = {
  documents: "safety", instructors: "safety", decision: "safety", requirements: "safety",
  logins: "people", emails: "people",
};
import { todayIso } from "../partner/partnerShared.jsx";
import { usePermissions } from "../../lib/permissions.js";
import { listPartnerInstructors, listPartnerRequirements, getRequirementsControl } from "../../lib/partnerPortal.js";
import { providerSummary, requiredKeys, REQUIREMENTS } from "../../lib/partnerPortalLogic.js";
import {
  listProviderDocuments, getPartner, createProviderDocument, updateProviderDocument,
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
  const [tab, setTab] = useRecordTab(PROVIDER_TABS, PROVIDER_TAB_ALIASES);
  const [classCount, setClassCount] = useState(null);
  // Flyers / social graphics the partner asked for that aren't on a class yet
  // (ClassesTable reports them; 20261123r). Amber on the To do list, never red.
  const [mediaGaps, setMediaGaps] = useState([]);
  const [emailCount, setEmailCount] = useState(null);
  const [decision, setDecision] = useState(null);
  // undefined = loading, null = couldn't load (20261119p).
  const [reqControl, setReqControl] = useState(undefined);
  // An answer for a partner this page has since left is dropped.
  const reqControlFor = useRef(null);
  function loadReqControl() {
    const id = partnerId;
    reqControlFor.current = id;
    getRequirementsControl(id)
      .then((c) => { if (reqControlFor.current === id) setReqControl(c); })
      .catch(() => { if (reqControlFor.current === id) setReqControl(null); });
  }

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
    setClassCount(null); setEmailCount(null); setDecision(null); setReqControl(undefined);
    getPartner(org.id, partnerId)
      .then((p) => { if (!cancelled) setPartner(p); })
      .catch((err) => { if (!cancelled) { setPartner(null); setError(`Couldn't load this partner: ${err?.message ?? "unknown error"}`); } });
    listProviderDocuments(org.id)
      .then((d) => { if (!cancelled) setDocs(d); })
      .catch((err) => { if (!cancelled) { setDocs([]); setError(`Couldn't load your documents: ${err?.message ?? "unknown error"}`); } });
    listPartnerInstructors(partnerId)
      .then((r) => { if (!cancelled) setInstructors(r); })
      .catch((err) => { if (!cancelled) { setInstructors([]); setError(`Couldn't load instructors: ${err?.message ?? "unknown error"}`); } });
    loadReqControl();
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
  // What this partner still needs from the provider (2026-11-20), from the
  // same summary the partner sees.
  const todo = s ? partnerTodo({ s, instructors, orgName, today, mediaGaps, partnerName: partner?.partner_name }) : [];

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
    // contain: the instructor grid is wider than a laptop's content column. Without
    // it the admin layout's grid column grows to fit the table and the whole page
    // scrolls sideways; with it the tables scroll inside their own boxes, as on
    // the partner's portal.
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "8px 0 40px", contain: "inline-size" }}>
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
      {/* Pinned to the bottom of the screen: with the record in tabs, the
          action that raised it (a login sent, a document saved) can be far below
          the top of the page. */}
      {toast && <div role="status" style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: "calc(16px + env(safe-area-inset-bottom, 0px))", zIndex: 60, maxWidth: "calc(100vw - 32px)", padding: "10px 14px", background: GREEN_BG, border: "1px solid #bbf7d0", borderRadius: 8, color: GREEN_INK, fontSize: 13, boxShadow: "0 4px 14px rgba(0,0,0,0.12)" }}>{toast}</div>}

      {loading ? (
        <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>
      ) : (
        <>
          <RegistrationLine orgId={org?.id} />
          <RecordSummary s={s} />

          {/* Same tabs as the partner's page, plus the provider-only two
              (RecordTabs.jsx). */}
          <RecordTabRow
            active={tab} onChange={setTab}
            tabs={[
              { id: "todo", label: "To do", count: todo.length || null, alert: todo.some((t) => t.tone === "bad") ? "bad" : todo.length ? "attention" : null },
              { id: "classes", label: "Classes", count: classCount },
              {
                // Documents, instructors, what they require, their decision: one dot for the worst.
                id: "safety", label: "Safety record", tag: decisionTag(decision)?.text,
                alert: worstAlert(
                  alertFor(s.business.map((b) => b.badge)),
                  s.instructors.total ? alertFor([s.instructors.badge]) : null,
                  decisionTag(decision)?.alert ?? null,
                ),
              },
              { id: "people", label: "People & emails", count: emailCount },
            ]}
          />

          <RecordTabPanel id="todo" active={tab}>
            <ProviderTodo
              items={todo} partnerName={partner.partner_name} canManage={canManage}
              requirementsUnknown={requirements === null || requirements?.length === 0}
              onUpload={(key) => setForm({ editing: null, kind: DOC_FOR[key] })}
              onRenew={(doc) => setForm({ editing: doc, kind: null })}
              instructorPortalUrl={`${window.location.origin}/${org?.slug}/instructor`}
              onTab={setTab}
            />
          </RecordTabPanel>

          <RecordTabPanel id="classes" active={tab}>
            <ClassesTable
              key={`classes:${partnerId}`} partnerId={partnerId} orgId={org?.id} orgName={orgName}
              viewer="provider" partnerName={partner.partner_name} canEdit={canManage} onCount={setClassCount}
              onMediaGaps={setMediaGaps}
            />
          </RecordTabPanel>

          {/* Safety record (2026-11-25 regroup): what were the Documents,
              Instructors, What they require and Decision tabs, top to bottom. */}
          <RecordTabPanel id="safety" active={tab}>
            <RecordSection id="documents">
              <RequirementsList requirements={requirements} viewer="provider" partnerName={partner.partner_name} />
              <DocumentsTable
                s={s} orgName={orgName} today={today} onOpen={open}
                viewer="provider" partnerName={partner.partner_name} renderActions={actions}
              />
              {canManage && (
                <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
                  <button type="button" style={primaryBtn} onClick={() => setForm({ editing: null, kind: null })}>Add another document</button>
                </div>
              )}
            </RecordSection>
            <RecordSection id="instructors">
              {/* Keyed on the partner: a picked cell must never carry over. */}
              <InstructorGrid
                key={partnerId} s={s} instructors={instructors} orgName={orgName} today={today}
                viewer="provider" partnerName={partner.partner_name}
              />
            </RecordSection>
            <RecordSection id="requirements">
              {/* Keys are unique among siblings: two equal keys here once made
                  React render this section twice. */}
              <PartnerRequirementsSection
                key={`requirements:${partnerId}`} partner={partner} rows={requirements} canManage={canManage}
                onChange={setRequirements} control={reqControl} onSaved={loadReqControl}
              />
              <MarketingAsksSection key={`marketing:${partnerId}`} partner={partner} viewer="provider" orgName={orgName} />
            </RecordSection>
            <RecordSection id="decision">
              <PartnerDecision key={`decision:${partnerId}`} partnerId={partnerId} partnerName={partner.partner_name} onLatest={setDecision} />
            </RecordSection>
          </RecordTabPanel>

          {/* People & emails (2026-11-25 regroup): Logins, then what goes out
              automatically and to whom, then what has gone out. */}
          <RecordTabPanel id="people" active={tab}>
            <RecordSection id="logins">
              <PartnerLoginsSection key={`logins:${partnerId}`} org={org} partner={partner} canManage={canManage} onMessage={flash} />
            </RecordSection>
            <RecordSection id="emails">
              <EmailsTheyGet key={`get:${partnerId}`} orgId={org?.id} partnerId={partnerId} />
              <EmailsSent key={`emails:${partnerId}`} partnerId={partnerId} orgName={orgName} viewer="provider" partnerName={partner.partner_name} onCount={setEmailCount} />
            </RecordSection>
          </RecordTabPanel>
        </>
      )}

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
