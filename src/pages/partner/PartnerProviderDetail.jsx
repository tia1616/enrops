// /partner/:partnerId - one provider's safety record, as one partner sees it
// (spec v3 H2). Jessica 2026-10-26: "a spreadsheet". So it is ONE grid: the
// business on the first row, one row per instructor below, one column per
// requirement this partner has (partner_requirements_for, 20261026a). Each
// cell is a check and a date, or the spec v3 chip word when something needs
// attention; clicking a cell shows its full details (dates, as of, source, and
// Open for a document) under the grid. Phones keep the same grid, name column
// frozen, scrolled sideways like a sheet, rather than turning into cards.
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
  GRID_DATE, gridCellText, instructorCellDate, businessCellDate,
} from "../../lib/partnerPortalLogic.js";
import { formatDate, compareByExpiry, EXPIRY_STATUS, limitLines } from "../../lib/providerDocumentLogic.js";
import { PartnerShell, PartnerSignIn, NoAccess, useMemberships, todayIso } from "./partnerShared.jsx";

// Short column headers; the full names live in REQUIREMENTS for the admin screen.
const SHORT = {
  insurance: "Insurance",
  partner_agreement: "Agreement",
  business_license: "Business license",
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

function goodThrough(row) {
  if (!row.expires_on) return "No expiry date";
  return row.expiry_status === "expired" ? `Expired ${formatDate(row.expires_on)}` : `Good through ${formatDate(row.expires_on)}`;
}

/** The facts a host checks on a certificate, in one short line. */
function insuranceFacts(d) {
  const hasAbuseAmount = d.abuse_occurrence_limit != null || d.abuse_aggregate_limit != null;
  return [
    d.insurer,
    // With an amount entered, the limits line below already says it.
    hasAbuseAmount ? null : d.abuse_coverage ? "Abuse and molestation coverage (amounts not entered)" : "Abuse and molestation coverage not listed",
    // "Names you" is only true of a certificate made out to THIS partner; one
    // shown to every partner may name only some.
    !d.additional_insured ? "Additional insured not listed" : d.partner_id ? "Names you as additional insured" : "Lists additional insureds",
  ].filter(Boolean).join(" · ");
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
          {/* The answer first. Each clause carries its OWN chip: one chip beside
              "Meets 2 of 2" that came from the instructors read as a contradiction. */}
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

          {/* Keyed on the partner: a picked cell must never carry over to
              another provider's record. */}
          <RecordGrid
            key={m.partner_id}
            s={s} instructors={instructors} orgName={orgName} today={today} onOpen={open}
          />

          {s.alsoOnFile.length > 0 && (
            <div className="mt-4 text-sm text-j2s-ink/70">
              <span className="font-semibold text-j2s-ink/80">Also on file:</span>{" "}
              {[...s.alsoOnFile].sort(compareByExpiry).map((d, i) => (
                <span key={d.id}>
                  {i > 0 && " · "}
                  <button type="button" onClick={() => open(d)} className="text-j2s-purple hover:underline">{d.title}</button>
                  <span className="text-j2s-ink/45"> ({DOC_TYPE_LABEL[d.doc_type] ?? "Document"})</span>
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </PartnerShell>
  );
}

// One grid: the business row, then one row per instructor; one column per
// required item. Clicking a cell (or a name) shows its details underneath.
function RecordGrid({ s, instructors, orgName, today, onOpen }) {
  const businessCols = s.business.map((b) => b.key);
  const instructorCols = s.instructors.columns;
  const cols = [...businessCols, ...instructorCols];
  const [picked, setPicked] = useState(null); // { kind, ... } | null

  const people = instructors.map((r) => ({ r, lines: instructorChecklist(r, orgName, today) }));
  const name = (r) => [r.first_name, r.last_name].filter(Boolean).join(" ");
  const isPicked = (id) => picked?.id === id;
  // The document a business cell's chip came from, so its "as of" describes
  // that document (not an older or another one).
  const chipDoc = (b) => {
    const dated = businessCellDate(b);
    return b.docs.find((d) => dated && d.expires_on === dated && EXPIRY_STATUS[d.expiry_status] === b.badge)
      ?? b.docs.find((d) => EXPIRY_STATUS[d.expiry_status] === b.badge)
      ?? null;
  };
  // Plain render helpers, NOT components: a component declared inside this
  // function would be a new type on every render, so React would remount every
  // cell on each click and drop the keyboard focus.
  // Oct 30 criterion 8: every chip shows "as of" and its source. The "as of"
  // is the cell's second line; the source shows on hover and in the details.
  // `meta` is the provenance line ("as of {date} · Source: ..."); with none,
  // the status is as of today.
  const Cell = ({ id, badge, text, meta, onPick, colSpan }) => {
    const full = meta || `as of ${formatDate(today)}`;
    return (
      <td key={id} colSpan={colSpan} className="border-b border-l border-j2s-ink/10 p-0">
        <button
          type="button"
          onClick={onPick}
          title={full}
          aria-label={badge ? `${badge.label}: ${text}, ${full}` : text}
          className={`block w-full px-2.5 py-1.5 text-left text-xs font-medium leading-snug ${badge ? CELL_TONE[badge.tone] ?? "" : "text-j2s-ink/30"} ${isPicked(id) ? "ring-2 ring-inset ring-j2s-purple" : ""} hover:brightness-95`}
        >
          {text}
          <span className="block text-[10px] font-normal opacity-60">{full.split(" · ")[0]}</span>
        </button>
      </td>
    );
  };
  const Blank = (key) => <td key={key} className="border-b border-l border-j2s-ink/10 bg-white px-2.5 py-2 text-center text-xs text-j2s-ink/25">—</td>;
  const Name = ({ id, children, onPick }) => (
    <th scope="row" className="sticky left-0 z-10 border-b border-j2s-ink/10 bg-white p-0 text-left font-normal">
      <button type="button" onClick={onPick} className={`block w-full min-w-[10rem] max-w-[14rem] px-3 py-2 text-left ${isPicked(id) ? "ring-2 ring-inset ring-j2s-purple" : ""}`}>
        {children}
      </button>
    </th>
  );

  return (
    <section className="mt-5 rounded-2xl bg-white shadow-card">
      <div className="overflow-x-auto rounded-2xl">
        <table className="min-w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 z-20 border-b border-j2s-ink/10 bg-white px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-j2s-ink/50"> </th>
              {cols.map((k) => (
                <th key={k} className="min-w-[8.5rem] border-b border-l border-j2s-ink/10 bg-white px-2.5 py-2 text-left align-bottom">
                  <div className="text-xs font-semibold text-j2s-ink/80">{SHORT[k]}</div>
                  <div className="text-[10px] uppercase tracking-wide text-j2s-ink/40">{GRID_DATE[k]}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* The business. */}
            <tr>
              {Name({
                id: "business",
                onPick: () => setPicked({ id: "business", kind: "business" }),
                children: (
                  <>
                    <div className="font-semibold text-j2s-ink">{orgName}</div>
                    <div className="text-[11px] text-j2s-ink/50">Business</div>
                  </>
                ),
              })}
              {s.business.map((b) => Cell({
                id: `b:${b.key}`, badge: b.badge,
                text: b.docs.length ? gridCellText(b.badge, businessCellDate(b)) : b.badge.label,
                meta: chipDoc(b) ? documentProvenance(chipDoc(b), orgName) : null,
                onPick: () => setPicked({ id: `b:${b.key}`, kind: "doc", item: b }),
              }))}
              {instructorCols.map((k) => Blank(k))}
            </tr>

            {/* Each instructor. */}
            {people.map(({ r, lines }) => (
              <tr key={r.instructor_id}>
                {Name({
                  id: `p:${r.instructor_id}`,
                  onPick: () => setPicked({ id: `p:${r.instructor_id}`, kind: "person", r }),
                  children: (
                    <>
                      <div className="font-semibold text-j2s-ink">{name(r)}</div>
                      <div className="text-[11px] text-j2s-ink/50">{(r.sites || []).join(", ")}</div>
                      {/* Contact in the row itself (Jessica 10/19: partners see
                          full names AND contact info), not only behind a click. */}
                      {r.shared && (r.email || r.phone) && (
                        <div className="mt-0.5 text-[11px] text-j2s-purple [overflow-wrap:anywhere]">
                          {[r.email, r.phone].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </>
                  ),
                })}
                {businessCols.map((k) => Blank(k))}
                {!r.shared
                  ? (instructorCols.length > 0 && Cell({
                      id: `c:${r.instructor_id}`, badge: lines[0].badge, colSpan: instructorCols.length,
                      text: lines[0].detail ? `${lines[0].badge.label}: ${lines[0].detail.charAt(0).toLowerCase()}${lines[0].detail.slice(1)}` : lines[0].badge.label,
                      onPick: () => setPicked({ id: `c:${r.instructor_id}`, kind: "line", r, line: lines[0] }),
                    }))
                  : instructorCols.map((k) => {
                    const l = lines.find((x) => x.key === k);
                    return l ? Cell({
                      id: `l:${r.instructor_id}:${k}`, badge: l.badge,
                      text: gridCellText(l.badge, instructorCellDate(r, k)),
                      meta: l.meta,
                      onPick: () => setPicked({ id: `l:${r.instructor_id}:${k}`, kind: "line", r, line: l }),
                    }) : Blank(k);
                  })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {instructors.length === 0 && (
        <p className="px-4 pt-3 text-sm text-j2s-ink/70">{orgName} hasn't assigned any instructors at your sites yet.</p>
      )}
      <div className="px-4 pb-4 pt-3">
        {picked ? (
          <CellDetail picked={picked} orgName={orgName} today={today} onOpen={onOpen} onClose={() => setPicked(null)} />
        ) : (
          <p className="text-xs text-j2s-ink/50">Click any cell for its dates, where it came from, and the document.</p>
        )}
      </div>
    </section>
  );
}

function CellDetail({ picked, orgName, today, onOpen, onClose }) {
  const close = <button type="button" onClick={onClose} className="text-xs font-semibold text-j2s-ink/50 hover:underline">Close</button>;
  const box = (title, body) => (
    <div className="rounded-xl border border-j2s-ink/10 bg-[#FBFBFB] p-3 text-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-semibold text-j2s-ink">{title}</span>
        {close}
      </div>
      {body}
    </div>
  );

  if (picked.kind === "doc") {
    const it = picked.item;
    return box(FULL[it.key], it.docs.length ? (
      <ul className="space-y-2">
        {[...it.docs].sort(compareByExpiry).map((d) => (
          <li key={d.id}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{d.title}</span>
              <DocumentStatusBadge status={d.expiry_status} />
              <button type="button" onClick={() => onOpen(d)} className="font-semibold text-j2s-purple hover:underline">Open</button>
            </div>
            <div className="text-j2s-ink/70">{goodThrough(d)}</div>
            {d.doc_type === "insurance" && (
              <>
                {limitLines(d).map((l) => <div key={l} className="text-j2s-ink/80">{l}</div>)}
                <div className="text-xs text-j2s-ink/60">{insuranceFacts(d)}</div>
              </>
            )}
            <div className="text-[11px] text-j2s-ink/45">{documentProvenance(d, orgName)}</div>
          </li>
        ))}
      </ul>
    ) : (
      <div className="flex flex-wrap items-center gap-2">
        <DocumentStatusBadge badge={it.badge} />
        <span className="text-j2s-ink/70">Not on file yet · as of {formatDate(today)}</span>
      </div>
    ));
  }

  if (picked.kind === "line") {
    const { r, line } = picked;
    return box(`${[r.first_name, r.last_name].filter(Boolean).join(" ")} · ${line.key === "consent" ? "Status" : FULL[line.key] ?? line.title}`, (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <DocumentStatusBadge badge={line.badge} />
          {line.detail && <span className="text-j2s-ink/75">{line.detail}</span>}
        </div>
        {line.meta && <div className="mt-1 text-[11px] text-j2s-ink/45">{line.meta}</div>}
      </>
    ));
  }

  if (picked.kind === "person") {
    const { r } = picked;
    return box([r.first_name, r.last_name].filter(Boolean).join(" "), (
      <div className="text-j2s-ink/75">
        <div>{(r.sites || []).join(", ")}</div>
        {r.shared ? (
          <div className="mt-1 [overflow-wrap:anywhere]">
            {r.email && <a className="text-j2s-purple hover:underline" href={`mailto:${r.email}`}>{r.email}</a>}
            {r.email && r.phone ? " · " : ""}
            {r.phone && <a className="text-j2s-purple hover:underline" href={`tel:${r.phone}`}>{r.phone}</a>}
          </div>
        ) : <div className="mt-1 text-j2s-ink/55">Contact details show once this instructor gives permission.</div>}
      </div>
    ));
  }

  // The business row.
  return box(orgName, <div className="text-j2s-ink/75">The provider's own documents are in this row. Click a cell to see each one.</div>);
}
