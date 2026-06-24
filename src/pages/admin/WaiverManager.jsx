// /admin/waivers — manage the waivers/agreements families sign.
//
// These are the forms the parent portal's waiver gate enforces and that the
// registration flow collects. Owner/admin only (reached from the settings-gated
// nav; waivers are org-scoped via RLS). A provider with none can seed an
// editable starter set. Brand-neutral copy — no tenant strings.

import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const CREAM = "#FBFBFB";
const GREEN_BG = "#f0fdf4";
const GREEN_INK = "#166534";
const RED = "#b53737";

// Generic starter waivers for a provider with none yet. {org} is filled with the
// org name on seed; the provider edits everything after.
function templateWaivers(orgName) {
  const o = orgName || "our program";
  return [
    {
      name: "Liability Waiver & Agreement",
      required: true,
      content:
`${o} is committed to a safe, positive learning environment. By enrolling my child, I acknowledge and agree to the following:

1. Participation & risk. Enrichment activities involve inherent risks. I voluntarily enroll my child and assume these risks.

2. Release. To the extent permitted by law, I release ${o}, its instructors, and its partner sites from liability for injuries or losses, except those caused by gross negligence.

3. Medical. In an emergency, I authorize ${o} to seek medical care for my child if I cannot be reached, and I am responsible for related costs.

4. Behavior. My child is expected to follow program rules. ${o} may remove a child whose behavior is unsafe or disruptive.

5. Pickup. I will arrange timely, authorized pickup at dismissal.

By signing, I confirm I have read and agree to this waiver and agreement.`,
    },
    {
      name: "Photo & Media Release",
      required: true,
      content:
`From time to time, ${o} may photograph or record program activities for use in materials such as our website, social media, and promotional content.

By signing, I grant ${o} permission to use my child's image and work in these materials, without compensation. No last names are published.

If you prefer your child not be photographed, please decline this release and let your instructor know — your child can still fully participate.`,
    },
  ];
}

export default function WaiverManager() {
  const { org } = useOutletContext();
  const [waivers, setWaivers] = useState(null); // null = loading
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // waiver object, or { _new: true }
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  async function load() {
    if (!org?.id) return;
    setError("");
    const { data, error: e } = await supabase
      .from("waivers")
      .select("id, name, content, required, active, version, updated_at")
      .eq("organization_id", org.id)
      .order("required", { ascending: false })
      .order("name");
    if (e) { setError(e.message); return; }
    setWaivers(data ?? []);
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [org?.id]);

  const activeCount = useMemo(() => (waivers ?? []).filter((w) => w.active).length, [waivers]);

  function flash(msg) { setToast(msg); setTimeout(() => setToast(""), 2200); }

  async function saveEditing(form) {
    setBusy(true); setError("");
    try {
      if (editing?._new) {
        const { error: e } = await supabase.from("waivers").insert({
          organization_id: org.id,
          name: form.name.trim(),
          content: form.content,
          required: !!form.required,
          active: true,
        });
        if (e) throw e;
        flash("Waiver added.");
      } else {
        const { error: e } = await supabase.from("waivers")
          .update({ name: form.name.trim(), content: form.content, required: !!form.required, updated_at: new Date().toISOString() })
          .eq("id", editing.id);
        if (e) throw e;
        flash("Waiver saved.");
      }
      setEditing(null);
      await load();
    } catch (e) {
      setError(e.message ?? "Couldn't save the waiver.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(w, field) {
    setError("");
    const { error: e } = await supabase.from("waivers")
      .update({ [field]: !w[field], updated_at: new Date().toISOString() }).eq("id", w.id);
    if (e) { setError(e.message); return; }
    flash(field === "active" ? (!w.active ? "Waiver activated." : "Waiver archived.") : (!w.required ? "Marked required." : "Marked optional."));
    load();
  }

  async function seedTemplate() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const rows = templateWaivers(org?.name).map((t) => ({
        organization_id: org.id, name: t.name, content: t.content, required: t.required, active: true,
      }));
      const { error: e } = await supabase.from("waivers").insert(rows);
      if (e) throw e;
      flash("Starter waivers added — edit them to match your program.");
      await load();
    } catch (e) {
      setError(e.message ?? "Couldn't add the starter waivers.");
    } finally {
      setBusy(false);
    }
  }

  if (waivers === null) {
    return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading waivers…</div>;
  }

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "8px 0 40px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, color: PURPLE, fontSize: 24, fontWeight: 700 }}>Waivers &amp; forms</h1>
          <p style={{ color: MUTED, fontSize: 14, marginTop: 4, lineHeight: 1.5, maxWidth: 560 }}>
            The agreements families sign to enroll. Required ones must be signed before a family can see their program details in the portal.
          </p>
        </div>
        <button type="button" onClick={() => setEditing({ _new: true })} style={primaryBtn(false)}>+ Add a waiver</button>
      </div>

      {error && <div style={{ marginTop: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}
      {toast && <div style={{ marginTop: 16, padding: "10px 12px", background: GREEN_BG, border: "1px solid #bbf7d0", borderRadius: 8, color: GREEN_INK, fontSize: 13 }}>{toast}</div>}

      {waivers.length === 0 ? (
        <div style={{ marginTop: 24, background: PANEL, border: `1px dashed ${RULE}`, borderRadius: 12, padding: 28, textAlign: "center" }}>
          <div style={{ color: INK, fontSize: 15, fontWeight: 600 }}>No waivers yet</div>
          <p style={{ color: MUTED, fontSize: 13.5, lineHeight: 1.6, margin: "8px auto 16px", maxWidth: 460 }}>
            Start from a standard set — a liability waiver and a photo/media release — then edit them to match your program. Or build your own from scratch.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={seedTemplate} disabled={busy} style={primaryBtn(busy)}>{busy ? "Adding…" : "Start from a template"}</button>
            <button type="button" onClick={() => setEditing({ _new: true })} style={ghostBtn(false)}>Add my own</button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 12 }}>
          {waivers.map((w) => (
            <div key={w.id} style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "14px 16px", opacity: w.active ? 1 : 0.6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: INK, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {w.name}
                    {w.required ? <Badge bg="#fff7ed" border="#fed7aa" color="#9a3412">Required</Badge> : <Badge bg="#f3f4f6" border={RULE} color={MUTED}>Optional</Badge>}
                    {!w.active && <Badge bg="#f3f4f6" border={RULE} color={MUTED}>Archived</Badge>}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12.5, color: MUTED, lineHeight: 1.5, maxWidth: 560, maxHeight: 40, overflow: "hidden" }}>{w.content}</div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => setEditing(w)} style={ghostBtn(false)}>Edit</button>
                  <button type="button" onClick={() => toggle(w, "required")} style={ghostBtn(false)}>{w.required ? "Make optional" : "Make required"}</button>
                  <button type="button" onClick={() => toggle(w, "active")} style={ghostBtn(false)}>{w.active ? "Archive" : "Restore"}</button>
                </div>
              </div>
            </div>
          ))}
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{activeCount} active · families sign every <strong>required + active</strong> waiver.</div>
        </div>
      )}

      {editing && (
        <WaiverEditor
          waiver={editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={saveEditing}
        />
      )}
    </div>
  );
}

function WaiverEditor({ waiver, busy, onCancel, onSave }) {
  const isNew = !!waiver._new;
  const [name, setName] = useState(isNew ? "" : waiver.name ?? "");
  const [content, setContent] = useState(isNew ? "" : waiver.content ?? "");
  const [required, setRequired] = useState(isNew ? true : !!waiver.required);
  const valid = name.trim().length > 0 && content.trim().length > 0;

  return (
    <div onClick={busy ? undefined : onCancel} style={{ position: "fixed", inset: 0, background: "rgba(28,0,79,0.32)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px", zIndex: 200 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, maxWidth: 640, width: "100%", maxHeight: "90vh", overflowY: "auto", padding: 24, boxShadow: "0 10px 40px rgba(0,0,0,0.25)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: INK }}>{isNew ? "Add a waiver" : "Edit waiver"}</h2>
          <button onClick={onCancel} disabled={busy} aria-label="Close" style={{ background: "none", border: "none", fontSize: 20, color: MUTED, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>

        <label style={lbl}>Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Liability Waiver & Agreement" style={input} disabled={busy} />

        <label style={{ ...lbl, marginTop: 16 }}>Text families read &amp; agree to</label>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={12} placeholder="Paste or write the full waiver text…" style={{ ...input, resize: "vertical", lineHeight: 1.5, fontFamily: "inherit" }} disabled={busy} />

        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, fontSize: 14, color: INK, cursor: "pointer" }}>
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} disabled={busy} />
          Required — families must sign this to enroll / see program details
        </label>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20, borderTop: `1px solid ${RULE}`, paddingTop: 16 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={ghostBtn(busy)}>Cancel</button>
          <button type="button" onClick={() => onSave({ name, content, required })} disabled={busy || !valid} style={primaryBtn(busy || !valid)}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function Badge({ children, bg, border, color }) {
  return <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, background: bg, border: `1px solid ${border}`, color, padding: "2px 8px", borderRadius: 999 }}>{children}</span>;
}

const lbl = { display: "block", fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 };
const input = { width: "100%", padding: "10px 12px", border: `1.5px solid ${RULE}`, borderRadius: 8, fontSize: 14, color: INK, background: "#fff", fontFamily: "inherit", boxSizing: "border-box" };
function primaryBtn(disabled) { return { padding: "9px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
function ghostBtn(disabled) { return { padding: "9px 14px", background: "#fff", color: BRIGHT, border: `1.5px solid ${BRIGHT}`, borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
