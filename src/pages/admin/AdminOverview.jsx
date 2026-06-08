// src/pages/admin/AdminOverview.jsx
// Default landing for /admin. Placeholder cards for the surfaces being built.

import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { defaultTenantSlug } from "../../lib/tenants.js";

const PURPLE = "#1C004F";
const VIOLET = "#8C88FF";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const OK_GREEN = "#3a7c3a";
const AMBER = "#b67e00";
const CORAL = "#D9694F"; // matches the "Needs hire" badge on the schedule board

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

  return (
    <div>
      <header style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 30, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.5 }}>
          Welcome back{displayName ? `, ${displayName}` : ""}.
        </h1>
        <p style={{ color: MUTED, marginTop: 6, fontSize: 15 }}>
          {org?.name ? `Operating as ${org.name}.` : "Admin overview."}
        </p>
      </header>

      {openHires?.total > 0 && <OpenHiresBanner openHires={openHires} />}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        {/* Renders only when this admin is also in the instructors table.
            Many enrichment operators teach classes themselves — they need
            their own teaching schedule visible from the admin home. */}
        {teaching && <TeachingScheduleCard teaching={teaching} />}
        <ContractorPipelineCard pipeline={pipeline} error={pipelineErr} />
        <Card
          title="Family Comms"
          body="Preview, schedule, and send campaigns."
          to="/admin/family-comms/marketing"
          cta="Open Family Comms"
          ready
        />
        <Card
          title="Instructors"
          body="Your contractors. Send onboarding invites, upload prior background checks, view their schedules and statuses."
          to="/admin/instructors"
          cta="Open Instructors"
          ready
        />
        <Card
          title="Schools & partners"
          body="Schools, districts, community orgs, and the contacts at each."
          to="/admin/schools?tab=partners"
          cta="Open Schools & partners"
          ready
        />
        <Card
          title="Schedule"
          body="Assign instructors to camps and afterschool classes. Manage offers, archive past cycles."
          to="/admin/schedule"
          cta="Open Schedule"
          ready
        />
        <Card
          title="Programs"
          body="Curricula, scheduled programs, locations."
          to="/admin/curricula"
          cta="Open Programs"
          ready
        />
        <Card
          title="Settings"
          body="Org branding, sending domain, payout setup, members & roles."
          soon
        />
      </div>
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
      borderRadius: 8,
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

function TeachingScheduleCard({ teaching }) {
  // teaching = { instructorId, assignments: [...] }. Both upcoming-empty
  // and upcoming-some states render — the CTA is the same either way.
  const next = teaching.assignments ?? [];
  const slug = defaultTenantSlug() ?? "j2s";
  const portalPath = `/${slug}/instructor`;

  return (
    <div style={{
      background: "#fff",
      border: `1px solid ${RULE}`,
      borderLeft: `3px solid ${VIOLET}`,
      borderRadius: 8,
      padding: 20,
      display: "flex",
      flexDirection: "column",
      minHeight: 150,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, color: INK, margin: 0 }}>Your teaching schedule</h2>
        <span style={{ fontSize: 10, color: PURPLE, background: `${VIOLET}33`, padding: "2px 8px", borderRadius: 999, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
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
        background: PURPLE,
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
      borderRadius: 8,
      padding: 20,
      display: "flex",
      flexDirection: "column",
      minHeight: 150,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, color: INK, margin: 0 }}>Contractor pipeline</h2>
        <span style={{ fontSize: 10, color: PURPLE, background: `${VIOLET}33`, padding: "2px 8px", borderRadius: 999, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
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
        background: PURPLE,
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
      borderRadius: 8,
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
          <span style={{ fontSize: 10, color: PURPLE, background: `${VIOLET}33`, padding: "2px 8px", borderRadius: 999, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
            Live
          </span>
        )}
      </div>
      <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.5, margin: "0 0 14px", flex: 1 }}>{body}</p>
      {ready && to && (
        <Link to={to} style={{
          display: "inline-block",
          padding: "7px 14px",
          background: PURPLE,
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
