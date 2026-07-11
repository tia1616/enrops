// /admin/registration-questions — the registration form builder.
//
// Lets an operator choose what their registration form asks families. Two kinds
// of question, one ordered list:
//   1. STANDARD questions — platform-defined types wired to structured storage
//      (second guardian, how the child leaves, who can pick up, who must NOT be
//      released to, emergency contact, how-heard). Toggle on/off + mandatory/
//      optional + label override. Safety questions default on.
//   2. CUSTOM questions — the operator's own questions (text/dropdown/etc.),
//      e.g. "does your child have music experience?".
//
// Both are rows in `custom_reg_fields` (org-scoped). standard_key IS NOT NULL for
// standard questions, NULL for custom. Absence of a row (or is_active=false) for
// a standard question = it's OFF. The registration form (built in a later chunk)
// reads active rows via get_active_registration_fields().
//
// Multi-tenant: every query is org-scoped via `org.id`; no hardcoded tenant.
// Owner/admin can edit; staff/viewer see a read-only view (settings gate).

import { useEffect, useMemo, useRef, useState } from "react";
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
const AMBER = "#8a6d1a";

// The platform's standard questions. `key` = custom_reg_fields.standard_key.
// `alwaysRequired` questions can't be made optional (they're safety-critical).
// `sensitive` questions carry a privacy note. Order here = default sort order.
const STANDARD_FIELDS = [
  {
    key: "guardian_secondary",
    label: "Second parent or guardian",
    desc: "Name, email, and phone for a second guardian. The person who registers is always the first guardian.",
    defaultRequired: false,
  },
  {
    key: "dismissal_method",
    label: "How does your child leave?",
    desc: "Released to an authorized adult, or walks / bikes home on their own. If you offer bus or aftercare, those show as options too.",
    defaultRequired: true,
    alwaysRequired: true,
  },
  {
    key: "authorized_pickup",
    label: "Who can pick up your child?",
    desc: "Up to 4 people (first and last name). Asked when the child is released to an adult.",
    defaultRequired: true,
  },
  {
    key: "do_not_release",
    label: "Anyone we should NOT release your child to?",
    desc: "Optional, for custody or safety situations. Shown only to you and your staff — never to instructors unless you allow it.",
    defaultRequired: false,
    sensitive: true,
  },
];

// Fields your registration form always asks (built in — not configurable here).
// Shown read-only so the builder reflects the whole form, not just the extras.
const ALWAYS_ON = [
  "Child's name, grade, and birth date",
  "Homeroom teacher",
  "Allergies and medical notes",
  "Emergency contact",
  "Parent / guardian name, email, and phone",
  "How did you hear about us?",
];

const STD_KEYS = STANDARD_FIELDS.map((f) => f.key);
const stdFieldKey = (key) => `std_${key}`;

const FIELD_TYPES = [
  { value: "text", label: "Short text" },
  { value: "textarea", label: "Long text (paragraph)" },
  { value: "select", label: "Dropdown (pick one)" },
  { value: "multiselect", label: "Checkboxes (pick many)" },
  { value: "checkbox", label: "Single checkbox (yes/no)" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
];
const TYPE_NEEDS_OPTIONS = new Set(["select", "multiselect"]);

// Map raw Postgres/Supabase errors to plain language (no jargon for operators).
function friendlyError(error) {
  const raw = (error && (error.message || String(error))) || "";
  const m = raw.toLowerCase();
  if (m.includes("duplicate key") || m.includes("unique")) return "You already have a question with that name — try a slightly different label.";
  if (m.includes("check constraint")) return "That value isn't allowed here.";
  if (m.includes("not authorized") || m.includes("row-level security") || m.includes("permission") || m.includes("policy")) return "You don't have permission to change this.";
  if (m.includes("network") || m.includes("failed to fetch") || m.includes("timeout")) return "Network hiccup — please try again.";
  return "Sorry, that didn't save. Please try again.";
}

export default function RegistrationQuestions() {
  const { org, orgMember } = useOutletContext() ?? {};
  const canEdit = useMemo(() => ["owner", "admin"].includes(orgMember?.role), [orgMember]);

  const [rows, setRows] = useState(null);          // all custom_reg_fields rows for the org
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);        // { kind, message }

  // Staged state for the standard section (saved together).
  const [std, setStd] = useState({});              // { key: {enabled, required, label} }
  const [savingStd, setSavingStd] = useState(false);
  const [savedStd, setSavedStd] = useState(false);

  const loadReq = useRef(0);

  async function load() {
    if (!org?.id) return;
    const myReq = ++loadReq.current;   // supersede any in-flight load (e.g. fast org switch)
    setLoading(true);
    const { data, error } = await supabase
      .from("custom_reg_fields")
      .select("id, field_key, label, field_type, options, is_required, applies_to, applies_to_value, sort_order, help_text, is_active, standard_key")
      .eq("organization_id", org.id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (myReq !== loadReq.current) return;   // a newer load started; drop this stale result
    if (error) {
      setToast({ kind: "error", message: "Couldn't load your questions. Please refresh and try again." });
      setRows([]);
      setLoading(false);
      return;
    }
    setRows(data ?? []);
    // Seed the staged standard state from existing rows (or defaults).
    const byStd = {};
    for (const r of data ?? []) if (r.standard_key) byStd[r.standard_key] = r;
    const seeded = {};
    for (const f of STANDARD_FIELDS) {
      const row = byStd[f.key];
      seeded[f.key] = {
        enabled: !!row && row.is_active !== false,
        required: f.alwaysRequired ? true : (row ? !!row.is_required : f.defaultRequired),
        label: row?.label ?? f.label,
      };
    }
    setStd(seeded);
    setSavedStd(false);
    setLoading(false);
  }

  useEffect(() => {
    load();   // load() self-supersedes via loadReq, so no stale result can win
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  // --- standard section handlers ---
  function editStd(key, patch) {
    setSavedStd(false);
    setStd((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  async function saveStandard() {
    if (!org?.id || !canEdit) return;
    setSavingStd(true);
    setToast(null);
    try {
      const byStd = {};
      for (const r of rows ?? []) if (r.standard_key) byStd[r.standard_key] = r;
      for (let i = 0; i < STANDARD_FIELDS.length; i++) {
        const f = STANDARD_FIELDS[i];
        const s = std[f.key];
        const existing = byStd[f.key];
        const label = (s.label || "").trim() || f.label;
        const required = f.alwaysRequired ? true : !!s.required;
        if (s.enabled) {
          // Upsert on the deterministic std_<key> field_key so a stale `rows`
          // snapshot (e.g. a concurrent admin session already created the row)
          // updates instead of hitting the unique constraint.
          const { error } = await supabase.from("custom_reg_fields").upsert({
            organization_id: org.id,
            standard_key: f.key,
            field_key: stdFieldKey(f.key),
            label,
            field_type: "standard",
            is_required: required,
            is_active: true,
            applies_to: "all",
            sort_order: i,
          }, { onConflict: "organization_id,field_key" });
          if (error) throw error;
        } else if (existing && existing.is_active !== false) {
          // Turn off but keep the config (label/required) for next time.
          const { error } = await supabase
            .from("custom_reg_fields")
            .update({ is_active: false })
            .eq("id", existing.id);
          if (error) throw error;
        }
      }
      await load();
      setSavedStd(true);
    } catch (e) {
      setToast({ kind: "error", message: friendlyError(e) });
    } finally {
      setSavingStd(false);
    }
  }

  // --- custom section handlers (immediate writes) ---
  const customRows = useMemo(
    () => (rows ?? []).filter((r) => !r.standard_key),
    [rows],
  );

  async function saveCustom(draft) {
    // draft: { id?, label, field_type, options[], is_required, help_text, is_active }
    if (!org?.id || !canEdit) return { error: "Not allowed" };
    const optionsClean = TYPE_NEEDS_OPTIONS.has(draft.field_type)
      ? [...new Set((draft.options || []).map((o) => o.trim()).filter(Boolean))]   // trim, drop empties, dedup
      : null;
    if (TYPE_NEEDS_OPTIONS.has(draft.field_type) && (!optionsClean || optionsClean.length === 0)) {
      return { error: "Add at least one option for a dropdown question." };
    }
    const label = (draft.label || "").trim();
    if (!label) return { error: "Give the question a label." };

    if (draft.id) {
      const { error } = await supabase
        .from("custom_reg_fields")
        .update({
          label,
          field_type: draft.field_type,
          options: optionsClean,
          is_required: !!draft.is_required,
          help_text: (draft.help_text || "").trim() || null,
          is_active: draft.is_active !== false,
        })
        .eq("id", draft.id);
      if (error) return { error: friendlyError(error) };
    } else {
      // Unique field_key per org; derive from label + a random suffix (UUID
      // fragment for enough entropy that same-label questions don't collide).
      const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "question";
      const rand = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
      const field_key = `${base}_${rand}`;
      // Append after existing custom questions (their band is 101+).
      const maxSort = (rows ?? []).filter((r) => !r.standard_key).reduce((m, r) => Math.max(m, r.sort_order ?? 0), 100);
      const { error } = await supabase.from("custom_reg_fields").insert({
        organization_id: org.id,
        standard_key: null,
        field_key,
        label,
        field_type: draft.field_type,
        options: optionsClean,
        is_required: !!draft.is_required,
        help_text: (draft.help_text || "").trim() || null,
        is_active: draft.is_active !== false,
        applies_to: "all",
        sort_order: maxSort + 1,
      });
      if (error) return { error: friendlyError(error) };
    }
    await load();
    return {};
  }

  async function deleteCustom(id) {
    if (!org?.id || !canEdit) return;
    const { error } = await supabase.from("custom_reg_fields").delete().eq("id", id).eq("organization_id", org.id);
    if (error) { setToast({ kind: "error", message: friendlyError(error) }); return; }
    await load();
  }

  async function moveCustom(id, dir) {
    if (!org?.id || !canEdit) return;
    const idx = customRows.findIndex((r) => r.id === id);
    if (idx < 0 || !customRows[idx + dir]) return;   // at an end
    // Build the new full order and write it atomically (one RPC, one transaction)
    // so a partial failure can't leave two rows sharing a sort_order.
    const next = [...customRows];
    [next[idx], next[idx + dir]] = [next[idx + dir], next[idx]];
    const { error } = await supabase.rpc("reorder_registration_fields", {
      p_org_id: org.id,
      p_ordered_ids: next.map((r) => r.id),
    });
    if (error) { setToast({ kind: "error", message: friendlyError(error) }); return; }
    await load();
  }

  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        <Link to="/admin/settings" style={{ fontSize: 13, color: BRIGHT, textDecoration: "none" }}>← Settings</Link>
      </div>
      <h1 style={{ margin: 0, color: PURPLE, fontSize: 26, fontWeight: 700 }}>Registration questions</h1>
      <p style={{ color: MUTED, fontSize: 14, margin: "6px 0 22px", lineHeight: 1.5, maxWidth: 640 }}>
        Choose what your registration form asks families. Turn the standard questions on or off, and add your own.
        Asking for pickup and release details up front saves you chasing them down later.
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

      {loading || rows === null ? (
        <div style={{ color: MUTED, fontSize: 14 }}>Loading…</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: 26, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 26, minWidth: 0 }}>
            {/* Always on the form (read-only) */}
            <section style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 12, padding: "16px 20px" }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: INK }}>Always on your form</h2>
              <p style={{ margin: "3px 0 10px", fontSize: 13, color: MUTED }}>These are built in and always asked.</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {ALWAYS_ON.map((f) => (
                  <span key={f} style={{ fontSize: 12, color: INK, background: "#fff", border: `1px solid ${RULE}`, borderRadius: 999, padding: "4px 11px" }}>{f}</span>
                ))}
              </div>
            </section>

            {/* Standard questions */}
            <section style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: "20px 22px" }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: INK }}>Optional standard questions</h2>
              <p style={{ margin: "3px 0 14px", fontSize: 13, color: MUTED }}>
                The questions most programs ask. Safety questions are on by default.
              </p>
              <div style={{ display: "flex", flexDirection: "column" }}>
                {STANDARD_FIELDS.map((f, i) => (
                  <StandardRow
                    key={f.key}
                    field={f}
                    state={std[f.key]}
                    canEdit={canEdit}
                    first={i === 0}
                    onChange={(patch) => editStd(f.key, patch)}
                  />
                ))}
              </div>
              {canEdit && (
                <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={saveStandard}
                    disabled={savingStd || savedStd}
                    style={{
                      padding: "9px 18px", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600,
                      fontFamily: "inherit", cursor: savingStd || savedStd ? "default" : "pointer",
                      background: savedStd ? OK_GREEN : BRIGHT, color: "#fff", opacity: savingStd ? 0.7 : 1,
                    }}
                  >
                    {savingStd ? "Saving…" : savedStd ? "Saved ✓" : "Save standard questions"}
                  </button>
                </div>
              )}
            </section>

            {/* Custom questions */}
            <CustomSection
              customRows={customRows}
              canEdit={canEdit}
              onSave={saveCustom}
              onDelete={deleteCustom}
              onMove={moveCustom}
            />
          </div>

          {/* Live preview */}
          <FormPreview std={std} customRows={customRows} />
        </div>
      )}
    </div>
  );
}

function StandardRow({ field, state, canEdit, first, onChange }) {
  if (!state) return null;
  return (
    <div style={{ padding: "14px 0", borderTop: first ? "none" : `1px solid ${RULE}` }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>
            {field.label}
            {field.sensitive && (
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: AMBER, background: "#fbf3dc", border: "1px solid #ecdca6", borderRadius: 4, padding: "1px 6px", textTransform: "uppercase", letterSpacing: 0.4 }}>
                Sensitive
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 3, lineHeight: 1.5, maxWidth: 460 }}>{field.desc}</div>
        </div>
        <Toggle on={!!state.enabled} locked={!canEdit} onClick={() => onChange({ enabled: !state.enabled })} />
      </div>

      {state.enabled && (
        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14 }}>
          {/* mandatory / optional */}
          <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, color: field.alwaysRequired ? MUTED : INK }}>
            <input
              type="checkbox"
              checked={field.alwaysRequired ? true : !!state.required}
              disabled={!canEdit || field.alwaysRequired}
              onChange={(e) => onChange({ required: e.target.checked })}
            />
            Required
            {field.alwaysRequired && <span style={{ color: MUTED }}>(always)</span>}
          </label>
          {/* label override */}
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, flex: 1, minWidth: 220 }}>
            <span style={{ fontSize: 12, color: MUTED, whiteSpace: "nowrap" }}>Label shown:</span>
            <input
              type="text"
              value={state.label}
              disabled={!canEdit}
              onChange={(e) => onChange({ label: e.target.value })}
              placeholder={field.label}
              style={{ flex: 1, minWidth: 0, fontFamily: "inherit", fontSize: 13, color: INK, border: `1px solid ${RULE}`, borderRadius: 6, padding: "6px 9px", background: canEdit ? "#fff" : CREAM }}
            />
          </span>
        </div>
      )}
    </div>
  );
}

function CustomSection({ customRows, canEdit, onSave, onDelete, onMove }) {
  const [editing, setEditing] = useState(null);   // draft being edited/added, or null
  const [pendingDelete, setPendingDelete] = useState(null);

  return (
    <section style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: "20px 22px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: INK }}>Your own questions</h2>
        {canEdit && !editing && (
          <button type="button" onClick={() => setEditing(blankDraft())} style={smallPrimary}>+ Add question</button>
        )}
      </div>
      <p style={{ margin: "0 0 14px", fontSize: 13, color: MUTED }}>
        Anything specific to your programs — e.g. "Does your child have music experience?"
      </p>

      {customRows.length === 0 && !editing && (
        <div style={{ fontSize: 13, color: MUTED, background: CREAM, border: `1px dashed ${RULE}`, borderRadius: 8, padding: "14px 16px" }}>
          No custom questions yet. {canEdit ? "Add one to ask families something specific to your programs." : ""}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {customRows.map((r, i) => (
          <div key={r.id} style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: "12px 14px", background: r.is_active === false ? CREAM : "#fff" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>
                  {r.label}
                  {r.is_required && <span style={{ color: RED, marginLeft: 4 }}>*</span>}
                  {r.is_active === false && <span style={{ marginLeft: 8, fontSize: 11, color: MUTED }}>(hidden)</span>}
                </div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                  {FIELD_TYPES.find((t) => t.value === r.field_type)?.label || r.field_type}
                  {Array.isArray(r.options) && r.options.length > 0 && ` · ${r.options.length} option${r.options.length === 1 ? "" : "s"}`}
                </div>
              </div>
              {canEdit && (
                <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                  <IconBtn label="Move up" disabled={i === 0} onClick={() => onMove(r.id, -1)}>↑</IconBtn>
                  <IconBtn label="Move down" disabled={i === customRows.length - 1} onClick={() => onMove(r.id, 1)}>↓</IconBtn>
                  <button type="button" onClick={() => setEditing({ ...r, options: Array.isArray(r.options) ? r.options : [] })} style={linkBtn}>Edit</button>
                  <button type="button" onClick={() => setPendingDelete(r)} style={{ ...linkBtn, color: RED }}>Delete</button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <CustomEditor
          draft={editing}
          onCancel={() => setEditing(null)}
          onSubmit={async (draft) => {
            const { error } = await onSave(draft);
            if (error) return error;
            setEditing(null);
            return null;
          }}
        />
      )}

      {pendingDelete && (
        <ConfirmBar
          message={`Delete "${pendingDelete.label}"? Families won't be asked this anymore.`}
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => { await onDelete(pendingDelete.id); setPendingDelete(null); }}
        />
      )}
    </section>
  );
}

function blankDraft() {
  return { id: null, label: "", field_type: "text", options: [], is_required: false, help_text: "", is_active: true };
}

function CustomEditor({ draft, onCancel, onSubmit }) {
  const [d, setD] = useState(draft);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const needsOptions = TYPE_NEEDS_OPTIONS.has(d.field_type);

  async function submit() {
    setBusy(true);
    setErr(null);
    const error = await onSubmit(d);
    if (error) { setErr(error); setBusy(false); }
    // on success the parent unmounts this editor
  }

  return (
    <div style={{ marginTop: 14, border: `1px solid ${BRIGHT}`, borderRadius: 10, padding: 16, background: "#faf9ff" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: PURPLE, marginBottom: 12 }}>{d.id ? "Edit question" : "New question"}</div>

      <label style={fieldLabel}>Question label</label>
      <input type="text" value={d.label} autoFocus onChange={(e) => setD({ ...d, label: e.target.value })}
        placeholder="e.g. Does your child have music experience?" style={textInput} />

      <label style={{ ...fieldLabel, marginTop: 12 }}>Answer type</label>
      <select value={d.field_type} onChange={(e) => setD({ ...d, field_type: e.target.value })} style={textInput}>
        {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
      </select>

      {needsOptions && (
        <>
          <label style={{ ...fieldLabel, marginTop: 12 }}>Options (one per line)</label>
          <textarea
            rows={4}
            value={(d.options || []).join("\n")}
            onChange={(e) => setD({ ...d, options: e.target.value.split("\n") })}
            placeholder={"None\nA little\nA lot"}
            style={{ ...textInput, resize: "vertical" }}
          />
        </>
      )}

      <label style={{ ...fieldLabel, marginTop: 12 }}>Helper text <span style={{ fontWeight: 400, color: MUTED }}>(optional)</span></label>
      <input type="text" value={d.help_text || ""} onChange={(e) => setD({ ...d, help_text: e.target.value })}
        placeholder="A short hint shown under the question" style={textInput} />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginTop: 12 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, color: INK }}>
          <input type="checkbox" checked={!!d.is_required} onChange={(e) => setD({ ...d, is_required: e.target.checked })} />
          Required
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, color: INK }}>
          <input type="checkbox" checked={d.is_active !== false} onChange={(e) => setD({ ...d, is_active: e.target.checked })} />
          Show on the form <span style={{ color: MUTED }}>(uncheck to hide without deleting)</span>
        </label>
      </div>

      {err && <div style={{ fontSize: 13, color: RED, marginTop: 10 }}>{err}</div>}

      <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <button type="button" onClick={onCancel} style={ghostBtn}>Cancel</button>
        <button type="button" onClick={submit} disabled={busy} style={{ ...smallPrimary, opacity: busy ? 0.7 : 1 }}>
          {busy ? "Saving…" : d.id ? "Save question" : "Add question"}
        </button>
      </div>
    </div>
  );
}

function ConfirmBar({ message, onCancel, onConfirm }) {
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: "#fff5f5", border: "1px solid #f0c4c4", borderRadius: 8, padding: "10px 14px" }}>
      <span style={{ fontSize: 13, color: INK }}>{message}</span>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button type="button" onClick={onCancel} style={ghostBtn}>Keep it</button>
        <button type="button" disabled={busy} onClick={async () => { setBusy(true); await onConfirm(); }} style={{ ...smallPrimary, background: RED, opacity: busy ? 0.7 : 1 }}>
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </div>
  );
}

// A lightweight preview of the resulting form — enabled standard questions +
// active custom questions, in order. Approximates what families will see.
function FormPreview({ std, customRows }) {
  const items = [];
  for (const f of STANDARD_FIELDS) {
    const s = std[f.key];
    if (s?.enabled) items.push({ key: f.key, label: (s.label || "").trim() || f.label, required: f.alwaysRequired || !!s.required, kind: "standard", stdKey: f.key });
  }
  for (const r of customRows) {
    if (r.is_active !== false) items.push({ key: r.id, label: r.label, required: !!r.is_required, kind: "custom", field_type: r.field_type, options: r.options });
  }

  return (
    <aside style={{ position: "sticky", top: 12, background: CREAM, border: `1px solid ${RULE}`, borderRadius: 12, padding: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>Preview</div>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 12 }}>How these questions read on your form.</div>
      {items.length === 0 ? (
        <div style={{ fontSize: 13, color: MUTED }}>No extra questions turned on yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {items.map((it) => (
            <div key={it.key}>
              <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>
                {it.label}{it.required && <span style={{ color: RED, marginLeft: 3 }}>*</span>}
              </div>
              <PreviewInput item={it} />
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

function PreviewInput({ item }) {
  const box = { marginTop: 5, width: "100%", boxSizing: "border-box", border: `1px solid ${RULE}`, borderRadius: 6, padding: "7px 9px", fontSize: 12, color: MUTED, background: "#fff" };
  if (item.kind === "standard") {
    const hints = {
      guardian_secondary: "Name · email · phone",
      dismissal_method: "○ Released to an adult   ○ Walks / bikes home",
      authorized_pickup: "Up to 4 people (first & last name)",
      do_not_release: "Name(s) — optional",
      emergency_contact: "Name · phone",
      how_heard: "Dropdown ▾",
    };
    return <div style={box}>{hints[item.stdKey] || ""}</div>;
  }
  if (item.field_type === "textarea") return <div style={{ ...box, minHeight: 34 }} />;
  if (item.field_type === "checkbox") return <div style={{ marginTop: 5, fontSize: 12, color: MUTED }}>☐ Yes</div>;
  if (item.field_type === "select") return <div style={box}>{(item.options?.[0] || "Pick one") + " ▾"}</div>;
  if (item.field_type === "multiselect") return <div style={{ marginTop: 5, fontSize: 12, color: MUTED }}>{(item.options || []).slice(0, 3).map((o) => `☐ ${o}`).join("   ") || "☐ …"}</div>;
  if (item.field_type === "date") return <div style={box}>mm / dd / yyyy</div>;
  if (item.field_type === "number") return <div style={box}>0</div>;
  return <div style={box} />;
}

function Toggle({ on, locked, onClick }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} disabled={locked}
      onClick={locked ? undefined : onClick}
      title={locked ? "" : on ? "On — click to turn off" : "Off — click to turn on"}
      style={{
        flexShrink: 0, width: 44, height: 26, borderRadius: 999, border: "none", position: "relative",
        cursor: locked ? "default" : "pointer", background: on ? BRIGHT : "#cfcbc0", opacity: locked ? 0.55 : 1,
        transition: "background 120ms", padding: 0,
      }}
    >
      <span style={{ position: "absolute", top: 3, left: on ? 21 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left 120ms", boxShadow: "0 1px 2px rgba(0,0,0,0.2)" }} />
    </button>
  );
}

function IconBtn({ children, label, disabled, onClick }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      style={{ width: 26, height: 26, borderRadius: 6, border: `1px solid ${RULE}`, background: "#fff", color: disabled ? "#cfcbc0" : INK, cursor: disabled ? "default" : "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}>
      {children}
    </button>
  );
}

const smallPrimary = { padding: "8px 14px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" };
const ghostBtn = { padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const linkBtn = { background: "none", border: "none", color: BRIGHT, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: "2px 4px" };
const fieldLabel = { display: "block", fontSize: 12, fontWeight: 600, color: INK, marginBottom: 5 };
const textInput = { width: "100%", boxSizing: "border-box", fontFamily: "inherit", fontSize: 13, color: INK, border: `1px solid ${RULE}`, borderRadius: 6, padding: "8px 10px", background: "#fff" };
