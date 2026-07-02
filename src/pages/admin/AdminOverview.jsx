// src/pages/admin/AdminOverview.jsx
// Default landing for /admin. Placeholder cards for the surfaces being built.

import { useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { defaultTenantSlug } from "../../lib/tenants.js";
import { fetchOrgTerms } from "../../lib/terms.js";
import Ennie from "../../components/Ennie";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const OK_GREEN = "#3a7c3a";
const AMBER = "#b67e00";
const CORAL = "#D9694F"; // matches the "Needs hire" badge on the schedule board

// Greeting rotates once per session (Spec_01 HomeScreen). Ennie's casual voice.
const GREETINGS = ["On deck", "Morning", "Let's go", "You've got this", "Showtime"];

// Bucketed view of contractor_onboarding_status used by the pipeline card.
// Order matters: rendered top-to-bottom in the card.
const PIPELINE_BUCKETS = [
  { key: "in_progress", label: "Filling out the wizard", color: PURPLE },
  { key: "pending_background_check", label: "Background check pending", color: AMBER },
  { key: "pending_stripe", label: "Payment setup pending", color: AMBER },
  { key: "payouts_disabled", label: "Payouts disabled — needs admin", color: "#b53737" },
  { key: "invited", label: "Invited (not started)", color: MUTED },
];

export default function AdminOverview() {
  const { org, user } = useOutletContext() ?? {};
  const [pipeline, setPipeline] = useState(null); // null = loading; {} = loaded
  const [pipelineErr, setPipelineErr] = useState("");

  // "Admins who also teach" — many enrichment operators run the org AND
  // take a class themselves. If this admin is in the instructors table for
  // their org, we surface their upcoming teaching schedule as a card. We
  // load their instructor row + next confirmed assignments in one effect;
  // both stay null when the admin doesn't teach (most operators).
  const [teaching, setTeaching] = useState(null);
  // null = loading, false = not an instructor, object = { instructorId, assignments: [...] }

  // Open-hires notification: how many instructor slots still need filling across
  // the cycles/terms you're actively staffing. Surfaced as a banner at the top so
  // it reads as a sign-in alert. null = loading; { camp, afterschool, total }.
  const [openHires, setOpenHires] = useState(null);

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      try {
        // Pull active instructors for this org, then their onboarding status.
        // Active filter mirrors InstructorsTab so counts agree.
        const { data: instructors, error: instErr } = await supabase
          .from("instructors")
          .select("id, first_name, last_name, preferred_name")
          .eq("organization_id", org.id)
          .eq("is_active", true);
        if (instErr) throw instErr;
        const ids = (instructors ?? []).map((i) => i.id);
        if (ids.length === 0) {
          if (!cancelled) setPipeline({ counts: {}, complete: [], total: 0 });
          return;
        }

        const { data: statusRows, error: stErr } = await supabase
          .from("contractor_onboarding_status")
          .select("instructor_id, overall_status")
          .in("instructor_id", ids);
        if (stErr) throw stErr;

        const statusById = new Map((statusRows ?? []).map((r) => [r.instructor_id, r.overall_status]));
        // Anyone without a row is treated as 'not_invited' so we don't lose them.
        const counts = {};
        const completeIds = [];
        for (const i of instructors) {
          const s = statusById.get(i.id) ?? "not_invited";
          counts[s] = (counts[s] ?? 0) + 1;
          if (s === "complete") completeIds.push(i.id);
        }

        if (!cancelled) {
          setPipeline({
            counts,
            complete: instructors.filter((i) => completeIds.includes(i.id)),
            total: instructors.length,
          });
        }
      } catch (err) {
        console.error("[admin/overview] pipeline load failed", err);
        if (!cancelled) setPipelineErr(err.message ?? "Couldn't load pipeline.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org?.id]);

  // Teaching-schedule load: is this admin also in the instructors table?
  // If so, fetch their next 2 confirmed assignments to surface in a card.
  useEffect(() => {
    if (!user?.id || !org?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const { data: instructorRow } = await supabase
          .from("instructors")
          .select("id, organization_id, first_name, preferred_name")
          .eq("auth_user_id", user.id)
          .eq("organization_id", org.id)
          .eq("is_active", true)
          .maybeSingle();
        if (cancelled) return;
        if (!instructorRow) {
          setTeaching(false);
          return;
        }

        // Confirmed, published, not-archived assignments for this admin-as-
        // instructor. Limit 2; the rest live in the full instructor portal.
        const { data: assignments } = await supabase
          .from("camp_assignments")
          .select(
            "id, status, role, distance_bonus_cents, camp_sessions(id, location_name, week_num, session_type, curriculum_name, starts_on, ends_on, start_time, end_time, cycle_id, scheduling_cycles:cycle_id(status))"
          )
          .eq("instructor_id", instructorRow.id)
          .eq("status", "confirmed")
          .not("published_at", "is", null)
          .order("camp_sessions(starts_on)", { ascending: true })
          .limit(2);
        if (cancelled) return;
        // Filter archived-cycle rows in JS (Supabase can't filter on joined cols here).
        const active = (assignments ?? []).filter(
          (a) => a.camp_sessions?.scheduling_cycles?.status !== "archived"
        );
        setTeaching({ instructorId: instructorRow.id, assignments: active });
      } catch (err) {
        console.error("[admin/overview] teaching load failed", err);
        if (!cancelled) setTeaching(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id, org?.id]);

  // Open-hires load. Counts unfilled instructor slots so the home can warn at
  // sign-in. Two sources, each scoped to what's actually being worked:
  //   • Camps: every camp needs a lead; a camp with >= DEVELOPING_THRESHOLD (12)
  //     enrolled also wants a developing instructor. Only active cycles
  //     (not archived, not already ended). Mirrors Schedule.jsx's counter.
  //   • After-school: every program needs a lead — but ONLY for terms that have
  //     started staffing (>=1 active assignment). Otherwise a fresh term with
  //     dozens of un-staffed programs would drown the alert in noise.
  // All queries are org-scoped (RLS + explicit org filter); no tenant hardcoding.
  useEffect(() => {
    if (!org?.id) return;
    const DEVELOPING_THRESHOLD = 12; // keep in sync with Schedule.jsx
    let cancelled = false;
    (async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);

        // ---- Camps ----
        const { data: cycles } = await supabase
          .from("scheduling_cycles")
          .select("id")
          .eq("organization_id", org.id)
          .eq("cycle_type", "summer_camp")
          .neq("status", "archived")
          .or(`ends_on.gte.${today},ends_on.is.null`);
        const cycleIds = (cycles ?? []).map((c) => c.id);

        let campOpen = 0;
        if (cycleIds.length) {
          const { data: sessions } = await supabase
            .from("camp_sessions")
            .select("id, current_enrollment")
            .eq("status", "active") // mirror Schedule.jsx: cancelled camps aren't open hires
            .in("cycle_id", cycleIds);
          const sessIds = (sessions ?? []).map((s) => s.id);
          let camp = [];
          if (sessIds.length) {
            const { data: ca } = await supabase
              .from("camp_assignments")
              .select("camp_session_id, role, status")
              .in("camp_session_id", sessIds);
            camp = (ca ?? []).filter((a) => a.status !== "withdrawn");
          }
          for (const s of sessions ?? []) {
            const own = camp.filter((a) => a.camp_session_id === s.id);
            const hasLead = own.some((a) => a.role === "lead");
            const hasDeveloping = own.some((a) => a.role === "developing");
            const wantsDeveloping = (s.current_enrollment ?? 0) >= DEVELOPING_THRESHOLD;
            if (!hasLead) campOpen++;
            if (wantsDeveloping && !hasDeveloping) campOpen++;
          }
        }

        // ---- After-school ----
        const { data: programs } = await supabase
          .from("programs")
          .select("id, term")
          .eq("organization_id", org.id)
          .eq("status", "open");
        const progIds = (programs ?? []).map((p) => p.id);

        let afterschoolOpen = 0;
        if (progIds.length) {
          const { data: pa } = await supabase
            .from("program_assignments")
            .select("program_id, role, status")
            .in("program_id", progIds);
          const active = (pa ?? []).filter(
            (a) => a.status !== "withdrawn" && a.status !== "declined"
          );
          const progById = new Map((programs ?? []).map((p) => [p.id, p]));
          const termsInStaffing = new Set();
          for (const a of active) {
            const p = progById.get(a.program_id);
            if (p) termsInStaffing.add(p.term);
          }
          for (const p of programs ?? []) {
            if (!termsInStaffing.has(p.term)) continue; // skip terms not yet being staffed
            const hasLead = active.some((a) => a.program_id === p.id && a.role === "lead");
            if (!hasLead) afterschoolOpen++;
          }
        }

        if (!cancelled) {
          setOpenHires({ camp: campOpen, afterschool: afterschoolOpen, total: campOpen + afterschoolOpen });
        }
      } catch (err) {
        console.error("[admin/overview] open-hires load failed", err);
        if (!cancelled) setOpenHires({ camp: 0, afterschool: 0, total: 0 });
      }
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  // Homescreen wins (joy-worthy only). One RLS-respecting RPC; celebrate fires on Ennie.
  const [wins, setWins] = useState(null);
  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc("get_home_wins", { p_org: org.id });
      if (cancelled) return;
      if (error) { console.error("[admin/overview] wins load failed", error); setWins([]); return; }
      setWins(data ?? []);
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  // Display name: take the bit before the @ in the email and Title-Case it.
  // Splits on dots/underscores too so "jessica.vorster" -> "Jessica Vorster".
  // No DB lookup needed for v1; we can move to a stored display_name later if
  // people want to override (e.g., "Jess" instead of "Jessica").
  const displayName = (() => {
    const raw = user?.email?.split("@")[0] ?? "";
    if (!raw) return "";
    return raw
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  })();

  // Greeting + view state. Greeting picked once per session; Today is default.
  const [greeting] = useState(() => GREETINGS[Math.floor(Math.random() * GREETINGS.length)]);
  const [view, setView] = useState("today"); // "today" | "week"
  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <div>
      <EnnieHero
        greeting={greeting}
        displayName={displayName}
        dateLabel={dateLabel}
        view={view}
        onView={setView}
        orgName={org?.name}
        celebrate={Array.isArray(wins) && wins.length > 0}
      />

      {view === "week" ? (
        <WeekView org={org} />
      ) : view === "month" ? (
        <MonthView org={org} />
      ) : (
        <>
          <WinsStrip wins={wins} />

          <ImportantToday org={org} user={user} openHires={openHires} />

          <TodayAgenda org={org} />

          <TermChecklist org={org} />

          <TimeSavedPill org={org} />
          {/* Nav shortcuts removed — the side nav covers navigation. The pipeline /
              teaching / open-hires data re-surfaces as heads-up cards in step 7. */}
        </>
      )}
    </div>
  );
}

// Ennie greeting hero — the ONE place the character lives (idle here; thinks while
// the home loads; celebrates a joy-worthy win). Enrops-branded shell, not tenant.
function EnnieHero({ greeting, displayName, dateLabel, view, onView, orgName, celebrate }) {
  // Ennie idles by default; when a joy-worthy win lands she plays celebrate once,
  // then settles back to idle.
  const [ennieState, setEnnieState] = useState("idle");
  useEffect(() => {
    if (celebrate) setEnnieState("celebrate");
  }, [celebrate]);
  return (
    <div style={{
      background: "#fff", border: `1px solid ${RULE}`, borderRadius: 14,
      padding: "16px 20px", marginBottom: 24, display: "flex",
      alignItems: "center", gap: 16, flexWrap: "wrap",
    }}>
      <Ennie state={ennieState} framed={false} size={104} onComplete={() => setEnnieState("idle")} />
      <div style={{ flex: 1, minWidth: 180 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.4 }}>
          {greeting}{displayName ? `, ${displayName}` : ""}
        </h1>
        <p style={{ color: MUTED, marginTop: 4, fontSize: 14 }}>
          {dateLabel}{orgName ? ` · ${orgName}` : ""}
        </p>
      </div>
      <ViewToggle view={view} onView={onView} />
    </div>
  );
}

function ViewToggle({ view, onView }) {
  const tab = (key, label) => (
    <button
      onClick={() => onView(key)}
      style={{
        fontSize: 13, fontWeight: 600, padding: "6px 14px", border: "none",
        cursor: "pointer", background: view === key ? BRIGHT : "transparent",
        color: view === key ? "#fff" : MUTED,
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ display: "flex", border: `1px solid ${RULE}`, borderRadius: 8, overflow: "hidden", flexShrink: 0 }}>
      {tab("today", "Today")}
      {tab("week", "Week")}
      {tab("month", "Month")}
    </div>
  );
}

// ---- Week / Month calendar views (camps populate the days; afterschool = fast-follow) ----
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
async function fetchCampsInRange(orgId, from, to) {
  const { data } = await supabase
    .from("camp_sessions")
    .select("id, location_name, curriculum_name, start_time, end_time, starts_on, ends_on")
    .eq("organization_id", orgId)
    .lte("starts_on", to)
    .gte("ends_on", from)
    .order("start_time", { ascending: true });
  return data ?? [];
}
function sessionsOnDay(sessions, dayStr) {
  return sessions.filter((s) => s.starts_on <= dayStr && s.ends_on >= dayStr);
}

function WeekView({ org }) {
  const week = useMemo(() => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const monday = new Date(t); monday.setDate(t.getDate() - ((t.getDay() + 6) % 7));
    const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });
    return { days, start: ymd(days[0]), end: ymd(days[6]), todayStr: ymd(t) };
  }, []);
  const [sessions, setSessions] = useState(null);
  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => { const s = await fetchCampsInRange(org.id, week.start, week.end); if (!cancelled) setSessions(s); })();
    return () => { cancelled = true; };
  }, [org?.id, week.start, week.end]);

  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 6 }}>
        {week.days.map((d, i) => {
          const isToday = ymd(d) === week.todayStr;
          return (
            <div key={i} style={{ textAlign: "center", padding: "4px 0", borderRadius: 8, background: isToday ? `${BRIGHT}14` : "transparent" }}>
              <div style={{ fontSize: 11, color: isToday ? BRIGHT : MUTED }}>{labels[i]}</div>
              <div style={{ fontSize: 13, fontWeight: isToday ? 700 : 400, color: isToday ? BRIGHT : INK }}>{d.getDate()}</div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 6, marginTop: 6, minHeight: 80 }}>
        {week.days.map((d, i) => {
          const day = sessions ? sessionsOnDay(sessions, ymd(d)) : [];
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {day.map((s) => (
                <div key={s.id} style={{ background: "#fafaf3", border: `1px solid ${RULE}`, borderRadius: 6, padding: "4px 5px" }}>
                  <div style={{ fontSize: 10, color: MUTED }}>{fmtClock(s.start_time)}</div>
                  <div style={{ fontSize: 11, fontWeight: 500, lineHeight: 1.2, color: INK }}>{s.curriculum_name}</div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {sessions !== null && sessions.length === 0 && (
        <div style={{ fontSize: 13, color: MUTED, textAlign: "center", marginTop: 10 }}>Nothing scheduled this week — enjoy the breather.</div>
      )}
    </div>
  );
}

function fmtDateRange(from, to) {
  const f = new Date(`${from}T00:00:00`);
  const t = new Date(`${to}T00:00:00`);
  const mo = (d) => d.toLocaleDateString(undefined, { month: "short" });
  if (from === to) return `${mo(f)} ${f.getDate()}`;
  if (f.getMonth() === t.getMonth()) return `${mo(f)} ${f.getDate()}–${t.getDate()}`;
  return `${mo(f)} ${f.getDate()} – ${mo(t)} ${t.getDate()}`;
}

// Month = a content-first agenda of the month's programs (a dot-grid wasted the
// screen for sparse activity). Each camp shown once with its date range.
function MonthView({ org }) {
  const range = useMemo(() => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const first = new Date(t.getFullYear(), t.getMonth(), 1);
    const last = new Date(t.getFullYear(), t.getMonth() + 1, 0);
    return { start: ymd(first), end: ymd(last), todayStr: ymd(t), label: t.toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
  }, []);
  const [sessions, setSessions] = useState(null);
  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => { const s = await fetchCampsInRange(org.id, range.start, range.end); if (!cancelled) setSessions(s); })();
    return () => { cancelled = true; };
  }, [org?.id, range.start, range.end]);

  const items = sessions
    ? [...sessions].sort((a, b) => (a.starts_on === b.starts_on ? (a.start_time || "").localeCompare(b.start_time || "") : a.starts_on.localeCompare(b.starts_on)))
    : null;

  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 }}>{range.label}</div>
      {items === null ? (
        <div style={{ fontSize: 13, color: MUTED, padding: "4px 0" }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ fontSize: 14, color: MUTED, padding: "6px 0" }}>Nothing scheduled this month — enjoy the breather.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {items.map((s) => {
            const active = s.starts_on <= range.todayStr && s.ends_on >= range.todayStr;
            return (
              <div key={s.id} style={{ display: "flex", gap: 14, alignItems: "flex-start", padding: "10px 2px", borderTop: `1px solid ${RULE}` }}>
                <div style={{ fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: active ? BRIGHT : MUTED, minWidth: 100, fontWeight: active ? 700 : 400, paddingTop: 1 }}>
                  {fmtDateRange(s.starts_on, s.ends_on)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: INK }}>{s.curriculum_name}</div>
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 1 }}>{fmtClock(s.start_time)}–{fmtClock(s.end_time)} · {s.location_name}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Time-saved pill — Ennie's running tally of minutes saved by automations this
// week (operator-surface standing rule). Hidden when there's nothing to show yet.
function TimeSavedPill({ org }) {
  const [mins, setMins] = useState(null);
  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from("automation_runs")
        .select("time_saved_minutes")
        .eq("organization_id", org.id)
        .gte("fired_at", since);
      if (cancelled) return;
      if (error) { console.error("[admin/overview] time-saved load failed", error); setMins(0); return; }
      setMins((data ?? []).reduce((s, r) => s + (r.time_saved_minutes || 0), 0));
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  if (!mins || mins <= 0) return null;
  const rounded = Math.max(5, Math.round(mins / 5) * 5);
  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${RULE}` }}>
      <span style={{ fontSize: 12, color: OK_GREEN, background: `${OK_GREEN}14`, border: `1px solid ${OK_GREEN}40`, borderRadius: 8, padding: "4px 10px", display: "inline-block" }}>
        Ennie saved you about {rounded} minutes this week
      </span>
    </div>
  );
}

// "Your term" to-do checklist — per-tenant editable term-planning steps, anchored
// to the active term's first day. Reads term_checklist_items + per-term completions.
// Items with a route deep-link in; external steps (route NULL) are check-off only.
// (Add/edit/remove UI = step 6b.)
function fmtDue(due) {
  if (!due) return null;
  return due.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function TermChecklist({ org }) {
  const [state, setState] = useState(null); // null=loading; {empty:true} ; {term, items}
  const [editMode, setEditMode] = useState(false);

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        // Active planning term = soonest upcoming first-day (afterschool term OR camp cycle).
        const [progRes, cycRes] = await Promise.all([
          supabase.from("programs").select("term, first_session_date")
            .eq("organization_id", org.id).not("first_session_date", "is", null),
          supabase.from("scheduling_cycles").select("id, name, starts_on")
            .eq("organization_id", org.id).eq("cycle_type", "summer_camp").not("starts_on", "is", null),
        ]);
        const termMin = new Map();
        for (const p of progRes.data ?? []) {
          if (!p.term || !p.first_session_date) continue;
          const cur = termMin.get(p.term);
          if (!cur || p.first_session_date < cur) termMin.set(p.term, p.first_session_date);
        }
        const candidates = [];
        for (const [term, d] of termMin) candidates.push({ kind: "afterschool_term", key: term, label: term, anchor: d });
        for (const c of cycRes.data ?? []) candidates.push({ kind: "camp_cycle", key: c.id, label: c.name, anchor: c.starts_on });
        if (candidates.length === 0) { if (!cancelled) setState({ empty: true }); return; }
        const future = candidates.filter((c) => c.anchor >= today).sort((a, b) => (a.anchor < b.anchor ? -1 : 1));
        const latest = [...candidates].sort((a, b) => (a.anchor > b.anchor ? -1 : 1));
        const term = future[0] || latest[0];

        const [itemRes, compRes] = await Promise.all([
          supabase.from("term_checklist_items").select("id, label, detail, route, offset_days, sort_order")
            .eq("organization_id", org.id).eq("archived", false).order("sort_order", { ascending: true }),
          supabase.from("term_checklist_completions").select("item_id")
            .eq("organization_id", org.id).eq("term_kind", term.kind).eq("term_key", term.key),
        ]);
        const doneSet = new Set((compRes.data ?? []).map((c) => c.item_id));
        const anchorDate = term.anchor ? new Date(`${term.anchor}T00:00:00`) : null;
        const items = (itemRes.data ?? []).map((it) => {
          let due = null;
          if (anchorDate && it.offset_days != null) {
            due = new Date(anchorDate);
            due.setDate(due.getDate() + it.offset_days);
          }
          return { ...it, done: doneSet.has(it.id), due };
        });
        if (!cancelled) setState({ term, items });
      } catch (e) {
        console.error("[admin/overview] checklist load failed", e);
        if (!cancelled) setState({ empty: true });
      }
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  async function toggle(item) {
    const term = state?.term;
    if (!term) return;
    // Optimistic flip; RLS (can_edit_org) gates the write for non-editors.
    setState((s) => ({ ...s, items: s.items.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)) }));
    if (item.done) {
      await supabase.from("term_checklist_completions").delete()
        .eq("organization_id", org.id).eq("item_id", item.id)
        .eq("term_kind", term.kind).eq("term_key", term.key);
    } else {
      await supabase.from("term_checklist_completions").insert({
        organization_id: org.id, item_id: item.id, term_kind: term.kind, term_key: term.key,
      });
    }
  }

  function dueFor(term, offset) {
    if (!term?.anchor || offset == null) return null;
    const d = new Date(`${term.anchor}T00:00:00`);
    d.setDate(d.getDate() + offset);
    return d;
  }
  function patchLocal(id, fields) {
    setState((s) => ({
      ...s,
      items: s.items.map((i) =>
        i.id === id ? { ...i, ...fields, ...("offset_days" in fields ? { due: dueFor(s.term, fields.offset_days) } : {}) } : i
      ),
    }));
  }
  async function persist(id, fields) {
    await supabase.from("term_checklist_items").update(fields).eq("id", id).eq("organization_id", org.id);
  }
  async function addItem() {
    const maxSort = state.items.reduce((m, i) => Math.max(m, i.sort_order || 0), 0);
    const { data, error } = await supabase
      .from("term_checklist_items")
      .insert({ organization_id: org.id, label: "New step", offset_days: -14, is_default: false, sort_order: maxSort + 1 })
      .select("id, label, detail, route, offset_days, sort_order")
      .single();
    if (error) { console.error("[checklist] add failed", error); return; }
    setState((s) => ({ ...s, items: [...s.items, { ...data, done: false, due: dueFor(s.term, data.offset_days) }] }));
  }
  async function removeItem(id) {
    setState((s) => ({ ...s, items: s.items.filter((i) => i.id !== id) }));
    await supabase.from("term_checklist_items").update({ archived: true }).eq("id", id).eq("organization_id", org.id);
  }

  if (state === null) return null;

  if (state.empty) {
    return (
      <div style={{ marginBottom: 22 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, color: INK, margin: "0 0 8px" }}>Your term</h2>
        <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 18, fontSize: 14, color: MUTED }}>
          Add programs with a start date and your term to-do list shows up here.
        </div>
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const ordered = [...state.items].sort((a, b) => (a.done === b.done ? a.sort_order - b.sort_order : a.done ? 1 : -1));
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, color: INK, margin: 0 }}>Your term</h2>
        <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
          <span style={{ fontSize: 12, color: MUTED }}>{state.term.label}</span>
          <button onClick={() => setEditMode((e) => !e)} style={{ fontSize: 12, fontWeight: 600, color: BRIGHT, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            {editMode ? "Done" : "Edit"}
          </button>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {/* Completed items sink to the bottom; otherwise keep the planned order. */}
        {ordered.map((it) => {
          const overdue = it.due && !it.done && it.due.toISOString().slice(0, 10) < today;
          if (editMode) {
            const weeks = it.offset_days != null ? Math.round(-it.offset_days / 7) : "";
            return (
              <div key={it.id} style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10, padding: "9px 12px", display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  value={it.label}
                  onChange={(e) => patchLocal(it.id, { label: e.target.value })}
                  onBlur={(e) => persist(it.id, { label: e.target.value.trim() || "Untitled step" })}
                  style={{ flex: 1, minWidth: 0, fontSize: 14, padding: "6px 8px", border: `1px solid ${RULE}`, borderRadius: 6 }}
                />
                <input
                  type="number"
                  min="0"
                  value={weeks}
                  onChange={(e) => patchLocal(it.id, { offset_days: e.target.value === "" ? null : -Math.abs(Math.round(Number(e.target.value))) * 7 })}
                  onBlur={(e) => persist(it.id, { offset_days: e.target.value === "" ? null : -Math.abs(Math.round(Number(e.target.value))) * 7 })}
                  style={{ width: 52, fontSize: 13, padding: "6px 6px", border: `1px solid ${RULE}`, borderRadius: 6, textAlign: "center" }}
                  aria-label="Weeks before term start"
                />
                <span style={{ fontSize: 11, color: MUTED, whiteSpace: "nowrap" }}>wks before</span>
                <button onClick={() => removeItem(it.id)} aria-label="Remove step" style={{ fontSize: 18, lineHeight: 1, color: MUTED, background: "none", border: "none", cursor: "pointer", padding: "0 4px" }}>×</button>
              </div>
            );
          }
          return (
            <div key={it.id} style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10, padding: "11px 14px", display: "flex", gap: 12, alignItems: "flex-start" }}>
              <button
                onClick={() => toggle(it)}
                aria-label={it.done ? "Mark not done" : "Mark done"}
                style={{
                  width: 20, height: 20, borderRadius: 6, flexShrink: 0, marginTop: 1, cursor: "pointer",
                  border: `1.5px solid ${it.done ? OK_GREEN : RULE}`, background: it.done ? OK_GREEN : "#fff",
                  color: "#fff", fontSize: 12, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                {it.done ? "✓" : ""}
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500, color: it.done ? MUTED : INK, textDecoration: it.done ? "line-through" : "none" }}>{it.label}</div>
                {it.detail && <div style={{ fontSize: 12, color: MUTED, marginTop: 2, lineHeight: 1.4 }}>{it.detail}</div>}
                <div style={{ marginTop: 6, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  {it.due && <span style={{ fontSize: 11, color: overdue ? AMBER : MUTED }}>{overdue ? "was due " : "by "}{fmtDue(it.due)}</span>}
                  {it.route ? (
                    <Link to={it.route} style={{ fontSize: 12, fontWeight: 600, color: BRIGHT, textDecoration: "none" }}>Open →</Link>
                  ) : (
                    <span style={{ fontSize: 11, color: MUTED, fontStyle: "italic" }}>done outside Enrops</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {editMode && (
          <button onClick={addItem} style={{ alignSelf: "flex-start", marginTop: 2, fontSize: 13, fontWeight: 600, color: BRIGHT, background: "none", border: `1px dashed ${RULE}`, borderRadius: 8, padding: "8px 14px", cursor: "pointer" }}>
            + Add a step
          </button>
        )}
      </div>
    </div>
  );
}

// Wins strip — joy-worthy only (Jessica's locked list). Ennie's celebrate plays
// up top; these cards carry the words. Clean, capped at 3.
const WIN_STYLE = {
  returning_family: {
    accent: "#7c3aed",
    build: (w) => ({
      headline: `The ${w.label} family is back!`,
      detail: "Re-enrolled for another term — the lifetime value (LTV) you're building.",
    }),
  },
  hire_cleared: {
    accent: OK_GREEN,
    build: (w) => ({
      headline: `${w.label} is cleared and ready!`,
      detail: "Background check and pay setup are done — ready to assign.",
    }),
  },
  full_class: {
    accent: CORAL,
    build: (w) => ({
      headline: `${w.label} is full!`,
      detail: `${w.detail || "Maxed out"} — full class.`,
    }),
  },
  emails_sent: {
    accent: "#2563eb",
    build: (w) => ({
      headline: `You reached ${w.label} ${Number(w.label) === 1 ? "family" : "families"}!`,
      detail: `${w.detail || "Your campaign"} just went out — outreach that grows enrollment.`,
    }),
  },
};

// Section label + card flourish both rotate so the strip feels alive, not canned.
const WINS_LABELS = ["Reasons to celebrate", "Pat yourself on the back", "High-fives", "Worth a smile"];
const PARTY = ["🎉", "🥳", "🎊", "🙌", "✨", "🌟", "🎈"];

function WinsStrip({ wins }) {
  const [label] = useState(() => WINS_LABELS[Math.floor(Math.random() * WINS_LABELS.length)]);
  const [seed] = useState(() => Math.floor(Math.random() * PARTY.length));
  if (!Array.isArray(wins) || wins.length === 0) return null;
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>{label}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
        {wins.slice(0, 3).map((w, idx) => {
          const cfg = WIN_STYLE[w.win_type];
          if (!cfg) return null;
          const { headline, detail } = cfg.build(w);
          const emoji = PARTY[(seed + idx) % PARTY.length];
          return (
            <div key={idx} style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 14 }}>
              <div style={{ fontSize: 22, lineHeight: 1, marginBottom: 6 }} aria-hidden="true">{emoji}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: INK, marginBottom: 3 }}>{headline}</div>
              <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.4 }}>{detail}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// "Today's schedule" — at-a-glance agenda of what's running today: time, topic,
// location, instructor. Covers BOTH camps (week-long sessions) and after-school
// (weekly recurring classes; "meets today" resolved via derive_program_session_dates
// so closures/breaks are honored). Single coral accent only where a class has no
// one to cover it today. Camps and after-school run in different seasons, so in
// practice a given day is one or the other — but both are merged and time-sorted.
const INSTRUCTOR_NAME_COLS = "first_name, preferred_name, last_name";
function instructorName(i) {
  if (!i) return null;
  const n = `${i.preferred_name || i.first_name || ""}${i.last_name ? ` ${i.last_name}` : ""}`.trim();
  return n || null;
}
// Stored times vary: camps use 24h ("09:00"); programs use 12h ("2:35 PM") or,
// for some imported rows, 24h ("15:45"). Normalize both to minutes / a clock label.
function timeToMinutes(t) {
  if (!t) return 0;
  const s = String(t).trim();
  const m12 = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/.exec(s);
  if (m12) {
    let h = parseInt(m12[1], 10) % 12;
    if (m12[3].toLowerCase() === "pm") h += 12;
    return h * 60 + parseInt(m12[2], 10);
  }
  const m24 = /^(\d{1,2}):(\d{2})/.exec(s);
  if (m24) return parseInt(m24[1], 10) * 60 + parseInt(m24[2], 10);
  return 0;
}
function fmtClock(t) {
  if (!t) return "";
  const min = timeToMinutes(t);
  let h = Math.floor(min / 60);
  const m = min % 60;
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}

function TodayAgenda({ org }) {
  const [rows, setRows] = useState(null); // null = loading; [] = nothing today

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        // Derive the weekday from the SAME UTC date the camp range uses (below), so
        // the date and weekday never disagree near a midnight-UTC boundary.
        const todayWeekday = new Date(`${today}T00:00:00Z`)
          .toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })
          .toLowerCase();

        // ---- Camps: week-long sessions; "running today" = today ∈ [starts_on, ends_on]. ----
        const { data: sessions, error: sErr } = await supabase
          .from("camp_sessions")
          .select("id, location_name, curriculum_name, start_time, end_time")
          .eq("organization_id", org.id)
          .lte("starts_on", today)
          .gte("ends_on", today);
        if (sErr) throw sErr;

        const campIds = (sessions ?? []).map((s) => s.id);
        const leadByCamp = new Map();
        if (campIds.length) {
          const { data: assigns } = await supabase
            .from("camp_assignments")
            .select(`camp_session_id, status, instructors(${INSTRUCTOR_NAME_COLS})`)
            .in("camp_session_id", campIds)
            .eq("role", "lead");
          for (const a of assigns ?? []) {
            if (a.status === "withdrawn" || a.status === "declined") continue;
            const name = instructorName(a.instructors);
            if (name) leadByCamp.set(a.camp_session_id, name);
          }
        }

        const campRows = (sessions ?? []).map((s) => ({
          id: `camp-${s.id}`,
          title: s.curriculum_name,
          location: s.location_name,
          startLabel: fmtClock(s.start_time),
          endLabel: fmtClock(s.end_time),
          sortMin: timeToMinutes(s.start_time),
          instructor: leadByCamp.get(s.id) || null,
          viaSub: false,
        }));

        // ---- After-school: weekly recurring classes. Find classes whose weekday is
        // today AND that belong to a currently-running term — bounded by
        // first_session_date (no dependency on org_terms, which can be empty), then
        // confirm today is a real session (not a break) via derive_program_session_dates.
        // Effective teacher = a confirmed same-day substitute if any, else the lead;
        // no one ⇒ "needs cover". Out of season nothing has a session dated today, so
        // this stays silent until after-school is actually running.
        const asRows = [];
        {
          const lookback = new Date(`${today}T00:00:00Z`);
          lookback.setUTCDate(lookback.getUTCDate() - 180); // ~ one term + gap
          const { data: progs } = await supabase
            .from("programs")
            .select("id, curriculum, day_of_week, start_time, end_time, program_location_id")
            .eq("organization_id", org.id)
            .not("status", "in", '("cancelled","archived")')
            .lte("first_session_date", today)
            .gte("first_session_date", lookback.toISOString().slice(0, 10));
          const candidates = (progs ?? []).filter(
            (p) => (p.day_of_week || "").trim().toLowerCase() === todayWeekday,
          );
          if (candidates.length) {
            // Confirm each candidate actually meets today (honors closures/breaks).
            const dateLists = await Promise.all(
              candidates.map((p) =>
                supabase.rpc("derive_program_session_dates", { p_program_id: p.id }).then((r) => r, () => ({ data: [] })),
              ),
            );
            const meeting = candidates.filter((p, i) => {
              const d = dateLists[i]?.data;
              return Array.isArray(d) && d.includes(today);
            });
            if (meeting.length) {
              const progIds = meeting.map((p) => p.id);
              const locIds = Array.from(new Set(meeting.map((p) => p.program_location_id).filter(Boolean)));
              const [{ data: locs }, { data: pAssigns }] = await Promise.all([
                locIds.length
                  ? supabase.from("program_locations").select("id, name").in("id", locIds)
                  : Promise.resolve({ data: [] }),
                supabase
                  .from("program_assignments")
                  .select(`id, program_id, status, instructors(${INSTRUCTOR_NAME_COLS})`)
                  .in("program_id", progIds),
              ]);
              const locName = new Map((locs ?? []).map((l) => [l.id, l.name]));
              const leadByProgram = new Map(); // program_id -> { assignmentId, name }
              for (const a of pAssigns ?? []) {
                if (a.status === "withdrawn" || a.status === "declined") continue;
                const name = instructorName(a.instructors);
                if (name && !leadByProgram.has(a.program_id)) {
                  leadByProgram.set(a.program_id, { assignmentId: a.id, name });
                }
              }
              // Confirmed same-day subs override the lead for today.
              const leadAssignmentIds = Array.from(leadByProgram.values()).map((v) => v.assignmentId);
              const subByAssignment = new Map();
              if (leadAssignmentIds.length) {
                const { data: subs } = await supabase
                  .from("assignment_substitutions")
                  .select(`parent_assignment_id, status, sub:instructors!sub_instructor_id(${INSTRUCTOR_NAME_COLS})`)
                  .eq("parent_assignment_type", "program")
                  .eq("date", today)
                  .in("parent_assignment_id", leadAssignmentIds);
                for (const s of subs ?? []) {
                  if (s.status !== "confirmed" && s.status !== "taught") continue;
                  const name = instructorName(s.sub);
                  if (name) subByAssignment.set(s.parent_assignment_id, name);
                }
              }
              for (const p of meeting) {
                const lead = leadByProgram.get(p.id) || null;
                const sub = lead ? subByAssignment.get(lead.assignmentId) : null;
                asRows.push({
                  id: `prog-${p.id}`,
                  title: p.curriculum || "Class",
                  location: locName.get(p.program_location_id) || "",
                  startLabel: fmtClock(p.start_time),
                  endLabel: fmtClock(p.end_time),
                  sortMin: timeToMinutes(p.start_time),
                  instructor: sub || lead?.name || null,
                  viaSub: !!sub,
                });
              }
            }
          }
        }

        const built = [...campRows, ...asRows].sort((a, b) => a.sortMin - b.sortMin);
        if (!cancelled) setRows(built);
      } catch (e) {
        console.error("[admin/overview] today agenda load failed", e);
        if (!cancelled) setRows([]);
      }
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, color: INK, margin: 0 }}>Today's schedule</h2>
        {Array.isArray(rows) && rows.length > 0 && (
          <span style={{ fontSize: 12, color: MUTED }}>{rows.length} running</span>
        )}
      </div>

      {rows === null ? (
        <div style={{ fontSize: 13, color: MUTED }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 20, fontSize: 14, color: MUTED }}>
          Nothing running today — enjoy the breather.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((r) => (
            <div key={r.id} style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10, padding: "11px 14px", display: "flex", gap: 14, alignItems: "flex-start" }}>
              <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: MUTED, minWidth: 66, lineHeight: 1.5 }}>
                {r.startLabel}<br />{r.endLabel}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>{r.title}</div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                  {r.location}{r.instructor ? ` · ${r.instructor}${r.viaSub ? " (sub)" : ""}` : ""}
                </div>
                {!r.instructor && (
                  <span style={{ display: "inline-block", marginTop: 6, fontSize: 11, fontWeight: 600, color: CORAL, background: `${CORAL}14`, border: `1px solid ${CORAL}55`, borderRadius: 6, padding: "2px 8px" }}>
                    needs cover
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// "Important today" — the merged on-deck + heads-up list (Spec_01). Ennie's
// first-person voice, no avatar (the hero carries her). ACTS (things to do) sort
// above FYIs; capped at 5 with a "More waiting" overflow toggle. This REPLACES the
// old open-hires banner — open hires is now one signal among several. Each card
// can be snoozed 24h ("Not now"); FYIs can also be dismissed for good. Dismissals
// are per-admin (homescreen_dismissals), so one admin's snooze doesn't hide a real
// action from another. Counts are aggregate (get_home_signals RPC, RLS-scoped);
// open-hires comes in as a prop from the existing JS calc so it stays byte-identical
// to the schedule board's counter. Empty -> the section hides itself entirely.
const IMPORTANT_CAP = 5;
const dismissBtn = { fontSize: 12, color: MUTED, background: "none", border: "none", cursor: "pointer", padding: 0 };

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(`${dateStr}T00:00:00`);
  return Math.round((d - today) / 86400000);
}

// Pure: turn the signal counts + open-hires into ordered cards. prio ascending
// within a kind; acts always above fyis. Copy is plain and real — no invented stats
// (automation_off uses the template's own description). Counts are aggregated so one
// card stands for N items, keeping the list inside the cap.
function buildImportant(sig, openHires, subSignals) {
  const out = [];
  // ---- Acts ----
  if (sig?.finish_stripe) out.push({
    key: "finish_stripe", kind: "act", prio: 1,
    title: "Finish your payment setup",
    detail: "Connect Stripe so families can register and your money lands in your account.",
    cta: { to: "/admin/settings", label: "Finish setup →" },
  });
  if (openHires?.total > 0) {
    const parts = [];
    if (openHires.camp > 0) parts.push(`${openHires.camp} camp ${openHires.camp === 1 ? "slot" : "slots"}`);
    if (openHires.afterschool > 0) parts.push(`${openHires.afterschool} after-school ${openHires.afterschool === 1 ? "class" : "classes"}`);
    out.push({
      key: "open_hires", kind: "act", prio: 2,
      title: openHires.total === 1 ? "1 class still needs an instructor" : `${openHires.total} classes still need an instructor`,
      detail: `${parts.join(" and ")} ${openHires.total === 1 ? "is" : "are"} unstaffed. Assign someone or send offers from the schedule.`,
      cta: { to: "/admin/schedule", label: "Open the schedule →" },
    });
  }
  // Genuinely uncovered — a sub said no and nobody's filling in. Urgent act.
  if (subSignals?.uncovered > 0) out.push({
    key: "needs_cover", kind: "act", prio: 3,
    title: subSignals.uncovered === 1 ? "A class day has no one to cover it" : `${subSignals.uncovered} class days have no one to cover them`,
    detail: "A sub said no and nobody's filling in yet — line up another sub, or have the lead take it.",
    cta: { to: "/admin/schedule", label: "Find a sub →" },
  });
  // Offer still out — calmer FYI, not an urgent act.
  if (subSignals?.awaiting > 0) out.push({
    key: "sub_pending", kind: "fyi", prio: 9,
    title: subSignals.awaiting === 1 ? "A sub offer is still out" : `${subSignals.awaiting} sub offers are still out`,
    detail: "You've asked someone to cover a day — just waiting to hear back.",
    cta: { to: "/admin/schedule", label: "View schedule →" },
  });
  if (sig?.low_enrollment > 0) out.push({
    key: "low_enrollment", kind: "act", prio: 4,
    title: sig.low_enrollment === 1 ? "1 camp is under half full" : `${sig.low_enrollment} camps are under half full`,
    detail: "Each starts within three weeks and is less than halfway to capacity — a quick campaign can still fill seats.",
    cta: { to: "/admin/family-comms/marketing", label: "Send a campaign →" },
  });
  if (sig?.change_requested > 0) out.push({
    key: "change_requested", kind: "act", prio: 5,
    title: sig.change_requested === 1 ? "An instructor asked for a change" : `${sig.change_requested} instructors asked for changes`,
    detail: "Someone you offered a class wants to talk it through before they accept.",
    cta: { to: "/admin/schedule", label: "Review requests →" },
  });
  if (sig?.offers_awaiting > 0) out.push({
    key: "offers_awaiting", kind: "act", prio: 6,
    title: sig.offers_awaiting === 1 ? "1 offer is waiting on a reply" : `${sig.offers_awaiting} offers are waiting on a reply`,
    detail: "These are out with instructors but unanswered. A nudge can speed things along.",
    cta: { to: "/admin/schedule", label: "See offers →" },
  });
  if (sig?.end_of_term > 0) out.push({
    key: "end_of_term", kind: "act", prio: 7,
    title: sig.end_of_term === 1 ? "A term is wrapping up soon" : `${sig.end_of_term} terms are wrapping up soon`,
    detail: "Check in with the school about next term while families are still engaged — it's the easiest re-enrollment you'll get.",
    cta: { to: "/admin/schools", label: "Open schools →" },
  });
  // ---- FYIs ----
  const dStart = daysUntil(sig?.next_start);
  if (dStart != null && dStart >= 0 && dStart <= 21) {
    const when = dStart === 0 ? "today" : dStart === 1 ? "tomorrow" : `in ${dStart} days`;
    out.push({
      key: "term_starting", kind: "fyi", prio: 8,
      title: `Your next session starts ${when}`,
      detail: "A good moment to confirm rosters, instructors, and welcome emails are set.",
      cta: null,
    });
  }
  if (sig?.automation_off > 0) out.push({
    key: "automation_off", kind: "fyi", prio: 9,
    title: sig.automation_off === 1 ? `“${sig.automation_off_name}” is turned off` : `${sig.automation_off} automations are turned off`,
    detail: sig.automation_off === 1 && sig.automation_off_detail
      ? sig.automation_off_detail
      : "Turning them on lets Ennie send these for you automatically.",
    cta: { to: "/admin/family-comms/automations", label: "Review automations →" },
  });
  return out;
}

function ImportantToday({ org, user, openHires }) {
  const [sig, setSig] = useState(null);               // get_home_signals row
  const [dismissals, setDismissals] = useState(null); // Map signal_key -> row
  const [subSignals, setSubSignals] = useState(null); // { uncovered, awaiting }
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      const [sigRes, disRes, subsRes] = await Promise.all([
        supabase.rpc("get_home_signals", { p_org: org.id }),
        supabase.from("homescreen_dismissals").select("signal_key, dismissed_until, permanent").eq("organization_id", org.id),
        // Sub-coverage via the shared get_sub_coverage RPC (single source of truth
        // with NeedsCoverBanner). Returns only slots on LIVE parents, already split
        // into 'uncovered' (declined, no one coming) and 'awaiting' (offer still
        // out) — so cancelled/withdrawn/deleted classes can't inflate this card.
        supabase.rpc("get_sub_coverage", { p_org: org.id }),
      ]);
      if (cancelled) return;
      if (sigRes.error) { console.error("[admin/overview] signals load failed", sigRes.error); setSig({}); }
      else setSig(Array.isArray(sigRes.data) ? sigRes.data[0] || {} : sigRes.data || {});
      setDismissals(new Map((disRes.data ?? []).map((r) => [r.signal_key, r])));

      let uncovered = 0, awaiting = 0;
      for (const r of subsRes.data ?? []) {
        if (r.state === "uncovered") uncovered++;
        else if (r.state === "awaiting") awaiting++;
      }
      setSubSignals({ uncovered, awaiting });
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  async function dismiss(item, permanent) {
    const until = permanent ? null : new Date(Date.now() + 86400000).toISOString();
    // Optimistic hide; RLS (own row only) gates the write.
    setDismissals((m) => new Map(m).set(item.key, { signal_key: item.key, permanent, dismissed_until: until }));
    await supabase.from("homescreen_dismissals").upsert(
      { organization_id: org.id, user_id: user?.id, signal_key: item.key, permanent, dismissed_until: until, updated_at: new Date().toISOString() },
      { onConflict: "organization_id,user_id,signal_key" }
    );
  }

  if (sig === null || dismissals === null) return null; // quiet while loading

  const now = Date.now();
  const all = buildImportant(sig, openHires, subSignals).filter((s) => {
    const d = dismissals.get(s.key);
    if (!d) return true;
    if (d.permanent) return false;
    if (d.dismissed_until && new Date(d.dismissed_until).getTime() > now) return false;
    return true;
  });
  all.sort((a, b) => (a.kind === b.kind ? a.prio - b.prio : a.kind === "act" ? -1 : 1));
  if (all.length === 0) return null;

  const shown = showAll ? all : all.slice(0, IMPORTANT_CAP);
  const overflow = all.length - shown.length;

  return (
    <div style={{ marginBottom: 22 }}>
      <h2 style={{ fontSize: 17, fontWeight: 600, color: INK, margin: "0 0 10px" }}>Important today</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {shown.map((it) => (
          <div key={it.key} style={{
            background: "#fff", border: `1px solid ${RULE}`,
            borderLeft: `3px solid ${it.kind === "act" ? BRIGHT : RULE}`,
            borderRadius: 10, padding: "12px 14px",
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>{it.title}</div>
            <div style={{ fontSize: 12.5, color: MUTED, marginTop: 3, lineHeight: 1.45 }}>{it.detail}</div>
            <div style={{ marginTop: 9, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
              {it.cta && (
                <Link to={it.cta.to} style={{ fontSize: 12.5, fontWeight: 600, color: BRIGHT, textDecoration: "none" }}>{it.cta.label}</Link>
              )}
              <button onClick={() => dismiss(it, false)} style={dismissBtn}>Not now</button>
              {it.kind === "fyi" && <button onClick={() => dismiss(it, true)} style={dismissBtn}>Dismiss</button>}
            </div>
          </div>
        ))}
      </div>
      {overflow > 0 && !showAll && (
        <button onClick={() => setShowAll(true)} style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600, color: MUTED, background: "none", border: "none", cursor: "pointer", padding: "4px 0" }}>
          More waiting ({overflow}) →
        </button>
      )}
    </div>
  );
}

function TeachingScheduleCard({ teaching, orgSlug }) {
  // teaching = { instructorId, assignments: [...] }. Both upcoming-empty
  // and upcoming-some states render — the CTA is the same either way.
  const next = teaching.assignments ?? [];
  // Multi-tenant: use THIS org's slug; fall back to the resolver, never a literal.
  const slug = orgSlug || defaultTenantSlug();
  const portalPath = slug ? `/${slug}/instructor` : "/instructor";

  return (
    <div style={{
      background: "#fff",
      border: `1px solid ${RULE}`,
      borderLeft: `3px solid ${BRIGHT}`,
      borderRadius: 12,
      padding: 20,
      display: "flex",
      flexDirection: "column",
      minHeight: 150,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, color: INK, margin: 0 }}>Your teaching schedule</h2>
        <span style={{ fontSize: 10, color: BRIGHT, background: `${BRIGHT}1A`, padding: "2px 8px", borderRadius: 999, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
          You teach too
        </span>
      </div>

      {next.length === 0 ? (
        <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.5, margin: "0 0 14px", flex: 1 }}>
          No confirmed assignments coming up for you right now. When your coordinator publishes new offers, you'll see them in the instructor portal.
        </p>
      ) : (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
          {next.map((a) => {
            const s = a.camp_sessions;
            if (!s) return null;
            const startTxt = s.starts_on
              ? new Date(`${s.starts_on}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })
              : "";
            return (
              <div key={a.id} style={{ fontSize: 13, color: INK, lineHeight: 1.4 }}>
                <div style={{ fontWeight: 600 }}>{s.curriculum_name}</div>
                <div style={{ color: MUTED, fontSize: 12 }}>
                  Week {s.week_num} · {startTxt} · {s.location_name}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Link to={portalPath} style={{
        display: "inline-block",
        padding: "7px 14px",
        background: BRIGHT,
        color: "#fff",
        borderRadius: 6,
        fontSize: 13,
        fontWeight: 500,
        textDecoration: "none",
        alignSelf: "flex-start",
      }}>
        Open instructor view →
      </Link>
    </div>
  );
}

function ContractorPipelineCard({ pipeline, error }) {
  const completeCount = pipeline?.counts?.complete ?? 0;
  const inFlightBuckets = PIPELINE_BUCKETS
    .map((b) => ({ ...b, count: pipeline?.counts?.[b.key] ?? 0 }))
    .filter((b) => b.count > 0);
  const inFlightTotal = inFlightBuckets.reduce((sum, b) => sum + b.count, 0);

  return (
    <div style={{
      background: "#fff",
      border: `1px solid ${RULE}`,
      borderRadius: 12,
      padding: 20,
      display: "flex",
      flexDirection: "column",
      minHeight: 150,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, color: INK, margin: 0 }}>Contractor pipeline</h2>
        <span style={{ fontSize: 10, color: BRIGHT, background: `${BRIGHT}1A`, padding: "2px 8px", borderRadius: 999, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
          Live
        </span>
      </div>

      {error ? (
        <p style={{ color: MUTED, fontSize: 13, lineHeight: 1.5, margin: "0 0 14px", flex: 1 }}>
          Couldn't load pipeline status. Open Contacts to see the full list.
        </p>
      ) : pipeline === null ? (
        <p style={{ color: MUTED, fontSize: 13, lineHeight: 1.5, margin: "0 0 14px", flex: 1 }}>
          Loading…
        </p>
      ) : pipeline.total === 0 ? (
        <p style={{ color: MUTED, fontSize: 13, lineHeight: 1.5, margin: "0 0 14px", flex: 1 }}>
          No active instructors yet. Invite your first one from Contacts.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14, flex: 1 }}>
          {completeCount > 0 && (
            <div style={{
              background: `${OK_GREEN}14`,
              border: `1px solid ${OK_GREEN}40`,
              borderRadius: 6,
              padding: "8px 10px",
              fontSize: 13,
              color: INK,
              lineHeight: 1.4,
            }}>
              <strong style={{ color: OK_GREEN }}>{completeCount} cleared</strong>
              {" — ready to assign to camps."}
            </div>
          )}
          {inFlightBuckets.length > 0 ? (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {inFlightBuckets.map((b) => (
                <li key={b.key} style={{ fontSize: 13, color: INK, display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                  <span style={{ color: MUTED }}>{b.label}</span>
                  <span style={{ color: b.color, fontWeight: 600 }}>{b.count}</span>
                </li>
              ))}
            </ul>
          ) : completeCount === 0 ? (
            <p style={{ color: MUTED, fontSize: 13, lineHeight: 1.5, margin: 0 }}>
              No one in the pipeline. Send onboarding invites from Contacts.
            </p>
          ) : (
            <p style={{ color: MUTED, fontSize: 13, lineHeight: 1.5, margin: 0 }}>
              No one in flight — everyone active is cleared.
            </p>
          )}
          {inFlightTotal > 0 && (
            <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 4 }}>
              {inFlightTotal} in flight
            </div>
          )}
        </div>
      )}

      <Link to="/admin/instructors" style={{
        display: "inline-block",
        padding: "7px 14px",
        background: BRIGHT,
        color: "#fff",
        borderRadius: 6,
        fontSize: 13,
        fontWeight: 500,
        textDecoration: "none",
        alignSelf: "flex-start",
      }}>
        Open Instructors
      </Link>
    </div>
  );
}

function Card({ title, body, to, cta, ready, soon }) {
  return (
    <div style={{
      background: "#fff",
      border: `1px solid ${RULE}`,
      borderRadius: 12,
      padding: 20,
      display: "flex",
      flexDirection: "column",
      minHeight: 150,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, color: INK, margin: 0 }}>{title}</h2>
        {soon && (
          <span style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
            Coming soon
          </span>
        )}
        {ready && (
          <span style={{ fontSize: 10, color: BRIGHT, background: `${BRIGHT}1A`, padding: "2px 8px", borderRadius: 999, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
            Live
          </span>
        )}
      </div>
      <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.5, margin: "0 0 14px", flex: 1 }}>{body}</p>
      {ready && to && (
        <Link to={to} style={{
          display: "inline-block",
          padding: "7px 14px",
          background: BRIGHT,
          color: "#fff",
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 500,
          textDecoration: "none",
          alignSelf: "flex-start",
        }}>
          {cta}
        </Link>
      )}
    </div>
  );
}
