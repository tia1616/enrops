// Q1_What — catalog picker. Three tabs:
//   - Programs: rows from `programs` (joined to program_locations + curricula),
//     grouped by term, with early-bird badge.
//   - Camps: rows from `camp_sessions`, grouped by week_num.
//   - Other: free-text topic chips (for partner notes / instructor reminders).
//
// State shape (lives on inputs.what):
//   { mode: 'programs'|'camps'|'other',
//     program_ids: uuid[], camp_session_ids: uuid[], topics: string[] }
//
// Selecting rows here drives the audience auto-default in Q2 and gives Ennie
// the structured KNOWN-FACTS list to write a personalized campaign from.

import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../../../lib/supabase.js";
import QuestionStep from "../QuestionStep.jsx";
import { PURPLE, RULE, INK, MUTED, OK, INFO, WARN } from "../../marketing/tokens.jsx";

const TABS = [
  { mode: "programs", label: "After-school programs" },
  { mode: "camps", label: "Camps" },
  { mode: "other", label: "Something else" },
];

export default function Q1_What({ inputs, setField, onNext, canNext }) {
  const { org } = useOutletContext() ?? {};
  const w = inputs.what;
  const mode = w?.mode ?? "programs";

  const setMode = (nextMode) => setField("what", { ...w, mode: nextMode });
  const setProgramIds = (program_ids) => setField("what", { ...w, program_ids });
  const setCampIds = (camp_session_ids) => setField("what", { ...w, camp_session_ids });
  const setTopics = (topics) => setField("what", { ...w, topics });

  return (
    <QuestionStep
      title="What are you marketing?"
      helper="Pick from your catalog — Ennie writes the campaign from those actual programs."
      onNext={onNext}
      canNext={canNext}
    >
      <TabBar mode={mode} onChange={setMode} />

      <div style={{ marginTop: 14 }}>
        {mode === "programs" && (
          <ProgramsPicker orgId={org?.id} selected={w.program_ids ?? []} onChange={setProgramIds} />
        )}
        {mode === "camps" && (
          <CampsPicker orgId={org?.id} selected={w.camp_session_ids ?? []} onChange={setCampIds} />
        )}
        {mode === "other" && (
          <TopicChips topics={w.topics ?? []} onChange={setTopics} />
        )}
      </div>
    </QuestionStep>
  );
}

// ---------- Tab bar ----------
function TabBar({ mode, onChange }) {
  return (
    <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${RULE}` }}>
      {TABS.map((t) => {
        const active = t.mode === mode;
        return (
          <button
            key={t.mode}
            onClick={() => onChange(t.mode)}
            style={{
              border: "none",
              background: "transparent",
              padding: "10px 16px",
              fontSize: 14,
              fontWeight: active ? 600 : 500,
              color: active ? PURPLE : MUTED,
              borderBottom: active ? `2px solid ${PURPLE}` : "2px solid transparent",
              marginBottom: -1,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------- Programs picker ----------
function ProgramsPicker({ orgId, selected, onChange }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    setRows(null);
    setErr(null);
    supabase
      .from("programs")
      .select("id, term, curriculum, day_of_week, first_session_date, session_count, price_cents, early_bird_price_cents, early_bird_deadline, status, program_location_id, program_locations(name)")
      .eq("organization_id", orgId)
      .gte("first_session_date", todayIso())
      .order("term")
      .order("first_session_date")
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) { setErr(error.message); return; }
        setRows(data ?? []);
      });
    return () => { alive = false; };
  }, [orgId]);

  // group rows by term
  const grouped = useMemo(() => {
    if (!rows) return null;
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? rows.filter((r) =>
          (r.curriculum || "").toLowerCase().includes(needle) ||
          (r.program_locations?.name || "").toLowerCase().includes(needle)
        )
      : rows;
    const groups = new Map();
    for (const r of filtered) {
      const key = r.term || "(no term)";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, q]);

  function toggleOne(id) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }
  function selectAllInGroup(group) {
    const ids = group.map((r) => r.id);
    const allOn = ids.every((id) => selected.includes(id));
    onChange(allOn ? selected.filter((id) => !ids.includes(id)) : [...new Set([...selected, ...ids])]);
  }

  if (!orgId) return <Hint>Loading org…</Hint>;
  if (err) return <ErrorBox msg={err} />;
  if (!rows) return <Hint>Loading your catalog…</Hint>;
  if (rows.length === 0) {
    return (
      <Hint>
        No upcoming programs in your catalog. Add some under Programs → Curricula + schedule them in Programs → Scheduled programs.
      </Hint>
    );
  }

  return (
    <div>
      <SearchInput value={q} onChange={setQ} placeholder="Search by curriculum or school…" />

      <div style={{ maxHeight: 480, overflowY: "auto", border: `1px solid ${RULE}`, borderTop: "none", borderRadius: "0 0 6px 6px", background: "#fff" }}>
        {grouped.length === 0 && <Hint>No matches.</Hint>}
        {grouped.map(([term, group]) => {
          const allOn = group.every((r) => selected.includes(r.id));
          return (
            <div key={term}>
              <div style={{
                position: "sticky", top: 0, zIndex: 1,
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "8px 12px", background: "#faf7ed",
                borderBottom: `1px solid ${RULE}`, fontSize: 12, fontWeight: 600,
                color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5,
              }}>
                <span>{term} · {group.length} program{group.length === 1 ? "" : "s"}</span>
                <button
                  onClick={() => selectAllInGroup(group)}
                  style={linkBtnStyle}
                >
                  {allOn ? "Clear" : "Select all"}
                </button>
              </div>
              {group.map((r) => (
                <ProgramRow
                  key={r.id}
                  row={r}
                  checked={selected.includes(r.id)}
                  onToggle={() => toggleOne(r.id)}
                />
              ))}
            </div>
          );
        })}
      </div>

      <FooterCount n={selected.length} singular="program selected" plural="programs selected" />
    </div>
  );
}

function ProgramRow({ row, checked, onToggle }) {
  const school = row.program_locations?.name || "(no school)";
  const ebActive = row.early_bird_price_cents && row.early_bird_deadline && row.early_bird_deadline >= todayIso();
  const ebDate = ebActive ? formatShortDate(row.early_bird_deadline) : null;
  const firstDate = row.first_session_date ? formatShortDate(row.first_session_date) : "TBD";
  return (
    <label style={{
      display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px",
      borderTop: `1px solid ${RULE}`, cursor: "pointer",
      background: checked ? "#faf7ed" : "transparent",
    }}>
      <input type="checkbox" checked={checked} onChange={onToggle} style={{ marginTop: 3 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontWeight: 600, color: INK, fontSize: 14 }}>{row.curriculum}</span>
          {ebActive && <Badge color={OK} bg="#EAF3DE">Early bird · ends {ebDate}</Badge>}
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
          {school} · {row.day_of_week}s · starts {firstDate} · {row.session_count} sessions · ${(row.price_cents / 100).toFixed(0)}
        </div>
      </div>
    </label>
  );
}

// ---------- Camps picker ----------
function CampsPicker({ orgId, selected, onChange }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    setRows(null);
    setErr(null);
    supabase
      .from("camp_sessions")
      .select("id, week_num, session_type, location_name, curriculum_name, starts_on, ends_on, current_enrollment, status")
      .eq("organization_id", orgId)
      .gte("starts_on", todayIso())
      .order("starts_on")
      .order("location_name")
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) { setErr(error.message); return; }
        setRows(data ?? []);
      });
    return () => { alive = false; };
  }, [orgId]);

  const grouped = useMemo(() => {
    if (!rows) return null;
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? rows.filter((r) =>
          (r.curriculum_name || "").toLowerCase().includes(needle) ||
          (r.location_name || "").toLowerCase().includes(needle)
        )
      : rows;
    const groups = new Map();
    for (const r of filtered) {
      const key = r.week_num ?? 0;
      if (!groups.has(key)) groups.set(key, { week: key, starts_on: r.starts_on, ends_on: r.ends_on, rows: [] });
      groups.get(key).rows.push(r);
    }
    return [...groups.values()].sort((a, b) => (a.starts_on || "").localeCompare(b.starts_on || ""));
  }, [rows, q]);

  function toggleOne(id) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }
  function selectAllInGroup(group) {
    const ids = group.rows.map((r) => r.id);
    const allOn = ids.every((id) => selected.includes(id));
    onChange(allOn ? selected.filter((id) => !ids.includes(id)) : [...new Set([...selected, ...ids])]);
  }

  if (!orgId) return <Hint>Loading org…</Hint>;
  if (err) return <ErrorBox msg={err} />;
  if (!rows) return <Hint>Loading your catalog…</Hint>;
  if (rows.length === 0) {
    return <Hint>No upcoming camps in your catalog.</Hint>;
  }

  return (
    <div>
      <SearchInput value={q} onChange={setQ} placeholder="Search by curriculum or location…" />

      <div style={{ maxHeight: 480, overflowY: "auto", border: `1px solid ${RULE}`, borderTop: "none", borderRadius: "0 0 6px 6px", background: "#fff" }}>
        {grouped.length === 0 && <Hint>No matches.</Hint>}
        {grouped.map((g) => {
          const allOn = g.rows.every((r) => selected.includes(r.id));
          const weekLabel = `Week ${g.week} · ${formatShortDate(g.starts_on)} – ${formatShortDate(g.ends_on)}`;
          return (
            <div key={g.week}>
              <div style={{
                position: "sticky", top: 0, zIndex: 1,
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "8px 12px", background: "#faf7ed",
                borderBottom: `1px solid ${RULE}`, fontSize: 12, fontWeight: 600,
                color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5,
              }}>
                <span>{weekLabel} · {g.rows.length} camp{g.rows.length === 1 ? "" : "s"}</span>
                <button onClick={() => selectAllInGroup(g)} style={linkBtnStyle}>
                  {allOn ? "Clear" : "Select all"}
                </button>
              </div>
              {g.rows.map((r) => (
                <CampRow
                  key={r.id}
                  row={r}
                  checked={selected.includes(r.id)}
                  onToggle={() => toggleOne(r.id)}
                />
              ))}
            </div>
          );
        })}
      </div>

      <FooterCount n={selected.length} singular="camp selected" plural="camps selected" />
    </div>
  );
}

function CampRow({ row, checked, onToggle }) {
  const enrollment = row.current_enrollment ?? 0;
  const lowEnrollment = enrollment > 0 && enrollment < 6;
  return (
    <label style={{
      display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px",
      borderTop: `1px solid ${RULE}`, cursor: "pointer",
      background: checked ? "#faf7ed" : "transparent",
    }}>
      <input type="checkbox" checked={checked} onChange={onToggle} style={{ marginTop: 3 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontWeight: 600, color: INK, fontSize: 14 }}>{row.curriculum_name}</span>
          {lowEnrollment && <Badge color={WARN} bg="#FAEEDA">Low: {enrollment} kid{enrollment === 1 ? "" : "s"}</Badge>}
          {enrollment === 0 && <Badge color={WARN} bg="#FAEEDA">No enrollment yet</Badge>}
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
          {row.location_name} · {formatShortDate(row.starts_on)} – {formatShortDate(row.ends_on)} · {row.session_type}
        </div>
      </div>
    </label>
  );
}

// ---------- Other (free-text topic chips) ----------
function TopicChips({ topics, onChange }) {
  const [pending, setPending] = useState("");
  const PRESETS = [
    "Note to partner schools",
    "Instructor reminder",
    "Recap / thank-you to families",
  ];

  function addTopic(label) {
    const trimmed = label.trim();
    if (!trimmed || topics.includes(trimmed)) return;
    onChange([...topics, trimmed]);
    setPending("");
  }
  function removeTopic(idx) {
    onChange(topics.filter((_, i) => i !== idx));
  }

  return (
    <div>
      <div
        style={{
          background: "#fff", border: `1px solid ${RULE}`, borderRadius: 6,
          padding: 10, display: "flex", flexWrap: "wrap", gap: 6,
          alignItems: "center", minHeight: 56,
        }}
      >
        {topics.map((t, i) => (
          <span
            key={`${t}-${i}`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              background: "#f0e3e8", color: PURPLE, fontWeight: 500,
              fontSize: 13, padding: "4px 10px", borderRadius: 999,
            }}
          >
            {t}
            <button
              onClick={() => removeTopic(i)}
              aria-label="Remove topic"
              style={{ background: "transparent", border: "none", color: PURPLE, cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={pending}
          placeholder={topics.length === 0 ? "Type a topic and press Enter…" : "Add another…"}
          onChange={(e) => setPending(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && pending.trim()) {
              e.preventDefault();
              addTopic(pending);
            }
            if (e.key === "Backspace" && pending === "" && topics.length > 0) {
              removeTopic(topics.length - 1);
            }
          }}
          style={{
            flex: 1, minWidth: 200, border: "none", outline: "none",
            fontSize: 14, padding: "6px 4px", fontFamily: "inherit", color: INK,
          }}
        />
      </div>
      <p style={{ margin: "6px 0 12px", fontSize: 12, color: MUTED }}>
        Use this for anything that isn't a scheduled program or camp — partner notes, instructor reminders, recaps.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => addTopic(p)}
            disabled={topics.includes(p)}
            style={{
              padding: "5px 10px", background: topics.includes(p) ? "#f5f5f5" : "#fff",
              border: `1px solid ${topics.includes(p) ? "#e0e0e0" : RULE}`,
              borderRadius: 999, fontSize: 12,
              color: topics.includes(p) ? "#a0a0a0" : INK,
              cursor: topics.includes(p) ? "default" : "pointer",
              fontFamily: "inherit",
            }}
          >
            {topics.includes(p) ? "✓" : "+"} {p}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- Shared bits ----------
function SearchInput({ value, onChange, placeholder }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: "100%", border: `1px solid ${RULE}`, borderRadius: "6px 6px 0 0",
        padding: "8px 10px", fontSize: 13, fontFamily: "inherit", outline: "none",
        background: "#fff", boxSizing: "border-box",
      }}
    />
  );
}

function Hint({ children }) {
  return <div style={{ padding: 14, fontSize: 12, color: MUTED, background: "#fff", border: `1px solid ${RULE}`, borderRadius: 6 }}>{children}</div>;
}
function ErrorBox({ msg }) {
  return <div style={{ padding: 12, fontSize: 12, color: "#b3261e", background: "#fdecea", border: "1px solid #f5c2c0", borderRadius: 6 }}>Error: {msg}</div>;
}
function Badge({ color, bg, children }) {
  return (
    <span style={{
      fontSize: 10, padding: "2px 6px", background: bg, color,
      borderRadius: 999, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}
function FooterCount({ n, singular, plural }) {
  if (n === 0) return null;
  return (
    <div style={{ marginTop: 8, padding: "6px 12px", fontSize: 12, color: PURPLE, background: "#faf7ed", border: `1px solid ${RULE}`, borderRadius: 6, fontWeight: 600 }}>
      {n} {n === 1 ? singular : plural}
    </div>
  );
}

const linkBtnStyle = {
  background: "transparent", border: "none", color: PURPLE,
  fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5,
  cursor: "pointer", padding: 0, fontFamily: "inherit",
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function formatShortDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
