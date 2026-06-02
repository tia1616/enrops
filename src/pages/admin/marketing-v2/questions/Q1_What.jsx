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

export default function Q1_What({ inputs, setField, onNext, onBack, canNext }) {
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
      helper="Pick from your catalog — Ennie will use these to plan your campaign."
      onNext={onNext}
      onBack={onBack}
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
  const [draftCount, setDraftCount] = useState(0);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");
  const [lowOnly, setLowOnly] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    setRows(null);
    setErr(null);

    // Fetch programs + confirmed-registration counts + a draft-count hint in
    // parallel, then merge client-side. status='open' hides drafts;
    // first_session_date filter hides past programs.
    Promise.all([
      supabase
        .from("programs")
        .select("id, term, curriculum, day_of_week, first_session_date, session_count, price_cents, early_bird_price_cents, early_bird_deadline, max_capacity, status, program_location_id, program_locations(name)")
        .eq("organization_id", orgId)
        .eq("status", "open")
        .gte("first_session_date", todayIso())
        .order("term")
        .order("first_session_date"),
      supabase
        .from("registrations")
        .select("program_id")
        .eq("organization_id", orgId)
        .eq("status", "confirmed")
        .not("program_id", "is", null),
      supabase
        .from("programs")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("status", "draft")
        .gte("first_session_date", todayIso()),
    ]).then(([progRes, regRes, draftRes]) => {
      if (!alive) return;
      if (progRes.error) { setErr(progRes.error); return; }
      // Registrations + draft-count failures are non-fatal — rows still render.
      const countByProgram = new Map();
      for (const r of regRes.data ?? []) {
        countByProgram.set(r.program_id, (countByProgram.get(r.program_id) ?? 0) + 1);
      }
      const merged = (progRes.data ?? []).map((p) => ({
        ...p,
        enrolled: countByProgram.get(p.id) ?? 0,
      }));
      setRows(merged);
      setDraftCount(draftRes.count ?? 0);
    });
    return () => { alive = false; };
  }, [orgId]);

  // group rows by term — applies search + low-enrollment filter
  const grouped = useMemo(() => {
    if (!rows) return null;
    const needle = q.trim().toLowerCase();
    let filtered = needle
      ? rows.filter((r) =>
          (r.curriculum || "").toLowerCase().includes(needle) ||
          (r.program_locations?.name || "").toLowerCase().includes(needle)
        )
      : rows;
    if (lowOnly) filtered = filtered.filter(isLowEnrollment);
    const groups = new Map();
    for (const r of filtered) {
      const key = r.term || "(no term)";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, q, lowOnly]);

  function toggleOne(id) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }
  function selectAllInGroup(group) {
    const ids = group.map((r) => r.id);
    const allOn = ids.every((id) => selected.includes(id));
    onChange(allOn ? selected.filter((id) => !ids.includes(id)) : [...new Set([...selected, ...ids])]);
  }

  if (!orgId) return <Hint>Loading org…</Hint>;
  if (err) return <ErrorBox error={err} />;
  if (!rows) return <Hint>Loading your catalog…</Hint>;
  if (rows.length === 0) {
    return (
      <Hint>
        No upcoming open programs in your catalog. Add some under Programs → Curricula and schedule them in Programs → Scheduled programs (make sure status is "open").
      </Hint>
    );
  }

  const lowCount = rows.filter(isLowEnrollment).length;
  const termSummary = summarizeTerms(rows);

  return (
    <div>
      {/* Term quick-picks — always visible when there are upcoming programs.
          One click selects all programs in that term. The term with an
          early-bird deadline within 7 days gets a soft red urgency badge. */}
      {termSummary.length > 0 && (
        <div style={{
          marginBottom: 8, padding: "8px 12px", background: "#fff",
          border: `1px solid ${RULE}`, borderRadius: 6,
          display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, marginRight: 4 }}>
            Pick a term
          </span>
          {termSummary.map((t) => (
            <button
              key={t.term}
              onClick={() => onChange([...new Set([...selected, ...t.programIds])])}
              title={t.isUrgent ? `Early-bird ends in ${t.daysAway} day${t.daysAway === 1 ? "" : "s"}` : `${t.count} program${t.count === 1 ? "" : "s"}`}
              style={{
                padding: "5px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
                background: t.isUrgent ? "#EAF3DE" : "#fff",
                color: t.isUrgent ? "#2d5a2d" : INK,
                border: `1px solid ${t.isUrgent ? OK : RULE}`,
                cursor: "pointer", fontFamily: "inherit",
                display: "inline-flex", alignItems: "center", gap: 6,
              }}
            >
              {t.term} <span style={{ color: MUTED, fontWeight: 500 }}>· {t.count}</span>
              {t.isUrgent && (
                <span style={{ fontSize: 10, color: OK, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}>
                  EB in {t.daysAway}d
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Hint about hidden drafts — only renders when there are upcoming
          programs in status='draft' that the operator may have expected to see. */}
      {draftCount > 0 && (
        <div style={{
          marginBottom: 8, padding: "8px 12px", background: "#FAEEDA",
          border: "1px solid #ece1bf", borderRadius: 6, fontSize: 12, color: "#7a5510",
        }}>
          {draftCount} upcoming program{draftCount === 1 ? "" : "s"} {draftCount === 1 ? "is" : "are"} still in <strong>draft</strong> and not shown here. Publish them in <a href="/admin/programs" style={{ color: PURPLE, fontWeight: 600 }}>Programs → Scheduled programs</a> to include in campaigns.
        </div>
      )}

      <SearchInput value={q} onChange={setQ} placeholder="Search by curriculum or school…" />

      {/* Filter chip row */}
      <div style={{
        display: "flex", gap: 6, padding: "6px 10px", background: "#fff",
        borderLeft: `1px solid ${RULE}`, borderRight: `1px solid ${RULE}`, borderBottom: `1px solid ${RULE}`,
        alignItems: "center", flexWrap: "wrap",
      }}>
        <FilterChip
          active={lowOnly}
          onClick={() => setLowOnly((v) => !v)}
          label={lowCount > 0 ? `Low enrollment only (${lowCount})` : "Low enrollment only — none right now"}
          disabled={lowCount === 0}
        />
        <span style={{ fontSize: 11, color: MUTED, marginLeft: "auto" }}>
          Showing only open programs starting today or later
        </span>
      </div>

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
  const enrolled = row.enrolled ?? 0;
  const cap = row.max_capacity;
  const enrollmentText = cap ? `${enrolled}/${cap} enrolled` : `${enrolled} enrolled`;
  const low = isLowEnrollment(row);
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
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {ebActive && <Badge color={OK} bg="#EAF3DE">Early bird · ends {ebDate}</Badge>}
            {low && <Badge color={WARN} bg="#FAEEDA">Low enrollment</Badge>}
          </div>
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
          {school} · {row.day_of_week}s · starts {firstDate} · {row.session_count} sessions · ${(row.price_cents / 100).toFixed(0)} · {enrollmentText}
        </div>
      </div>
    </label>
  );
}

// Summarizes the upcoming terms in the catalog into chips the operator can
// click to one-shot select all programs in that term. Each entry includes
// urgency info (soonest early-bird deadline within 7 days) so the chip can
// surface a deadline badge for the term that needs immediate attention.
function summarizeTerms(rows) {
  if (!rows || rows.length === 0) return [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const MS_PER_DAY = 86400000;
  const byTerm = new Map();
  for (const r of rows) {
    const t = r.term || "(no term)";
    if (!byTerm.has(t)) {
      byTerm.set(t, { term: t, rows: [], soonestEarlyBird: null, soonestDaysAway: null });
    }
    const entry = byTerm.get(t);
    entry.rows.push(r);
    if (r.early_bird_price_cents && r.early_bird_deadline) {
      const dl = new Date(r.early_bird_deadline + "T23:59:59");
      const daysAway = Math.ceil((dl.getTime() - today.getTime()) / MS_PER_DAY);
      if (daysAway >= 0 && (entry.soonestDaysAway == null || daysAway < entry.soonestDaysAway)) {
        entry.soonestEarlyBird = r.early_bird_deadline;
        entry.soonestDaysAway = daysAway;
      }
    }
  }
  return [...byTerm.values()]
    .sort((a, b) => a.term.localeCompare(b.term))
    .map((e) => ({
      term: e.term,
      count: e.rows.length,
      programIds: e.rows.map((r) => r.id),
      isUrgent: e.soonestDaysAway != null && e.soonestDaysAway <= 7,
      daysAway: e.soonestDaysAway,
    }));
}

// "Low enrollment" = under half of capacity AND first_session_date within 6 weeks.
// The proximity gate matters: when registration just opened (3+ months out),
// EVERY program has near-zero enrollment — flagging them all as "low" is noise.
// "Low" is only meaningful close to start when an empty roster is a real
// problem the operator should address with a push campaign.
function isLowEnrollment(row) {
  if (!row.first_session_date) return false;
  const daysUntilStart = Math.ceil(
    (new Date(row.first_session_date + "T00:00:00").getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000,
  );
  if (daysUntilStart > 42) return false; // 6 weeks out — too early to judge
  const enrolled = row.enrolled ?? 0;
  const cap = row.max_capacity;
  if (cap && cap > 0) return enrolled < cap * 0.5;
  return enrolled < 6;
}

function FilterChip({ active, onClick, label, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "4px 10px", borderRadius: 999, fontSize: 11, fontWeight: 600,
        background: active ? PURPLE : "#fff",
        color: active ? "#fff" : (disabled ? "#a0a0a0" : INK),
        border: `1px solid ${active ? PURPLE : RULE}`,
        cursor: disabled ? "default" : "pointer",
        fontFamily: "inherit",
      }}
    >
      {label}
    </button>
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
        if (error) { setErr(error); return; }
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
  if (err) return <ErrorBox error={err} />;
  if (!rows) return <Hint>Loading your catalog…</Hint>;
  if (rows.length === 0) {
    return <Hint>No upcoming camps in your catalog.</Hint>;
  }

  const allUpcomingIds = rows.map((r) => r.id);
  const allSelected = allUpcomingIds.every((id) => selected.includes(id));

  return (
    <div>
      {/* Camps master select-all — mirrors the term picker on the Programs
          tab. Camps don't have a "term" concept so this is a single chip
          covering "all upcoming." Per-week select-all still available in the
          week group headers below. */}
      <div style={{
        marginBottom: 8, padding: "8px 12px", background: "#fff",
        border: `1px solid ${RULE}`, borderRadius: 6,
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, marginRight: 4 }}>
          Quick pick
        </span>
        <button
          onClick={() => onChange(allSelected
            ? selected.filter((id) => !allUpcomingIds.includes(id))
            : [...new Set([...selected, ...allUpcomingIds])])}
          style={{
            padding: "5px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
            background: allSelected ? PURPLE : "#fff",
            color: allSelected ? "#fff" : INK,
            border: `1px solid ${allSelected ? PURPLE : RULE}`,
            cursor: "pointer", fontFamily: "inherit",
            display: "inline-flex", alignItems: "center", gap: 6,
          }}
        >
          {allSelected ? "Clear all" : `Select all ${rows.length} upcoming`}
        </button>
      </div>

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

// Translates Supabase errors to plain-English copy. The technical detail
// stays available behind a "show details" toggle for debugging without
// leaking SQL-speak into the operator-facing surface.
function ErrorBox({ error }) {
  const [open, setOpen] = useState(false);
  const friendly = friendlyErrorMessage(error);
  const detail = error?.message || error?.error_description || String(error);
  return (
    <div style={{ padding: 14, fontSize: 13, color: "#7a2018", background: "#fdecea", border: "1px solid #f5c2c0", borderRadius: 6 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{friendly}</div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "transparent", border: "none", padding: 0, marginTop: 4,
          color: "#7a2018", textDecoration: "underline", cursor: "pointer",
          fontSize: 11, fontFamily: "inherit",
        }}
      >
        {open ? "Hide details" : "Show technical details"}
      </button>
      {open && (
        <div style={{ marginTop: 6, padding: 8, background: "#fbd9d6", borderRadius: 4, fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#5a1a14", wordBreak: "break-word" }}>
          {detail}
        </div>
      )}
    </div>
  );
}

function friendlyErrorMessage(error) {
  const code = error?.code || "";
  const msg = (error?.message || "").toLowerCase();
  if (msg.includes("permission denied") || msg.includes("rls") || code === "42501") {
    return "We couldn't load your catalog. You may need to sign in again.";
  }
  if (msg.includes("jwt") && msg.includes("expired")) {
    return "Your session expired. Refresh the page to sign back in.";
  }
  if (msg.includes("network") || msg.includes("fetch") || msg.includes("failed to fetch")) {
    return "Lost connection. Try again in a moment.";
  }
  if (msg.includes("timeout")) {
    return "That took too long to load. Try again.";
  }
  return "Something went wrong loading your catalog.";
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
