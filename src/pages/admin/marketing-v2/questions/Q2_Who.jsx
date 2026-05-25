// Q2_Who — audience + real multi-select dropdowns pulled from the org's data.
// State shape matches the deployed marketing-draft-campaign's WhoInput:
//   { audience: 'parents' | 'partners' | 'instructors', filter: {...} }
//
// Data sources (all org-scoped):
//   - schools  → program_locations (organization_id)
//   - areas    → distinct marketing_recipients.geo_segment for this org
//   - segments → distinct unnest(marketing_recipients.segments) for this org
//   - single   → simple typeahead against marketing_recipients name/email

import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../../../lib/supabase.js";
import QuestionStep from "../QuestionStep.jsx";
import { PURPLE, RULE, INK, MUTED, WARN } from "../../marketing/tokens.jsx";

const AUDIENCES = [
  {
    key: "parents",
    label: "Parents",
    helper: "Past, current, or all participants. By school, area, segment, or one family.",
    disabled: false,
  },
  {
    key: "partners",
    label: "Partner orgs",
    helper: "Schools, parks & rec, churches, libraries.",
    disabled: true,
  },
  {
    key: "instructors",
    label: "Instructors",
    helper: "All active, by tier, or specific people.",
    disabled: true,
  },
];

const PARENT_SCOPES = [
  { value: "master_list", label: "Master list (everyone)" },
  { value: "school", label: "A specific school…" },
  { value: "area", label: "An area…" },
  { value: "segment", label: "A saved segment…" },
  { value: "person", label: "Just one person…" },
];

export default function Q2_Who({ inputs, setField, onNext, onBack, canNext }) {
  const { org } = useOutletContext() ?? {};
  const who = inputs.who;

  function setAudience(audience) {
    if (audience === "parents") {
      setField("who", { audience: "parents", filter: { type: "master_list" } });
    } else {
      setField("who", { audience, filter: {} });
    }
  }

  function setParentsScope(type) {
    if (type === "master_list") {
      setField("who", { audience: "parents", filter: { type: "master_list" } });
      return;
    }
    const next = { type };
    if (type === "school") next.school_ids = [];
    if (type === "area") next.area = "";
    if (type === "segment") next.segments = [];
    if (type === "person") next.recipient_id = null;
    setField("who", { audience: "parents", filter: next });
  }

  function updateFilter(patch) {
    setField("who", { audience: "parents", filter: { ...who.filter, ...patch } });
  }

  return (
    <QuestionStep
      title="Who's this going to?"
      helper="Pick an audience and narrow from there."
      onNext={onNext}
      onBack={onBack}
      canNext={canNext}
    >
      <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, overflow: "hidden" }}>
        {AUDIENCES.map((a, i) => (
          <label
            key={a.key}
            style={{
              display: "flex", alignItems: "flex-start", gap: 10, padding: 12,
              borderTop: i === 0 ? "none" : `1px solid ${RULE}`,
              cursor: a.disabled ? "not-allowed" : "pointer",
              opacity: a.disabled ? 0.55 : 1,
              background: who.audience === a.key ? "#faf7ed" : "#fff",
            }}
          >
            <input
              type="radio"
              name="audience"
              checked={who.audience === a.key}
              onChange={() => !a.disabled && setAudience(a.key)}
              disabled={a.disabled}
              style={{ marginTop: 3 }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: 600, color: INK }}>{a.label}</span>
                {a.disabled && (
                  <span style={{ fontSize: 10, padding: "2px 6px", background: "#FAEEDA", color: WARN, borderRadius: 999, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>
                    Coming soon
                  </span>
                )}
              </div>
              <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>{a.helper}</div>
            </div>
          </label>
        ))}
      </div>

      {who.audience === "parents" && (
        <div style={{ background: "#faf7ed", border: `1px solid #ece1bf`, borderRadius: 8, padding: 14, marginTop: 12 }}>
          <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 600, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.6 }}>
            Narrow it down
          </p>
          <label style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>Scope</label>
          <select
            value={who.filter?.type ?? "master_list"}
            onChange={(e) => setParentsScope(e.target.value)}
            style={{
              width: "100%", padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 5,
              background: "#fff", fontSize: 13, fontFamily: "inherit", color: INK,
            }}
          >
            {PARENT_SCOPES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>

          {who.filter?.type === "master_list" && (
            <p style={{ margin: "8px 0 0", fontSize: 12, color: MUTED }}>
              All parents on your master list will be included.
            </p>
          )}
          {who.filter?.type === "school" && (
            <SchoolMultiSelect
              orgId={org?.id}
              selected={who.filter.school_ids ?? []}
              onChange={(school_ids) => updateFilter({ school_ids })}
            />
          )}
          {who.filter?.type === "area" && (
            <AreaSelect
              orgId={org?.id}
              selected={who.filter.area ?? ""}
              onChange={(area) => updateFilter({ area })}
            />
          )}
          {who.filter?.type === "segment" && (
            <SegmentMultiSelect
              orgId={org?.id}
              selected={who.filter.segments ?? []}
              onChange={(segments) => updateFilter({ segments })}
            />
          )}
          {who.filter?.type === "person" && (
            <PersonTypeahead
              orgId={org?.id}
              selectedId={who.filter.recipient_id ?? null}
              onChange={(recipient_id, label) => updateFilter({ recipient_id, recipient_label: label })}
            />
          )}
        </div>
      )}
    </QuestionStep>
  );
}

// ---------- School multi-select ----------
function SchoolMultiSelect({ orgId, selected, onChange }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    setRows(null);
    setErr(null);
    supabase
      .from("program_locations")
      .select("id, name, name_aliases")
      .eq("organization_id", orgId)
      .order("name")
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) setErr(error.message);
        else setRows(data ?? []);
      });
    return () => { alive = false; };
  }, [orgId]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(needle));
  }, [rows, q]);

  function toggle(id) {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id));
    else onChange([...selected, id]);
  }

  return (
    <ListWrap>
      <SearchInput value={q} onChange={setQ} placeholder="Search your schools…" />
      <ListBody loading={!rows} error={err} empty={!err && rows && rows.length === 0 ? "No program_locations yet — add some in Programs." : null}>
        {(filtered ?? []).map((loc) => (
          <CheckRow
            key={loc.id}
            checked={selected.includes(loc.id)}
            onChange={() => toggle(loc.id)}
            label={loc.name}
            aside={loc.name_aliases?.length ? `${loc.name_aliases.length} alias${loc.name_aliases.length === 1 ? "" : "es"}` : ""}
          />
        ))}
      </ListBody>
      <FooterCount n={selected.length} singular="school selected" plural="schools selected" />
    </ListWrap>
  );
}

// ---------- Area single-select (distinct geo_segment) ----------
function AreaSelect({ orgId, selected, onChange }) {
  const [areas, setAreas] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    setAreas(null);
    setErr(null);
    supabase
      .from("marketing_recipients")
      .select("geo_segment")
      .eq("organization_id", orgId)
      .not("geo_segment", "is", null)
      .limit(2000)
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) { setErr(error.message); return; }
        const counts = new Map();
        for (const r of data ?? []) {
          if (!r.geo_segment) continue;
          counts.set(r.geo_segment, (counts.get(r.geo_segment) ?? 0) + 1);
        }
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        setAreas(sorted.map(([key, n]) => ({ key, count: n })));
      });
    return () => { alive = false; };
  }, [orgId]);

  return (
    <ListWrap>
      <ListBody loading={!areas} error={err} empty={!err && areas && areas.length === 0 ? "No areas yet — tag recipients with geo_segment to use this filter." : null}>
        {(areas ?? []).map((a) => (
          <label
            key={a.key}
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
              borderTop: `1px solid ${RULE}`, cursor: "pointer",
              background: selected === a.key ? "#faf7ed" : "transparent",
            }}
          >
            <input
              type="radio"
              name="area"
              checked={selected === a.key}
              onChange={() => onChange(a.key)}
            />
            <span style={{ fontSize: 13, color: INK, flex: 1 }}>{a.key}</span>
            <span style={{ fontSize: 11, color: MUTED }}>{a.count} parents</span>
          </label>
        ))}
      </ListBody>
    </ListWrap>
  );
}

// ---------- Segment multi-select (distinct unnest of segments) ----------
function SegmentMultiSelect({ orgId, selected, onChange }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    setRows(null);
    setErr(null);
    supabase
      .from("marketing_recipients")
      .select("segments")
      .eq("organization_id", orgId)
      .not("segments", "is", null)
      .limit(5000)
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) { setErr(error.message); return; }
        const counts = new Map();
        for (const r of data ?? []) {
          for (const s of r.segments ?? []) {
            if (!s) continue;
            counts.set(s, (counts.get(s) ?? 0) + 1);
          }
        }
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        setRows(sorted.map(([key, n]) => ({ key, count: n })));
      });
    return () => { alive = false; };
  }, [orgId]);

  function toggle(key) {
    if (selected.includes(key)) onChange(selected.filter((x) => x !== key));
    else onChange([...selected, key]);
  }

  return (
    <ListWrap>
      <ListBody loading={!rows} error={err} empty={!err && rows && rows.length === 0 ? "No saved segments yet — tag recipients to use this filter." : null}>
        {(rows ?? []).map((s) => (
          <CheckRow
            key={s.key}
            checked={selected.includes(s.key)}
            onChange={() => toggle(s.key)}
            label={<span style={{ fontFamily: "ui-monospace, monospace" }}>{s.key}</span>}
            aside={`${s.count} parents`}
          />
        ))}
      </ListBody>
      <FooterCount n={selected.length} singular="segment selected" plural="segments selected" />
    </ListWrap>
  );
}

// ---------- Person typeahead ----------
function PersonTypeahead({ orgId, selectedId, onChange }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!orgId || q.trim().length < 2) {
      setResults([]);
      return;
    }
    let alive = true;
    setLoading(true);
    const handle = setTimeout(() => {
      supabase
        .from("marketing_recipients")
        .select("id, parent_name, email, school_name")
        .eq("organization_id", orgId)
        .or(`parent_name.ilike.%${q}%,email.ilike.%${q}%,child_first_name.ilike.%${q}%`)
        .limit(8)
        .then(({ data }) => {
          if (!alive) return;
          setResults(data ?? []);
          setLoading(false);
        });
    }, 200);
    return () => { alive = false; clearTimeout(handle); };
  }, [orgId, q]);

  return (
    <ListWrap>
      <SearchInput value={q} onChange={setQ} placeholder="Type a name or email…" />
      <ListBody loading={loading} empty={q.trim().length < 2 ? "Type at least 2 characters to search." : results.length === 0 ? "No matches." : null}>
        {results.map((r) => (
          <button
            key={r.id}
            onClick={() => onChange(r.id, `${r.parent_name || r.email}`)}
            style={{
              width: "100%", textAlign: "left", padding: "8px 10px",
              border: "none", background: selectedId === r.id ? "#faf7ed" : "transparent",
              borderTop: `1px solid ${RULE}`, cursor: "pointer", fontFamily: "inherit",
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
            }}
          >
            <span style={{ fontSize: 13, color: INK, minWidth: 0 }}>
              <strong>{r.parent_name || "(no name)"}</strong> · {r.email}
            </span>
            <span style={{ fontSize: 11, color: MUTED, whiteSpace: "nowrap" }}>
              {r.school_name || ""}
            </span>
          </button>
        ))}
      </ListBody>
    </ListWrap>
  );
}

// ---------- Shared bits ----------
function ListWrap({ children }) {
  return (
    <div style={{ marginTop: 8, background: "#fff", border: `1px solid ${RULE}`, borderRadius: 6, overflow: "hidden" }}>
      {children}
    </div>
  );
}

function SearchInput({ value, onChange, placeholder }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: "100%", border: "none", borderBottom: `1px solid ${RULE}`,
        padding: "8px 10px", fontSize: 13, fontFamily: "inherit", outline: "none", background: "#fff",
      }}
    />
  );
}

function ListBody({ loading, error, empty, children }) {
  if (loading) return <div style={{ padding: 12, fontSize: 12, color: MUTED }}>Loading…</div>;
  if (error) return <div style={{ padding: 12, fontSize: 12, color: "#b3261e" }}>Error: {error}</div>;
  if (empty) return <div style={{ padding: 12, fontSize: 12, color: MUTED }}>{empty}</div>;
  return <div style={{ maxHeight: 220, overflowY: "auto" }}>{children}</div>;
}

function CheckRow({ checked, onChange, label, aside }) {
  return (
    <label style={{
      display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
      borderTop: `1px solid ${RULE}`, cursor: "pointer",
      background: checked ? "#faf7ed" : "transparent",
    }}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span style={{ fontSize: 13, color: INK, flex: 1 }}>{label}</span>
      {aside && <span style={{ fontSize: 11, color: MUTED }}>{aside}</span>}
    </label>
  );
}

function FooterCount({ n, singular, plural }) {
  if (n === 0) return null;
  return (
    <div style={{ padding: "6px 10px", fontSize: 11, color: MUTED, background: "#fafafa", borderTop: `1px solid ${RULE}` }}>
      {n} {n === 1 ? singular : plural}
    </div>
  );
}
