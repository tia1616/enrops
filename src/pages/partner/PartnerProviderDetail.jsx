// /partner/:partnerId - one provider's safety record, as one partner sees it
// (spec v3 H2). Two tables, the way compliance tools present it (Jessica
// 2026-10-26: the business and the instructors in one table "is confusing"):
//   1. Documents: one row per document this partner requires, with its status,
//      expiry, "as of" and a View link. The partner reads the certificate
//      itself; nothing is typed off it (20261026b).
//   2. Instructors: one row per instructor at this partner's sites, one column
//      per required item. Each cell is a check and a date, or the spec v3 chip
//      word when something needs attention, plus its "as of"; click a cell for
//      the source and details.
// Both tables scroll sideways on a phone, first column frozen, rather than
// turning into cards. Only what this partner requires is shown
// (partner_requirements_for, 20261026a). The tables themselves are
// ProviderRecord.jsx, shared with the provider's own page for this partner.
//
// :partnerId is the partner row, which belongs to exactly one provider, so it
// names both "who is looking" and "whose record". The page shows nothing unless
// this login holds that grant (partner_portal_memberships); every read below is
// also refused by the database for anyone else.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { listPartnerInstructors, listPartnerRequirements, logPartnerPortalEvent, getRequirementsControl } from "../../lib/partnerPortal.js";
import PartnerRequirementsSection from "../admin/PartnerRequirementsSection.jsx";
import { listProviderDocuments, openDocumentInNewTab } from "../../lib/providerDocuments.js";
import { providerSummary, requiredKeys } from "../../lib/partnerPortalLogic.js";
import { PartnerShell, PartnerSignIn, NoAccess, useMemberships, todayIso } from "./partnerShared.jsx";
import { DocumentsTable, InstructorGrid, RecordSummary, RegistrationLine, RequirementsList } from "./ProviderRecord.jsx";
import PartnerDecision from "./PartnerDecision.jsx";
import ClassesTable from "./ClassesTable.jsx";
import MarketingAsksSection from "./MarketingAsksSection.jsx";
import EmailsSent from "./EmailsSent.jsx";
import { RecordTabRow, RecordTabPanel, RecordSection, SectionJumps, useRecordTab, alertFor } from "./RecordTabs.jsx";
import { decisionTag, worstAlert } from "../../lib/recordTabs.js";

// Three tabs (Jessica 2026-11-25: enrollment first, then "too many tabs").
// Classes opens by default; the old tabs are sections of Safety record, and
// their #names (in emails already sent) still open it at that section.
const PARTNER_TABS = ["classes", "safety", "emails"];
const PARTNER_TAB_ALIASES = { documents: "safety", instructors: "safety", requirements: "safety", decision: "safety", marketing: "classes" };
// The jump row at the top of Safety record (Jessica 2026-11-25: "and requirements?").
const CLASSES_SECTIONS = [{ id: "marketing", label: "Flyers you ask for" }];
const SAFETY_SECTIONS = [
  { id: "documents", label: "Documents" }, { id: "instructors", label: "Instructors" },
  { id: "requirements", label: "Requirements" }, { id: "decision", label: "Decision" },
];

export default function PartnerProviderDetail() {
  const { partnerId } = useParams();
  const { user, authLoading, signOut, memberships, error } = useMemberships();
  const m = useMemo(() => (memberships ?? []).find((x) => x.partner_id === partnerId) ?? null, [memberships, partnerId]);

  const [docs, setDocs] = useState(null);
  const [instructors, setInstructors] = useState(null);
  // undefined = loading, null = could not load (everything then counts as
  // required: a host sees too much rather than having a gap hidden).
  const [requirements, setRequirements] = useState(undefined);
  const [loadError, setLoadError] = useState("");
  const [openError, setOpenError] = useState("");
  const opening = useRef(false);
  const [tab, setTab] = useRecordTab(PARTNER_TABS, PARTNER_TAB_ALIASES,
    !!m && docs !== null && instructors !== null && requirements !== undefined);
  // Bumped when the partner saves a marketing ask, so Classes re-reads it.
  const [marketingVersion, setMarketingVersion] = useState(0);
  const [classCount, setClassCount] = useState(null);
  const [emailCount, setEmailCount] = useState(null);
  const [decision, setDecision] = useState(null);
  // undefined = loading, null = couldn't load (20261119p).
  const [reqControl, setReqControl] = useState(undefined);
  const reqControlFor = useRef(null);
  function loadReqControl(partnerId) {
    reqControlFor.current = partnerId;
    getRequirementsControl(partnerId)
      .then((c) => { if (reqControlFor.current === partnerId) setReqControl(c); })
      .catch(() => { if (reqControlFor.current === partnerId) setReqControl(null); });
  }

  useEffect(() => {
    setDocs(null); setInstructors(null); setRequirements(undefined); setLoadError("");
    setClassCount(null); setEmailCount(null); setDecision(null); setReqControl(undefined);
    if (!m) return;
    let cancelled = false;
    // The view log: this partner opened this provider's record.
    logPartnerPortalEvent(m.partner_id, "portal_viewed");
    listProviderDocuments(m.organization_id)
      .then((d) => { if (!cancelled) setDocs(d.filter((x) => !x.partner_id || x.partner_id === m.partner_id)); })
      .catch((err) => { if (!cancelled) { setDocs([]); setLoadError(`Couldn't load documents: ${err?.message ?? "unknown error"}`); } });
    listPartnerInstructors(m.partner_id)
      .then((r) => { if (!cancelled) setInstructors(r); })
      .catch((err) => { if (!cancelled) { setInstructors([]); setLoadError(`Couldn't load instructors: ${err?.message ?? "unknown error"}`); } });
    loadReqControl(m.partner_id);
    listPartnerRequirements(m.partner_id)
      .then((r) => { if (!cancelled) setRequirements(r); })
      .catch(() => { if (!cancelled) setRequirements(null); });
    return () => { cancelled = true; };
  }, [m]);

  if (authLoading) return <PartnerShell><p className="py-24 text-center text-j2s-ink/60">Loading…</p></PartnerShell>;
  if (!user) return <PartnerShell><PartnerSignIn /></PartnerShell>;
  if (memberships === null) return <PartnerShell onSignOut={signOut}><p className="py-24 text-center text-j2s-ink/60">Loading…</p></PartnerShell>;
  if (memberships.length === 0) return <PartnerShell onSignOut={signOut}><NoAccess email={user.email} onSignOut={signOut} /></PartnerShell>;
  if (!m) {
    return (
      <PartnerShell onSignOut={signOut}>
        <p className="py-16 text-center text-j2s-ink/70">
          This record isn't shared with you. <Link to="/partner" className="font-semibold text-j2s-purple hover:underline">See your providers</Link>
        </p>
      </PartnerShell>
    );
  }

  const today = todayIso();
  const orgName = m.organization_name;
  const loading = docs === null || instructors === null || requirements === undefined;
  const s = loading ? null : providerSummary({
    docs, instructors, partnerId: m.partner_id, orgName, today, required: requiredKeys(requirements),
  });

  async function open(d) {
    // A second tap while the file is on its way would sign and log it twice.
    if (opening.current) return;
    opening.current = true;
    setOpenError("");
    try {
      const problem = await openDocumentInNewTab(d.storage_path, {
        onOpened: () => logPartnerPortalEvent(m.partner_id, "document_opened", d.id),
      });
      if (problem) setOpenError(problem);
    } finally {
      opening.current = false;
    }
  }

  return (
    <PartnerShell onSignOut={signOut} feedbackOrg={{ id: m.organization_id }}>
      <Link to="/partner" className="text-sm text-j2s-ink/60 hover:underline">← All providers</Link>
      <div className="mt-2 text-sm font-semibold uppercase tracking-wide text-j2s-ink/50">{m.partner_name}</div>
      <h1 className="mt-1 text-3xl font-bold text-j2s-ink">{orgName}</h1>
      <RegistrationLine orgId={m.organization_id} />

      {(error || loadError || openError) && <p className="error-text mt-4">{error || loadError || openError}</p>}

      {loading ? (
        <p className="mt-8 text-j2s-ink/60">Loading…</p>
      ) : (
        <>
          <RecordSummary s={s} />
          {(requirements === null || requirements?.length === 0) && (
            <p className="mt-2 text-xs text-j2s-ink/50">Showing every standard requirement: your list couldn't be loaded just now.</p>
          )}

          {/* One section per tab; the summary above shows on every tab
              (RecordTabs.jsx). */}
          <RecordTabRow
            sticky
            active={tab} onChange={setTab}
            tabs={[
              { id: "classes", label: "Classes", count: classCount },
              {
                // Documents, instructors, requirements, decision: one dot for the worst.
                id: "safety", label: "Safety record", tag: decisionTag(decision)?.text,
                alert: worstAlert(
                  alertFor(s.business.map((b) => b.badge)),
                  s.instructors.total ? alertFor([s.instructors.badge]) : null,
                  decisionTag(decision)?.alert ?? null,
                ),
              },
              { id: "emails", label: "Emails sent", count: emailCount },
            ]}
          />

          <RecordTabPanel id="classes" active={tab}>
            {/* The asks sit below a long class list; this makes them findable. */}
            <SectionJumps sections={CLASSES_SECTIONS} onJump={setTab} />
            <ClassesTable key={`classes:${m.partner_id}:${marketingVersion}`} partnerId={m.partner_id}
              // Only logins that can change the asks are invited to.
              onAskMarketing={reqControl?.can_edit ? () => {
                // The asks are on this tab now, below the classes.
                document.getElementById("marketing-asks")?.scrollIntoView({ behavior: "smooth", block: "start" });
              } : undefined} orgId={m.organization_id} orgName={orgName} onCount={setClassCount}
              // For "Share sign-up link" (Jessica 2026-11-25): the provider's public page, tagged with this partner.
              orgSlug={m.organization_slug} sharerName={m.partner_name} />
            {/* Flyers and graphics they want, and their logo, with the classes
                and flyer board (Jessica 2026-11-25: "how do they know where
                flyers are?"); was under Requirements. Same every-site admin edits. */}
            <RecordSection id="marketing">
              <MarketingAsksSection
                key={`marketing:${m.partner_id}`}
                partner={{ id: m.partner_id, partner_name: m.partner_name }}
                viewer="partner" orgName={orgName} canEdit={!!reqControl?.can_edit}
                onSaved={() => setMarketingVersion((v) => v + 1)}
              />
            </RecordSection>
          </RecordTabPanel>

          {/* Safety record (2026-11-25 regroup): what were the Documents,
              Instructors, Requirements and Decision tabs, top to bottom. */}
          <RecordTabPanel id="safety" active={tab}>
            <SectionJumps sections={SAFETY_SECTIONS} onJump={setTab} />
            <RecordSection id="documents">
              <RequirementsList requirements={requirements} />
              <DocumentsTable s={s} orgName={orgName} today={today} onOpen={open} />
            </RecordSection>
            <RecordSection id="instructors">
              {/* Keyed on the partner: a picked cell must never carry over to
                  another provider's record. */}
              <InstructorGrid key={m.partner_id} s={s} instructors={instructors} orgName={orgName} today={today} />
            </RecordSection>
            <RecordSection id="requirements">
              {/* The same checklist the provider sees, worded for the partner;
                  its admin logins can change it (20261119p). */}
              <PartnerRequirementsSection
                key={`requirements:${m.partner_id}`}
                partner={{ id: m.partner_id, partner_name: m.partner_name }}
                rows={requirements} canManage onChange={setRequirements}
                viewer="partner" orgName={orgName} control={reqControl}
                onSaved={() => loadReqControl(m.partner_id)}
              />
            </RecordSection>
            <RecordSection id="decision">
              <PartnerDecision key={`decision:${m.partner_id}`} partnerId={m.partner_id} onLatest={setDecision} />
            </RecordSection>
          </RecordTabPanel>

          <RecordTabPanel id="emails" active={tab}>
            <EmailsSent key={`emails:${m.partner_id}`} partnerId={m.partner_id} orgName={orgName} onCount={setEmailCount} />
          </RecordTabPanel>
        </>
      )}
    </PartnerShell>
  );
}
