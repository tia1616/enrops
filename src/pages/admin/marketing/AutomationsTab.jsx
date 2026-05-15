// src/pages/admin/marketing/AutomationsTab.jsx
// Lists the 6 starter automations with toggle on/off + edit template.

import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase.js";
import { INK, MUTED, RULE, PLUM, INFO, WARN, OK, Card, Pill, btn, input as inputStyle } from "./tokens.jsx";

export default function AutomationsTab({ org }) {
  const [automations, setAutomations] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // automation id being edited
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editTiming, setEditTiming] = useState({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      // Load system templates
      const { data: tpls } = await supabase
        .from("marketing_automation_templates")
        .select("*")
        .order("sort_order");
      setTemplates(tpls ?? []);

      // Load org automations (may not exist yet — seed on first load)
      let { data: autos } = await supabase
        .from("marketing_automations")
        .select("*");

      if (!autos || autos.length === 0) {
        // Seed automations for this org from templates
        if (tpls && tpls.length > 0 && org?.id) {
          const seeds = tpls.map(t => ({
            organization_id: org.id,
            template_id: t.id,
            enabled: true,
            timing_config: t.default_timing,
          }));
          const { data: inserted } = await supabase
            .from("marketing_automations")
            .insert(seeds)
            .select("*");
          autos = inserted ?? [];
        }
      }

      setAutomations(autos ?? []);
    } catch (e) {
      console.error("Automations load error:", e);
    } finally {
      setLoading(false);
    }
  }

  function templateFor(auto) {
    return templates.find(t => t.id === auto.template_id);
  }

  function triggerLabel(tpl) {
    if (!tpl) return "";
    switch (tpl.trigger_type) {
      case "registration_complete": return "When a parent registers";
      case "days_before_start": {
        const days = tpl.default_timing?.days_before ?? 7;
        return `${days} days before class starts`;
      }
      case "days_after_start": {
        const days = tpl.default_timing?.days_after ?? 14;
        return `${days} days after class starts`;
      }
      case "session_halfway": return "Halfway through the term";
      case "session_complete": return "On the last day of class";
      case "student_birthday": return "On a student's birthday";
      default: return tpl.trigger_type;
    }
  }

  async function toggleEnabled(auto) {
    const newVal = !auto.enabled;
    const { error } = await supabase
      .from("marketing_automations")
      .update({ enabled: newVal, updated_at: new Date().toISOString() })
      .eq("id", auto.id);
    if (!error) {
      setAutomations(prev => prev.map(a => a.id === auto.id ? { ...a, enabled: newVal } : a));
    }
  }

  function startEdit(auto) {
    const tpl = templateFor(auto);
    setEditing(auto.id);
    setEditSubject(auto.subject_override ?? tpl?.default_subject ?? "");
    setEditBody(auto.body_override ?? tpl?.default_body ?? "");
    setEditTiming(auto.timing_config ?? tpl?.default_timing ?? {});
    setMsg("");
  }

  async function saveEdit(autoId) {
    setSaving(true);
    const { error } = await supabase
      .from("marketing_automations")
      .update({
        subject_override: editSubject || null,
        body_override: editBody || null,
        timing_config: editTiming,
        updated_at: new Date().toISOString(),
      })
      .eq("id", autoId);
    setSaving(false);
    if (error) {
      setMsg("Save error: " + error.message);
    } else {
      setMsg("Saved!");
      setAutomations(prev => prev.map(a => a.id === autoId ? {
        ...a, subject_override: editSubject || null, body_override: editBody || null, timing_config: editTiming,
      } : a));
      setTimeout(() => { setEditing(null); setMsg(""); }, 800);
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 4px", letterSpacing: -0.3, color: INK }}>
        Automations
      </h1>
      <p style={{ fontSize: 13, color: MUTED, margin: "0 0 14px" }}>
        Set-and-forget triggers. Each one fires automatically when an event happens. Edit the template once, it runs forever.
      </p>

      {loading && <p style={{ color: MUTED, fontSize: 14 }}>Loading automations…</p>}

      {!loading && (
        <Card style={{ padding: 0, marginTop: 12 }}>
          {/* Header */}
          <div style={{
            display: "grid", gridTemplateColumns: "2fr 2.2fr 0.8fr 1fr 0.5fr",
            padding: "10px 14px", borderBottom: `1px solid ${RULE}`,
            fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, fontWeight: 600,
          }}>
            <span>Automation</span>
            <span>Trigger</span>
            <span>Status</span>
            <span>Last 30 days</span>
            <span></span>
          </div>

          {automations.map(auto => {
            const tpl = templateFor(auto);
            return (
              <div key={auto.id}>
                <div style={{
                  display: "grid", gridTemplateColumns: "2fr 2.2fr 0.8fr 1fr 0.5fr",
                  padding: "12px 14px", borderBottom: `1px solid ${RULE}`,
                  fontSize: 12, alignItems: "center",
                }}>
                  <span style={{ fontWeight: 600 }}>{tpl?.name ?? "—"}</span>
                  <span style={{ color: MUTED }}>{triggerLabel(tpl)}</span>
                  <span>
                    <span
                      onClick={() => toggleEnabled(auto)}
                      style={{
                        display: "inline-block", width: 30, height: 16,
                        background: auto.enabled ? "#639922" : "#d1cfc6",
                        borderRadius: 999, position: "relative", cursor: "pointer",
                        transition: "background 0.15s",
                      }}
                    >
                      <span style={{
                        position: "absolute", top: 2, width: 12, height: 12,
                        background: "#fff", borderRadius: "50%",
                        right: auto.enabled ? 2 : "auto",
                        left: auto.enabled ? "auto" : 2,
                        transition: "all 0.15s",
                      }} />
                    </span>
                  </span>
                  <span>{auto.total_sent_30d ?? 0} sent</span>
                  <a
                    onClick={() => editing === auto.id ? setEditing(null) : startEdit(auto)}
                    style={{ color: INFO, fontSize: 11, cursor: "pointer" }}
                  >
                    {editing === auto.id ? "Close" : "Edit →"}
                  </a>
                </div>

                {/* Inline edit panel */}
                {editing === auto.id && (
                  <div style={{ padding: 16, borderBottom: `1px solid ${RULE}`, background: "#faf8f0" }}>
                    {/* Timing controls per trigger type */}
                    {tpl?.trigger_type === "days_before_start" && (
                      <div style={{ marginBottom: 12 }}>
                        <label style={labelSm}>When to send</label>
                        <select
                          value={editTiming.days_before ?? 7}
                          onChange={e => setEditTiming({ ...editTiming, days_before: parseInt(e.target.value) })}
                          style={inputStyle({ width: 200 })}
                        >
                          <option value={3}>3 days before class starts</option>
                          <option value={7}>7 days before class starts</option>
                          <option value={14}>14 days before class starts</option>
                        </select>
                      </div>
                    )}
                    {tpl?.trigger_type === "days_after_start" && (
                      <div style={{ marginBottom: 12 }}>
                        <label style={labelSm}>When to send</label>
                        <select
                          value={editTiming.days_after ?? 14}
                          onChange={e => setEditTiming({ ...editTiming, days_after: parseInt(e.target.value) })}
                          style={inputStyle({ width: 200 })}
                        >
                          <option value={7}>7 days after class starts</option>
                          <option value={14}>14 days after class starts</option>
                          <option value={21}>21 days after class starts</option>
                        </select>
                      </div>
                    )}
                    {tpl?.trigger_type === "session_halfway" && (
                      <div style={{ marginBottom: 12 }}>
                        <label style={labelSm}>When to send</label>
                        <select
                          value={editTiming.halfway_method ?? "midpoint"}
                          onChange={e => setEditTiming({ ...editTiming, halfway_method: e.target.value })}
                          style={inputStyle({ width: 240 })}
                        >
                          <option value="midpoint">Halfway through (session 4 of 8)</option>
                          <option value="after_3">After session 3</option>
                          <option value="after_5">After session 5</option>
                        </select>
                      </div>
                    )}
                    {tpl?.trigger_type === "session_complete" && (
                      <div style={{ marginBottom: 12 }}>
                        <label style={labelSm}>When to send</label>
                        <select
                          value={editTiming.final_method ?? "last_day"}
                          onChange={e => setEditTiming({ ...editTiming, final_method: e.target.value })}
                          style={inputStyle({ width: 260 })}
                        >
                          <option value="last_day">On the last day of class</option>
                          <option value="day_after">Day after last class</option>
                          <option value="2_days_after">2 days after last class</option>
                        </select>
                      </div>
                    )}

                    <div style={{ marginBottom: 12 }}>
                      <label style={{ ...labelSm }}>
                        Subject
                      </label>
                      <input
                        value={editSubject}
                        onChange={e => setEditSubject(e.target.value)}
                        style={inputStyle()}
                      />
                    </div>

                    <div style={{ marginBottom: 12 }}>
                      <label style={{ ...labelSm }}>
                        Body
                      </label>
                      <textarea
                        value={editBody}
                        onChange={e => setEditBody(e.target.value)}
                        rows={8}
                        style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.6 }}
                      />
                      <div style={{ fontSize: 10, color: MUTED, marginTop: 4 }}>
                        Available: {"{"}{"{"}<span style={{ color: "#0C447C" }}>parent_first_name</span>{"}"}{"}"}
                        {" "}{"{"}{"{"}<span style={{ color: "#0C447C" }}>student_first_name</span>{"}"}{"}"}
                        {" "}{"{"}{"{"}<span style={{ color: "#4A1B0C" }}>school_name</span>{"}"}{"}"}
                        {" "}{"{"}{"{"}<span style={{ color: "#4A1B0C" }}>curriculum_name</span>{"}"}{"}"}
                        {" "}{"{"}{"{"}<span style={{ color: "#4A1B0C" }}>day_of_week</span>{"}"}{"}"}
                        {" "}{"{"}{"{"}<span style={{ color: "#4A1B0C" }}>start_time</span>{"}"}{"}"}
                        {" "}{"{"}{"{"}<span style={{ color: "#4A1B0C" }}>instructor_first_name</span>{"}"}{"}"}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <button onClick={() => saveEdit(auto.id)} disabled={saving} style={btn(PLUM)}>
                        {saving ? "Saving…" : "Save changes"}
                      </button>
                      <button onClick={() => setEditing(null)} style={btn(MUTED, "#fff", true)}>Cancel</button>
                      {msg && <span style={{ fontSize: 12, color: OK, marginLeft: 8 }}>{msg}</span>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}

      {/* Info box */}
      <div style={{
        background: "#FAEEDA", borderLeft: `3px solid ${WARN}`,
        padding: "10px 12px", borderRadius: "0 4px 4px 0", marginTop: 16,
      }}>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "#854F0B", fontWeight: 600, marginBottom: 4 }}>
          How automations work
        </div>
        <div style={{ fontSize: 12, color: "#633806", lineHeight: 1.55 }}>
          These run automatically — you set them up once and they handle the rest.
          Each one sends a personalized email when something happens (a parent registers, class is about to start, a birthday).
          Edit the wording anytime. Toggle off anything you don't need.
        </div>
      </div>
    </div>
  );
}

const labelSm = { fontSize: 11, color: "#6b6b6b", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, display: "block", marginBottom: 4 };
