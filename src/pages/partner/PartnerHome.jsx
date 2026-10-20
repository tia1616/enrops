// /partner - the partner home (spec v3 H1). "Your providers' safety record":
// one row per provider sharing with this partner, worst first, the way
// established vendor-compliance tools (TrustLayer, Covera, Aclaimant) show it:
// a table of status chips you scan, then open a provider for the detail.
//
// On Oct 30 a Happy Valley login has one row (Journey to STEAM); providers a
// partner invites add rows from Nov 6. Built as the list now so they drop in.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import DocumentStatusBadge from "../../components/DocumentStatusBadge.jsx";
import { listPartnerInstructors } from "../../lib/partnerPortal.js";
import { listProviderDocuments } from "../../lib/providerDocuments.js";
import { providerSummary } from "../../lib/partnerPortalLogic.js";
import { formatDate } from "../../lib/providerDocumentLogic.js";
import { PartnerShell, PartnerSignIn, NoAccess, useMemberships, todayIso } from "./partnerShared.jsx";

// Spec v3 H1 states. Accepted / Lapsed / Invited / Unknown arrive with
// invitations and decisions (Nov 6); until then every provider sharing with a
// partner is Pending by definition ("shared its record; no decision").
const STATES = ["Unknown", "Invited", "Pending", "Accepted", "Lapsed"];

function Chip({ badge }) {
  return badge ? <DocumentStatusBadge badge={badge} /> : <span className="text-sm text-j2s-ink/40">None yet</span>;
}

export default function PartnerHome() {
  const { user, authLoading, signOut, memberships, error } = useMemberships();
  const [rows, setRows] = useState(null); // [{ m, summary }] | null
  const [loadError, setLoadError] = useState("");
  const [site, setSite] = useState("");

  useEffect(() => {
    setRows(null);
    setLoadError("");
    if (!memberships || memberships.length === 0) return;
    let cancelled = false;
    const today = todayIso();
    // Documents are fetched once per provider; instructors once per partner row.
    const docsByOrg = new Map();
    for (const m of memberships) {
      if (!docsByOrg.has(m.organization_id)) docsByOrg.set(m.organization_id, listProviderDocuments(m.organization_id));
    }
    Promise.all(memberships.map(async (m) => {
      const [docs, instructors] = await Promise.all([docsByOrg.get(m.organization_id), listPartnerInstructors(m.partner_id)]);
      return { m, summary: providerSummary({ docs, instructors, partnerId: m.partner_id, orgName: m.organization_name, today }) };
    }))
      .then((r) => { if (!cancelled) setRows(r); })
      .catch((err) => { if (!cancelled) setLoadError(`Couldn't load your providers: ${err?.message ?? "unknown error"}`); });
    return () => { cancelled = true; };
  }, [memberships]);

  const sites = useMemo(() => [...new Set((rows ?? []).flatMap((r) => r.summary.sites))].sort(), [rows]);
  const shown = useMemo(() => {
    const list = (rows ?? []).filter((r) => !site || r.summary.sites.includes(site));
    return list.sort((a, b) => a.summary.rank - b.summary.rank || a.m.organization_name.localeCompare(b.m.organization_name));
  }, [rows, site]);

  if (authLoading) return <PartnerShell><p className="py-24 text-center text-j2s-ink/60">Loading…</p></PartnerShell>;
  if (!user) return <PartnerShell><PartnerSignIn /></PartnerShell>;
  if (memberships === null) return <PartnerShell onSignOut={signOut}><p className="py-24 text-center text-j2s-ink/60">Loading your providers…</p></PartnerShell>;
  if (memberships.length === 0) return <PartnerShell onSignOut={signOut}><NoAccess email={user.email} onSignOut={signOut} />{error && <p className="error-text mt-3">{error}</p>}</PartnerShell>;

  const partnerNames = [...new Set(memberships.map((m) => m.partner_name))].join(", ");
  const counts = { Pending: (rows ?? []).length };
  const feedbackOrg = { id: memberships[0].organization_id };

  return (
    <PartnerShell onSignOut={signOut} feedbackOrg={feedbackOrg}>
      <div className="text-sm font-semibold uppercase tracking-wide text-j2s-ink/50">{partnerNames}</div>
      {/* Spec v3 header, word for word. Never "vendor compliance". */}
      <h1 className="mt-1 text-3xl font-bold text-j2s-ink">Your providers' safety record</h1>

      <div className="mt-6 grid grid-cols-5 gap-2 sm:max-w-2xl">
        {STATES.map((s) => (
          <div key={s} className="rounded-xl bg-white px-3 py-2 text-center shadow-card">
            <div className="text-xl font-bold text-j2s-ink">{counts[s] ?? 0}</div>
            <div className="text-xs text-j2s-ink/60">{s}</div>
          </div>
        ))}
      </div>

      {sites.length > 1 && (
        <label className="mt-6 flex items-center gap-2 text-sm text-j2s-ink/70">
          Site
          <select value={site} onChange={(e) => setSite(e.target.value)} className="input-field max-w-xs py-1.5">
            <option value="">All sites</option>
            {sites.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      )}

      {(error || loadError) && <p className="error-text mt-4">{error || loadError}</p>}

      {rows === null && !loadError ? (
        <p className="mt-8 text-j2s-ink/60">Loading your providers…</p>
      ) : (
        <>
          {/* Desktop: the table. */}
          <div className="mt-6 hidden overflow-x-auto rounded-2xl bg-white shadow-card md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-j2s-ink/10 text-xs uppercase tracking-wide text-j2s-ink/50">
                <tr>
                  <th className="px-4 py-3 font-semibold">Provider</th>
                  <th className="px-4 py-3 font-semibold">Insurance</th>
                  <th className="px-4 py-3 font-semibold">Instructors</th>
                  <th className="px-4 py-3 font-semibold">Training</th>
                  <th className="px-4 py-3 font-semibold">Agreement</th>
                  <th className="px-4 py-3 font-semibold">Last change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-j2s-ink/10">
                {shown.map(({ m, summary: s }) => (
                  <tr key={m.partner_id} className="hover:bg-j2s-purple-soft/40">
                    <td className="px-4 py-3">
                      <Link to={`/partner/${m.partner_id}`} className="font-semibold text-j2s-purple hover:underline">{m.organization_name}</Link>
                      {s.sites.length > 0 && <div className="text-xs text-j2s-ink/50">{s.sites.join(", ")}</div>}
                    </td>
                    <td className="px-4 py-3"><Chip badge={s.insurance} /></td>
                    <td className="px-4 py-3">
                      {s.instructors.total > 0 ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-j2s-ink/80">{s.instructors.current} of {s.instructors.total} Current</span>
                          <Chip badge={s.instructors.badge} />
                        </div>
                      ) : <span className="text-sm text-j2s-ink/40">None assigned yet</span>}
                    </td>
                    <td className="px-4 py-3"><Chip badge={s.training} /></td>
                    <td className="px-4 py-3"><Chip badge={s.agreement} /></td>
                    <td className="px-4 py-3 text-j2s-ink/60">{s.lastChange ? formatDate(s.lastChange) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phone: the same rows as cards. */}
          <div className="mt-6 space-y-3 md:hidden">
            {shown.map(({ m, summary: s }) => (
              <Link key={m.partner_id} to={`/partner/${m.partner_id}`} className="block rounded-2xl bg-white p-4 shadow-card">
                <div className="font-semibold text-j2s-purple">{m.organization_name}</div>
                {s.sites.length > 0 && <div className="text-xs text-j2s-ink/50">{s.sites.join(", ")}</div>}
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                  <dt className="text-j2s-ink/60">Insurance</dt><dd><Chip badge={s.insurance} /></dd>
                  <dt className="text-j2s-ink/60">Instructors</dt>
                  <dd>{s.instructors.total > 0 ? <>{s.instructors.current} of {s.instructors.total} <Chip badge={s.instructors.badge} /></> : <span className="text-j2s-ink/40">None yet</span>}</dd>
                  <dt className="text-j2s-ink/60">Training</dt><dd><Chip badge={s.training} /></dd>
                  <dt className="text-j2s-ink/60">Agreement</dt><dd><Chip badge={s.agreement} /></dd>
                  <dt className="text-j2s-ink/60">Last change</dt><dd className="text-j2s-ink/70">{s.lastChange ? formatDate(s.lastChange) : "—"}</dd>
                </dl>
              </Link>
            ))}
          </div>
        </>
      )}
    </PartnerShell>
  );
}
