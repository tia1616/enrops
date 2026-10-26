// /partner/:partnerId - one provider's safety record, as one partner sees it
// (spec v3 H2). Two tables, the way compliance tools present it (Jessica
// 2026-10-26: the business and the instructors in one table "is confusing"):
//   1. Documents: one row per document this partner requires, with its status,
//      expiry, "as of" and an Open link. The partner reads the certificate
//      itself; nothing is typed off it (20261026b).
//   2. Instructors: one row per instructor at this partner's sites, one column
//      per required item. Each cell is a check and a date, or the spec v3 chip
//      word when something needs attention, plus its "as of"; click a cell for
//      the source and details.
// Both tables scroll sideways on a phone, first column frozen, rather than
// turning into cards. Only what this partner requires is shown
// (partner_requirements_for, 20261026a).
//
// :partnerId is the partner row, which belongs to exactly one provider, so it
// names both "who is looking" and "whose record". The page shows nothing unless
// this login holds that grant (partner_portal_memberships); every read below is
// also refused by the database for anyone else.

import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import DocumentStatusBadge from "../../components/DocumentStatusBadge.jsx";
import { listPartnerInstructors, listPartnerRequirements, logPartnerPortalEvent } from "../../lib/partnerPortal.js";
import { listProviderDocuments, openDocumentInNewTab } from "../../lib/providerDocuments.js";
import {
  instructorChecklist, documentProvenance, providerSummary, requiredKeys, worstBadge, REQUIREMENTS,
  GRID_DATE, gridCellText, instructorCellDate,
} from "../../lib/partnerPortalLogic.js";
import { formatDate, compareByExpiry } from "../../lib/providerDocumentLogic.js";
import { PartnerShell, PartnerSignIn, NoAccess, useMemberships, todayIso } from "./partnerShared.jsx";

// Short column headers; the full names live in REQUIREMENTS for the admin screen.
const SHORT = {
  background_check: "Background check",
  training: "Training",
  code_of_conduct: "Code of conduct",
  mandatory_reporter: "Mandatory reporter",
  contractor_agreement: "Contractor agreement",
};
const FULL = Object.fromEntries(REQUIREMENTS.map((r) => [r.key, r.label]));
const DOC_TYPE_LABEL = { insurance: "Insurance certificate", agreement: "Agreement", business_license: "Business license", other: "Document" };

// Cell colours follow the chip tones, with the words always present in the cell.
const CELL_TONE = {
  good: "bg-emerald-50 text-emerald-800",
  warn: "bg-amber-50 text-amber-900",
  bad: "bg-red-50 text-red-800",
  review: "bg-violet-50 text-violet-800",
  neutral: "bg-slate-50 text-slate-600",
};

const TH = "border-b border-j2s-ink/10 bg-white px-3 py-2 text-left text-xs font-semibold text-j2s-ink/60";
const TD = "border-b border-j2s-ink/10 px-3 py-2 align-middle";

function expiresText(d) {
  if (!d.expires_on) return "Doesn't expire";
  return formatDate(d.expires_on);
}

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

  useEffect(() => {
    setDocs(null); setInstructors(null); setRequirements(undefined); setLoadError("");
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
    setOpenError("");
    const problem = await openDocumentInNewTab(d.storage_path);
    if (problem) { setOpenError(problem); return; }
    logPartnerPortalEvent(m.partner_id, "document_opened", d.id);
  }

  return (
    <PartnerShell onSignOut={signOut} feedbackOrg={{ id: m.organization_id }}>
      <Link to="/partner" className="text-sm text-j2s-ink/60 hover:underline">← All providers</Link>
      <div className="mt-2 text-sm font-semibold uppercase tracking-wide text-j2s-ink/50">{m.partner_name}</div>
      <h1 className="mt-1 text-3xl font-bold text-j2s-ink">{orgName}</h1>

      {(error || loadError || openError) && <p className="error-text mt-4">{error || loadError || openError}</p>}

      {loading ? (
        <p className="mt-8 text-j2s-ink/60">Loading…</p>
      ) : (
        <>
          {/* The answer first. Each clause carries its OWN chip. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-j2s-ink/80">
            {s.total > 0 && (
              <span className="flex items-center gap-2">
                <DocumentStatusBadge badge={worstBadge(s.business.map((b) => b.badge))} />
                Meets {s.met} of {s.total} requirement{s.total === 1 ? "" : "s"}
              </span>
            )}
            {s.instructors.total > 0 && (
              <span className="flex items-center gap-2">
                <DocumentStatusBadge badge={s.instructors.badge} />
                {s.instructors.current} of {s.instructors.total} instructor{s.instructors.total === 1 ? "" : "s"} current
              </span>
            )}
          </div>
          {(requirements === null || requirements?.length === 0) && (
            <p className="mt-2 text-xs text-j2s-ink/50">Showing every standard requirement: your list couldn't be loaded just now.</p>
          )}

          <DocumentsTable s={s} orgName={orgName} today={today} onOpen={open} />

          {/* Keyed on the partner: a picked cell must never carry over to
              another provider's record. */}
          <InstructorGrid key={m.partner_id} s={s} instructors={instructors} orgName={orgName} today={today} />
        </>
      )}
    </PartnerShell>
  );
}

// One row per document: the required ones (a missing one gets a row saying
// so), then anything else shared with this partner, marked "Not required".
function DocumentsTable({ s, orgName, today, onOpen }) {
  const rows = [
    ...s.business.flatMap((b) =>
      b.docs.length
        ? [...b.docs].sort(compareByExpiry).map((d) => ({ key: d.id, label: FULL[b.key], d, badge: null }))
        : [{ key: b.key, label: FULL[b.key], d: null, badge: b.badge }],
    ),
    ...[...s.alsoOnFile].sort(compareByExpiry).map((d) => ({ key: d.id, label: DOC_TYPE_LABEL[d.doc_type] ?? "Document", d, badge: null, extra: true })),
  ];

  return (
    <section className="mt-5 rounded-2xl bg-white shadow-card">
      <h2 className="px-4 pt-4 text-base font-bold text-j2s-ink">Documents</h2>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 pt-2 text-sm text-j2s-ink/70">No documents are on your list.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <th className={`${TH} sticky left-0 z-10`}>Document</th>
                <th className={TH}>Status</th>
                <th className={TH}>Expires</th>
                <th className={TH}>As of</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ key, label, d, badge, extra }) => (
                <tr key={key}>
                  <td className={`${TD} sticky left-0 z-10 bg-white`}>
                    <div className="font-medium text-j2s-ink">{label}</div>
                    {d && <div className="text-xs text-j2s-ink/50">{d.title}</div>}
                  </td>
                  <td className={TD}>
                    {extra
                      ? <span className="text-xs text-j2s-ink/50">Not required</span>
                      : d ? <DocumentStatusBadge status={d.expiry_status} /> : <DocumentStatusBadge badge={badge} />}
                  </td>
                  <td className={`${TD} whitespace-nowrap text-j2s-ink/75`}>{d ? expiresText(d) : "Not on file yet"}</td>
                  <td className={`${TD} whitespace-nowrap text-xs text-j2s-ink/50`} title={d ? documentProvenance(d, orgName) : undefined}>
                    {d ? documentProvenance(d, orgName).split(" · ")[0] : `as of ${formatDate(today)}`}
                  </td>
                  <td className={`${TD} text-right`}>
                    {d && <button type="button" onClick={() => onOpen(d)} className="font-semibold text-j2s-purple hover:underline">Open</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// One row per instructor, one column per REQUIRED item. Clicking a cell shows
// its source and details underneath.
function InstructorGrid({ s, instructors, orgName, today }) {
  const cols = s.instructors.columns;
  const [picked, setPicked] = useState(null); // { id, r, line } | null
  const people = instructors.map((r) => ({ r, lines: instructorChecklist(r, orgName, today) }));
  const name = (r) => [r.first_name, r.last_name].filter(Boolean).join(" ");

  // A plain render helper, NOT a component: one declared inside this function
  // would be a new type each render, remounting every cell and dropping focus.
  const cell = ({ id, badge, text, meta, onPick, colSpan }) => {
    const full = meta || `as of ${formatDate(today)}`;
    return (
      <td key={id} colSpan={colSpan} className="border-b border-l border-j2s-ink/10 p-0">
        <button
          type="button"
          onClick={onPick}
          title={full}
          aria-label={`${badge.label}: ${text}, ${full}`}
          className={`block w-full px-2.5 py-1.5 text-left text-xs font-medium leading-snug ${CELL_TONE[badge.tone] ?? ""} ${picked?.id === id ? "ring-2 ring-inset ring-j2s-purple" : ""} hover:brightness-95`}
        >
          {text}
          <span className="block text-[10px] font-normal opacity-60">{full.split(" · ")[0]}</span>
        </button>
      </td>
    );
  };

  return (
    <section className="mt-5 rounded-2xl bg-white shadow-card">
      <h2 className="px-4 pt-4 text-base font-bold text-j2s-ink">Instructors at your sites</h2>
      {instructors.length === 0 ? (
        <p className="px-4 pb-4 pt-2 text-sm text-j2s-ink/70">{orgName} hasn't assigned any instructors at your sites yet.</p>
      ) : (
        <>
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <th className={`${TH} sticky left-0 z-20`}>Instructor</th>
                  {cols.map((k) => (
                    <th key={k} className={`${TH} min-w-[8.5rem] border-l align-bottom`}>
                      <div className="text-j2s-ink/80">{SHORT[k]}</div>
                      <div className="text-[10px] font-normal uppercase tracking-wide text-j2s-ink/40">{GRID_DATE[k]}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {people.map(({ r, lines }) => (
                  <tr key={r.instructor_id}>
                    <th scope="row" className={`${TD} sticky left-0 z-10 min-w-[10rem] max-w-[14rem] bg-white text-left font-normal`}>
                      <div className="font-semibold text-j2s-ink">{name(r)}</div>
                      <div className="text-[11px] text-j2s-ink/50">{(r.sites || []).join(", ")}</div>
                      {/* Contact in the row (Jessica 10/19: partners see full names AND contact info). */}
                      {r.shared && (r.email || r.phone) && (
                        <div className="mt-0.5 text-[11px] text-j2s-purple [overflow-wrap:anywhere]">{[r.email, r.phone].filter(Boolean).join(" · ")}</div>
                      )}
                    </th>
                    {!r.shared
                      ? (cols.length > 0 && cell({
                          id: `c:${r.instructor_id}`, badge: lines[0].badge, colSpan: cols.length,
                          text: lines[0].detail ? `${lines[0].badge.label}: ${lines[0].detail.charAt(0).toLowerCase()}${lines[0].detail.slice(1)}` : lines[0].badge.label,
                          onPick: () => setPicked({ id: `c:${r.instructor_id}`, r, line: lines[0] }),
                        }))
                      : cols.map((k) => {
                        const l = lines.find((x) => x.key === k);
                        return l ? cell({
                          id: `l:${r.instructor_id}:${k}`, badge: l.badge,
                          text: gridCellText(l.badge, instructorCellDate(r, k)),
                          meta: l.meta,
                          onPick: () => setPicked({ id: `l:${r.instructor_id}:${k}`, r, line: l }),
                        }) : <td key={k} className="border-b border-l border-j2s-ink/10" />;
                      })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-4 pb-4 pt-3">
            {picked ? (
              <div className="rounded-xl border border-j2s-ink/10 bg-[#FBFBFB] p-3 text-sm">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="font-semibold text-j2s-ink">
                    {name(picked.r)} · {picked.line.key === "consent" ? "Status" : FULL[picked.line.key] ?? picked.line.title}
                  </span>
                  <button type="button" onClick={() => setPicked(null)} className="text-xs font-semibold text-j2s-ink/50 hover:underline">Close</button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <DocumentStatusBadge badge={picked.line.badge} />
                  {picked.line.detail && <span className="text-j2s-ink/75">{picked.line.detail}</span>}
                </div>
                {picked.line.meta && <div className="mt-1 text-[11px] text-j2s-ink/45">{picked.line.meta}</div>}
              </div>
            ) : (
              <p className="text-xs text-j2s-ink/50">Click any cell for where it came from.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
