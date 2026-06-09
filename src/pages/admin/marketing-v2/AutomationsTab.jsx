// AutomationsTab — lifecycle automations dashboard.
//
// Lists every automation_templates row joined with the org's optional
// `automations` override row. Operator can toggle on/off, see last-fired +
// time-saved stats, and click into the body editor (step 5 — drawer not
// yet built; button is a no-op placeholder for now).
//
// Honest copy rules:
//   - No "parent portal" mention until the portal ships (data trail exists
//     via push_to_parent_portal flag, UI just doesn't surface it yet).
//   - No alert()/confirm() — inline status text.
//   - "Last fired" pill reads from automation_runs.fired_at (artifact column
//     rule), not a derived computed status.
//   - thank_you gating: "Active" only when Stripe Connect is enabled for the
//     org (operator must run registration through Enrops). Otherwise locked
//     with a helpful pointer to Stripe setup.

import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import { PURPLE, INK, MUTED, RULE, OK, INFO, WARN } from "../marketing/tokens.jsx";
import FamilyCommsTabs from "./FamilyCommsTabs.jsx";
import AutomationEditor from "./AutomationEditor.jsx";

// Templates that require Stripe Connect to fire — UI locks the toggle until
// the org connects. Kept here (not in DB) for v1 — a `requires_stripe_connect`
// column on automation_templates would be cleaner but premature now.
const STRIPE_DEPENDENT_KEYS = new Set(["thank_you", "abandoned_registration"]);

export default function AutomationsTab() {
  const { user, org } = useOutletContext();
  const [editingTpl, setEditingTpl] = useState(null);
  const [orgLogoUrl, setOrgLogoUrl] = useState(null);
  const [orgSenderName, setOrgSenderName] = useState(null);
  const [orgPrimaryColor, setOrgPrimaryColor] = useState(null);
  // Templates currently celebrating — when an operator flips off → on, the
  // row plays a brief "🎉 Live!" chip that pops in, stays visible, then
  // fades. Cleared by a timeout so the celebration doesn't linger forever.
  const [celebratingId, setCelebratingId] = useState(null);

  const [templates, setTemplates] = useState([]);
  const [automationByTpl, setAutomationByTpl] = useState({});
  const [runStats, setRunStats] = useState({});
  const [stripeReady, setStripeReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savingTplId, setSavingTplId] = useState(null);

  useEffect(() => {
    if (org?.id) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [tplRes, autoRes, runsRes, orgRes, brandingRes] = await Promise.all([
        supabase.from("automation_templates").select("*").order("sort_order"),
        supabase.from("automations").select("*").eq("organization_id", org.id),
        supabase
          .from("automation_runs")
          .select("automation_id, fired_at, audience_size, time_saved_minutes, status")
          .eq("organization_id", org.id)
          .eq("status", "sent")
          .order("fired_at", { ascending: false }),
        supabase
          .from("organizations")
          .select("stripe_account_status, logo_email_url, default_sender_name")
          .eq("id", org.id)
          .maybeSingle(),
        supabase
          .from("org_branding")
          .select("primary_color")
          .eq("organization_id", org.id)
          .maybeSingle(),
      ]);
      if (tplRes.error) throw tplRes.error;
      if (autoRes.error) throw autoRes.error;
      if (runsRes.error) throw runsRes.error;
      if (orgRes.error) throw orgRes.error;

      setTemplates(tplRes.data ?? []);

      const aMap = {};
      (autoRes.data ?? []).forEach((a) => { aMap[a.template_id] = a; });
      setAutomationByTpl(aMap);

      const stats = {};
      (runsRes.data ?? []).forEach((r) => {
        if (!stats[r.automation_id]) {
          stats[r.automation_id] = {
            last_fired: r.fired_at,
            total_runs: 0,
            total_sent: 0,
            total_time_saved: 0,
          };
        }
        stats[r.automation_id].total_runs += 1;
        stats[r.automation_id].total_sent += r.audience_size || 0;
        stats[r.automation_id].total_time_saved += r.time_saved_minutes || 0;
      });
      setRunStats(stats);

      // 'active' is the only stripe_account_status that means payments flow.
      // (The CHECK constraint permits not_connected/onboarding/active/
      // disconnected/restricted — there is no 'enabled' value, so the old
      // `=== "enabled"` branch was always dead.)
      const status = orgRes.data?.stripe_account_status;
      setStripeReady(status === "active");
      setOrgLogoUrl(orgRes.data?.logo_email_url ?? null);
      setOrgSenderName(orgRes.data?.default_sender_name ?? null);
      // Fall back to the Enrops default purple when an org hasn't set a
      // branding row yet — matches the loadOrgBrand cascade in the cron.
      setOrgPrimaryColor(brandingRes.data?.primary_color ?? "#1C004F");
    } catch (e) {
      setError(e?.message ?? "Failed to load automations");
    } finally {
      setLoading(false);
    }
  }

  async function toggleAutomation(tpl) {
    if (!tpl.is_v1_enabled) return;
    if (STRIPE_DEPENDENT_KEYS.has(tpl.key) && !stripeReady) return;
    setSavingTplId(tpl.id);
    setError(null);
    const existing = automationByTpl[tpl.id];
    const wasEnabled = !!existing?.enabled;
    try {
      if (existing) {
        const { error: upErr } = await supabase
          .from("automations")
          .update({ enabled: !existing.enabled })
          .eq("id", existing.id);
        if (upErr) throw upErr;
        setAutomationByTpl((prev) => ({
          ...prev,
          [tpl.id]: { ...existing, enabled: !existing.enabled },
        }));
      } else {
        const { data, error: insErr } = await supabase
          .from("automations")
          .insert({ organization_id: org.id, template_id: tpl.id, enabled: true })
          .select()
          .single();
        if (insErr) throw insErr;
        setAutomationByTpl((prev) => ({ ...prev, [tpl.id]: data }));
      }
      // Off → On transition: kick off the celebration. Already-on or just-
      // toggled-off transitions don't celebrate (would feel sarcastic on an
      // off toggle and overwhelming when re-flipping a working automation).
      if (!wasEnabled) {
        setCelebratingId(tpl.id);
        setTimeout(() => setCelebratingId((cur) => (cur === tpl.id ? null : cur)), 3500);
      }
    } catch (e) {
      setError(e?.message ?? "Couldn't update — try again");
    } finally {
      setSavingTplId(null);
    }
  }

  if (loading) {
    return (
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 32px" }}>
        <FamilyCommsTabs active="automations" />
        <div style={{ color: MUTED, padding: 24 }}>Loading automations…</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 32px" }}>
      {/* Celebration animation keyframes — used on the row chip when an
          operator flips an automation from Off → On. Defined here once
          rather than per-Chip so React reconciler keeps the animation
          fresh across re-renders. */}
      <style>{`
        @keyframes automation-celebrate-in {
          0%   { opacity: 0; transform: translateY(-4px) scale(0.85); }
          40%  { opacity: 1; transform: translateY(0) scale(1.1); }
          70%  { opacity: 1; transform: scale(1); }
          100% { opacity: 0; transform: translateY(-2px) scale(0.95); }
        }
        @keyframes automation-confetti-float {
          0%   { opacity: 0; transform: translate(var(--cx, 0), 0) rotate(0deg) scale(0.6); }
          15%  { opacity: 1; }
          80%  { opacity: 1; }
          100% { opacity: 0; transform: translate(var(--cx, 0), -36px) rotate(var(--cr, 80deg)) scale(1); }
        }
      `}</style>
      <FamilyCommsTabs active="automations" />

      <header style={{ marginBottom: 28 }}>
        <h1 style={{ color: INK, fontSize: 26, fontWeight: 800, margin: "0 0 8px" }}>
          Automations
        </h1>
        <p style={{ color: MUTED, fontSize: 15, lineHeight: 1.55, margin: "0 0 10px" }}>
          Stay close to families between sessions. Enrops sends the messages
          automatically so you don&apos;t have to, saving hours of manual work.
          Every touch builds Lifetime Value (<strong>LTV</strong> — the total
          revenue from a family across every program their kids take with you).
        </p>
        <p style={{ color: MUTED, fontSize: 13, lineHeight: 1.55, margin: 0, fontStyle: "italic" }}>
          These reach every parent of a registered student, even if they
          unsubscribed from marketing. They&apos;re service updates, not sales.
        </p>
      </header>

      {error && (
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: `1px solid ${WARN}`,
            color: "#7c2d12",
            padding: "10px 14px",
            borderRadius: 8,
            marginBottom: 16,
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {templates.map((tpl) => {
          const auto = automationByTpl[tpl.id];
          const stats = auto ? runStats[auto.id] : null;
          const locked = STRIPE_DEPENDENT_KEYS.has(tpl.key) && !stripeReady;
          const disabledTemplate = !tpl.is_v1_enabled;
          const enabled = !!auto?.enabled;
          const isSaving = savingTplId === tpl.id;

          return (
            <li
              key={tpl.id}
              style={{
                border: `1px solid ${RULE}`,
                borderRadius: 12,
                padding: 20,
                marginBottom: 14,
                background: "#fff",
                opacity: disabledTemplate ? 0.65 : 1,
                position: "relative",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                    <h2 style={{ color: INK, fontSize: 17, fontWeight: 700, margin: 0 }}>
                      {tpl.display_name}
                    </h2>
                    <StatusPill
                      locked={locked}
                      disabledTemplate={disabledTemplate}
                      enabled={enabled}
                    />
                    <Chip color={INFO} bg="#eef4fc">
                      {tpl.applies_to_program_type === "camps"
                        ? "Camps only"
                        : tpl.applies_to_program_type === "afterschool"
                          ? "After-school only"
                          : "Camps + after-school"}
                    </Chip>
                  </div>
                  <p style={{ color: MUTED, fontSize: 14, margin: "4px 0 10px", lineHeight: 1.5 }}>
                    {tpl.description}
                  </p>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
                    {stats?.last_fired && (
                      <Chip color={MUTED} bg="#f5f4ee">
                        Last sent {relativeTime(stats.last_fired)}
                      </Chip>
                    )}
                    {stats?.total_sent > 0 && (
                      <Chip color={OK} bg="#ecf6ec">
                        ⏱ {formatTimeSaved(stats.total_time_saved)}
                        {" · "}
                        {stats.total_sent} {stats.total_sent === 1 ? "send" : "sends"}
                      </Chip>
                    )}
                    {locked && (
                      <Link
                        to="/admin/finances"
                        style={{
                          display: "inline-block",
                          background: "#fef5e6",
                          color: WARN,
                          padding: "3px 10px",
                          borderRadius: 999,
                          fontSize: 12,
                          fontWeight: 600,
                          lineHeight: 1.4,
                          textDecoration: "none",
                        }}
                      >
                        Connect Stripe to unlock →
                      </Link>
                    )}
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, flexShrink: 0 }}>
                  <Toggle
                    checked={enabled}
                    onClick={() => toggleAutomation(tpl)}
                    disabled={locked || disabledTemplate || isSaving}
                    title={
                      locked
                        ? "Available when Stripe Connect is set up for registrations"
                        : disabledTemplate
                          ? "Coming soon"
                          : enabled
                            ? "Turn off"
                            : "Turn on"
                    }
                  />
                  <button
                    type="button"
                    disabled={disabledTemplate || locked}
                    onClick={() => setEditingTpl((prev) => (prev?.id === tpl.id ? null : tpl))}
                    style={{
                      background: editingTpl?.id === tpl.id ? PURPLE : "transparent",
                      border: `1px solid ${editingTpl?.id === tpl.id ? PURPLE : RULE}`,
                      color: editingTpl?.id === tpl.id ? "#fff" : INK,
                      padding: "6px 12px",
                      borderRadius: 8,
                      fontSize: 13,
                      cursor: disabledTemplate || locked ? "not-allowed" : "pointer",
                      opacity: disabledTemplate || locked ? 0.5 : 1,
                    }}
                  >
                    {editingTpl?.id === tpl.id ? "Close" : "Edit"}
                  </button>
                </div>
              </div>

              {celebratingId === tpl.id && (
                <CelebrationOverlay templateName={tpl.display_name} />
              )}

              {editingTpl?.id === tpl.id && (
                <AutomationEditor
                  template={tpl}
                  automation={automationByTpl[tpl.id] ?? null}
                  orgId={org.id}
                  orgName={org.name}
                  orgSlug={org.slug}
                  orgLogoUrl={orgLogoUrl}
                  orgSenderName={orgSenderName}
                  orgPrimaryColor={orgPrimaryColor}
                  userEmail={user?.email || ""}
                  onClose={() => setEditingTpl(null)}
                  onSaved={(row) => {
                    setAutomationByTpl((prev) => ({ ...prev, [tpl.id]: row }));
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Brief celebratory overlay rendered inside a row's `<li>` when the operator
// flips an automation Off → On. Auto-removes after 3.5s via the parent's
// setTimeout. Three floating confetti emojis drift up while the central
// "🎉 Live!" chip pops + holds + fades.
function CelebrationOverlay({ templateName }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span style={{ position: "relative", display: "inline-block", width: 0, height: 0 }}>
        <span style={{ position: "absolute", left: -14, top: 10, fontSize: 16, animation: "automation-confetti-float 1.6s ease-out 0.05s both", ["--cx"]: "-14px", ["--cr"]: "-60deg" }}>✨</span>
        <span style={{ position: "absolute", left: 0,   top: 8,  fontSize: 18, animation: "automation-confetti-float 1.8s ease-out 0.15s both", ["--cx"]: "2px",   ["--cr"]: "20deg" }}>🎊</span>
        <span style={{ position: "absolute", left: 14,  top: 12, fontSize: 16, animation: "automation-confetti-float 1.7s ease-out 0.10s both", ["--cx"]: "10px",  ["--cr"]: "55deg" }}>✨</span>
      </span>
      <span
        style={{
          background: "#ecf6ec",
          color: OK,
          padding: "4px 12px",
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 700,
          boxShadow: "0 2px 8px rgba(78, 145, 78, 0.25)",
          animation: "automation-celebrate-in 3.5s ease-out both",
        }}
      >
        🎉 {templateName} is live!
      </span>
    </div>
  );
}

function StatusPill({ locked, disabledTemplate, enabled }) {
  if (disabledTemplate) {
    return <Chip color={MUTED} bg="#f5f4ee">Coming soon</Chip>;
  }
  if (locked) {
    return <Chip color={WARN} bg="#fef5e6">Locked</Chip>;
  }
  return enabled
    ? <Chip color={OK} bg="#ecf6ec">Active</Chip>
    : <Chip color={MUTED} bg="#f5f4ee">Off</Chip>;
}

function Chip({ color, bg, children }) {
  return (
    <span
      style={{
        display: "inline-block",
        background: bg,
        color,
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.4,
      }}
    >
      {children}
    </span>
  );
}

function Toggle({ checked, onClick, disabled, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={checked}
      style={{
        position: "relative",
        width: 44,
        height: 24,
        borderRadius: 999,
        border: "none",
        background: checked ? PURPLE : "#d6d3c8",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 150ms",
        padding: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 22 : 2,
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "#fff",
          transition: "left 150ms",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
        }}
      />
    </button>
  );
}

// "Saved you N+ hours" framing per project_enrops_time_saved memory.
// At small accumulations (under 1 hour), drop to "Saved you N+ min" so the
// pill stays honest — "0+ hours" reads broken until enough sends pile up.
function formatTimeSaved(totalMinutes) {
  const m = Math.floor(totalMinutes ?? 0);
  if (m >= 60) {
    const hours = Math.floor(m / 60);
    return `Saved you ${hours}+ hour${hours === 1 ? "" : "s"}`;
  }
  return `Saved you ${m}+ min`;
}

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} ${diffHr === 1 ? "hour" : "hours"} ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay} ${diffDay === 1 ? "day" : "days"} ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
