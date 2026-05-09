// src/pages/admin/marketing/ComposeTab.jsx
// Compose email with send-mode picker (one / split by school / class / area).
// Stage 1: textarea-based (no rich text). Placeholder insertion.
// Preview shows "Email 1 of 22 · Cannady (52 parents)" with prev/next.

import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase.js";
import { INK, MUTED, RULE, PLUM, INFO, WARN, OK, DANGER, Card, Pill, btn, input as inputStyle } from "./tokens.jsx";
import { wrapEmailHtml, resolvePlaceholders, PREVIEW_SAMPLE_DATA } from "./emailTemplate.js";

const SEND_MODES = [
  { key: "one", label: "One email", detail: "to all" },
  { key: "split_by_school", label: "Split by school", detail: "1 per school" },
  { key: "split_by_class", label: "Split by class", detail: "1 per class" },
  { key: "split_by_area", label: "Split by area", detail: "1 per district" },
];

const BLUE_PLACEHOLDERS = [
  { tag: "parent_first_name", label: "Parent first name" },
  { tag: "student_first_name", label: "Student first name" },
  { tag: "registration_link", label: "Registration link" },
];
const ORANGE_PLACEHOLDERS = [
  { tag: "school_name", label: "School name" },
  { tag: "first_session_date", label: "First session date" },
  { tag: "day_of_week", label: "Day of week" },
  { tag: "start_time", label: "Start time" },
  { tag: "instructor_first_name", label: "Instructor name" },
];

const TEMPLATES = [
  { key: "schedule_change", icon: "📅", label: "Schedule change", subject: "Update: {{class_name}} at {{school_name}} — schedule change", body: "Hi {{parent_first_name}},\n\nWe're writing to let you know about a change to {{student_first_name}}'s {{class_name}} class at {{school_name}}.\n\n[What changed — new day, time, room, etc.]\n\nThe updated schedule is:\nDay: {{day_of_week}}\nTime: {{start_time}}\nInstructor: {{instructor_first_name}}\n\nIf this doesn't work for your family, just reply and we'll help figure out the best option.\n\nThank you for your patience!" },
  { key: "cancellation", icon: "✕", label: "Cancellation", subject: "{{class_name}} at {{school_name}} — important update", body: "Hi {{parent_first_name}},\n\nWe're sorry to let you know that {{class_name}} at {{school_name}} will not be running this term due to [reason — low enrollment / scheduling conflict / etc.].\n\n[Choose one or both:]\n- We've issued a full refund to the card on file. You should see it within 5–10 business days.\n- We'd love to get {{student_first_name}} into another class! Here are some options: [list alternatives]\n\nWe know this is disappointing. Please reply if you have any questions — we're here to help." },
  { key: "sales_promo", icon: "🏷️", label: "Sales / promo", subject: "{{school_name}} families: spots are open in {{class_name}}!", body: "Hi {{parent_first_name}},\n\nWe wanted to make sure you saw this — there are still spots available in {{class_name}} at {{school_name}}!\n\nWhat they'll do:\n[Paste or write a 2-3 sentence description of the class — what kids build, create, or explore]\n\nThe details:\nDay: {{day_of_week}}\nTime: {{start_time}}\nStarts: {{first_session_date}}\nInstructor: {{instructor_first_name}}\n\n[Optional: Add a promo or urgency line like \"Use code FALL10 for 10% off\" or \"Only 4 spots left!\"]\n\nRegister here: {{registration_link}}\n\nQuestions? Just reply to this email." },
  { key: "blank", icon: "📄", label: "Blank email", subject: "", body: "" },
];

export default function ComposeTab({ org, composeCtx }) {
  const [groups, setGroups] = useState([]);
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [sendMode, setSendMode] = useState("one");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [templateKey, setTemplateKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState({ text: "", tone: "info" });
  const [previewIdx, setPreviewIdx] = useState(0);
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewDevice, setPreviewDevice] = useState("desktop"); // desktop | mobile
  const [accentColor, setAccentColor] = useState("#674EE8");
  const [autoSignature, setAutoSignature] = useState(true);

  // Real counts from DB — loaded on mount, recalculated when groups change
  const [sendCounts, setSendCounts] = useState({ parents: 0, schools: 0, classes: 0, areas: 0 });

  const splitCount = sendMode === "one" ? 1
    : sendMode === "split_by_school" ? sendCounts.schools
    : sendMode === "split_by_class" ? sendCounts.classes
    : sendMode === "split_by_area" ? sendCounts.areas : 1;

  const totalRecipients = sendCounts.parents;

  useEffect(() => { loadGroups(); loadSendCounts(); }, []);

  async function loadSendCounts() {
    try {
      // Count schools with open programs
      const { count: schoolCount } = await supabase
        .from("programs")
        .select("program_location_id", { count: "exact", head: true })
        .eq("status", "open");
      
      // Count distinct schools (programs can share a location)
      const { data: schoolRows } = await supabase
        .from("programs")
        .select("program_location_id")
        .eq("status", "open");
      const uniqueSchools = new Set((schoolRows ?? []).map(r => r.program_location_id)).size;

      // Count total classes (programs)
      const classCount = schoolCount ?? 0;

      // Count distinct areas
      const { data: locRows } = await supabase
        .from("program_locations")
        .select("id, district");
      const locMap = Object.fromEntries((locRows ?? []).map(l => [l.id, l.district]));
      const activeDistricts = new Set(
        (schoolRows ?? []).map(r => locMap[r.program_location_id]).filter(Boolean)
      );

      // Count reachable parents from marketing_recipients
      const { count: parentCount } = await supabase
        .from("marketing_recipients")
        .select("id", { count: "exact", head: true });

      setSendCounts({
        parents: parentCount ?? 0,
        schools: uniqueSchools,
        classes: classCount,
        areas: activeDistricts.size,
      });
    } catch (e) {
      console.error("loadSendCounts error:", e);
    }
  }

  async function loadGroups() {
    setLoading(true);
    const { data } = await supabase
      .from("marketing_groups")
      .select("*")
      .order("name");
    setGroups(data ?? []);
    setLoading(false);
  }

  function applyTemplate(tpl) {
    setTemplateKey(tpl.key);
    setSubject(tpl.subject);
    setBody(tpl.body);
  }

  function insertPlaceholder(tag) {
    const placeholder = `{{${tag}}}`;
    setBody(prev => prev + placeholder);
  }

  function toggleGroup(group) {
    setSelectedGroups(prev => {
      const exists = prev.find(g => g.id === group.id);
      return exists ? prev.filter(g => g.id !== group.id) : [...prev, group];
    });
  }

  async function saveDraft() {
    if (!subject && !body) return;
    setSaving(true);
    const { error } = await supabase
      .from("marketing_emails")
      .insert({
        organization_id: org?.id,
        subject,
        body,
        send_mode: sendMode,
        target_group_ids: selectedGroups.map(g => g.id),
        status: "draft",
        template_key: templateKey,
      });
    setSaving(false);
    if (error) {
      setMsg({ text: "Save error: " + error.message, tone: "err" });
    } else {
      setMsg({ text: "Draft saved!", tone: "ok" });
      setTimeout(() => setMsg({ text: "", tone: "info" }), 2000);
    }
  }

  async function scheduleOrSend(immediate = false) {
    if (!subject || !body) {
      setMsg({ text: "Subject and body are required.", tone: "err" });
      return;
    }
    if (selectedGroups.length === 0) {
      setMsg({ text: "Select at least one group.", tone: "err" });
      return;
    }

    const action = immediate
      ? `Send NOW to ${totalRecipients || "?"} recipients across ${splitCount} email${splitCount > 1 ? "s" : ""}?`
      : "Schedule this email?";
    if (!confirm(action + " This cannot be undone.")) return;

    setSaving(true);
    const { data, error } = await supabase
      .from("marketing_emails")
      .insert({
        organization_id: org?.id,
        subject,
        body,
        send_mode: sendMode,
        target_group_ids: selectedGroups.map(g => g.id),
        status: immediate ? "sending" : "scheduled",
        template_key: templateKey,
        total_recipients: totalRecipients,
      })
      .select()
      .single();
    
    if (error) {
      setSaving(false);
      setMsg({ text: "Error: " + error.message, tone: "err" });
      return;
    }

    if (immediate && data) {
      // Call edge function to actually send
      try {
        const { data: sendResult, error: sendErr } = await supabase.functions.invoke("marketing-send-email", {
          body: { email_id: data.id },
        });
        if (sendErr) throw sendErr;
        setMsg({
          text: `Sent! ${sendResult?.sent ?? "?"} delivered, ${sendResult?.errors ?? 0} errors.`,
          tone: "ok",
        });
      } catch (e) {
        setMsg({ text: "Send error: " + (e.message ?? String(e)), tone: "err" });
      }
    } else {
      setMsg({ text: "Scheduled!", tone: "ok" });
    }
    setSaving(false);
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 4px", letterSpacing: -0.3, color: INK }}>
        New email
      </h1>
      <p style={{ fontSize: 13, color: MUTED, margin: "0 0 14px" }}>
        Write once, personalize for every parent. Each family gets an email with their school's name, class details, and instructor — automatically.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 220px", gap: 14 }}>
        {/* Main compose area */}
        <div>
          <Card style={{ marginBottom: 0 }}>
            {/* To field */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, fontWeight: 600, marginBottom: 6 }}>
                To
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                {selectedGroups.map(g => (
                  <span
                    key={g.id}
                    onClick={() => toggleGroup(g)}
                    style={{
                      padding: "4px 10px", background: "#E6F1FB", color: "#0C447C",
                      borderRadius: 999, fontSize: 11, fontWeight: 600, cursor: "pointer",
                    }}
                  >
                    {g.name} · {g.cached_count} ✕
                  </span>
                ))}
                <span
                  onClick={() => setShowAddGroup(!showAddGroup)}
                  style={{ fontSize: 11, color: MUTED, cursor: "pointer" }}
                >
                  + add group
                </span>
              </div>
              {showAddGroup && (
                <div style={{ marginTop: 6, padding: 8, background: "#f7f6ef", borderRadius: 4 }}>
                  {loading ? <span style={{ fontSize: 11, color: MUTED }}>Loading…</span> :
                    groups.length === 0 ? (
                      <span style={{ fontSize: 11, color: MUTED }}>No groups yet — create one in the Groups tab.</span>
                    ) : groups.map(g => (
                      <div
                        key={g.id}
                        onClick={() => { toggleGroup(g); setShowAddGroup(false); }}
                        style={{
                          padding: "5px 8px", cursor: "pointer", fontSize: 12,
                          borderRadius: 4, marginBottom: 2,
                          background: selectedGroups.find(sg => sg.id === g.id) ? "#E6F1FB" : "transparent",
                        }}
                      >
                        {g.name} <span style={{ color: MUTED, fontSize: 11 }}>· {g.cached_count} parents</span>
                      </div>
                    ))}
                </div>
              )}
            </div>

            {/* Send mode picker */}
            <div style={{
              background: "#FAEEDA", borderLeft: `3px solid ${WARN}`,
              padding: "10px 12px", borderRadius: "0 4px 4px 0", marginBottom: 12,
            }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "#854F0B", fontWeight: 600, marginBottom: 6 }}>
                How to send
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6 }}>
                {[
                  { key: "one", label: "One email", count: sendCounts.parents, detail: "parents get same email" },
                  { key: "split_by_school", label: "Split by school", count: sendCounts.schools, detail: "emails · 1 per school" },
                  { key: "split_by_class", label: "Split by class", count: sendCounts.classes, detail: "emails · 1 per class" },
                  { key: "split_by_area", label: "Split by area", count: sendCounts.areas, detail: "emails · 1 per district" },
                ].map(m => (
                  <div
                    key={m.key}
                    onClick={() => setSendMode(m.key)}
                    style={{
                      padding: "8px 10px", background: sendMode === m.key ? "#FAEEDA" : "#fff",
                      border: sendMode === m.key ? `2px solid ${WARN}` : `1px solid ${RULE}`,
                      borderRadius: 4, cursor: "pointer",
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 11, color: sendMode === m.key ? "#633806" : INK }}>
                      {m.label}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: sendMode === m.key ? "#633806" : PLUM, marginTop: 3 }}>
                      {m.count || "—"}
                    </div>
                    <div style={{ color: sendMode === m.key ? "#854F0B" : MUTED, fontSize: 9, marginTop: 1 }}>
                      {m.detail}
                    </div>
                  </div>
                ))}
              </div>
              {sendMode !== "one" && (
                <div style={{ fontSize: 11, color: "#633806", marginTop: 8, lineHeight: 1.5 }}>
                  Every parent gets a personalized email with their school's name, class day, time, and instructor.
                  Write once — we send {splitCount}.
                </div>
              )}
            </div>

            {/* Subject */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, fontWeight: 600, marginBottom: 4 }}>
                Subject
              </div>
              <input
                value={subject}
                onChange={e => setSubject(e.target.value)}
                placeholder="Email subject line…"
                style={inputStyle()}
              />
            </div>

            {/* Body */}
            <div>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, fontWeight: 600, marginBottom: 4 }}>
                Body <span style={{ fontWeight: 400, textTransform: "none" }}>(plain text — rich text coming in Stage 2)</span>
              </div>
              <textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                rows={10}
                placeholder="Write your email…"
                style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.6 }}
              />
            </div>
          </Card>

          {/* Quick inline preview */}
          {(subject || body) && (
            <Card style={{ marginTop: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, fontWeight: 600 }}>
                  Quick preview
                  {splitCount > 1 && ` · Email ${previewIdx + 1} of ${splitCount}`}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {splitCount > 1 && (
                    <span style={{ fontSize: 11, color: MUTED }}>
                      <span onClick={() => setPreviewIdx(Math.max(0, previewIdx - 1))} style={{ cursor: "pointer" }}>◂ prev</span>
                      <span style={{ margin: "0 6px" }}>·</span>
                      <span onClick={() => setPreviewIdx(Math.min(splitCount - 1, previewIdx + 1))} style={{ cursor: "pointer" }}>next ▸</span>
                    </span>
                  )}
                  <button
                    onClick={() => setShowPreviewModal(true)}
                    style={{ ...btn(INFO), padding: "5px 12px", fontSize: 12 }}
                  >
                    Preview email
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.55, color: INK, padding: "6px 4px" }}>
                <strong>{resolvePlaceholders(subject)}</strong>
                <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                  {resolvePlaceholders(body)}
                </div>
              </div>
            </Card>
          )}

          {/* Action buttons */}
          <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              onClick={() => scheduleOrSend(true)}
              disabled={saving}
              style={btn(PLUM)}
            >
              {splitCount > 1 ? `Send ${splitCount} emails now` : "Send now"}
            </button>
            <button
              onClick={() => scheduleOrSend(false)}
              disabled={saving}
              style={btn(PLUM, "#fff", true)}
            >
              Schedule for later
            </button>
            {(subject || body) && (
              <button
                onClick={() => setShowPreviewModal(true)}
                style={btn(INFO, "#fff", true)}
              >
                Preview
              </button>
            )}
            <button onClick={saveDraft} disabled={saving} style={{ ...btn("transparent", MUTED), border: "none", marginLeft: "auto" }}>
              Save draft
            </button>
          </div>

          {msg.text && (
            <div style={{
              marginTop: 10, padding: 10, borderRadius: 4, fontSize: 13,
              background: msg.tone === "ok" ? "#e8f5e9" : msg.tone === "err" ? "#fdecea" : "#fff8e1",
              color: msg.tone === "ok" ? OK : msg.tone === "err" ? DANGER : INK,
            }}>
              {msg.text}
            </div>
          )}

          {/* Preview Modal */}
          {showPreviewModal && (
            <div
              onClick={(e) => { if (e.target === e.currentTarget) setShowPreviewModal(false); }}
              style={{
                position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
                background: "rgba(0,0,0,0.5)", zIndex: 1000,
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: 24,
              }}
            >
              <div style={{
                background: "#fff", borderRadius: 10, width: "100%",
                maxWidth: previewDevice === "mobile" ? 420 : 720,
                maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column",
                transition: "max-width 0.2s",
              }}>
                {/* Modal header */}
                <div style={{
                  padding: "14px 20px", borderBottom: `1px solid ${RULE}`,
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>
                    Email preview
                    {splitCount > 1 && <span style={{ fontWeight: 400, color: MUTED }}> · Email {previewIdx + 1} of {splitCount}</span>}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    {/* Device toggle */}
                    <div style={{
                      display: "flex", border: `1px solid ${RULE}`, borderRadius: 4, overflow: "hidden",
                    }}>
                      {["desktop", "mobile"].map(d => (
                        <button
                          key={d}
                          onClick={() => setPreviewDevice(d)}
                          style={{
                            padding: "4px 10px", fontSize: 11, border: "none", cursor: "pointer",
                            background: previewDevice === d ? PLUM : "#fff",
                            color: previewDevice === d ? "#fff" : MUTED,
                            fontFamily: "inherit", fontWeight: 500,
                          }}
                        >
                          {d === "desktop" ? "Desktop" : "Mobile"}
                        </button>
                      ))}
                    </div>
                    {splitCount > 1 && (
                      <div style={{ fontSize: 11, color: MUTED }}>
                        <span onClick={() => setPreviewIdx(Math.max(0, previewIdx - 1))} style={{ cursor: "pointer" }}>◂</span>
                        <span style={{ margin: "0 4px" }}>{previewIdx + 1}/{splitCount}</span>
                        <span onClick={() => setPreviewIdx(Math.min(splitCount - 1, previewIdx + 1))} style={{ cursor: "pointer" }}>▸</span>
                      </div>
                    )}
                    <button
                      onClick={() => setShowPreviewModal(false)}
                      style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: MUTED, padding: "0 4px" }}
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* Email render */}
                <div style={{ flex: 1, overflow: "auto", background: "#f5f3ff", padding: previewDevice === "mobile" ? "16px 8px" : "24px 16px" }}>
                  <div
                    dangerouslySetInnerHTML={{
                      __html: wrapEmailHtml({
                        subject: resolvePlaceholders(subject),
                        body: resolvePlaceholders(
                          autoSignature && !body.includes("Big adventures")
                            ? body + "\n\nBig adventures after the last bell."
                            : body
                        ),
                        orgName: org?.name || "Journey to STEAM",
                        contactEmail: "info@journeytosteam.com",
                        accentColor,
                        tagline: "",
                      }),
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right sidebar: templates + placeholders */}
        <div>
          <Card style={{ marginBottom: 10, padding: 12 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, fontWeight: 600, marginBottom: 6 }}>
              Start from template
            </div>
            <div style={{ display: "grid", gap: 4, fontSize: 12 }}>
              {TEMPLATES.map(t => (
                <div
                  key={t.key}
                  onClick={() => applyTemplate(t)}
                  style={{
                    padding: "7px 10px", cursor: "pointer", borderRadius: 4,
                    background: templateKey === t.key ? "#E6F1FB" : "transparent",
                  }}
                >
                  {t.icon} {t.label}
                </div>
              ))}
            </div>
          </Card>

          <Card style={{ padding: 12 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, fontWeight: 600, marginBottom: 6 }}>
              Placeholders
            </div>

            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, marginBottom: 4 }}>
              Per parent
            </div>
            <div style={{ fontSize: 11, lineHeight: 1.7, marginBottom: 8 }}>
              {BLUE_PLACEHOLDERS.map(p => (
                <span
                  key={p.tag}
                  onClick={() => insertPlaceholder(p.tag)}
                  style={{
                    display: "inline-block", background: "#E6F1FB", color: "#0C447C",
                    padding: "1px 4px", borderRadius: 2, cursor: "pointer", marginBottom: 2,
                  }}
                >
                  {`{{${p.tag}}}`}
                </span>
              )).reduce((prev, curr) => prev.length ? [...prev, <br key={Math.random()} />, curr] : [curr], [])}
            </div>

            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, marginBottom: 4 }}>
              Per school <span style={{ fontSize: 9 }}>(when split)</span>
            </div>
            <div style={{ fontSize: 11, lineHeight: 1.7, opacity: sendMode === "one" ? 0.4 : 1 }}>
              {ORANGE_PLACEHOLDERS.map(p => (
                <span
                  key={p.tag}
                  onClick={() => sendMode !== "one" && insertPlaceholder(p.tag)}
                  style={{
                    display: "inline-block", background: "#f4c4b3", color: "#4A1B0C",
                    padding: "1px 4px", borderRadius: 2,
                    cursor: sendMode !== "one" ? "pointer" : "default", marginBottom: 2,
                  }}
                >
                  {`{{${p.tag}}}`}
                </span>
              )).reduce((prev, curr) => prev.length ? [...prev, <br key={Math.random()} />, curr] : [curr], [])}
            </div>
          </Card>

          {/* Email style options */}
          <Card style={{ padding: 12, marginTop: 10 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, fontWeight: 600, marginBottom: 8 }}>
              Email style
            </div>

            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: INK, marginBottom: 4 }}>Header color</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[
                  { color: "#674EE8", label: "Purple" },
                  { color: "#691D39", label: "Plum" },
                  { color: "#1565c0", label: "Blue" },
                  { color: "#2e7d32", label: "Green" },
                  { color: "#e65100", label: "Orange" },
                  { color: "#1A1530", label: "Dark" },
                ].map(c => (
                  <div
                    key={c.color}
                    onClick={() => setAccentColor(c.color)}
                    title={c.label}
                    style={{
                      width: 26, height: 26, borderRadius: 4, cursor: "pointer",
                      background: c.color,
                      border: accentColor === c.color ? "2px solid #1a1a1a" : "2px solid transparent",
                      transition: "border 0.1s",
                    }}
                  />
                ))}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                onClick={() => setAutoSignature(!autoSignature)}
                style={{
                  display: "inline-block", width: 30, height: 16,
                  background: autoSignature ? "#639922" : "#d1cfc6",
                  borderRadius: 999, position: "relative", cursor: "pointer",
                }}
              >
                <span style={{
                  position: "absolute", top: 2, width: 12, height: 12,
                  background: "#fff", borderRadius: "50%",
                  right: autoSignature ? 2 : "auto",
                  left: autoSignature ? "auto" : 2,
                }} />
              </span>
              <span style={{ fontSize: 11, color: INK }}>Auto-add tagline</span>
            </div>
            <div style={{ fontSize: 10, color: MUTED, marginTop: 3 }}>
              "Big adventures after the last bell."
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}


