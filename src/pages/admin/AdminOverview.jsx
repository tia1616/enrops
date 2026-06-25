// src/pages/admin/AdminOverview.jsx
// Default landing for /admin. Placeholder cards for the surfaces being built.

import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { defaultTenantSlug } from "../../lib/tenants.js";
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
        <WeekPlaceholder />
      ) : (
        <>
          <WinsStrip wins={wins} />

          {openHires?.total > 0 && <OpenHiresBanner openHires={openHires} />}

          <TodayAgenda org={org} />

          <TermChecklist org={org} />

          {/* Existing live cards — absorbed into wins / agenda / to-dos in later build steps. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
            {teaching && <TeachingScheduleCard teaching={teaching} orgSlug={org?.slug} />}
            <ContractorPipelineCard pipeline={pipeline} error={pipelineErr} />
            <Card title="Family Comms" body="Preview, schedule, and send campaigns." to="/admin/family-comms/marketing" cta="Open Family Comms" ready />
            <Card title="Instructors" body="Your contractors. Send onboarding invites, upload prior background checks, view their schedules and statuses." to="/admin/instructors" cta="Open Instructors" ready />
            <Card title="Schools & partners" body="Schools, districts, community orgs, and the contacts at each." to="/admin/schools?tab=partners" cta="Open Schools & partners" ready />
            <Card title="Schedule" body="Assign instructors to camps and afterschool classes. Manage offers, archive past cycles." to="/admin/schedule" cta="Open Schedule" ready />
            <Card title="Programs" body="Curricula, scheduled programs, locations." to="/admin/curricula" cta="Open Programs" ready />
            <Card title="Settings" body="Org branding, sending domain, payout setup, members & roles." soon />
          </div>
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
      <Ennie state={ennieState} size={60} onComplete={() => setEnnieState("idle")} />
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
    </div>
  );
}

// Week/Month calendar grids land in a later build step; placeholder keeps the
// toggle honest until then.
function WeekPlaceholder() {
  return (
    <div style={{
      background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12,
      padding: 28, textAlign: "center", color: MUTED, fontSize: 14,
    }}>
      This week's calendar is coming in the next build step.
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
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, color: INK, margin: 0 }}>Your term</h2>
        <span style={{ fontSize: 12, color: MUTED }}>{state.term.label}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {state.items.map((it) => {
          const overdue = it.due && !it.done && it.due.toISOString().slice(0, 10) < today;
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
};

function WinsStrip({ wins }) {
  if (!Array.isArray(wins) || wins.length === 0) return null;
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>wins</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
        {wins.slice(0, 3).map((w, idx) => {
          const cfg = WIN_STYLE[w.win_type];
          if (!cfg) return null;
          const { headline, detail } = cfg.build(w);
          return (
            <div key={idx} style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 14 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: cfg.accent, marginBottom: 8 }} />
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
// location, instructor. Camps now; afterschool (via derive_program_session_dates)
// is step 4b. Single accent only where a session needs cover.
function fmtTime(t) {
  if (!t) return "";
  const [h, m] = String(t).split(":");
  let hh = parseInt(h, 10);
  if (Number.isNaN(hh)) return "";
  const ap = hh >= 12 ? "PM" : "AM";
  hh = hh % 12 || 12;
  return `${hh}:${m} ${ap}`;
}

function TodayAgenda({ org }) {
  const [rows, setRows] = useState(null); // null = loading; [] = nothing today

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        // Camps are week-long sessions; "running today" = today within [starts_on, ends_on].
        const { data: sessions, error: sErr } = await supabase
          .from("camp_sessions")
          .select("id, location_name, curriculum_name, start_time, end_time")
          .eq("organization_id", org.id)
          .lte("starts_on", today)
          .gte("ends_on", today)
          .order("start_time", { ascending: true });
        if (sErr) throw sErr;

        const ids = (sessions ?? []).map((s) => s.id);
        const leadByCamp = new Map();
        if (ids.length) {
          const { data: assigns } = await supabase
            .from("camp_assignments")
            .select("camp_session_id, status, instructors(first_name, preferred_name, last_name)")
            .in("camp_session_id", ids)
            .eq("role", "lead");
          for (const a of assigns ?? []) {
            if (a.status === "withdrawn" || a.status === "declined") continue;
            const i = a.instructors;
            if (!i) continue;
            const name = `${i.preferred_name || i.first_name || ""}${i.last_name ? ` ${i.last_name}` : ""}`.trim();
            if (name) leadByCamp.set(a.camp_session_id, name);
          }
        }

        const built = (sessions ?? []).map((s) => ({
          id: s.id,
          title: s.curriculum_name,
          location: s.location_name,
          start: s.start_time,
          end: s.end_time,
          instructor: leadByCamp.get(s.id) || null,
        }));
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
                {fmtTime(r.start)}<br />{fmtTime(r.end)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>{r.title}</div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                  {r.location}{r.instructor ? ` · ${r.instructor}` : ""}
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

function OpenHiresBanner({ openHires }) {
  const { camp, afterschool, total } = openHires;
  // Plain-English breakdown, only naming the sources that actually have openings.
  const parts = [];
  if (camp > 0) parts.push(`${camp} camp ${camp === 1 ? "slot" : "slots"}`);
  if (afterschool > 0) parts.push(`${afterschool} after-school ${afterschool === 1 ? "class" : "classes"}`);
  const breakdown = parts.join(" and ");

  return (
    <div style={{
      background: `${CORAL}12`,
      border: `1px solid ${CORAL}55`,
      borderLeft: `4px solid ${CORAL}`,
      borderRadius: 12,
      padding: "14px 18px",
      marginBottom: 20,
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: INK }}>
          {total === 1 ? "1 open hire needs your attention" : `${total} open hires need your attention`}
        </div>
        <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>
          {breakdown} still {total === 1 ? "needs" : "need"} an instructor. Assign someone or send offers from the schedule.
        </div>
      </div>
      <Link to="/admin/schedule" style={{
        flexShrink: 0,
        display: "inline-block",
        padding: "8px 16px",
        background: CORAL,
        color: "#fff",
        borderRadius: 6,
        fontSize: 13,
        fontWeight: 600,
        textDecoration: "none",
      }}>
        Review open hires →
      </Link>
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
