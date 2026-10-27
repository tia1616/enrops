// /admin/partner-documents - the provider's Partner portal: one row per partner
// it keeps a record for (Jessica 2026-10-27: "it should be a list of our
// partners"), each counted exactly as that partner's own portal counts it
// (providerSummary + the same cells the partner home uses). Click a partner to
// see what they see and to upload, renew or remove documents, set what they
// require and who there can log in (admin/PartnerRecord).
//
// Listed: partners with a document filed for them alone, or a login
// (partnersInUse). Every other partner, J2S has 94 mostly schools, is one pick
// away under "Set up another partner".
//
// Background checks, training and CPR are NOT entered here. They are per
// instructor and already recorded on each instructor's onboarding record; the
// partner view reads them there.
//
// Owners and admins only (the nav item's gate "settings" in AdminLayout).
// Expiry status comes from the database (provider_documents_with_status), never
// from a date comparison here, so this screen and the partner view always agree.

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { RequirementsCell, InstructorsCell } from "../partner/ProviderRecord.jsx";
import { todayIso } from "../partner/partnerShared.jsx";
import { listPartnerInstructors, listPartnerRequirements, listPortalAccess } from "../../lib/partnerPortal.js";
import { partnersInUse, providerSummary, requiredKeys } from "../../lib/partnerPortalLogic.js";
import { listProviderDocuments, listPartners } from "../../lib/providerDocuments.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";

const input = { width: "100%", padding: "10px 12px", border: `1.5px solid ${RULE}`, borderRadius: 8, fontSize: 14, color: INK, background: "#fff", fontFamily: "inherit", boxSizing: "border-box" };
const th = { padding: "10px 14px", borderBottom: `1px solid ${RULE}`, fontWeight: 700, whiteSpace: "nowrap" };
const td = { padding: "12px 14px", borderBottom: `1px solid ${RULE}`, verticalAlign: "middle" };

function loginsText(list) {
  if (!list.length) return "No one yet";
  const signedIn = list.filter((g) => g.last_signed_in_at).length;
  return `${list.length} ${list.length === 1 ? "person" : "people"}, ${signedIn} signed in`;
}

export default function ProviderDocuments() {
  const { org } = useOutletContext();
  const navigate = useNavigate();

  const [partners, setPartners] = useState(null);
  const [docs, setDocs] = useState([]);
  const [grants, setGrants] = useState([]);
  const [summaries, setSummaries] = useState(null); // Map partnerId -> summary | "failed"
  const [error, setError] = useState("");

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    setPartners(null); setSummaries(null); setError("");
    (async () => {
      // Each read stands alone: a failed logins read must not hide the
      // partners that have documents on file, and vice versa.
      const [pr, dr, gr] = await Promise.allSettled([listPartners(org.id), listProviderDocuments(org.id), listPortalAccess(org.id)]);
      if (cancelled) return;
      const failed = [pr, dr, gr].filter((r) => r.status === "rejected").map((r) => r.reason?.message ?? "unknown error");
      if (failed.length) setError(`Some of this page couldn't load: ${failed.join("; ")}. Try refreshing.`);
      const p = pr.status === "fulfilled" ? pr.value : [];
      const d = dr.status === "fulfilled" ? dr.value : [];
      const g = gr.status === "fulfilled" ? gr.value : [];
      setPartners(p); setDocs(d); setGrants(g);
      const today = todayIso();
      const inUse = partnersInUse(p, d, g);
      try {
        // allSettled: one partner's failed read must not hide the others.
        const results = await Promise.allSettled(inUse.map(async (row) => {
          const [instructors, requirements] = await Promise.all([
            listPartnerInstructors(row.id),
            // A list that fails to load counts everything, as the partner's own page does.
            listPartnerRequirements(row.id).catch(() => null),
          ]);
          const shown = d.filter((x) => !x.partner_id || x.partner_id === row.id);
          return [row.id, providerSummary({ docs: shown, instructors, partnerId: row.id, orgName: org.name, today, required: requiredKeys(requirements) })];
        }));
        if (cancelled) return;
        setSummaries(new Map(results.map((r, i) => (r.status === "fulfilled" ? r.value : [inUse[i].id, "failed"]))));
      } catch {
        if (!cancelled) setSummaries(new Map());
      }
    })();
    return () => { cancelled = true; };
  }, [org?.id, org?.name]);

  const used = useMemo(() => partnersInUse(partners ?? [], docs, grants), [partners, docs, grants]);
  const others = useMemo(() => {
    const ids = new Set(used.map((p) => p.id));
    return (partners ?? []).filter((p) => !p.inactive && !ids.has(p.id));
  }, [partners, used]);
  const sharedWithAll = docs.filter((d) => !d.partner_id);

  if (partners === null) {
    return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>;
  }

  return (
    // contain: on a phone the table scrolls inside its box, not the whole page (see PartnerRecord).
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "8px 0 40px", contain: "inline-size" }}>
      <h1 style={{ margin: "8px 0 4px", color: PURPLE, fontSize: 24, fontWeight: 700 }}>Partner portal</h1>
      <p style={{ color: MUTED, fontSize: 14, marginTop: 0, lineHeight: 1.5, maxWidth: 620 }}>
        Each partner you work with sees your record when they log in: your insurance certificate, your agreement with
        them, anything else they require, and your instructors at their sites. Open a partner to see exactly what they
        see and keep it current.
      </p>

      {error && <div role="alert" style={{ marginTop: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}

      {used.length === 0 ? (
        <div style={{ marginTop: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: "28px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>
            {sharedWithAll.length ? "Nothing filed for one partner yet" : "No partner records yet"}
          </div>
          <div style={{ fontSize: 13, color: MUTED, maxWidth: 460, margin: "6px auto 0", lineHeight: 1.5 }}>
            {sharedWithAll.length
              ? "Your shared documents (below) show to every partner. Pick a partner to see their page and add what's theirs alone."
              : "Pick a partner below to start. Their page shows what they'll see, with a place to upload each document they require."}
          </div>
        </div>
      ) : (
        <section style={{ marginTop: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5, minWidth: 640 }}>
            <thead>
              <tr style={{ textAlign: "left", color: MUTED, fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4 }}>
                <th style={th}>Partner</th>
                <th style={th}>Requirements</th>
                <th style={th}>Instructors</th>
                <th style={th}>Logins</th>
              </tr>
            </thead>
            <tbody>
              {used.map((p) => {
                const s = summaries?.get(p.id);
                const theirLogins = grants.filter((g) => g.partner_id === p.id);
                return (
                  <tr key={p.id}>
                    <td style={td}>
                      <Link to={`/admin/partner-documents/${p.id}`} style={{ color: BRIGHT, fontWeight: 700, textDecoration: "none" }}>{p.partner_name}</Link>
                      {p.inactive && <div style={{ fontSize: 12, color: "#92400e" }}>Archived</div>}
                    </td>
                    {!summaries ? (
                      <td style={{ ...td, color: MUTED }} colSpan={2}>Loading…</td>
                    ) : s === "failed" || !s ? (
                      <td style={{ ...td, color: "#991b1b" }} colSpan={2}>Couldn't load. Open the partner to see it.</td>
                    ) : (
                      <>
                        <td style={td}><RequirementsCell s={s} viewer="provider" /></td>
                        <td style={td}><InstructorsCell s={s} /></td>
                      </>
                    )}
                    <td style={{ ...td, color: MUTED }}>{loginsText(theirLogins)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {sharedWithAll.length > 0 && (
        <p style={{ fontSize: 13, color: MUTED, marginTop: 10, lineHeight: 1.5 }}>
          Shared with every partner: {sharedWithAll.map((d) => d.title).join(", ")}. It shows on each partner's page,
          and you can manage it from any of them.
        </p>
      )}

      {others.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <label htmlFor="other-partner" style={{ display: "block", fontSize: 14, fontWeight: 600, color: INK, marginBottom: 6 }}>Set up another partner</label>
          <select id="other-partner" value="" onChange={(e) => e.target.value && navigate(`/admin/partner-documents/${e.target.value}`)} style={{ ...input, maxWidth: 420 }}>
            <option value="">Choose a partner</option>
            {others.map((p) => <option key={p.id} value={p.id}>{p.partner_name}</option>)}
          </select>
          <div style={{ fontSize: 12.5, color: MUTED, marginTop: 6 }}>
            Not listed? Add them in <Link to="/admin/schools" style={{ color: BRIGHT }}>Locations</Link> first.
          </div>
        </section>
      )}
    </div>
  );
}
