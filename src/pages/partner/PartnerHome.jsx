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
import { listPartnerInstructors, listPartnerRequirements, logPartnerPortalEvent } from "../../lib/partnerPortal.js";
import { listProviderDocuments } from "../../lib/providerDocuments.js";
import { providerSummary, requiredKeys, worstBadge } from "../../lib/partnerPortalLogic.js";
import { formatDate } from "../../lib/providerDocumentLogic.js";
import { PartnerShell, PartnerSignIn, NoAccess, useMemberships, todayIso } from "./partnerShared.jsx";

// Spec v3 H1 states. Accepted / Lapsed / Invited / Unknown arrive with
// invitations and decisions (Nov 6); until then every provider sharing with a
// partner is Pending by definition ("shared its record; no decision").
const STATES = ["Unknown", "Invited", "Pending", "Accepted", "Lapsed"];

function Chip({ badge }) {
  return badge ? <DocumentStatusBadge badge={badge} /> : <span className="text-sm text-j2s-ink/40">None yet</span>;
}

// "2 of 2" with the worst chip among the partner's REQUIRED business items.
function RequirementsCell({ s }) {
  if (!s.total) return <span className="text-sm text-j2s-ink/40">None on your list</span>;
  const worst = worstBadge(s.business.map((b) => b.badge));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-j2s-ink/80">{s.met} of {s.total} met</span>
      <Chip badge={worst} />
    </div>
  );
}

function InstructorsCell({ s }) {
  if (!s.instructors.total) return <span className="text-sm text-j2s-ink/40">None assigned yet</span>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-j2s-ink/80">{s.instructors.current} of {s.instructors.total} current</span>
      <Chip badge={s.instructors.badge} />
    </div>
  );
}
export default function PartnerHome() {
  const { user, authLoading, signOut, memberships, error } = useMemberships();
  const [rows, setRows] = useState(null); // [{ m, summary }] | null
  const [loadError, setLoadError] = useState("");
  const [site, setSite] = useState("");

  // The visit log + usage capture (20261022b). Signing in lands here, so a host
  // who reads this table and leaves is still counted. Keyed on the partner ids,
  // not the array, so a re-fetch of the same memberships does not log again;
  // the database also folds repeats within 30 minutes into one visit.
  const partnerIdsKey = (memberships ?? []).map((m) => m.partner_id).join(",");
  useEffect(() => {
    if (!partnerIdsKey) return;
    for (const id of new Set(partnerIdsKey.split(","))) logPartnerPortalEvent(id, "portal_viewed");
  }, [partnerIdsKey]);

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
    // allSettled, not all: one provider's failed read must not hide the others.
    // The providers that failed are named in the error line above the table.
    Promise.allSettled(memberships.map(async (m) => {
      const [docs, instructors, requirements] = await Promise.all([
        docsByOrg.get(m.organization_id),
        listPartnerInstructors(m.partner_id),
        // A list that fails to load counts everything (requiredKeys(null)):
        // the row shows too much rather than hiding a gap.
        listPartnerRequirements(m.partner_id).catch(() => null),
      ]);
      return {
        m,
        summary: providerSummary({
          docs, instructors, partnerId: m.partner_id, orgName: m.organization_name, today, required: requiredKeys(requirements),
        }),
      };
    }))
      .then((results) => {
        if (cancelled) return;
        setRows(results.filter((r) => r.status === "fulfilled").map((r) => r.value));
        const failed = results
          .map((r, i) => (r.status === "rejected" ? memberships[i].organization_name : null))
          .filter(Boolean);
        if (failed.length) setLoadError(`Couldn't load ${failed.join(", ")} right now. Try refreshing.`);
      });
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
                  <th className="px-4 py-3 font-semibold">Requirements</th>
                  <th className="px-4 py-3 font-semibold">Instructors</th>
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
                    <td className="px-4 py-3"><RequirementsCell s={s} /></td>
                    <td className="px-4 py-3"><InstructorsCell s={s} /></td>
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
                <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-j2s-ink/60">Requirements</dt><dd><RequirementsCell s={s} /></dd>
                  <dt className="text-j2s-ink/60">Instructors</dt><dd><InstructorsCell s={s} /></dd>
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
