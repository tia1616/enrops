// /admin/survey-settings — availability-survey builder, v1 = "toggles + intro".
//
// Lets an operator turn standard survey questions on/off per context
// (after-school / camps) and set a default intro. NOT a form builder: the
// data-derived questions (areas, subjects) keep their OPTIONS sourced from
// Programs/Curricula — the toggle only controls whether the whole question is
// asked. Scheduling-core questions (days+times / weeks) are always asked.
//
// Stored in org_survey_config (organization_id, context) as disabled_questions
// (keys turned OFF; empty = all on = default behavior) + intro. Read-only for
// staff/viewer at the RLS layer; only owner/admin can save (settings gate).
//
// Multi-tenant: every query is org-scoped; no hardcoded tenant.

import { useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const CREAM = "#FBFBFB";
const OK_GREEN = "#2f7d32";
const RED = "#a13a3a";

// Standard questions per context. `locked` questions are always asked (the
// scheduling core — without them there's no survey). `source` questions draw
// their options from another surface; we say where so operators don't try to
// add choices here.
const QUESTIONS = {
  afterschool: [
    { key: "weekday_availability", label: "Which days & times they can work", hint: "The core scheduling question.", locked: true },
    { key: "days_per_week", label: "How many days per week they want" },
    { key: "areas", label: "Which areas they want to work in", source: { label: "Programs & Partners", to: "/admin/schools" } },
    { key: "subjects", label: "What subjects they like to teach", source: { label: "Curricula (Offerings)", to: "/admin/curricula" } },
    { key: "unavailable_dates", label: "Specific dates they can't work" },
    { key: "notes", label: "Anything else (free-text note)" },
  ],
  camp: [
    { key: "weeks", label: "Which weeks they can work", hint: "The core scheduling question.", locked: true },
    { key: "session_types", label: "Times of day (morning / afternoon / full day)", locked: true },
    { key: "areas", label: "Which areas they want to work in", source: { label: "Programs & Partners", to: "/admin/schools" } },
    { key: "subjects", label: "What subjects they like to teach", source: { label: "Curricula (Offerings)", to: "/admin/curricula" } },
    { key: "role", label: "Lead or developing role preference" },
    { key: "saturdays", label: "Saturday availability" },
    { key: "unavailable_dates", label: "Specific dates they can't work" },
    { key: "notes", label: "Anything else (free-text note)" },
  ],
};

const CONTEXTS = [
  { key: "afterschool", label: "After-school", blurb: "Weekly term classes (e.g. Fall, Winter, Spring)." },
  { key: "camp", label: "Camps", blurb: "Summer camp cycles." },
];

export default function SurveySettings() {
  const { org, orgMember } = useOutletContext() ?? {};
  // config[context] = { disabled: Set<string>, intro: string }
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savingCtx, setSavingCtx] = useState(null);
  const [toast, setToast] = useState(null);

  // Owner/admin can save; everyone else sees a read-only view.
  const canEdit = useMemo(() => ["owner", "admin"].includes(orgMember?.role), [orgMember]);

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("org_survey_config")
        .select("context, disabled_questions, intro")
        .eq("organization_id", org.id);
      if (cancelled) return;
      if (error) setToast({ kind: "error", message: `Couldn't load survey settings: ${error.message}` });
      const next = {};
      for (const ctx of CONTEXTS) {
        const row = (data ?? []).find((r) => r.context === ctx.key);
        next[ctx.key] = {
          disabled: new Set(Array.isArray(row?.disabled_questions) ? row.disabled_questions : []),
          intro: row?.intro ?? "",
        };
      }
      setConfig(next);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  function toggle(ctxKey, qKey) {
    setConfig((prev) => {
      const cur = prev[ctxKey];
      const disabled = new Set(cur.disabled);
      if (disabled.has(qKey)) disabled.delete(qKey);
      else disabled.add(qKey);
      return { ...prev, [ctxKey]: { ...cur, disabled } };
    });
  }

  function setIntro(ctxKey, value) {
    setConfig((prev) => ({ ...prev, [ctxKey]: { ...prev[ctxKey], intro: value } }));
  }

  async function save(ctxKey) {
    if (!org?.id || !canEdit) return;
    setSavingCtx(ctxKey);
    setToast(null);
    try {
      const cur = config[ctxKey];
      const { error } = await supabase
        .from("org_survey_config")
        .upsert(
          {
            organization_id: org.id,
            context: ctxKey,
            disabled_questions: [...cur.disabled],
            intro: cur.intro.trim() || null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "organization_id,context" },
        );
      if (error) throw error;
      setToast({ kind: "success", message: `${CONTEXTS.find((c) => c.key === ctxKey).label} survey settings saved.` });
    } catch (e) {
      setToast({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSavingCtx(null);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        <Link to="/admin/settings" style={{ fontSize: 13, color: BRIGHT, textDecoration: "none" }}>← Settings</Link>
      </div>
      <h1 style={{ margin: 0, color: PURPLE, fontSize: 26, fontWeight: 700 }}>Availability survey</h1>
      <p style={{ color: MUTED, fontSize: 14, margin: "6px 0 22px", lineHeight: 1.5, maxWidth: 620 }}>
        Choose which questions your availability survey asks and set a default intro. Turn off anything you don't need.
        The scheduling questions are always asked. Answer options for areas and subjects come from your Programs and
        Curricula — manage those there.
      </p>

      {toast && (
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
          padding: "10px 14px", borderRadius: 8, marginBottom: 18, fontSize: 13,
          background: toast.kind === "success" ? "#f0f8f0" : "#fff5f5",
          border: `1px solid ${toast.kind === "success" ? "#bfd9bf" : "#f0c4c4"}`,
          color: toast.kind === "success" ? OK_GREEN : RED,
        }}>
          <span>{toast.message}</span>
          <button type="button" onClick={() => setToast(null)} style={{ border: "none", background: "none", cursor: "pointer", fontSize: 18, color: "inherit", lineHeight: 1 }}>×</button>
        </div>
      )}

      {!canEdit && !loading && (
        <div style={{ fontSize: 13, color: MUTED, background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, padding: "10px 14px", marginBottom: 18 }}>
          You're viewing these settings. Only an owner or admin can change them.
        </div>
      )}

      {loading || !config ? (
        <div style={{ color: MUTED, fontSize: 14 }}>Loading…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
          {CONTEXTS.map((ctx) => (
            <ContextPanel
              key={ctx.key}
              ctx={ctx}
              state={config[ctx.key]}
              canEdit={canEdit}
              saving={savingCtx === ctx.key}
              onToggle={(qKey) => toggle(ctx.key, qKey)}
              onIntro={(v) => setIntro(ctx.key, v)}
              onSave={() => save(ctx.key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ContextPanel({ ctx, state, canEdit, saving, onToggle, onIntro, onSave }) {
  const questions = QUESTIONS[ctx.key];
  return (
    <section style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: "20px 22px" }}>
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: INK }}>{ctx.label} survey</h2>
        <p style={{ margin: "3px 0 0", fontSize: 13, color: MUTED }}>{ctx.blurb}</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        {questions.map((q, i) => {
          const on = !state.disabled.has(q.key);
          return (
            <div
              key={q.key}
              style={{
                display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16,
                padding: "12px 0", borderTop: i === 0 ? "none" : `1px solid ${RULE}`,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>{q.label}</div>
                {q.locked && (
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                    {q.hint || "Always asked."} <span style={{ color: MUTED }}>· always asked</span>
                  </div>
                )}
                {q.source && (
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                    Options come from your{" "}
                    <Link to={q.source.to} style={{ color: BRIGHT, textDecoration: "none" }}>{q.source.label}</Link>
                    {" "}— manage them there.
                  </div>
                )}
              </div>
              <Toggle on={q.locked ? true : on} locked={q.locked || !canEdit} onClick={() => onToggle(q.key)} />
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 16 }}>
        <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 }}>
          Default intro <span style={{ fontWeight: 400, color: MUTED }}>(optional — shown at the top of the survey; you can still edit it when you send)</span>
        </label>
        <textarea
          value={state.intro}
          onChange={(e) => onIntro(e.target.value)}
          disabled={!canEdit}
          rows={3}
          placeholder="e.g. We're planning next term's schedule — let us know when and where you'd like to work."
          style={{
            width: "100%", boxSizing: "border-box", fontFamily: "inherit", fontSize: 14, color: INK,
            border: `1px solid ${RULE}`, borderRadius: 8, padding: "10px 12px", resize: "vertical",
            background: canEdit ? "#fff" : CREAM,
          }}
        />
      </div>

      {canEdit && (
        <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            style={{
              padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8,
              fontSize: 14, fontWeight: 600, cursor: saving ? "default" : "pointer", fontFamily: "inherit",
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? "Saving…" : `Save ${ctx.label} settings`}
          </button>
        </div>
      )}
    </section>
  );
}

function Toggle({ on, locked, onClick }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={locked}
      onClick={locked ? undefined : onClick}
      title={locked ? "Always asked" : (on ? "On — click to turn off" : "Off — click to turn on")}
      style={{
        flexShrink: 0, width: 44, height: 26, borderRadius: 999, border: "none",
        position: "relative", cursor: locked ? "default" : "pointer",
        background: on ? BRIGHT : "#cfcbc0", opacity: locked ? 0.55 : 1,
        transition: "background 120ms", padding: 0,
      }}
    >
      <span style={{
        position: "absolute", top: 3, left: on ? 21 : 3, width: 20, height: 20, borderRadius: "50%",
        background: "#fff", transition: "left 120ms", boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
      }} />
    </button>
  );
}
