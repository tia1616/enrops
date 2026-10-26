// /partner/:partnerId - one provider's safety record, as one partner sees it
// (spec v3 H2), laid out the way compliance tools present it (Jessica
// 2026-10-26: "way more streamlined, like in a spreadsheet"): a one-line
// summary, a requirements table, an instructor grid, then anything else on
// file. Measured ONLY against what this partner requires
// (partner_requirements_for, 20261026a), so nothing it doesn't ask for is ever
// shown as missing.
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
import { instructorChecklist, documentProvenance, providerSummary, requiredKeys, worstBadge, REQUIREMENTS } from "../../lib/partnerPortalLogic.js";
import { formatDate, compareByExpiry } from "../../lib/providerDocumentLogic.js";
import { PartnerShell, PartnerSignIn, NoAccess, useMemberships, todayIso } from "./partnerShared.jsx";

const LABEL = Object.fromEntries(REQUIREMENTS.map((r) => [r.key, r.label]));
// Grid headers are narrower than the admin labels.
const COLUMN_LABEL = { ...LABEL, contractor_agreement: "Agreement" };
const DOC_TYPE_LABEL = { insurance: "Insurance certificate", agreement: "Agreement", business_license: "Business license", other: "Document" };

function goodThrough(row) {
  if (!row.expires_on) return "No expiry date";
  return row.expiry_status === "expired" ? `Expired ${formatDate(row.expires_on)}` : `Good through ${formatDate(row.expires_on)}`;
}

/** The facts a host checks on a certificate, in one short line. */
function insuranceFacts(d) {
  return [
    d.insurer,
    d.abuse_coverage ? "Abuse and molestation coverage" : "Abuse and molestation coverage not listed",
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
          {/* The answer first: does this provider meet what we require? */}
          {/* Each clause carries its OWN chip: one chip beside "Meets 2 of 2"
              that came from the instructors read as a contradiction. */}
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
          {requirements === null && (
            <p className="mt-2 text-xs text-j2s-ink/50">Showing every standard requirement: your list couldn't be loaded just now.</p>
          )}

          <Section title="Requirements">
            <RequirementsTable items={s.business} orgName={orgName} today={today} onOpen={open} />
          </Section>

          <Section title="Instructors at your sites">
            {instructors.length === 0 ? (
              <p className="text-sm text-j2s-ink/70">{orgName} hasn't assigned any instructors at your sites yet.</p>
            ) : (
              <InstructorGrid rows={instructors} columns={s.instructors.columns} orgName={orgName} today={today} />
            )}
          </Section>

          {s.alsoOnFile.length > 0 && (
            <Section title="Also on file">
              <ul className="divide-y divide-j2s-ink/10 text-sm">
                {[...s.alsoOnFile].sort(compareByExpiry).map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                    <span className="min-w-0">
                      <span className="font-medium text-j2s-ink">{d.title}</span>
                      <span className="text-j2s-ink/50"> · {DOC_TYPE_LABEL[d.doc_type] ?? "Document"} · {goodThrough(d)}</span>
                    </span>
                    <button type="button" onClick={() => open(d)} className="font-semibold text-j2s-purple hover:underline">Open</button>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
    </PartnerShell>
  );
}

function Section({ title, children }) {
  return (
    <section className="mt-6 rounded-2xl bg-white p-4 shadow-card sm:p-5">
      <h2 className="text-base font-bold text-j2s-ink">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

// One row per document, grouped under the requirement it satisfies; a
// requirement with nothing on file gets one row saying so.
function RequirementsTable({ items, orgName, today, onOpen }) {
  const rows = items.flatMap((it) =>
    it.docs.length
      ? [...it.docs].sort(compareByExpiry).map((d, i) => ({ it, d, first: i === 0 }))
      : [{ it, d: null, first: true }],
  );
  if (!rows.length) return <p className="text-sm text-j2s-ink/70">No business documents are on your list.</p>;
  const asOf = (d) => (d ? documentProvenance(d, orgName) : `as of ${formatDate(today)}`);

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-j2s-ink/10 text-xs uppercase tracking-wide text-j2s-ink/50">
            <tr>
              <th className="py-2 pr-3 font-semibold">Requirement</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Document</th>
              <th className="px-3 py-2 font-semibold">As of</th>
              <th className="py-2 pl-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-j2s-ink/10 align-top">
            {rows.map(({ it, d, first }) => (
              <tr key={d?.id ?? it.key}>
                <td className="py-2.5 pr-3 font-medium text-j2s-ink">{first ? it.label : ""}</td>
                <td className="px-3 py-2.5">{d ? <DocumentStatusBadge status={d.expiry_status} /> : <DocumentStatusBadge badge={it.badge} />}</td>
                <td className="px-3 py-2.5 text-j2s-ink/80">
                  {d ? (
                    <>
                      <div>{d.title} · {goodThrough(d)}</div>
                      {d.doc_type === "insurance" && <div className="text-xs text-j2s-ink/55">{insuranceFacts(d)}</div>}
                    </>
                  ) : <span className="text-j2s-ink/60">Not on file yet</span>}
                </td>
                <td className="px-3 py-2.5 text-xs text-j2s-ink/50" title={asOf(d)}>{asOf(d).split(" · Source")[0]}</td>
                <td className="py-2.5 pl-3 text-right">
                  {d && <button type="button" onClick={() => onOpen(d)} className="font-semibold text-j2s-purple hover:underline">Open</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden">
        {rows.map(({ it, d }) => (
          <li key={d?.id ?? it.key} className="rounded-xl border border-j2s-ink/10 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-j2s-ink">{it.label}</span>
              {d ? <DocumentStatusBadge status={d.expiry_status} /> : <DocumentStatusBadge badge={it.badge} />}
            </div>
            <div className="mt-1 text-j2s-ink/75">{d ? `${d.title} · ${goodThrough(d)}` : "Not on file yet"}</div>
            {d?.doc_type === "insurance" && <div className="text-xs text-j2s-ink/55">{insuranceFacts(d)}</div>}
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="text-[11px] text-j2s-ink/45">{asOf(d)}</span>
              {d && <button type="button" onClick={() => onOpen(d)} className="font-semibold text-j2s-purple hover:underline">Open</button>}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

// One row per instructor, one column per REQUIRED item. The chip is the status;
// the small line under it is the date and "as of"; the source shows on hover
// (spec v3: tapping or hovering shows the source), and in full on a phone.
function InstructorGrid({ rows, columns, orgName, today }) {
  const people = rows.map((r) => ({ r, lines: instructorChecklist(r, orgName, today) }));
  // A grid cell is narrow: the date that matters (renews / expired) when there
  // is one, otherwise the whole detail.
  const cellLine = (l) => (l.detail || "").split(" · ").find((p) => /^(Renews|Expired) /.test(p)) || l.detail;
  const contact = (r) => r.shared && (r.email || r.phone) && (
    <div className="mt-0.5 text-xs [overflow-wrap:anywhere]">
      {r.email && <a className="text-j2s-purple hover:underline" href={`mailto:${r.email}`}>{r.email}</a>}
      {r.email && r.phone ? " · " : ""}
      {r.phone && <a className="text-j2s-purple hover:underline" href={`tel:${r.phone}`}>{r.phone}</a>}
    </div>
  );

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-j2s-ink/10 text-xs uppercase tracking-wide text-j2s-ink/50">
            <tr>
              <th className="py-2 pr-3 font-semibold">Instructor</th>
              {columns.map((k) => <th key={k} className="px-3 py-2 font-semibold">{COLUMN_LABEL[k]}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-j2s-ink/10 align-top">
            {people.map(({ r, lines }) => (
              <tr key={r.instructor_id}>
                <td className="py-2.5 pr-3">
                  <div className="font-semibold text-j2s-ink">{[r.first_name, r.last_name].filter(Boolean).join(" ")}</div>
                  <div className="text-xs text-j2s-ink/50">{(r.sites || []).join(", ")}</div>
                  {contact(r)}
                </td>
                {!r.shared ? (
                  <td colSpan={Math.max(columns.length, 1)} className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <DocumentStatusBadge badge={lines[0].badge} />
                      <span className="text-j2s-ink/70">{lines[0].detail}</span>
                    </div>
                  </td>
                ) : columns.map((key) => {
                  const l = lines.find((x) => x.key === key);
                  return (
                    <td key={key} className="px-3 py-2.5" title={l?.meta || undefined}>
                      {l && <DocumentStatusBadge badge={l.badge} />}
                      {l?.detail && <div className="mt-1 text-xs text-j2s-ink/60">{cellLine(l)}</div>}
                      {l?.meta && <div className="text-[11px] text-j2s-ink/40">{l.meta.split(" · Source")[0]}</div>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-2 md:hidden">
        {people.map(({ r, lines }) => {
          const shown = r.shared ? lines.filter((l) => columns.includes(l.key)) : lines;
          return (
            <div key={r.instructor_id} className="rounded-xl border border-j2s-ink/10 p-3">
              <div className="font-semibold text-j2s-ink">{[r.first_name, r.last_name].filter(Boolean).join(" ")}</div>
              <div className="text-xs text-j2s-ink/50">{(r.sites || []).join(", ")}</div>
              {contact(r)}
              <ul className="mt-2 divide-y divide-j2s-ink/5">
                {shown.map((l) => (
                  <li key={l.key} className="py-1.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-j2s-ink/80">{r.shared ? COLUMN_LABEL[l.key] ?? l.title : l.title}</span>
                      <DocumentStatusBadge badge={l.badge} />
                    </div>
                    {(l.detail || l.meta) && (
                      <div className="text-[11px] text-j2s-ink/45">{[l.detail && cellLine(l), l.meta].filter(Boolean).join(" · ")}</div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </>
  );
}
