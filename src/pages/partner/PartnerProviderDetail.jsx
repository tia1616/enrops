// /partner/:partnerId - one provider's safety record, as one partner sees it
// (spec v3 H2). Sections in the spec's order: business, insurance, instructors
// (a grid: one row per instructor, one column per item, the way compliance
// tools lay out a roster), agreements, other documents.
//
// :partnerId is the partner row, which belongs to exactly one provider, so it
// names both "who is looking" and "whose record". The page shows nothing unless
// this login holds that grant (partner_portal_memberships); every read below is
// also refused by the database for anyone else.

import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import DocumentStatusBadge from "../../components/DocumentStatusBadge.jsx";
import { listPartnerInstructors, logPartnerPortalEvent } from "../../lib/partnerPortal.js";
import { listProviderDocuments, openDocumentInNewTab } from "../../lib/providerDocuments.js";
import { instructorChecklist, documentProvenance, providerSummary } from "../../lib/partnerPortalLogic.js";
import { EXPIRY_STATUS, formatDate, compareByExpiry } from "../../lib/providerDocumentLogic.js";
import { PartnerShell, PartnerSignIn, NoAccess, useMemberships, todayIso } from "./partnerShared.jsx";

const GRID_COLUMNS = [
  ["background_check", "Background check"],
  ["training", "Training"],
  ["code_of_conduct", "Code of conduct"],
  ["mandatory_reporter", "Mandatory reporter"],
  ["agreement", "Agreement"],
];

function goodThrough(row) {
  if (!row.expires_on) return "No expiry date";
  return row.expiry_status === "expired" ? `Expired ${formatDate(row.expires_on)}` : `Good through ${formatDate(row.expires_on)}`;
}

export default function PartnerProviderDetail() {
  const { partnerId } = useParams();
  const { user, authLoading, signOut, memberships, error } = useMemberships();
  const m = useMemo(() => (memberships ?? []).find((x) => x.partner_id === partnerId) ?? null, [memberships, partnerId]);

  const [docs, setDocs] = useState(null);
  const [instructors, setInstructors] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [openError, setOpenError] = useState("");

  useEffect(() => {
    setDocs(null); setInstructors(null); setLoadError("");
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
  const byType = (t) => (docs ?? []).filter((d) => d.doc_type === t).sort(compareByExpiry);
  const summary = docs && instructors ? providerSummary({ docs, instructors, partnerId: m.partner_id, orgName, today }) : null;

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

      {docs === null || instructors === null ? (
        <p className="mt-8 text-j2s-ink/60">Loading…</p>
      ) : (
        <>
          {/* 1. Business */}
          <Section title="Business">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-40 shrink-0 font-medium">Business license</span>
              <DocumentStatusBadge badge={summary.license} />
              {summary.licenseDoc && <span className="text-j2s-ink/70">{goodThrough(summary.licenseDoc)}</span>}
            </div>
          </Section>

          {/* 2. Insurance */}
          <Section title="Insurance">
            <DocList docs={byType("insurance")} orgName={orgName} onOpen={open} empty="No insurance certificate on file." insurance />
          </Section>

          {/* 3. Instructors */}
          <Section title="Instructors at your sites" note={instructors.length ? `${summary.instructors.current} of ${summary.instructors.total} Current` : null}>
            {instructors.length === 0 ? (
              <p className="text-sm text-j2s-ink/70">{orgName} hasn't assigned any instructors at your sites yet.</p>
            ) : (
              <InstructorGrid rows={instructors} orgName={orgName} today={today} />
            )}
          </Section>

          {/* 4. Agreements */}
          <Section title="Agreements">
            <DocList docs={byType("agreement")} orgName={orgName} onOpen={open} empty="No agreement on file." />
          </Section>

          {byType("other").length > 0 && (
            <Section title="Other documents">
              <DocList docs={byType("other")} orgName={orgName} onOpen={open} />
            </Section>
          )}
          {byType("business_license").length > 0 && (
            <Section title="Business license documents">
              <DocList docs={byType("business_license")} orgName={orgName} onOpen={open} />
            </Section>
          )}
        </>
      )}
    </PartnerShell>
  );
}

function Section({ title, note, children }) {
  return (
    <section className="mt-6 rounded-2xl bg-white p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-j2s-ink">{title}</h2>
        {note && <span className="text-sm text-j2s-ink/60">{note}</span>}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function DocList({ docs, orgName, onOpen, empty, insurance }) {
  if (!docs.length) {
    return empty ? (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <DocumentStatusBadge badge={EXPIRY_STATUS.expired} />
        <span className="text-j2s-ink/70">{empty}</span>
      </div>
    ) : null;
  }
  return (
    <div className="divide-y divide-j2s-ink/10">
      {docs.map((d) => (
        <div key={d.id} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-j2s-ink">{d.title}</span>
              <DocumentStatusBadge status={d.expiry_status} />
            </div>
            <div className="mt-1 text-sm text-j2s-ink/70">{goodThrough(d)}</div>
            {insurance && (
              <div className="mt-1 text-sm text-j2s-ink/70">
                {[d.insurer, d.coverage_notes].filter(Boolean).join(" · ")}
                {(d.insurer || d.coverage_notes) ? " · " : ""}
                {d.abuse_coverage ? "Includes abuse and molestation coverage" : "Abuse and molestation coverage not listed"}
                {" · "}
                {/* "Names you" is only true of a certificate made out to THIS
                    partner; one shown to every partner may name only some. */}
                {!d.additional_insured ? "Additional insured not listed" : d.partner_id ? "Names you as additional insured" : "Lists additional insureds (see the certificate)"}
              </div>
            )}
            <div className="mt-1 text-xs text-j2s-ink/50">{documentProvenance(d, orgName)}</div>
          </div>
          <button type="button" onClick={() => onOpen(d)} className="text-sm font-semibold text-j2s-purple hover:underline">Open</button>
        </div>
      ))}
    </div>
  );
}

// One row per instructor, one column per item. The chip is the status; the
// small line under it is the date; "as of" and the source show on hover (and
// in full on a phone, where there is room to stack them).
function InstructorGrid({ rows, orgName, today }) {
  const people = rows.map((r) => ({ r, lines: instructorChecklist(r, orgName, today) }));
  // A grid cell is narrow: show the date that matters (renews / expired) when
  // there is one, otherwise the whole detail.
  const cellLine = (l) => (l.detail || "").split(" · ").find((p) => /^(Renews|Expired) /.test(p)) || l.detail;

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-j2s-ink/10 text-xs uppercase tracking-wide text-j2s-ink/50">
            <tr>
              <th className="py-2 pr-4 font-semibold">Instructor</th>
              {GRID_COLUMNS.map(([, label]) => <th key={label} className="px-3 py-2 font-semibold">{label}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-j2s-ink/10 align-top">
            {people.map(({ r, lines }) => (
              <tr key={r.instructor_id}>
                <td className="py-3 pr-4">
                  <div className="font-semibold text-j2s-ink">{[r.first_name, r.last_name].filter(Boolean).join(" ")}</div>
                  <div className="text-xs text-j2s-ink/50">{(r.sites || []).join(", ")}</div>
                  {r.shared && r.email && <a className="block text-xs text-j2s-purple hover:underline" href={`mailto:${r.email}`}>{r.email}</a>}
                  {r.shared && r.phone && <a className="block text-xs text-j2s-purple hover:underline" href={`tel:${r.phone}`}>{r.phone}</a>}
                </td>
                {!r.shared ? (
                  <td colSpan={GRID_COLUMNS.length} className="px-3 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <DocumentStatusBadge badge={lines[0].badge} />
                      <span className="text-j2s-ink/70">{lines[0].detail}</span>
                    </div>
                  </td>
                ) : GRID_COLUMNS.map(([key]) => {
                  const l = lines.find((x) => x.key === key);
                  return (
                    <td key={key} className="px-3 py-3" title={l?.meta || undefined}>
                      {l && <DocumentStatusBadge badge={l.badge} />}
                      {l?.detail && <div className="mt-1 text-xs text-j2s-ink/60">{cellLine(l)}</div>}
                      {l?.meta && <div className="mt-0.5 text-[11px] text-j2s-ink/40">{l.meta.split(" · Source")[0]}</div>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-4 md:hidden">
        {people.map(({ r, lines }) => (
          <div key={r.instructor_id} className="rounded-xl border border-j2s-ink/10 p-3">
            <div className="font-semibold text-j2s-ink">{[r.first_name, r.last_name].filter(Boolean).join(" ")}</div>
            <div className="text-xs text-j2s-ink/50">{(r.sites || []).join(", ")}</div>
            {r.shared && (r.email || r.phone) && (
              <div className="mt-1 text-xs">
                {r.email && <a className="text-j2s-purple" href={`mailto:${r.email}`}>{r.email}</a>}
                {r.email && r.phone ? " · " : ""}
                {r.phone && <a className="text-j2s-purple" href={`tel:${r.phone}`}>{r.phone}</a>}
              </div>
            )}
            <ul className="mt-2 space-y-2">
              {lines.map((l) => (
                <li key={l.key} className="text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-36 shrink-0 font-medium">{l.title}</span>
                    <DocumentStatusBadge badge={l.badge} />
                  </div>
                  {l.detail && <div className="text-xs text-j2s-ink/60">{l.detail}</div>}
                  {l.meta && <div className="text-[11px] text-j2s-ink/40">{l.meta}</div>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}
