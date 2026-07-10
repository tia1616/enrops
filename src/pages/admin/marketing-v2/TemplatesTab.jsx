// TemplatesTab — the Family Comms "Templates" surface.
//
// Why this exists: operators send the same kinds of emails over and over
// (a welcome, a win-back, a "spots are filling"). Saved templates let them
// write the wording ONCE, name it, and reuse it — instead of rebuilding it or
// digging up an old campaign every time. Richelle's ask.
//
// This tab is where templates are CREATED and MANAGED. Reusing one happens
// inside a campaign email: TouchpointCard has "Save as template" and "Use a
// saved template" so the loop closes where the operator is actually writing.
//
// Storage: saved_email_templates, one row per org (RLS gates to org owner/admin).
// Body is the same friendly-editor HTML as campaign touchpoints, so merge tags
// like {{first_name}} survive and render the same way when reused.
//
// Org comes from useOutletContext — never hardcoded. Copy is tenant-neutral.

import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import { BRIGHT, INK, MUTED, RULE } from "../marketing/tokens.jsx";
import FamilyCommsTabs from "./FamilyCommsTabs.jsx";
import AttachmentPicker from "./AttachmentPicker.jsx";
import { htmlToEditable, editableToHtml, highlightTokens, stripHtml } from "./bodyEditorUtils.js";

const RED = "#b53737";

function snippet(html, max = 140) {
  const t = stripHtml(html);
  return t.length > max ? t.slice(0, max).trimEnd() + "…" : t;
}

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

export default function TemplatesTab() {
  const { org } = useOutletContext() ?? {};

  const [templates, setTemplates] = useState(null); // null = loading
  const [loadErr, setLoadErr] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // editing: null (list view) | { id?, name, subject, editableText }
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setTemplates(null);
      setLoadErr(null);
      const { data, error } = await supabase
        .from("saved_email_templates")
        .select("id, name, subject, body_html, updated_at, email_attachments")
        .eq("organization_id", org.id)
        .order("updated_at", { ascending: false });
      if (cancelled) return;
      if (error) { setLoadErr(error.message); setTemplates([]); return; }
      setTemplates(data ?? []);
    })();
    return () => { cancelled = true; };
  }, [org?.id, refreshKey]);

  const startNew = () => setEditing({ name: "", subject: "", editableText: "" });
  const startEdit = (t) => setEditing({
    id: t.id,
    name: t.name ?? "",
    subject: t.subject ?? "",
    editableText: htmlToEditable(t.body_html ?? ""),
    email_attachments: Array.isArray(t.email_attachments) ? t.email_attachments : [],
  });

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 32px" }}>
      <FamilyCommsTabs active="templates" />

      <header style={{ marginBottom: 20, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ color: INK, fontSize: 26, fontWeight: 800, margin: "0 0 8px" }}>
            Templates
          </h1>
          <p style={{ color: MUTED, fontSize: 15, lineHeight: 1.55, margin: 0, maxWidth: 620 }}>
            Save an email you send often, so you can reuse it in one click. When
            you&apos;re writing a campaign email, click <em>Use a saved template</em> to
            drop one in.
          </p>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={startNew}
            style={{
              background: BRIGHT, color: "#fff", border: "none", borderRadius: 999,
              padding: "10px 18px", fontSize: 14, fontWeight: 700, fontFamily: "inherit",
              cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            + New template
          </button>
        )}
      </header>

      {editing ? (
        <TemplateEditor
          org={org}
          value={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); setRefreshKey((k) => k + 1); }}
        />
      ) : templates === null ? (
        <p style={{ color: MUTED, fontSize: 14 }}>Loading your templates…</p>
      ) : loadErr ? (
        <p style={{ color: RED, fontSize: 14 }}>Couldn&apos;t load your templates. Refresh and try again.</p>
      ) : templates.length === 0 ? (
        <div style={{
          border: `1px dashed ${RULE}`, borderRadius: 12, padding: "36px 24px",
          textAlign: "center", background: "#fff",
        }}>
          <div style={{ fontSize: 15, color: INK, fontWeight: 600, marginBottom: 6 }}>
            No saved templates yet
          </div>
          <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.55, margin: "0 auto 16px", maxWidth: 420 }}>
            Save the emails you reach for again and again, a welcome, a win-back,
            a &quot;spots are filling.&quot; Write it once, reuse it anytime.
          </p>
          <button
            type="button"
            onClick={startNew}
            style={{
              background: BRIGHT, color: "#fff", border: "none", borderRadius: 999,
              padding: "10px 18px", fontSize: 14, fontWeight: 700, fontFamily: "inherit", cursor: "pointer",
            }}
          >
            + New template
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {templates.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              onEdit={() => startEdit(t)}
              onDeleted={() => setRefreshKey((k) => k + 1)}
              orgId={org?.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateCard({ template, onEdit, onDeleted, orgId }) {
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState(null);

  const doDelete = async () => {
    setDeleting(true);
    setErr(null);
    const { error } = await supabase
      .from("saved_email_templates")
      .delete()
      .eq("id", template.id)
      .eq("organization_id", orgId);
    setDeleting(false);
    if (error) { setErr("Couldn't delete. Try again."); setConfirming(false); return; }
    onDeleted();
  };

  return (
    <div style={{
      border: `1px solid ${RULE}`, borderRadius: 12, background: "#fff", padding: 16,
      display: "flex", gap: 14, alignItems: "flex-start",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: INK }}>{template.name}</div>
        {template.subject && (
          <div style={{ fontSize: 13, color: INK, marginTop: 3 }}>
            <span style={{ color: MUTED }}>Subject: </span>{template.subject}
          </div>
        )}
        <div style={{ fontSize: 13, color: MUTED, marginTop: 5, lineHeight: 1.5 }}>
          {snippet(template.body_html) || <em>No body yet</em>}
        </div>
        <div style={{ fontSize: 11, color: MUTED, marginTop: 8 }}>
          Updated {fmtDate(template.updated_at)}
        </div>
        {err && <div style={{ fontSize: 12, color: RED, marginTop: 6 }}>{err}</div>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
        <button
          type="button"
          onClick={onEdit}
          style={{
            background: "#fff", border: `1px solid ${RULE}`, color: INK,
            padding: "6px 14px", borderRadius: 999, fontSize: 12, fontFamily: "inherit", cursor: "pointer",
          }}
        >
          Edit
        </button>
        {confirming ? (
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={doDelete}
              disabled={deleting}
              style={{
                background: RED, border: "none", color: "#fff",
                padding: "6px 10px", borderRadius: 999, fontSize: 12, fontFamily: "inherit",
                cursor: deleting ? "wait" : "pointer",
              }}
            >
              {deleting ? "…" : "Delete"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={deleting}
              style={{
                background: "#fff", border: `1px solid ${RULE}`, color: MUTED,
                padding: "6px 10px", borderRadius: 999, fontSize: 12, fontFamily: "inherit", cursor: "pointer",
              }}
            >
              Keep
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            style={{
              background: "#fff", border: `1px solid ${RULE}`, color: RED,
              padding: "6px 14px", borderRadius: 999, fontSize: 12, fontFamily: "inherit", cursor: "pointer",
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

function TemplateEditor({ org, value, onCancel, onSaved }) {
  const [name, setName] = useState(value.name);
  const [subject, setSubject] = useState(value.subject);
  const [editableText, setEditableText] = useState(value.editableText);
  const [emailAttachments, setEmailAttachments] = useState(
    Array.isArray(value.email_attachments) ? value.email_attachments : [],
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const bodyHtml = editableToHtml(editableText);
  const canSave = name.trim().length > 0 && !saving;

  const save = async () => {
    if (!name.trim()) { setErr("Give your template a name so you can find it later."); return; }
    if (!org?.id) { setErr("Couldn't find your org. Refresh and try again."); return; }
    setSaving(true);
    setErr(null);
    const row = {
      organization_id: org.id,
      name: name.trim(),
      subject: subject.trim() || null,
      body_html: bodyHtml || null,
      body_text: stripHtml(bodyHtml) || null,
      email_attachments: emailAttachments ?? [],
    };
    let error;
    if (value.id) {
      // Bump updated_at on edit so the list re-sorts most-recent-first. On
      // INSERT we let the DB default (now()) own it — one server clock, no
      // client-skew in the sort order (matches the save-from-editor path).
      ({ error } = await supabase
        .from("saved_email_templates")
        .update({ ...row, updated_at: new Date().toISOString() })
        .eq("id", value.id)
        .eq("organization_id", org.id));
    } else {
      const { data: userData } = await supabase.auth.getUser();
      ({ error } = await supabase
        .from("saved_email_templates")
        .insert({ ...row, created_by: userData?.user?.id ?? null }));
    }
    setSaving(false);
    if (error) { setErr("Couldn't save your template. Try again."); return; }
    onSaved();
  };

  const inputStyle = {
    width: "100%", padding: "10px 12px", border: `1px solid ${RULE}`, borderRadius: 8,
    fontSize: 14, fontFamily: "inherit", color: INK, background: "#fff", boxSizing: "border-box",
  };
  const labelStyle = {
    fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4,
    fontWeight: 600, display: "block", marginBottom: 5,
  };

  return (
    <div style={{ border: `1px solid ${RULE}`, borderRadius: 12, background: "#fff", padding: 20, display: "grid", gap: 16 }}>
      <div>
        <label style={labelStyle}>Template name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Welcome new family"
          style={inputStyle}
          autoFocus
        />
        <p style={{ margin: "6px 0 0", fontSize: 11, color: MUTED }}>
          Just for you, so you can find it. Families never see this name.
        </p>
      </div>

      <div>
        <label style={labelStyle}>Subject</label>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="e.g. Welcome to {{org_name}}!"
          style={inputStyle}
        />
      </div>

      <div>
        <label style={labelStyle}>Email body</label>
        <textarea
          value={editableText}
          onChange={(e) => setEditableText(e.target.value)}
          rows={12}
          placeholder="Write your email here. Leave a blank line to start a new paragraph."
          style={{ ...inputStyle, lineHeight: 1.55, resize: "vertical" }}
        />
        <p style={{ margin: "6px 0 0", fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
          Blank line = new paragraph. Square brackets{" "}
          <span style={{ fontFamily: "ui-monospace, monospace" }}>[link text]({"{{register_url}}"})</span>{" "}
          make a clickable button. Tags like{" "}
          <span style={{ fontFamily: "ui-monospace, monospace" }}>{"{{first_name}}"}</span>{" "}
          get filled in for each family when you send.
        </p>
      </div>

      <div>
        <AttachmentPicker
          orgId={org?.id}
          emailAttachments={emailAttachments}
          onChange={setEmailAttachments}
          allowAttach={false}
          primaryColor={BRIGHT}
        />
      </div>

      {bodyHtml && (
        <div>
          <label style={labelStyle}>Preview</label>
          <div
            style={{ padding: "14px 16px", border: `1px solid ${RULE}`, borderRadius: 8, background: "#faf8f1", fontSize: 14, color: INK, lineHeight: 1.55 }}
            dangerouslySetInnerHTML={{ __html: highlightTokens(bodyHtml) }}
          />
        </div>
      )}

      {err && <div style={{ fontSize: 13, color: RED }}>{err}</div>}

      <div style={{ display: "flex", gap: 10 }}>
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          style={{
            background: canSave ? BRIGHT : "#cfc6dc", color: "#fff", border: "none", borderRadius: 999,
            padding: "10px 20px", fontSize: 14, fontWeight: 700, fontFamily: "inherit",
            cursor: canSave ? "pointer" : "not-allowed",
          }}
        >
          {saving ? "Saving…" : value.id ? "Save changes" : "Save template"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          style={{
            background: "#fff", border: `1px solid ${RULE}`, color: INK, borderRadius: 999,
            padding: "10px 20px", fontSize: 14, fontFamily: "inherit", cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
