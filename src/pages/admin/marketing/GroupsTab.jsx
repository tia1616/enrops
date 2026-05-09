// src/pages/admin/marketing/GroupsTab.jsx
// Groups list + builder with multi-select filters.
// Provider-facing: "pick your schools, we personalize for each one."

import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase.js";
import { INK, MUTED, RULE, PLUM, INFO, WARN, Card, btn, input as inputStyle } from "./tokens.jsx";

export default function GroupsTab({ org }) {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showBuilder, setShowBuilder] = useState(false);

  // Builder state — arrays for multi-select
  const [newName, setNewName] = useState("");
  const [filterSchools, setFilterSchools] = useState([]);
  const [filterAreas, setFilterAreas] = useState([]);
  const [filterPrograms, setFilterPrograms] = useState([]);
  const [filterTerms, setFilterTerms] = useState([]);
  const [filterStatus, setFilterStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  // Available filter options (loaded from DB)
  const [schools, setSchools] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [terms, setTerms] = useState([]);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("marketing_groups")
      .select("*")
      .order("created_at", { ascending: false });
    setGroups(data ?? []);

    const { data: schoolRows } = await supabase
      .from("program_locations")
      .select("id, name, district")
      .order("name");
    setSchools(schoolRows ?? []);

    const { data: progRows } = await supabase
      .from("programs")
      .select("id, curriculum")
      .eq("status", "open")
      .order("curriculum");
    const seen = new Set();
    setPrograms((progRows ?? []).filter(p => {
      if (seen.has(p.curriculum)) return false;
      seen.add(p.curriculum);
      return true;
    }));

    // Load unique terms
    const { data: termRows } = await supabase
      .from("programs")
      .select("term")
      .order("term");
    const uniqueTerms = [...new Set((termRows ?? []).map(t => t.term).filter(Boolean))];
    setTerms(uniqueTerms);

    setLoading(false);
  }

  const uniqueAreas = [...new Set(schools.map(s => s.district).filter(Boolean))].sort();

  async function saveGroup() {
    if (!newName.trim()) { setMsg("Name is required."); return; }

    const filterRules = {};
    if (filterSchools.length) filterRules.schools = filterSchools;
    if (filterAreas.length) filterRules.areas = filterAreas;
    if (filterPrograms.length) filterRules.programs = filterPrograms;
    if (filterTerms.length) filterRules.terms = filterTerms;
    if (filterStatus) filterRules.status = filterStatus;

    setSaving(true);
    const { data, error } = await supabase
      .from("marketing_groups")
      .insert({
        organization_id: org?.id,
        name: newName.trim(),
        filter_rules: filterRules,
        cached_count: 0,
      })
      .select()
      .single();
    setSaving(false);

    if (error) {
      setMsg("Error: " + error.message);
    } else {
      setGroups(prev => [data, ...prev]);
      resetBuilder();
    }
  }

  function resetBuilder() {
    setNewName(""); setFilterSchools([]); setFilterAreas([]);
    setFilterPrograms([]); setFilterTerms([]); setFilterStatus(""); setShowBuilder(false); setMsg("");
  }

  async function deleteGroup(id) {
    if (!confirm("Delete this group? This can't be undone.")) return;
    const { error } = await supabase.from("marketing_groups").delete().eq("id", id);
    if (!error) setGroups(prev => prev.filter(g => g.id !== id));
  }

  const selectionCount = filterSchools.length + filterAreas.length + filterPrograms.length + filterTerms.length + (filterStatus ? 1 : 0);

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 4px", letterSpacing: -0.3, color: INK }}>
          Groups
        </h1>
        <p style={{ fontSize: 13, color: MUTED, margin: 0 }}>
          Pick the schools and areas you want to reach. When you send from Compose, each school gets a personalized email — their name, dates, instructor — automatically.
        </p>
      </div>

      {/* Value prop callout */}
      <div style={{
        background: "#FAEEDA", borderLeft: "3px solid #BA7517",
        padding: "10px 12px", borderRadius: "0 4px 4px 0", marginBottom: 14,
      }}>
        <div style={{ fontSize: 12, color: "#633806", lineHeight: 1.55 }}>
          <strong>Write one email, send it personalized to every school.</strong> Create a group with 10 schools → Compose fills in each school's name, class day, time, and instructor automatically. One click, 10 customized emails.
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 16 }}>
        {/* Group list */}
        <div>
          {loading && <p style={{ color: MUTED, fontSize: 14 }}>Loading groups…</p>}

          {!loading && groups.length === 0 && (
            <Card dashed style={{ padding: 24, textAlign: "center" }}>
              <p style={{ color: MUTED, fontSize: 13, margin: 0 }}>
                No groups yet. Create your first group to start sending targeted, personalized emails.
              </p>
            </Card>
          )}

          {groups.map(g => (
            <Card key={g.id} style={{ padding: "10px 14px", marginBottom: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                <strong style={{ fontSize: 13 }}>{g.name}</strong>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: MUTED }}>{g.cached_count} parents</span>
                  <span onClick={() => deleteGroup(g.id)} style={{ fontSize: 10, color: MUTED, cursor: "pointer" }} title="Delete group">✕</span>
                </div>
              </div>
              <div style={{ fontSize: 11, color: MUTED }}>
                {describeFilters(g.filter_rules)}
              </div>
            </Card>
          ))}

          {!showBuilder && (
            <button onClick={() => setShowBuilder(true)} style={{ ...btn(PLUM, "#fff", true), marginTop: 10, padding: "8px 14px", fontSize: 12 }}>
              + New group
            </button>
          )}
        </div>

        {/* Group builder */}
        <div>
          {showBuilder && (
            <Card style={{ padding: 14 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>New group</div>
              <div style={{ fontSize: 11, color: MUTED, marginBottom: 12 }}>
                Select the schools, areas, or programs to include. Parents who match will be added automatically.
              </div>

              {/* Name */}
              <div style={{ marginBottom: 12 }}>
                <div style={labelSm}>Group name</div>
                <input
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="e.g. PPS fall parents, Hillsboro families"
                  style={inputStyle()}
                />
              </div>

              {/* Areas / Neighborhoods */}
              <div style={{ marginBottom: 12 }}>
                <div style={labelSm}>Areas</div>
                <MultiSelect
                  options={uniqueAreas.map(a => ({ value: a, label: a }))}
                  selected={filterAreas}
                  onChange={setFilterAreas}
                  placeholder="Select areas…"
                />
              </div>

              {/* Schools */}
              <div style={{ marginBottom: 12 }}>
                <div style={labelSm}>
                  Schools
                  {filterAreas.length > 0 && <span style={{ fontWeight: 400, textTransform: "none" }}> (filtered to {filterAreas.join(", ")})</span>}
                </div>
                <MultiSelect
                  options={schools
                    .filter(s => filterAreas.length === 0 || filterAreas.includes(s.district))
                    .map(s => ({ value: s.name, label: s.name }))}
                  selected={filterSchools}
                  onChange={setFilterSchools}
                  placeholder="Select schools…"
                />
                {filterSchools.length > 0 && (
                  <div style={{ fontSize: 10, color: PLUM, marginTop: 4, fontWeight: 600 }}>
                    {filterSchools.length} school{filterSchools.length > 1 ? "s" : ""} selected
                  </div>
                )}
              </div>

              {/* Programs */}
              <div style={{ marginBottom: 12 }}>
                <div style={labelSm}>Programs</div>
                <MultiSelect
                  options={programs.map(p => ({ value: p.curriculum, label: p.curriculum }))}
                  selected={filterPrograms}
                  onChange={setFilterPrograms}
                  placeholder="Select programs…"
                />
              </div>

              {/* Terms */}
              <div style={{ marginBottom: 12 }}>
                <div style={labelSm}>Term</div>
                <MultiSelect
                  options={terms.map(t => ({ value: t, label: termLabel(t) }))}
                  selected={filterTerms}
                  onChange={setFilterTerms}
                  placeholder="Select terms…"
                />
              </div>

              {/* Status */}
              <div style={{ marginBottom: 12 }}>
                <div style={labelSm}>Enrollment status</div>
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={inputStyle()}>
                  <option value="">Any status</option>
                  <option value="currently_enrolled">Currently enrolled</option>
                  <option value="past_not_enrolled">Past, not currently enrolled</option>
                  <option value="cancelled_this_term">Cancelled this term</option>
                </select>
              </div>

              {/* Summary */}
              <div style={{
                background: "#f7f6ef", padding: "10px 12px", borderRadius: 4, marginTop: 10, fontSize: 11,
              }}>
                <div style={{ color: MUTED, marginBottom: 4 }}>This group will include</div>
                {selectionCount === 0 ? (
                  <div style={{ color: MUTED }}>All parents (no filters applied)</div>
                ) : (
                  <div style={{ color: INK, lineHeight: 1.6 }}>
                    {filterAreas.length > 0 && <div>Areas: <strong>{filterAreas.join(", ")}</strong></div>}
                    {filterSchools.length > 0 && <div>Schools: <strong>{filterSchools.join(", ")}</strong></div>}
                    {filterPrograms.length > 0 && <div>Programs: <strong>{filterPrograms.join(", ")}</strong></div>}
                    {filterTerms.length > 0 && <div>Terms: <strong>{filterTerms.map(termLabel).join(", ")}</strong></div>}
                    {filterStatus && <div>Status: <strong>{filterStatus.replace(/_/g, " ")}</strong></div>}
                  </div>
                )}
                <div style={{ color: MUTED, fontSize: 10, marginTop: 6 }}>
                  Count updates automatically as new parents register
                </div>
              </div>

              {msg && <div style={{ fontSize: 12, color: "#b3261e", marginTop: 8 }}>{msg}</div>}

              <button onClick={saveGroup} disabled={saving} style={{ ...btn(PLUM), marginTop: 10, width: "100%", justifyContent: "center" }}>
                {saving ? "Saving…" : "Save group"}
              </button>
              <button onClick={resetBuilder} style={{ ...btn("transparent", MUTED), marginTop: 4, width: "100%", justifyContent: "center", border: "none" }}>
                Cancel
              </button>
            </Card>
          )}

          {!showBuilder && (
            <Card dashed style={{ padding: 16, textAlign: "center" }}>
              <p style={{ color: MUTED, fontSize: 12, margin: "0 0 4px" }}>
                Groups update automatically as parents register.
              </p>
              <p style={{ color: MUTED, fontSize: 12, margin: 0 }}>
                Use them in Compose with "Split by school" to send one personalized email per school in one click.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// Multi-select dropdown component
function MultiSelect({ options, selected, onChange, placeholder }) {
  const [open, setOpen] = useState(false);

  function toggle(val) {
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val]);
  }

  const label = selected.length === 0
    ? placeholder
    : selected.length <= 2
      ? options.filter(o => selected.includes(o.value)).map(o => o.label).join(", ")
      : `${selected.length} selected`;

  return (
    <div style={{ position: "relative" }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          padding: "7px 10px", border: `1px solid ${RULE}`, borderRadius: 5,
          fontSize: 12, background: "#fff", cursor: "pointer",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          color: selected.length === 0 ? "#999" : INK,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <span style={{ fontSize: 10, color: "#999", marginLeft: 8 }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 10,
          background: "#fff", border: `1px solid ${RULE}`, borderRadius: "0 0 5px 5px",
          maxHeight: 200, overflowY: "auto", boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
        }}>
          {options.length === 0 && (
            <div style={{ padding: "8px 10px", fontSize: 11, color: "#999" }}>No options</div>
          )}
          {options.map(o => {
            const isSelected = selected.includes(o.value);
            return (
              <div
                key={o.value}
                onClick={() => toggle(o.value)}
                style={{
                  padding: "7px 10px", fontSize: 12, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 8,
                  background: isSelected ? "#E6F1FB" : "transparent",
                  color: isSelected ? "#0C447C" : INK,
                }}
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "#f7f6ef"; }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{
                  width: 16, height: 16, borderRadius: 3, flexShrink: 0,
                  border: isSelected ? "none" : `1.5px solid #ccc`,
                  background: isSelected ? "#0C447C" : "transparent",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "#fff", fontSize: 11, fontWeight: 700,
                }}>
                  {isSelected && "✓"}
                </span>
                {o.label}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function describeFilters(rules) {
  if (!rules || Object.keys(rules).length === 0) return "All parents (no filters)";
  const parts = [];
  if (rules.schools?.length) parts.push(`${rules.schools.length} school${rules.schools.length > 1 ? "s" : ""}: ${rules.schools.join(", ")}`);
  if (rules.school_name) parts.push(`School: ${rules.school_name}`);
  if (rules.areas?.length) parts.push(rules.areas.join(", "));
  if (rules.area) parts.push(`Area: ${rules.area}`);
  if (rules.programs?.length) parts.push(`Programs: ${rules.programs.join(", ")}`);
  if (rules.program) parts.push(`Program: ${rules.program}`);
  if (rules.terms?.length) parts.push(`Terms: ${rules.terms.map(termLabel).join(", ")}`);
  if (rules.status) parts.push(rules.status.replace(/_/g, " "));
  return parts.join(" · ");
}

function termLabel(code) {
  if (!code) return code;
  const season = code.slice(0, 2);
  const year = code.slice(2);
  const names = { FA: "Fall", WI: "Winter", SP: "Spring", SU: "Summer" };
  return `${names[season] || season} '${year}`;
}

const labelSm = {
  fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5,
  color: "#6b6b6b", fontWeight: 600, marginBottom: 4,
};
