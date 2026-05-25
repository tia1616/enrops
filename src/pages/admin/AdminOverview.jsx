// src/pages/admin/AdminOverview.jsx
// Default landing for /admin. Placeholder cards for the surfaces being built.

import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase";

const PURPLE = "#1C004F";
const VIOLET = "#8C88FF";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const OK_GREEN = "#3a7c3a";
const AMBER = "#b67e00";

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

  return (
    <div>
      <header style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 30, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.5 }}>
          Welcome back{user?.email ? `, ${user.email.split("@")[0]}` : ""}.
        </h1>
        <p style={{ color: MUTED, marginTop: 6, fontSize: 15 }}>
          {org?.name ? `Operating as ${org.name}.` : "Admin overview."}
        </p>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        <ContractorPipelineCard pipeline={pipeline} error={pipelineErr} />
        <Card
          title="Marketing"
          body="Preview, schedule, and send campaigns."
          to="/admin/marketing-v2"
          cta="Open Marketing"
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
          title="Contacts"
          body="Partner organizations and parent families."
          to="/admin/contacts"
          cta="Open Contacts"
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
