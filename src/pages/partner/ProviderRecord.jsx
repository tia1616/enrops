// One provider's safety record as one partner sees it: the summary line, the
// Documents table and the Instructors grid. Rendered by the partner's own
// pages (PartnerHome, PartnerProviderDetail) AND by the provider's admin page
// for that partner (admin/PartnerRecord), so the provider sees exactly what the
// partner sees (Jessica 2026-10-27: "I should see basically the same info that
// they see about us"). One component, never a copy, so the two can't drift.
//
// `viewer` only changes wording that names who is looking ("your sites" for a
// partner, "Happy Valley's sites" for the provider) and lets the provider page
// put its own buttons on each document row (`renderActions`). What is counted,
// and how, is providerSummary() in partnerPortalLogic.js, for both.

import { useState } from "react";
import DocumentStatusBadge from "../../components/DocumentStatusBadge.jsx";
import {
  instructorChecklist, documentProvenance, worstBadge, REQUIREMENTS,
  GRID_DATE, gridCellText, instructorCellDate,
} from "../../lib/partnerPortalLogic.js";
import { formatDate, compareByExpiry } from "../../lib/providerDocumentLogic.js";

// Short column headers; the full names live in REQUIREMENTS.
const SHORT = {
  background_check: "Background check",
  training: "Training",
  code_of_conduct: "Code of conduct",
  mandatory_reporter: "Mandatory reporter",
  contractor_agreement: "Contractor agreement",
};
export const REQUIREMENT_LABEL = Object.fromEntries(REQUIREMENTS.map((r) => [r.key, r.label]));
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

function Chip({ badge }) {
  return badge ? <DocumentStatusBadge badge={badge} /> : <span className="text-sm text-j2s-ink/40">None yet</span>;
}

/** "2 of 2 met" with the worst chip among the REQUIRED business items, naming any gap. */
export function RequirementsCell({ s, viewer = "partner" }) {
  if (!s.total) return <span className="text-sm text-j2s-ink/40">{viewer === "provider" ? "Nothing required" : "None on your list"}</span>;
  const worst = worstBadge(s.business.map((b) => b.badge));
  // Name the gap, so a coordinator knows which one without opening the record.
  const gaps = s.business.filter((b) => b.badge.tone !== "good" && b.badge.tone !== "warn").map((b) => b.label);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-j2s-ink/80">{s.met} of {s.total} met</span>
        <Chip badge={worst} />
      </div>
      {gaps.length > 0 && <div className="mt-0.5 text-xs text-j2s-ink/55">Needs: {gaps.join(", ")}</div>}
    </div>
  );
}

export function InstructorsCell({ s }) {
  if (!s.instructors.total) return <span className="text-sm text-j2s-ink/40">None assigned yet</span>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-j2s-ink/80">{s.instructors.current} of {s.instructors.total} current</span>
      <Chip badge={s.instructors.badge} />
    </div>
  );
}

/** The answer first: requirements met, instructors current. Each clause carries its OWN chip. */
export function RecordSummary({ s }) {
  return (
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
  );
}

/**
 * One row per document: the required ones (a missing one gets a row saying
 * so), then anything else shared with this partner, marked "Not required".
 * `renderActions({ d, requirementKey })` fills the last cell; without it a
 * document row gets a View button and a missing row nothing.
 */
export function DocumentsTable({ s, orgName, today, onOpen, viewer = "partner", partnerName, renderActions }) {
  const rows = [
    ...s.business.flatMap((b) =>
      b.docs.length
        ? [...b.docs].sort(compareByExpiry).map((d) => ({ key: d.id, label: REQUIREMENT_LABEL[b.key], d, badge: null, requirementKey: b.key }))
        : [{ key: b.key, label: REQUIREMENT_LABEL[b.key], d: null, badge: b.badge, requirementKey: b.key }],
    ),
    ...[...s.alsoOnFile].sort(compareByExpiry).map((d) => ({ key: d.id, label: DOC_TYPE_LABEL[d.doc_type] ?? "Document", d, badge: null, extra: true, requirementKey: null })),
  ];
  const actions = renderActions ?? (({ d }) => d && (
    <button type="button" onClick={() => onOpen(d)} className="font-semibold text-j2s-purple hover:underline">View</button>
  ));

  return (
    <section className="mt-5 rounded-2xl bg-white shadow-card">
      <h2 className="px-4 pt-4 text-base font-bold text-j2s-ink">Documents</h2>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 pt-2 text-sm text-j2s-ink/70">
          {viewer === "provider" ? `${partnerName} doesn't require any documents from you.` : "No documents are on your list."}
        </p>
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
              {rows.map(({ key, label, d, badge, extra, requirementKey }) => (
                <tr key={key}>
                  <td className={`${TD} sticky left-0 z-10 bg-white`}>
                    <div className="font-medium text-j2s-ink">{label}</div>
                    {d && <div className="text-xs text-j2s-ink/50">{d.title}</div>}
                    {/* The provider is told when one file is in EVERY partner's
                        packet, so changing it here isn't a surprise elsewhere. */}
                    {viewer === "provider" && d && !d.partner_id && <div className="text-xs text-j2s-ink/50">Shared with every partner</div>}
                  </td>
                  <td className={TD}>
                    {d ? <DocumentStatusBadge status={d.expiry_status} /> : <DocumentStatusBadge badge={badge} />}
                    {extra && <div className="mt-1 text-xs text-j2s-ink/50">Not required</div>}
                  </td>
                  <td className={`${TD} whitespace-nowrap text-j2s-ink/75`}>{d ? expiresText(d) : "Not on file yet"}</td>
                  {/* The source is in the row itself, not a hover tooltip, so it reads on a phone. */}
                  <td className={`${TD} min-w-[11rem] text-xs text-j2s-ink/50`}>
                    {d ? documentProvenance(d, orgName) : `as of ${formatDate(today)}`}
                  </td>
                  <td className={`${TD} whitespace-nowrap text-right`}>{actions({ d, requirementKey })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * One row per instructor, one column per REQUIRED item. Clicking a cell shows
 * its source and details underneath. Key it on the partner at the call site: a
 * picked cell must never carry over to another record.
 */
export function InstructorGrid({ s, instructors, orgName, today, viewer = "partner", partnerName }) {
  const cols = s.instructors.columns;
  const [picked, setPicked] = useState(null); // { id, r, line } | null
  const people = instructors.map((r) => ({ r, lines: instructorChecklist(r, orgName, today) }));
  const name = (r) => [r.first_name, r.last_name].filter(Boolean).join(" ");
  const provider = viewer === "provider";

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
      <h2 className="px-4 pt-4 text-base font-bold text-j2s-ink">{provider ? `Instructors at ${partnerName}'s sites` : "Instructors at your sites"}</h2>
      {instructors.length === 0 ? (
        <p className="px-4 pb-4 pt-2 text-sm text-j2s-ink/70">
          {provider
            ? `No instructors are assigned at ${partnerName}'s sites yet. They appear here once you assign them to a class or camp there.`
            : `${orgName} hasn't assigned any instructors at your sites yet.`}
        </p>
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
                    {name(picked.r)} · {picked.line.key === "consent" ? "Status" : REQUIREMENT_LABEL[picked.line.key] ?? picked.line.title}
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
