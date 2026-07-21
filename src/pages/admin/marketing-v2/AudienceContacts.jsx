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
import { BRIGHT, INK, MUTED, RULE } from "../marketing/tokens.jsx";
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
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
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
                {columns.map((c) => <th key={c.key} style={headCell}>{c.label}</th>)}
                {onRowClick && <th style={headCell} />}
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
                  {onRowClick && <td style={{ ...listCell, textAlign: "right", color: BRIGHT, fontWeight: 600, whiteSpace: "nowrap" }}>Activity ›</td>}
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
          .select("id, partner_name, inactive")
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
          __dim: !!p?.inactive,
        };
      });
      // Group visually by partner: sort by partner name, then contact name.
      merged.sort((a, b) =>
        (a.partner_name ?? "").localeCompare(b.partner_name ?? "") ||
        (a.contact_name ?? "").localeCompare(b.contact_name ?? ""));
      setRows(merged);
    })();
    return () => { alive = false; };
  }, [org?.id]);

  const columns = [
    { key: "contact", label: "Contact", render: (r) => (
      <span>
        <strong>{r.contact_name || <em style={{ fontWeight: 400, color: MUTED }}>(no name)</em>}</strong>
        {r.is_org_inbox && <span style={{ fontSize: 10, color: AMBER, marginLeft: 6, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}>shared inbox</span>}
      </span>
    ) },
    { key: "email", label: "Email", render: (r) => r.contact_email || <Dash /> },
    { key: "phone", label: "Phone", render: (r) => r.contact_phone || <Dash /> },
    { key: "role", label: "Role", render: (r) => (r.contact_role ? r.contact_role.replace(/_/g, " ") : <Dash />) },
    { key: "partner", label: "Partner", render: (r) => (
      <span>{r.partner_name || <Dash />}{r.__dim && <span style={{ color: MUTED, fontWeight: 400 }}> · inactive</span>}</span>
    ) },
  ];

  return (
    <>
    <PeopleList
      title="Partners"
      subtitle={<>Partner contacts come from your <Link to="/admin/schools" style={{ color: BRIGHT, fontWeight: 600 }}>Partners</Link> tab — add or edit each partner&apos;s contacts there and they show up here to email.</>}
      searchPlaceholder="Search name, email, partner…"
      columns={columns}
      rows={rows}
      loading={rows === null}
      error={error}
      searchText={(r) => [r.contact_name, r.contact_email, r.contact_phone, r.partner_name, r.contact_role].filter(Boolean).join(" ")}
      emptyLabel="No partner contacts yet — add them under each partner in the Partners tab."
      noun="contacts"
      onRowClick={setOpenRow}
    />
    {openRow && (
      <ContactTimelineDrawer
        audience="partners"
        contact={openRow}
        contactLabel={openRow.contact_name || openRow.contact_email || "Partner contact"}
        orgId={org?.id}
        onClose={() => setOpenRow(null)}
      />
    )}
    </>
  );
}
