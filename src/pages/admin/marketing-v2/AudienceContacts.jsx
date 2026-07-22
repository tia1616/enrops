// Instructor + Partner contact lists for Comms>Contacts.
//
// These are the CRM "your people" views — a clean, searchable people list per
// audience that matches the Families list's look. They are deliberately NOT the
// full operational surfaces: onboarding invites, background checks, availability,
// venues, and calendars stay at /admin/instructors and /admin/schools, and each
// view links out to them. Reads are org-scoped by RLS (org from the caller).

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import { BRIGHT, INK, MUTED, PURPLE, RULE } from "../marketing/tokens.jsx";
import ContactTimelineDrawer from "./ContactTimelineDrawer.jsx";

const CREAM = "#FBFBFB";
const RED = "#b53737";
const AMBER = "#b67e00";

const headCell = {
  position: "sticky", top: 0, background: CREAM, textAlign: "left",
  padding: "8px 10px", color: MUTED, fontWeight: 700, fontSize: 10.5,
  textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap",
  borderBottom: `1px solid ${RULE}`,
};
const listCell = { padding: "8px 10px", borderBottom: `1px solid ${RULE}`, whiteSpace: "nowrap", color: INK, verticalAlign: "top" };

function Dash() { return <span style={{ color: MUTED }}>—</span>; }

// Shared list scaffold: header (title + subtitle with a "manage" link), search
// box (+ optional toolbar), the table, and a count. Consumers supply column
// defs, the already-audience-filtered rows, and a per-row search string.
function PeopleList({ title, subtitle, searchPlaceholder, columns, rows, loading, error, searchText, emptyLabel, noun, toolbar, onRowClick }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    if (!rows) return null;
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => searchText(r).toLowerCase().includes(needle));
  }, [rows, q, searchText]);
  const span = columns.length + (onRowClick ? 1 : 0);

  return (
    <div>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ color: INK, fontSize: 26, fontWeight: 800, margin: "0 0 8px" }}>{title}</h1>
        <p style={{ color: MUTED, fontSize: 15, lineHeight: 1.55, margin: 0 }}>{subtitle}</p>
      </header>

      <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder}
            style={{ flex: "1 1 220px", padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", color: INK }}
          />
          {toolbar}
        </div>

        <div style={{ overflowX: "auto", border: `1px solid ${RULE}`, borderRadius: 6 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
            <thead>
              <tr>
                {columns.map((c) => <th key={c.key} style={{ ...headCell, zIndex: 2 }}>{c.label}</th>)}
                {onRowClick && <th style={{ ...headCell, right: 0, zIndex: 3, borderLeft: `1px solid ${RULE}` }} />}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={span} style={{ padding: 16, color: MUTED, fontSize: 13 }}>Loading…</td></tr>
              ) : error ? (
                <tr><td colSpan={span} style={{ padding: 16, color: RED, fontSize: 13 }}>{error}</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={span} style={{ padding: 16, color: MUTED, fontSize: 13 }}>{q ? `No ${noun} match “${q}”.` : emptyLabel}</td></tr>
              ) : filtered.map((r) => (
                <tr
                  key={r.__key}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  style={{ ...(r.__dim ? { opacity: 0.55 } : null), ...(onRowClick ? { cursor: "pointer" } : null) }}
                >
                  {columns.map((c) => <td key={c.key} style={listCell}>{c.render(r)}</td>)}
                  {onRowClick && <td style={{ ...listCell, textAlign: "right", color: BRIGHT, fontWeight: 600, whiteSpace: "nowrap", position: "sticky", right: 0, zIndex: 1, background: "#fff", borderLeft: `1px solid ${RULE}` }}>Activity ›</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
          {filtered && `${filtered.length} ${filtered.length === 1 ? noun.replace(/s$/, "") : noun}`}
        </div>
      </div>
    </div>
  );
}

// ─── Instructors ─────────────────────────────────────────────────────────────

export function InstructorContacts({ org }) {
  const [rows, setRows] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [showInactive, setShowInactive] = useState(false);
  const [openRow, setOpenRow] = useState(null); // contact whose timeline is open

  useEffect(() => {
    if (!org?.id) return;
    let alive = true;
    setRows(null); setError(null);
    (async () => {
      const { data, error } = await supabase
        .from("instructors")
        .select("id, first_name, last_name, preferred_name, email, phone, contractor_tier, is_active")
        .eq("organization_id", org.id)
        .order("last_name", { ascending: true, nullsFirst: false });
      if (!alive) return;
      if (error) { setError(`Couldn't load instructors: ${error.message}`); setRows([]); return; }
      setRows(data ?? []);
    })();
    return () => { alive = false; };
  }, [org?.id]);

  const nameOf = (r) => r.preferred_name?.trim() || `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || r.email || "";

  // Active/inactive filter is audience-level (before search) — pre-filter here so
  // the shared search box only sees what should be visible.
  const visible = useMemo(() => {
    if (!rows) return null;
    return rows
      .filter((r) => showInactive || r.is_active)
      .map((r) => ({ ...r, __key: r.id, __dim: !r.is_active }));
  }, [rows, showInactive]);

  const columns = [
    { key: "name", label: "Name", render: (r) => (
      <span><strong>{nameOf(r)}</strong>{!r.is_active && <span style={{ color: MUTED, fontWeight: 400 }}> · inactive</span>}</span>
    ) },
    { key: "email", label: "Email", render: (r) => r.email || <Dash /> },
    { key: "phone", label: "Phone", render: (r) => r.phone || <Dash /> },
    { key: "tier", label: "Tier", render: (r) => r.contractor_tier || <Dash /> },
  ];

  return (
    <>
    <PeopleList
      title="Instructors"
      subtitle={<>Everyone on your <Link to="/admin/instructors" style={{ color: BRIGHT, fontWeight: 600 }}>Instructor Roster</Link> shows up here automatically. Add instructors, send onboarding invites, or edit details there.</>}
      searchPlaceholder="Search name, email, phone…"
      columns={columns}
      rows={visible}
      loading={rows === null}
      error={error}
      searchText={(r) => [nameOf(r), r.email, r.phone].filter(Boolean).join(" ")}
      emptyLabel="No instructors yet — add them on your Instructor Roster and they'll appear here."
      noun="instructors"
      toolbar={
        <label style={{ display: "flex", alignItems: "center", gap: 6, color: MUTED, fontSize: 12 }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
        </label>
      }
      onRowClick={setOpenRow}
    />
    {openRow && (
      <ContactTimelineDrawer
        audience="instructors"
        contact={openRow}
        contactLabel={nameOf(openRow)}
        orgId={org?.id}
        onClose={() => setOpenRow(null)}
      />
    )}
    </>
  );
}

// ─── Partners ────────────────────────────────────────────────────────────────

export function PartnerContacts({ org }) {
  const [rows, setRows] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [openRow, setOpenRow] = useState(null); // contact whose timeline is open
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!org?.id) return;
    let alive = true;
    setRows(null); setError(null);
    (async () => {
      // Two org-scoped reads, joined client-side by partner_id — avoids relying on
      // a PostgREST embed relationship. partner_contacts carry organization_id.
      const [{ data: contacts, error: cErr }, { data: partners, error: pErr }] = await Promise.all([
        supabase
          .from("partner_contacts")
          .select("id, contact_name, contact_email, contact_phone, contact_role, is_org_inbox, partner_id")
          .eq("organization_id", org.id),
        supabase
          .from("partners")
          .select("id, partner_name, partner_type, location_area, inactive")
          .eq("organization_id", org.id),
      ]);
      if (!alive) return;
      if (cErr || pErr) { setError(`Couldn't load partner contacts: ${(cErr ?? pErr).message}`); setRows([]); return; }
      const pmap = new Map((partners ?? []).map((p) => [p.id, p]));
      const merged = (contacts ?? []).map((c) => {
        const p = pmap.get(c.partner_id);
        return {
          ...c,
          __key: c.id,
          partner_name: p?.partner_name ?? null,
          partner_type: p?.partner_type ?? null,
          partner_area: p?.location_area ?? null,
          __dim: !!p?.inactive,
        };
      });
      setRows(merged);
    })();
    return () => { alive = false; };
  }, [org?.id]);

  // Group contacts by partner — a school in the normal case, an umbrella org
  // (Parks & Rec, a district) for the ones that cover multiple venues. Search
  // filters within groups; empty groups drop out.
  const groups = useMemo(() => {
    if (!rows) return null;
    const needle = q.trim().toLowerCase();
    const visible = needle
      ? rows.filter((r) => [r.contact_name, r.contact_email, r.contact_phone, r.partner_name, r.contact_role].filter(Boolean).join(" ").toLowerCase().includes(needle))
      : rows;
    const map = new Map();
    for (const r of visible) {
      const key = r.partner_id ?? "__none__";
      if (!map.has(key)) map.set(key, { key, name: r.partner_name || "Unassigned", type: r.partner_type, area: r.partner_area, dim: r.__dim, contacts: [] });
      map.get(key).contacts.push(r);
    }
    for (const g of map.values()) g.contacts.sort((a, b) => (a.contact_name ?? "").localeCompare(b.contact_name ?? ""));
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, q]);

  const total = rows?.length ?? 0;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ color: INK, fontSize: 26, fontWeight: 800, margin: "0 0 8px" }}>Partners</h1>
        <p style={{ color: MUTED, fontSize: 15, lineHeight: 1.55, margin: 0 }}>
          The people at your partner sites you can email, grouped by school or organization. Add or edit each partner&apos;s contacts in the <Link to="/admin/schools" style={{ color: BRIGHT, fontWeight: 600 }}>Partners</Link> tab.
        </p>
      </header>

      <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 16 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, email, partner…"
          style={{ width: "100%", padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", color: INK, marginBottom: 12, boxSizing: "border-box" }}
        />

        {rows === null ? (
          <div style={{ color: MUTED, fontSize: 13, padding: 16 }}>Loading…</div>
        ) : error ? (
          <div style={{ color: RED, fontSize: 13, padding: 16 }}>{error}</div>
        ) : groups.length === 0 ? (
          <div style={{ color: MUTED, fontSize: 13, padding: 16 }}>{q ? `No partner contacts match “${q}”.` : "No partner contacts yet — add them under each partner in the Partners tab."}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {groups.map((g) => (
              <div key={g.key} style={{ border: `1px solid ${RULE}`, borderRadius: 8, overflow: "hidden", opacity: g.dim ? 0.6 : 1 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", background: CREAM, padding: "8px 12px", borderBottom: `1px solid ${RULE}` }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>{g.name}</span>
                  {g.type && <span style={{ fontSize: 10.5, fontWeight: 600, color: PURPLE, background: `${PURPLE}0F`, border: `1px solid ${PURPLE}22`, borderRadius: 999, padding: "1px 8px" }}>{PARTNER_TYPE_LABELS[g.type] || g.type.replace(/_/g, " ")}</span>}
                  {g.area && <span style={{ fontSize: 11.5, color: MUTED }}>· {g.area}</span>}
                  {g.dim && <span style={{ fontSize: 10.5, color: AMBER, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}>inactive</span>}
                  <span style={{ fontSize: 11.5, color: MUTED, marginLeft: "auto" }}>{g.contacts.length} contact{g.contacts.length === 1 ? "" : "s"}</span>
                </div>
                <div>
                  {g.contacts.map((c) => (
                    <button
                      key={c.__key}
                      type="button"
                      onClick={() => setOpenRow(c)}
                      style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", background: "#fff", border: "none", borderBottom: `1px solid ${CREAM}`, padding: "9px 12px", cursor: "pointer", fontFamily: "inherit" }}
                    >
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: INK }}>{c.contact_name || <em style={{ fontWeight: 400, color: MUTED }}>(no name)</em>}</span>
                        {c.contact_role && <span style={{ fontSize: 10.5, color: MUTED, marginLeft: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>{c.contact_role.replace(/_/g, " ")}</span>}
                        {c.is_org_inbox && <span style={{ fontSize: 10, color: AMBER, marginLeft: 6, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}>shared inbox</span>}
                        <span style={{ display: "block", fontSize: 12, color: MUTED, marginTop: 1 }}>{c.contact_email || "no email"}{c.contact_phone ? ` · ${c.contact_phone}` : ""}</span>
                      </span>
                      <span style={{ color: BRIGHT, fontWeight: 600, fontSize: 12, whiteSpace: "nowrap" }}>Activity ›</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
          {rows && `${total} contact${total === 1 ? "" : "s"} across ${groups?.length ?? 0} partner${(groups?.length ?? 0) === 1 ? "" : "s"}`}
        </div>
      </div>

      {openRow && (
        <ContactTimelineDrawer audience="partners" contact={openRow} contactLabel={openRow.contact_name || openRow.contact_email || "Partner contact"} orgId={org?.id} onClose={() => setOpenRow(null)} />
      )}
    </div>
  );
}

const PARTNER_TYPE_LABELS = {
  public_school: "Public school", private_school: "Private school",
  charter_school: "Charter school", school_district: "School district",
  parks_rec: "Parks & Rec", community_org: "Community org", church: "Church",
};
