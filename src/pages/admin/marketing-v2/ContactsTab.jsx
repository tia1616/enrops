// ContactsTab — the Family Comms contact list surface.
//
// Why this exists: campaigns build their Q2 audience from `marketing_recipients`.
// A brand-new tenant has 0 rows there, so they can't send anything until they
// load their list. This tab shows the current contact count and an
// upload flow that writes into marketing_recipients via the import-contacts
// edge fn (service-role, but org-gated + org-stamped per row).
//
// Upload flow:
//   1. pick a .csv (or .xlsx) → parse client-side (SheetJS, already a dep)
//   2. column-mapping preview — auto-guess header → field, operator confirms
//   3. preview first ~10 mapped rows + valid-email count
//   4. required consent checkbox ("I have permission to email these contacts")
//   5. commit → supabase.functions.invoke("import-contacts")
//   6. show result (inserted / updated / skipped / invalid) + refresh count
//
// Org comes from useOutletContext — never hardcoded. Copy is tenant-neutral.

import { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import { PURPLE, BRIGHT, INK, MUTED, RULE, OK, WARN } from "../marketing/tokens.jsx";
import FamilyCommsTabs from "./FamilyCommsTabs.jsx";
import ElapsedTimer from "../../../components/ElapsedTimer.jsx";
import { InstructorContacts, PartnerContacts } from "./AudienceContacts.jsx";
import ContactTimelineDrawer from "./ContactTimelineDrawer.jsx";

// Comms is the single CRM hub for all three audiences. Instructors + Partners
// get a light, consistent "your people" contacts list here (name / email /
// phone) that matches the Families list — NOT the full operational surfaces.
// Onboarding, background checks, venues, and calendars stay at
// /admin/instructors and /admin/schools; these views link out to them.

const CREAM = "#FBFBFB";
const RED = "#b53737";

// Fields we can pull out of a contact CSV → columns on marketing_recipients.
// `email` is the only required one — nothing sends without it.
const CONTACT_FIELDS = [
  { key: "email", label: "Email", required: true,
    aliases: ["email", "emailaddress", "email_address", "e-mail", "mail", "parentemail", "guardianemail"] },
  { key: "parent_name", label: "Parent / guardian name",
    aliases: ["parentname", "guardianname", "parent", "guardian", "name", "fullname", "contactname", "familyname"] },
  { key: "phone", label: "Phone",
    aliases: ["phone", "phonenumber", "tel", "telephone", "mobile", "cell", "cellphone", "contactphone"] },
  { key: "child_first_name", label: "Child first name",
    aliases: ["childfirstname", "studentfirstname", "childfirst", "firstname", "kidfirstname", "childname"] },
  { key: "child_last_name", label: "Child last name",
    aliases: ["childlastname", "studentlastname", "childlast", "lastname", "surname"] },
  { key: "school_name", label: "School",
    aliases: ["schoolname", "school", "site", "sitename", "campus"] },
  { key: "city", label: "City",
    aliases: ["city", "town", "municipality"] },
  { key: "state", label: "State",
    aliases: ["state", "province", "region"] },
  { key: "zip", label: "ZIP / postal code",
    aliases: ["zip", "zipcode", "postalcode", "postcode", "zip_code"] },
  { key: "child_birthdate", label: "Child date of birth",
    aliases: ["childbirthdate", "childdob", "dob", "birthdate", "dateofbirth", "birthday", "studentdob", "studentbirthdate", "childbirthday"] },
  // Optional grouping label (e.g. membership tier). Lands in
  // marketing_recipients.tags and powers the "A group / tag…" campaign audience.
  { key: "tags", label: "Group / tag (e.g. membership tier)",
    aliases: ["tag", "tags", "group", "groups", "segment", "tier", "membership", "membershiptype", "membershipoption", "plan", "level", "category"] },
];

// A group/tier cell may hold one value ("All-Inclusive $120") or several
// ("vip, scholarship"). Split on comma/semicolon into a clean tag array.
function splitTags(v) {
  if (!v) return [];
  return v.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normHeader(h) {
  return (h ?? "").toString().toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Auto-map CSV headers to our fields. Longest alias that appears as a substring
// of the normalized header wins; falls back to exact equality. Mirrors the
// deterministic mapping in the partner importer.
function autoMapColumns(headers) {
  const map = {};
  const norm = headers.map(normHeader);
  const claimed = new Set();
  for (const def of CONTACT_FIELDS) {
    const aliases = [...def.aliases].sort((a, b) => b.length - a.length);
    let pickIdx = -1;
    for (const alias of aliases) {
      const a = normHeader(alias);
      const exact = norm.findIndex((h, i) => h === a && !claimed.has(headers[i]));
      if (exact !== -1) { pickIdx = exact; break; }
      const sub = norm.findIndex((h, i) => h.includes(a) && !claimed.has(headers[i]));
      if (sub !== -1) { pickIdx = sub; break; }
    }
    if (pickIdx !== -1) {
      map[def.key] = headers[pickIdx];
      claimed.add(headers[pickIdx]);
    }
  }
  return map;
}

// Tiny CSV parser — handles quoted fields with embedded commas, escaped quotes
// (""), and CRLF/LF endings. Mirrors the one in Rosters.jsx. Excel files go
// through SheetJS instead (dynamic import, keeps it out of the main bundle).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* swallow */ }
      else field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }
  if (rows.length === 0) return { headers: [], data: [] };
  const headers = rows[0].map((h) => (h ?? "").toString());
  const data = rows.slice(1).filter((r) => r.some((c) => c !== ""));
  return { headers, data };
}

// Turn the confirmed column mapping into contact objects the edge fn accepts.
// bulkTags are applied to EVERY contact in the file (the "tag everyone" box),
// unioned with any per-row tags from a mapped Group/tag column.
function buildContacts(headers, rows, mapping, bulkTags = []) {
  const idx = {};
  for (const f of CONTACT_FIELDS) idx[f.key] = mapping[f.key] ? headers.indexOf(mapping[f.key]) : -1;
  const at = (row, key) => (idx[key] >= 0 ? (row[idx[key]] ?? "").toString().trim() : "");
  const out = [];
  for (const row of rows) {
    const email = at(row, "email");
    // Per-row column tags ∪ "tag everyone" tags, de-duped. The importer merges
    // these into any tags a contact already has, so imports only ADD.
    const rowTags = [...new Set([...(idx.tags >= 0 ? splitTags(at(row, "tags")) : []), ...bulkTags])];
    // Keep every row for the preview/count; the edge fn does the final
    // validity gate. We surface the valid-email count so the operator sees it.
    out.push({
      email,
      parent_name: at(row, "parent_name") || null,
      phone: at(row, "phone") || null,
      child_first_name: at(row, "child_first_name") || null,
      child_last_name: at(row, "child_last_name") || null,
      school_name: at(row, "school_name") || null,
      city: at(row, "city") || null,
      state: at(row, "state") || null,
      zip: at(row, "zip") || null,
      child_birthdate: at(row, "child_birthdate") || null,
      ...(rowTags.length ? { tags: rowTags } : {}),
    });
  }
  return out;
}

// Read a File to base64 (no "data:" prefix) for the extract-contacts edge fn.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || "");
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

// PDF/Word are AI-extracted server-side and come back already keyed to our
// fields, so we skip column-mapping and feed the review table a 1:1 mapping.
const DOC_COLUMNS = ["email", "parent_name", "phone", "child_first_name", "child_last_name", "child_birthdate", "school_name", "city", "state", "zip"];

export default function ContactsTab() {
  const { org } = useOutletContext() ?? {};
  const [params, setParams] = useSearchParams();

  // Audience selection rides in the URL (?audience=) so it survives refresh +
  // deep links, and the sidebar "Comms" item stays lit (path is unchanged:
  // /admin/family-comms/contacts). Default (no param) = families.
  const audience = ["instructors", "partners"].includes(params.get("audience"))
    ? params.get("audience")
    : "families";
  function selectAudience(a) {
    const next = new URLSearchParams(params);
    if (a === "families") next.delete("audience");
    else next.set("audience", a);
    setParams(next, { replace: true });
  }

  return (
    <div style={{ padding: "24px 32px" }}>
      <div>
        <FamilyCommsTabs active="contacts" />
        <AudienceSwitcher active={audience} onSelect={selectAudience} />
      </div>
      {audience === "families" && <FamiliesContacts org={org} />}
      {audience === "instructors" && <InstructorContacts org={org} />}
      {audience === "partners" && <PartnerContacts org={org} />}
    </div>
  );
}

// Segmented control leading the Contacts surface. Three CRM audiences:
// families (marketing_recipients), instructors (the roster), partners
// (partner_contacts) — the enrichment-specific shape no marketing tool nails.
function AudienceSwitcher({ active, onSelect }) {
  const items = [
    { key: "families", label: "Families" },
    { key: "instructors", label: "Instructors" },
    { key: "partners", label: "Partners" },
  ];
  return (
    <div role="tablist" aria-label="Contact audience" style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
      {items.map((it) => {
        const on = active === it.key;
        return (
          <button
            key={it.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onSelect(it.key)}
            style={{
              padding: "7px 16px",
              borderRadius: 999,
              border: `1px solid ${on ? BRIGHT : RULE}`,
              background: on ? BRIGHT : "#fff",
              color: on ? "#fff" : MUTED,
              fontSize: 13,
              fontWeight: on ? 700 : 500,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function FamiliesContacts({ org }) {
  const [count, setCount] = useState(null); // null = loading
  const [countErr, setCountErr] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setCount(null);
      setCountErr(null);
      const { count: n, error } = await supabase
        .from("marketing_recipients")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id);
      if (cancelled) return;
      if (error) { setCountErr(error.message); setCount(0); return; }
      setCount(n ?? 0);
    })();
    return () => { cancelled = true; };
  }, [org?.id, refreshKey]);

  return (
    <div>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ color: INK, fontSize: 26, fontWeight: 800, margin: "0 0 8px" }}>
          Families
        </h1>
        <p style={{ color: MUTED, fontSize: 15, lineHeight: 1.55, margin: 0 }}>
          This is the list your campaigns send to. Upload your families&apos; email
          addresses here so you can start sending. You choose who receives each
          campaign when you build it.
        </p>
      </header>

      <div style={{
        display: "flex", gap: 16, alignItems: "center", justifyContent: "space-between",
        background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12,
        padding: 18, marginBottom: 18, flexWrap: "wrap",
      }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6 }}>
            Contacts on your list
          </div>
          <div style={{ fontSize: 32, fontWeight: 700, color: INK, lineHeight: 1.1, marginTop: 2 }}>
            {count === null ? "—" : count.toLocaleString()}
          </div>
          {countErr && (
            <div style={{ fontSize: 12, color: RED, marginTop: 4 }}>Couldn&apos;t load your count. Refresh and try again.</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setUploading(true)}
          style={{
            padding: "10px 16px", background: BRIGHT, color: "#fff", border: "none",
            borderRadius: 6, fontSize: 14, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
          }}
        >
          Upload contacts →
        </button>
      </div>

      {count === 0 && !countErr && (
        <div style={{ border: `1px dashed ${RULE}`, borderRadius: 12, padding: 28, textAlign: "center", color: MUTED }}>
          <p style={{ margin: "0 0 4px", color: INK, fontWeight: 600 }}>No contacts yet</p>
          <p style={{ margin: 0, fontSize: 13 }}>
            Upload a CSV of your families to build your list — then you can send your first campaign.
          </p>
        </div>
      )}

      {count > 0 && org?.id && (
        <ContactsList orgId={org.id} refreshKey={refreshKey} />
      )}

      {uploading && org?.id && (
        <UploadModal
          orgId={org.id}
          onClose={() => setUploading(false)}
          onImported={() => {
            setUploading(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

// ─── Contacts list (view + search + filter by tag) ───────────────────────────
// The Contacts tab used to show only a count — no way to actually see who's on
// the list or confirm tags landed. This is a paginated, tenant-safe viewer
// (marketing_recipients RLS is org-gated) with name/email search + a tag filter.
const LIST_PAGE = 25;
const listCell = { padding: "8px 10px", borderBottom: `1px solid ${RULE}`, whiteSpace: "nowrap", color: INK, verticalAlign: "top" };
function pagerBtn(disabled) {
  return {
    padding: "5px 12px", background: disabled ? "#f3f3f3" : "#fff",
    color: disabled ? MUTED : PURPLE, border: `1px solid ${RULE}`, borderRadius: 6,
    fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer",
  };
}

function ContactsList({ orgId, refreshKey }) {
  const [q, setQ] = useState("");
  const [tag, setTag] = useState(""); // "" = all tags
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState(null);
  const [tagOptions, setTagOptions] = useState([]);
  const [debouncedQ, setDebouncedQ] = useState("");
  const [editId, setEditId] = useState(null); // contact being edited, or null
  const [activityRow, setActivityRow] = useState(null); // contact whose timeline is open
  const [localRefresh, setLocalRefresh] = useState(0); // bump to re-fetch after an edit
  const [newTagOpen, setNewTagOpen] = useState(false);
  const [newTag, setNewTag] = useState("");
  const seqRef = useRef(0);

  // Debounce the search box so we fire one query after typing settles, not per
  // keystroke. Reset to page 0 in the SAME batch as the debounced term so the
  // fetch effect fires once, not twice (stale page + separate reset).
  useEffect(() => {
    const h = setTimeout(() => { setDebouncedQ(q); setPage(0); }, 200);
    return () => clearTimeout(h);
  }, [q]);

  // Distinct tags for the filter dropdown (single page is plenty for a picker).
  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    (async () => {
      // Filter list = tags in use ∪ the saved-tags registry, so a freshly
      // created tag (not yet on any contact) still shows up. In-use tags come
      // from an RPC (server-side unnest+distinct) so a tag on a contact past
      // row 2000 isn't silently dropped — the old .limit(2000) truncated it.
      const [usedRes, regRes] = await Promise.all([
        supabase.rpc("distinct_marketing_tags", { p_org: orgId }),
        supabase.from("marketing_tags").select("name").eq("organization_id", orgId),
      ]);
      if (!alive) return;
      const set = new Set();
      for (const t of usedRes.data ?? []) if (t) set.add(t);
      for (const r of regRes.data ?? []) if (r.name) set.add(r.name);
      setTagOptions([...set].sort((a, b) => a.localeCompare(b)));
    })();
    return () => { alive = false; };
  }, [orgId, refreshKey, localRefresh]);

  // A fresh import (refreshKey) returns to the first page. Search + tag changes
  // reset the page inline at their source (batched), so no extra fetch fires here.
  useEffect(() => { setPage(0); }, [refreshKey]);

  useEffect(() => {
    if (!orgId) return;
    const seq = ++seqRef.current;
    let alive = true;
    setRows(null);
    setErr(null);
    (async () => {
      let query = supabase
        .from("marketing_recipients")
        .select("id, email, parent_name, child_first_name, child_last_name, geo_segment, tags", { count: "exact" })
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false })
        .range(page * LIST_PAGE, page * LIST_PAGE + LIST_PAGE - 1);
      if (tag) query = query.contains("tags", [tag]);
      // Strip PostgREST-significant chars (incl. the * and _ wildcards) so search
      // is literal and a stray comma/paren can't break the or() filter.
      const safe = debouncedQ.replace(/[,()%*_]/g, " ").trim();
      if (safe) {
        query = query.or(
          `parent_name.ilike.%${safe}%,email.ilike.%${safe}%,child_first_name.ilike.%${safe}%,child_last_name.ilike.%${safe}%`,
        );
      }
      const { data, error, count } = await query;
      // Ignore superseded (out-of-order) responses and unmounts.
      if (!alive || seq !== seqRef.current) return;
      if (error) { setErr(error.message); setRows([]); return; }
      setRows(data ?? []);
      setTotal(count ?? 0);
      // If a filter or a delete shrank the set below the current page, step back.
      if ((data?.length ?? 0) === 0 && page > 0) setPage(0);
    })();
    return () => { alive = false; };
  }, [orgId, debouncedQ, tag, page, refreshKey, localRefresh]);

  // Create a reusable tag (saved-tags registry). RLS org-scopes the insert; a
  // duplicate just means it already exists, so we add it locally either way.
  async function createTag() {
    const name = newTag.trim();
    if (!name) { setNewTagOpen(false); return; }
    const { error } = await supabase.from("marketing_tags").insert({ organization_id: orgId, name });
    // Duplicate just means it already exists — fine. Log anything else; the tag
    // won't persist and the next re-sync drops it (rare; RLS-gated insert).
    if (error && !/duplicate|unique/i.test(error.message)) console.error("[ContactsTab] create tag failed", error);
    setTagOptions((prev) => [...new Set([...prev, name])].sort((a, b) => a.localeCompare(b)));
    setNewTag("");
    setNewTagOpen(false);
  }

  const from = total === 0 ? 0 : page * LIST_PAGE + 1;
  const to = Math.min((page + 1) * LIST_PAGE, total);

  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 16 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or email…"
          style={{ flex: "1 1 220px", padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", color: INK }}
        />
        <select
          value={tag}
          onChange={(e) => { setTag(e.target.value); setPage(0); }}
          style={{ padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", background: "#fff", color: INK }}
        >
          <option value="">All tags</option>
          {tagOptions.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {newTagOpen ? (
          <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <input
              autoFocus
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); createTag(); } if (e.key === "Escape") { setNewTagOpen(false); setNewTag(""); } }}
              placeholder="New tag name"
              style={{ padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", color: INK, width: 150 }}
            />
            <button type="button" onClick={createTag} style={{ padding: "8px 12px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>Add</button>
            <button type="button" onClick={() => { setNewTagOpen(false); setNewTag(""); }} style={{ background: "transparent", border: "none", color: MUTED, fontSize: 16, cursor: "pointer" }} aria-label="Cancel">✕</button>
          </span>
        ) : (
          <button type="button" onClick={() => setNewTagOpen(true)} style={{ padding: "8px 12px", background: "#fff", color: PURPLE, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>+ New tag</button>
        )}
      </div>

      <div style={{ overflowX: "auto", border: `1px solid ${RULE}`, borderRadius: 6 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
          <thead>
            <tr>
              {["Email", "Parent", "Child", "Area", "Tags"].map((h) => (
                <th key={h} style={{ position: "sticky", top: 0, zIndex: 2, background: CREAM, textAlign: "left", padding: "8px 10px", color: MUTED, fontWeight: 700, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap", borderBottom: `1px solid ${RULE}` }}>{h}</th>
              ))}
              <th style={{ position: "sticky", top: 0, right: 0, zIndex: 3, background: CREAM, borderBottom: `1px solid ${RULE}`, borderLeft: `1px solid ${RULE}` }} />

            </tr>
          </thead>
          <tbody>
            {rows === null ? (
              <tr><td colSpan={6} style={{ padding: 16, color: MUTED, fontSize: 13 }}>Loading…</td></tr>
            ) : err ? (
              <tr><td colSpan={6} style={{ padding: 16, color: RED, fontSize: 13 }}>Couldn&apos;t load contacts: {err}</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: 16, color: MUTED, fontSize: 13 }}>No contacts match{tag ? ` the tag “${tag}”` : ""}{q ? ` “${q}”` : ""}.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.id}>
                <td style={listCell}><strong>{r.email}</strong></td>
                <td style={listCell}>{r.parent_name || <span style={{ color: MUTED }}>—</span>}</td>
                <td style={listCell}>{[r.child_first_name, r.child_last_name].filter(Boolean).join(" ") || <span style={{ color: MUTED }}>—</span>}</td>
                <td style={listCell}>{r.geo_segment || <span style={{ color: MUTED }}>—</span>}</td>
                <td style={listCell}>
                  {(r.tags ?? []).length === 0 ? <span style={{ color: MUTED }}>—</span> : (
                    <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {r.tags.map((t) => (
                        <span key={t} style={{ fontSize: 11, fontWeight: 600, color: PURPLE, background: `${PURPLE}0F`, border: `1px solid ${PURPLE}22`, borderRadius: 999, padding: "1px 8px", whiteSpace: "nowrap" }}>{t}</span>
                      ))}
                    </span>
                  )}
                </td>
                <td style={{ ...listCell, textAlign: "right", whiteSpace: "nowrap", position: "sticky", right: 0, zIndex: 1, background: "#fff", borderLeft: `1px solid ${RULE}` }}>
                  <button type="button" onClick={() => setActivityRow(r)} style={{ padding: "3px 10px", marginRight: 6, background: "#fff", color: BRIGHT, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 11.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>Activity</button>
                  <button type="button" onClick={() => setEditId(r.id)} style={{ padding: "3px 10px", background: "#fff", color: PURPLE, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 11.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, fontSize: 12, color: MUTED }}>
        <span>{total === 0 ? "No contacts" : `Showing ${from}–${to} of ${total.toLocaleString()}`}</span>
        <span style={{ display: "flex", gap: 6 }}>
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} style={pagerBtn(page === 0)}>← Prev</button>
          <button type="button" disabled={to >= total} onClick={() => setPage((p) => p + 1)} style={pagerBtn(to >= total)}>Next →</button>
        </span>
      </div>

      {editId && (
        <EditContactModal
          orgId={orgId}
          contactId={editId}
          suggestions={tagOptions}
          onClose={() => setEditId(null)}
          onSaved={() => { setEditId(null); setLocalRefresh((n) => n + 1); }}
        />
      )}

      {activityRow && (
        <ContactTimelineDrawer
          audience="families"
          contact={activityRow}
          contactLabel={activityRow.parent_name || activityRow.email}
          orgId={orgId}
          onClose={() => setActivityRow(null)}
        />
      )}
    </div>
  );
}

// Edit a single contact — fields + tags. Writes directly to marketing_recipients
// (RLS org-gates the update). Import only ever ADDS tags; this is where an
// operator removes/fixes them or corrects a detail after upload.
function EditContactModal({ orgId, contactId, onClose, onSaved, suggestions = [] }) {
  const [row, setRow] = useState(null);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [tagInput, setTagInput] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase
        .from("marketing_recipients")
        .select("id, email, parent_name, phone, child_first_name, child_last_name, child_birthdate, school_name, city, state, zip, tags")
        .eq("id", contactId)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (!alive) return;
      if (error || !data) { setErr(error?.message ?? "Couldn't load this contact."); return; }
      setRow({ ...data, tags: data.tags ?? [] });
    })();
    return () => { alive = false; };
  }, [contactId, orgId]);

  const set = (k, v) => setRow((r) => ({ ...r, [k]: v }));
  function addTag() {
    const parts = splitTags(tagInput);
    if (!parts.length) return;
    setRow((r) => ({ ...r, tags: [...new Set([...(r.tags ?? []), ...parts])] }));
    setTagInput("");
  }
  const removeTag = (t) => setRow((r) => ({ ...r, tags: (r.tags ?? []).filter((x) => x !== t) }));

  async function save() {
    setErr("");
    const email = (row.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { setErr("Enter a valid email — nothing sends without it."); return; }
    setSaving(true);
    // Writes to marketing_recipients go through a service-role edge fn (the table
    // grants withhold UPDATE from the client). The fn re-validates + org-scopes.
    const { error } = await supabase.functions.invoke("update-contact", {
      body: {
        organization_id: orgId,
        id: contactId,
        email,
        parent_name: row.parent_name,
        phone: row.phone,
        child_first_name: row.child_first_name,
        child_last_name: row.child_last_name,
        child_birthdate: row.child_birthdate || null,
        school_name: row.school_name,
        city: row.city,
        state: row.state,
        zip: row.zip,
        tags: row.tags ?? [],
      },
    });
    if (error) {
      let msg = error.message ?? "Couldn't save.";
      try {
        const resp = error?.context?.response ?? error?.context;
        if (resp && typeof resp.clone === "function") {
          const t = await resp.clone().text();
          try { const p = JSON.parse(t); if (p?.error) msg = p.error; } catch { /* not JSON */ }
        }
      } catch { /* ignore */ }
      setErr(msg);
      setSaving(false);
      return;
    }
    onSaved();
  }

  const fld = { width: "100%", padding: "7px 9px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", color: INK, boxSizing: "border-box" };
  const lbl = { fontSize: 11, fontWeight: 600, color: MUTED, marginBottom: 3, display: "block" };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px", zIndex: 200, fontFamily: "inherit" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, maxWidth: 560, width: "100%", padding: 22, maxHeight: "90vh", overflowY: "auto", boxShadow: "0 10px 40px rgba(0,0,0,0.25)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: INK }}>Edit contact</h2>
          <button type="button" onClick={onClose} style={{ background: "transparent", border: "none", color: MUTED, fontSize: 18, cursor: "pointer" }} aria-label="Close">✕</button>
        </div>
        {err && <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>{err}</div>}
        {row === null ? (
          <div style={{ padding: "30px 0", textAlign: "center", color: MUTED, fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
              <div style={{ gridColumn: "1 / -1" }}><label style={lbl}>Email *</label><input style={fld} value={row.email ?? ""} onChange={(e) => set("email", e.target.value)} /></div>
              <div><label style={lbl}>Parent / guardian</label><input style={fld} value={row.parent_name ?? ""} onChange={(e) => set("parent_name", e.target.value)} /></div>
              <div><label style={lbl}>Phone</label><input style={fld} value={row.phone ?? ""} onChange={(e) => set("phone", e.target.value)} /></div>
              <div><label style={lbl}>Child first name</label><input style={fld} value={row.child_first_name ?? ""} onChange={(e) => set("child_first_name", e.target.value)} /></div>
              <div><label style={lbl}>Child last name</label><input style={fld} value={row.child_last_name ?? ""} onChange={(e) => set("child_last_name", e.target.value)} /></div>
              <div><label style={lbl}>Child birthdate</label><input type="date" style={fld} value={row.child_birthdate ?? ""} onChange={(e) => set("child_birthdate", e.target.value)} /></div>
              <div><label style={lbl}>School / center</label><input style={fld} value={row.school_name ?? ""} onChange={(e) => set("school_name", e.target.value)} /></div>
              <div><label style={lbl}>City</label><input style={fld} value={row.city ?? ""} onChange={(e) => set("city", e.target.value)} /></div>
              <div><label style={lbl}>State</label><input style={fld} value={row.state ?? ""} onChange={(e) => set("state", e.target.value)} /></div>
              <div><label style={lbl}>ZIP</label><input style={fld} value={row.zip ?? ""} onChange={(e) => set("zip", e.target.value)} /></div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={lbl}>Tags</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6 }}>
                {(row.tags ?? []).length === 0 ? <span style={{ color: MUTED, fontSize: 12 }}>No tags yet</span> : row.tags.map((t) => (
                  <span key={t} style={{ fontSize: 11.5, fontWeight: 600, color: PURPLE, background: `${PURPLE}0F`, border: `1px solid ${PURPLE}22`, borderRadius: 999, padding: "2px 6px 2px 10px", display: "inline-flex", alignItems: "center", gap: 4 }}>
                    {t}
                    <button type="button" onClick={() => removeTag(t)} style={{ background: "transparent", border: "none", color: PURPLE, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }} aria-label={`Remove ${t}`}>×</button>
                  </span>
                ))}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input list="edit-tag-suggestions" style={{ ...fld, flex: 1 }} value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }} placeholder="Add a tag (e.g. VIP), press Enter" />
                <datalist id="edit-tag-suggestions">{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
                <button type="button" onClick={addTag} style={{ padding: "7px 12px", background: "#fff", color: PURPLE, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>Add</button>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 12, borderTop: `1px solid ${RULE}` }}>
              <button type="button" onClick={onClose} style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}>Cancel</button>
              <button type="button" onClick={save} disabled={saving} style={{ padding: "8px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "Save changes"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Upload modal ───────────────────────────────────────────────────────────

function UploadModal({ orgId, onClose, onImported }) {
  const [step, setStep] = useState("pick"); // pick | parsing | mapping | committing | done
  const [elapsed, setElapsed] = useState(0); // live m:ss counter for the file read (PDF = AI extract)

  // Tick the elapsed counter once per second while a file is being read.
  useEffect(() => {
    if (step !== "parsing") return undefined;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [step]);
  const [file, setFile] = useState(null);
  const [error, setError] = useState("");
  const [rawHeaders, setRawHeaders] = useState([]);
  const [rawRows, setRawRows] = useState([]);
  const [mapping, setMapping] = useState({});
  const [consent, setConsent] = useState(false);
  const [result, setResult] = useState(null);
  const [bulkTags, setBulkTags] = useState([]);
  const [existingTags, setExistingTags] = useState([]);
  // "new" (send the welcome) | "existing" (skip it). Drives suppress_welcome.
  const [welcomeChoice, setWelcomeChoice] = useState("new");

  // Existing tags power the "tag everyone" autocomplete + the tidy-up nudge.
  // Uses the distinct-tags RPC (server-side unnest+distinct) so every tag shows,
  // not just those on the first 2000 rows; the operator can still type a new one.
  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    (async () => {
      const { data } = await supabase.rpc("distinct_marketing_tags", { p_org: orgId });
      if (!alive) return;
      const set = new Set();
      for (const t of data ?? []) if (t) set.add(t);
      setExistingTags([...set].sort());
    })();
    return () => { alive = false; };
  }, [orgId]);

  async function startParse() {
    setError("");
    if (!file) { setError("Pick a file first."); return; }
    setStep("parsing");
    // Clear any state from a prior parse so a failed/retried upload can't carry
    // a previous file's rows into the review table.
    setRawHeaders([]); setRawRows([]); setMapping({}); setElapsed(0);
    // Reset per-file choices too, so a Back → re-parse of a DIFFERENT file can't
    // inherit the prior file's consent tick, bulk tags, or welcome choice.
    setConsent(false); setBulkTags([]); setWelcomeChoice("new");
    try {
      const name = (file.name || "").toLowerCase();

      // PDF / Word can't be parsed in the browser — send to the AI extractor,
      // which returns rows already keyed to our fields. Skip column-mapping.
      if (name.endsWith(".pdf") || name.endsWith(".docx")) {
        const file_base64 = await fileToBase64(file);
        const { data, error: exErr } = await supabase.functions.invoke("extract-contacts", {
          body: { organization_id: orgId, filename: file.name, file_base64 },
        });
        if (exErr) {
          let msg = exErr.message ?? "We couldn't read that file.";
          try {
            const resp = exErr?.context?.response ?? exErr?.context;
            if (resp && typeof resp.clone === "function") {
              const t = await resp.clone().text();
              try { const p = JSON.parse(t); if (p?.error) msg = p.error; } catch { /* not JSON */ }
            }
          } catch { /* ignore */ }
          setError(msg); setStep("pick"); return;
        }
        const exRows = Array.isArray(data?.rows) ? data.rows : [];
        if (exRows.length === 0) {
          setError("We couldn't find any families with an email in that file. Try a spreadsheet instead.");
          setStep("pick"); return;
        }
        setRawHeaders(DOC_COLUMNS);
        setRawRows(exRows.map((r) => DOC_COLUMNS.map((k) => (r?.[k] ?? "").toString())));
        setMapping(Object.fromEntries(DOC_COLUMNS.map((k) => [k, k])));
        setStep("mapping");
        return;
      }

      const isExcel = name.endsWith(".xlsx") || name.endsWith(".xls")
        || /spreadsheetml|ms-excel/.test(file.type || "");

      let headers = [];
      let data = [];
      if (isExcel) {
        // SheetJS is dynamically imported so it only loads when someone
        // actually uploads a spreadsheet (keeps it out of the main bundle).
        const buf = await file.arrayBuffer();
        const XLSX = await import("xlsx");
        // cellDates + raw:false so Excel date cells (stored internally as serial
        // numbers like 43573) render as readable dates, not the raw number.
        const wb = XLSX.read(new Uint8Array(buf), { type: "array", cellDates: true });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        if (!sheet) throw new Error("no-sheet");
        const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: "", raw: false, dateNF: "yyyy-mm-dd" });
        headers = (aoa[0] || []).map((c) => (c == null ? "" : String(c)));
        data = aoa.slice(1)
          .map((row) => row.map((c) => (c == null ? "" : String(c))))
          .filter((row) => row.some((c) => c.trim() !== ""));
      } else {
        const text = await file.text();
        const parsed = parseCsv(text);
        headers = parsed.headers;
        data = parsed.data;
      }

      if (headers.length === 0 || data.length === 0) {
        setError("That file didn't have any rows we could read.");
        setStep("pick");
        return;
      }
      setRawHeaders(headers);
      setRawRows(data);
      setMapping(autoMapColumns(headers));
      setStep("mapping");
    } catch (e) {
      console.error("[ContactsTab] parse failed", e);
      setError("Couldn't read that file. Try saving it as a CSV and uploading that.");
      setStep("pick");
    }
  }

  const contacts = useMemo(
    () => (step === "mapping" ? buildContacts(rawHeaders, rawRows, mapping, bulkTags) : []),
    [step, rawHeaders, rawRows, mapping, bulkTags],
  );
  const validEmailCount = useMemo(
    () => contacts.filter((c) => EMAIL_RE.test((c.email ?? "").trim().toLowerCase())).length,
    [contacts],
  );

  async function commit() {
    setError("");
    if (!mapping.email) { setError("Map the Email column first — nothing sends without it."); return; }
    if (validEmailCount === 0) { setError("None of these rows have a valid email address."); return; }
    if (!consent) { setError("Please confirm you have permission to email these contacts."); return; }
    setStep("committing");
    try {
      // Only send rows with a usable email. The edge fn re-validates + dedupes,
      // but trimming here keeps the payload lean.
      const payload = contacts.filter((c) => EMAIL_RE.test((c.email ?? "").trim().toLowerCase()));
      const { data, error: fnErr } = await supabase.functions.invoke("import-contacts", {
        body: { organization_id: orgId, contacts: payload, source: "manual", suppress_welcome: welcomeChoice === "existing" },
      });
      if (fnErr) {
        let msg = fnErr.message ?? "Import failed.";
        try {
          const resp = fnErr?.context?.response ?? fnErr?.context;
          if (resp && typeof resp.clone === "function") {
            const text = await resp.clone().text();
            try { const p = JSON.parse(text); if (p?.error) msg = p.error; } catch { /* not JSON */ }
          }
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      setResult(data ?? { inserted: 0, updated: 0, skipped: 0, invalid: 0 });
      setStep("done");
    } catch (e) {
      console.error("[ContactsTab] import failed", e);
      setError(e.message ?? "Import failed.");
      setStep("mapping");
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "4vh 16px", zIndex: 200, fontFamily: "inherit",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff", borderRadius: 12, maxWidth: 760, width: "100%",
          padding: 24, maxHeight: "92vh", overflowY: "auto",
          boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: INK }}>Upload contacts</h2>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: MUTED }}>
              {step === "pick" && "Upload a spreadsheet or PDF of your families — we'll pull out the contacts for you."}
              {step === "parsing" && "Reading your file… a PDF can take a few seconds."}
              {step === "mapping" && "Confirm which column is which, then review before saving."}
              {step === "committing" && "Saving to your list…"}
              {step === "done" && "Done."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: MUTED, fontSize: 18, cursor: "pointer", lineHeight: 1 }}
            aria-label="Close"
          >✕</button>
        </div>

        {error && (
          <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {step === "pick" && (
          <div>
            <p style={{ margin: "0 0 12px", fontSize: 13, color: INK, lineHeight: 1.55 }}>
              Add your families&apos; contact info in one go. Upload a
              <strong> spreadsheet (CSV or Excel)</strong> or a <strong> PDF</strong> —
              even a roster or sign-up export from another system. We&apos;ll pull out
              the families and you&apos;ll review everything before it saves. All we
              really need is an <strong>email</strong> for each.
            </p>
            <label
              htmlFor="contacts-upload-file"
              style={{ display: "block", fontSize: 12.5, color: MUTED, marginBottom: 6 }}
            >Choose your file:</label>
            <input
              id="contacts-upload-file"
              type="file"
              accept=".csv,.xlsx,.xls,.pdf,.docx,text/csv,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              style={{ fontSize: 13, marginBottom: 10 }}
            />
            {file && (
              <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
                Selected: <strong>{file.name}</strong> ({Math.round(file.size / 1024)} KB)
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16, paddingTop: 12, borderTop: `1px solid ${RULE}` }}>
              <button
                type="button"
                onClick={onClose}
                style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}
              >Cancel</button>
              <button
                type="button"
                onClick={startParse}
                style={{ padding: "8px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}
              >Read file →</button>
            </div>
          </div>
        )}

        {step === "parsing" && (
          <div style={{ padding: "40px 0", textAlign: "center", color: MUTED, fontSize: 14 }}>
            <div style={{ marginBottom: 10 }}>Reading your file…</div>
            <ElapsedTimer seconds={elapsed} />
          </div>
        )}

        {step === "mapping" && (
          <MappingStep
            headers={rawHeaders}
            rows={rawRows}
            mapping={mapping}
            setMapping={setMapping}
            contacts={contacts}
            validEmailCount={validEmailCount}
            consent={consent}
            setConsent={setConsent}
            bulkTags={bulkTags}
            setBulkTags={setBulkTags}
            existingTags={existingTags}
            welcomeChoice={welcomeChoice}
            setWelcomeChoice={setWelcomeChoice}
            onBack={() => setStep("pick")}
            onCommit={commit}
          />
        )}

        {step === "committing" && (
          <div style={{ padding: "40px 0", textAlign: "center", color: MUTED, fontSize: 14 }}>
            Saving to your list…
          </div>
        )}

        {step === "done" && result && (
          <DoneStep result={result} onClose={onImported} />
        )}
      </div>
    </div>
  );
}

function MappingStep({ headers, rows, mapping, setMapping, contacts, validEmailCount, consent, setConsent, bulkTags, setBulkTags, existingTags, welcomeChoice, setWelcomeChoice, onBack, onCommit }) {
  const emailMapped = !!mapping.email;
  const preview = contacts.slice(0, 10);
  // Only the columns the operator actually mapped — so the preview shows exactly
  // what will be saved per contact, with no empty "not in this file" clutter.
  // Show the tag column too when they're bulk-tagging (even without a tag column).
  const mappedFields = CONTACT_FIELDS.filter((f) => mapping[f.key] || (f.key === "tags" && bulkTags.length > 0));
  const canSave = emailMapped && validEmailCount > 0 && consent;

  return (
    <div>
      <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 13, color: INK, lineHeight: 1.5 }}>
        Read <strong>{rows.length}</strong> row{rows.length === 1 ? "" : "s"}. Confirm which column is which —
        we guessed where we could. Only <strong>Email</strong> is required.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
        {CONTACT_FIELDS.map((def) => (
          <div key={def.key} style={{ padding: "4px 2px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: INK, marginBottom: 2 }}>
              {def.label}{def.required && <span style={{ color: RED, marginLeft: 3 }}>*</span>}
            </div>
            <select
              value={mapping[def.key] || ""}
              onChange={(e) => setMapping({ ...mapping, [def.key]: e.target.value || undefined })}
              style={{ width: "100%", padding: "5px 8px", border: `1px solid ${RULE}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit", background: "#fff", color: INK }}
            >
              <option value="">— not in this file —</option>
              {headers.map((h, i) => <option key={i} value={h}>{h}</option>)}
            </select>
          </div>
        ))}
      </div>

      <BulkTagAssign bulkTags={bulkTags} setBulkTags={setBulkTags} existingTags={existingTags} />

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6 }}>
          Preview (first {preview.length})
        </div>
        <div style={{ fontSize: 12, color: validEmailCount > 0 ? OK : WARN, fontWeight: 600 }}>
          {validEmailCount.toLocaleString()} of {contacts.length.toLocaleString()} row{contacts.length === 1 ? "" : "s"} have a valid email
        </div>
      </div>

      {!emailMapped ? (
        <div style={{ background: `${WARN}1A`, color: WARN, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 6 }}>
          Pick the column that holds email addresses to see a preview.
        </div>
      ) : (
        <>
          {/* Full table of every MAPPED field, so the operator sees exactly what
              will be saved for each contact — not just email + name. Only mapped
              columns show (no "not in this file" clutter); scrolls if wide. */}
          <div style={{ border: `1px solid ${RULE}`, borderRadius: 6, marginBottom: 6, maxHeight: 260, overflow: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr>
                  {mappedFields.map((f) => (
                    <th key={f.key} style={{
                      position: "sticky", top: 0, background: CREAM, textAlign: "left",
                      padding: "6px 10px", color: MUTED, fontWeight: 700, fontSize: 10.5,
                      textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap",
                      borderBottom: `1px solid ${RULE}`,
                    }}>
                      {f.label.replace(/\s*\(.*\)$/, "")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((c, i) => {
                  const valid = EMAIL_RE.test((c.email ?? "").trim().toLowerCase());
                  return (
                    <tr key={i} style={{ background: valid ? "#fff" : `${RED}0D` }}>
                      {mappedFields.map((f) => {
                        const val = f.key === "tags" ? (c.tags ?? []).join(", ") : (c[f.key] ?? "");
                        return (
                          <td key={f.key} style={{
                            padding: "6px 10px", borderBottom: `1px solid ${RULE}`,
                            whiteSpace: "nowrap", color: f.key === "tags" ? PURPLE : INK,
                            verticalAlign: "top",
                          }}>
                            {f.key === "email" ? (
                              <span>
                                <strong style={{ color: valid ? INK : RED }}>{c.email || "(no email)"}</strong>
                                {!valid && <span style={{ color: RED, fontSize: 11 }}> · will be skipped</span>}
                              </span>
                            ) : f.key === "tags" ? (
                              val ? <span>🏷 {val}</span> : <span style={{ color: MUTED }}>—</span>
                            ) : (
                              val || <span style={{ color: MUTED }}>—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p style={{ margin: "0 0 14px", fontSize: 11.5, color: MUTED }}>
            Showing the first {preview.length} of {contacts.length.toLocaleString()} row{contacts.length === 1 ? "" : "s"}. Only mapped columns appear, and only rows with a valid email — <strong>{validEmailCount.toLocaleString()}</strong> — will be saved. Blank cells show as “—”.
          </p>
        </>
      )}

      <div style={{ background: `${PURPLE}06`, border: `1px solid ${PURPLE}22`, borderRadius: 8, padding: 12, marginBottom: 14 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: INK, marginBottom: 8 }}>
          Are these new families or your existing list?
        </div>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8, cursor: "pointer" }}>
          <input type="radio" name="welcome-choice" checked={welcomeChoice === "new"} onChange={() => setWelcomeChoice("new")} style={{ marginTop: 2 }} />
          <span style={{ fontSize: 13, color: INK, lineHeight: 1.45 }}>
            <strong>New families</strong> — send them a welcome email (if your Welcome automation is on).
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
          <input type="radio" name="welcome-choice" checked={welcomeChoice === "existing"} onChange={() => setWelcomeChoice("existing")} style={{ marginTop: 2 }} />
          <span style={{ fontSize: 13, color: INK, lineHeight: 1.45 }}>
            <strong>My existing families</strong> — skip the welcome. They&apos;ll still get your other updates.
          </span>
        </label>
      </div>

      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, background: `${PURPLE}06`, border: `1px solid ${PURPLE}22`, borderRadius: 8, padding: 12, marginBottom: 14, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span style={{ fontSize: 13, color: INK, lineHeight: 1.5 }}>
          I have permission to email these contacts.
        </span>
      </label>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 12, borderTop: `1px solid ${RULE}` }}>
        <button
          type="button"
          onClick={onBack}
          style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}
        >← Back</button>
        <button
          type="button"
          onClick={onCommit}
          disabled={!canSave}
          style={{ padding: "8px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: canSave ? "pointer" : "not-allowed", opacity: canSave ? 1 : 0.5 }}
        >Add {validEmailCount.toLocaleString()} contact{validEmailCount === 1 ? "" : "s"}</button>
      </div>
    </div>
  );
}

// "Tag everyone in this upload" — apply one or more labels to every contact in
// the file. The common case when an export has no group/tier column. Autocompletes
// from the org's existing tags so operators reuse instead of fragmenting.
function BulkTagAssign({ bulkTags, setBulkTags, existingTags }) {
  const [draft, setDraft] = useState("");
  const add = (raw) => {
    const t = (raw ?? "").trim();
    if (!t) return;
    if (!bulkTags.includes(t)) setBulkTags([...bulkTags, t]);
    setDraft("");
  };
  const tooMany = existingTags.length >= 25;
  return (
    <div style={{ background: `${PURPLE}06`, border: `1px solid ${PURPLE}22`, borderRadius: 8, padding: 12, marginBottom: 14 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: INK, marginBottom: 2 }}>
        Tag everyone in this upload <span style={{ color: MUTED, fontWeight: 400 }}>(optional)</span>
      </div>
      <p style={{ margin: "0 0 8px", fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
        Handy when your file has no group column — e.g. tag this whole list <em>All-Inclusive</em>. Added to every
        contact here, on top of any Group/tag column. Re-importing later adds tags; it never removes them.
      </p>
      {bulkTags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {bulkTags.map((t) => (
            <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: PURPLE, background: "#fff", border: `1px solid ${PURPLE}33`, borderRadius: 999, padding: "3px 6px 3px 10px" }}>
              🏷 {t}
              <button type="button" onClick={() => setBulkTags(bulkTags.filter((x) => x !== t))} aria-label={`Remove ${t}`}
                style={{ border: "none", background: "transparent", color: MUTED, cursor: "pointer", fontSize: 14, lineHeight: 1 }}>×</button>
            </span>
          ))}
        </div>
      )}
      <input
        list="existing-tags-list"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(draft); } }}
        onBlur={() => add(draft)}
        placeholder="Type a tag and press Enter…"
        style={{ width: "100%", padding: "7px 10px", border: `1px solid ${RULE}`, borderRadius: 5, fontSize: 13, fontFamily: "inherit", background: "#fff", color: INK }}
      />
      <datalist id="existing-tags-list">
        {existingTags.map((t) => <option key={t} value={t} />)}
      </datalist>
      {tooMany && (
        <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "#7a5510" }}>
          You already have {existingTags.length} tags — reuse one above where you can, to keep your list tidy.
        </p>
      )}
    </div>
  );
}

function DoneStep({ result, onClose }) {
  const inserted = result.inserted ?? 0;
  const updated = result.updated ?? 0;
  const invalid = result.invalid ?? 0;
  return (
    <div>
      <div style={{ textAlign: "center", padding: "8px 0 14px" }}>
        <div style={{ fontSize: 40, lineHeight: 1 }}>🎉</div>
        <h3 style={{ margin: "8px 0 2px", fontSize: 18, fontWeight: 800, color: PURPLE }}>Your list is updated.</h3>
        <p style={{ margin: 0, fontSize: 13, color: MUTED }}>
          {inserted} new contact{inserted === 1 ? "" : "s"} added
          {updated > 0 && ` · ${updated} updated`}
          {invalid > 0 && ` · ${invalid} skipped (no valid email)`}
        </p>
      </div>

      <div style={{ marginTop: 8, background: `${PURPLE}0A`, border: `1px solid ${PURPLE}22`, borderRadius: 8, padding: 14 }}>
        <p style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 700, color: PURPLE }}>What this unlocks</p>
        <p style={{ margin: 0, fontSize: 13, color: INK, lineHeight: 1.6 }}>
          Your contacts are on your list now, so you can <strong>build a campaign</strong> and
          reach these families. You&apos;ll pick who receives each campaign when you set it up.
        </p>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button
          type="button"
          onClick={onClose}
          style={{ padding: "8px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 700, fontFamily: "inherit", cursor: "pointer" }}
        >Done</button>
      </div>
    </div>
  );
}
