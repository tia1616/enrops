// TemplatesTab — the Comms "Templates" surface, now a SHARED TEMPLATE SHELF.
//
// Why this exists: operators send the same kinds of emails over and over
// (a welcome, a win-back, a "spots are filling"). Saved templates let them
// write the wording ONCE, name it, and reuse it — instead of rebuilding it or
// digging up an old campaign every time. Richelle's ask.
//
// Comms is one hub for THREE audiences, so the shelf holds copy for each:
//   • Families    — campaign email (also reachable from a campaign touchpoint's
//                   "Save as template" / "Use a saved template").
//   • Instructors — availability surveys, class offers, sub requests.
//   • Partners    — what you email a partner site (e.g. a class roster).
// An audience switcher (mirrors Comms>Contacts) scopes the list; the in-context
// send buttons (Schedule / roster) read their audience's templates from here.
//
// This tab is where templates are CREATED and MANAGED. Reusing a FAMILY one also
// happens inside a campaign email: TouchpointCard has "Save as template" and
// "Use a saved template" (family-scoped) so the loop closes where the operator
// is actually writing.
//
// Storage: saved_email_templates, one row per template, `audience` column added
// in 20260721c (RLS gates to org owner/admin — same policy for every audience).
// Body is the same friendly-editor HTML as campaign touchpoints, so merge tags
// like {{first_name}} survive and render the same way when reused.
//
// Org comes from useOutletContext — never hardcoded. Copy is tenant-neutral.

import { useEffect, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import { BRIGHT, INK, MUTED, RULE } from "../marketing/tokens.jsx";
import FamilyCommsTabs from "./FamilyCommsTabs.jsx";
import AttachmentPicker from "./AttachmentPicker.jsx";
import AudienceSwitcher from "./AudienceSwitcher.jsx";
import { htmlToEditable, editableToHtml, highlightTokens, stripHtml } from "./bodyEditorUtils.js";

const RED = "#b53737";

// Instructor templates can be tagged with WHICH board send they feed. The
// Schedule board seeds that send's editable copy box from the org's template
// with the matching purpose (most-recently-updated wins if several share one).
// "" = a general instructor template with no board binding (reuse by hand).
// Only offered for the instructors audience; families/partners save null.
const INSTRUCTOR_PURPOSES = [
  { value: "", label: "General — not tied to a send" },
  { value: "availability_survey", label: "Availability survey" },
  { value: "assignment_offer", label: "Class / assignment offer" },
  { value: "sub_offer", label: "Sub & cover request" },
];
const PURPOSE_LABEL = {
  availability_survey: "Availability survey",
  assignment_offer: "Class offer",
  sub_offer: "Sub & cover",
};

// Per-audience copy for the shelf. Only surface text differs; the editor, storage,
// and RLS are identical across audiences. Families keeps the merge-token hint it
// ships with today; instructor/partner hints stay honest — they don't promise a
// token the send buttons don't yet fill in (that lands with Chunk 4).
const AUDIENCES = {
  families: {
    key: "families",
    label: "Families",
    intro: (
      <>
        Save an email you send often, so you can reuse it in one click. When
        you&apos;re writing a campaign email, click <em>Use a saved template</em> to
        drop one in.
      </>
    ),
    nameHint: "Just for you, so you can find it. Families never see this name.",
    subjectPlaceholder: "e.g. Welcome to {{org_name}}!",
    bodyHint: (
      <>
        Blank line = new paragraph. Square brackets{" "}
        <span style={{ fontFamily: "ui-monospace, monospace" }}>[link text]({"{{register_url}}"})</span>{" "}
        make a clickable button. Tags like{" "}
        <span style={{ fontFamily: "ui-monospace, monospace" }}>{"{{first_name}}"}</span>{" "}
        get filled in for each family when you send.
      </>
    ),
    emptyTitle: "No family templates yet",
    emptyBody: (
      <>
        Save the emails you reach for again and again, a welcome, a win-back,
        a &quot;spots are filling.&quot; Write it once, reuse it anytime.
      </>
    ),
  },
  instructors: {
    key: "instructors",
    label: "Instructors",
    intro: (
      <>
        Draft and save the wording you use with your instructors — an
        availability survey, a class offer, a sub request — so it&apos;s written
        once and ready to reuse.
      </>
    ),
    nameHint: "Just for you, so you can find it. Instructors never see this name.",
    subjectPlaceholder: "e.g. Your classes for next week",
    bodyHint: (
      <>
        Blank line = new paragraph. Keep the wording you use for availability
        surveys, class offers, or sub requests here, written once and ready to
        reuse.
      </>
    ),
    emptyTitle: "No instructor templates yet",
    emptyBody: (
      <>
        Save the messages you send your instructors again and again — an
        availability survey, a class offer, a sub request. Write it once, reuse
        it anytime.
      </>
    ),
  },
  partners: {
    key: "partners",
    label: "Partners",
    intro: (
      <>
        Save the wording you use when you email a partner site — like sending a
        class roster — so you can reuse it instead of rewriting it.
      </>
    ),
    nameHint: "Just for you, so you can find it. Partners never see this name.",
    subjectPlaceholder: "e.g. This week's class roster",
    bodyHint: (
      <>
        Blank line = new paragraph. Save the wording you use when you email a
        partner site — like the note that goes with a class roster — so you can
        reuse it.
      </>
    ),
    emptyTitle: "No partner templates yet",
    emptyBody: (
      <>
        Save the messages you send your partner sites again and again — like the
        note that goes with a class roster. Write it once, reuse it anytime.
      </>
    ),
  },
};

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
  const [params, setParams] = useSearchParams();

  // Audience rides in the URL (?audience=) so it survives refresh + deep links
  // and matches Comms>Contacts. Default (no param) = families, so the campaign
  // template experience is byte-for-byte unchanged.
  const audience = ["instructors", "partners"].includes(params.get("audience"))
    ? params.get("audience")
    : "families";
  const cfg = AUDIENCES[audience];

  const [templates, setTemplates] = useState(null); // null = loading
  const [loadErr, setLoadErr] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // editing: null (list view) | { id?, name, subject, editableText }
  const [editing, setEditing] = useState(null);
  // Whether the open editor has unsaved edits — lets the audience switch nudge
  // before it throws the draft away (the editor reports this up).
  const [editorDirty, setEditorDirty] = useState(false);

  function selectAudience(a) {
    // Switching audience closes the editor (below), which would silently drop an
    // in-progress draft — confirm first if there are unsaved changes.
    if (editing && editorDirty && !window.confirm("Discard your unsaved changes to this template?")) return;
    const next = new URLSearchParams(params);
    if (a === "families") next.delete("audience");
    else next.set("audience", a);
    setParams(next, { replace: true });
  }

  // Leaving the editor when the audience changes prevents saving a draft under
  // the wrong audience (the editor writes whichever audience is active). The
  // switch is guarded above, so by here the operator has already confirmed.
  useEffect(() => { setEditing(null); }, [audience]);

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setTemplates(null);
      setLoadErr(null);
      const { data, error } = await supabase
        .from("saved_email_templates")
        .select("id, name, subject, body_html, updated_at, email_attachments, purpose")
        .eq("organization_id", org.id)
        .eq("audience", audience)
        .order("updated_at", { ascending: false });
      if (cancelled) return;
      if (error) { setLoadErr(error.message); setTemplates([]); return; }
      setTemplates(data ?? []);
    })();
    return () => { cancelled = true; };
  }, [org?.id, audience, refreshKey]);

  const startNew = () => setEditing({ name: "", subject: "", editableText: "", purpose: "" });
  const startEdit = (t) => setEditing({
    id: t.id,
    name: t.name ?? "",
    subject: t.subject ?? "",
    editableText: htmlToEditable(t.body_html ?? ""),
    email_attachments: Array.isArray(t.email_attachments) ? t.email_attachments : [],
    purpose: t.purpose ?? "",
  });

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 32px" }}>
      <FamilyCommsTabs active="templates" />
      <AudienceSwitcher active={audience} onSelect={selectAudience} label="Template audience" />

      <header style={{ marginBottom: 20, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ color: INK, fontSize: 26, fontWeight: 800, margin: "0 0 8px" }}>
            Templates
          </h1>
          <p style={{ color: MUTED, fontSize: 15, lineHeight: 1.55, margin: 0, maxWidth: 620 }}>
            {cfg.intro}
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
          audience={audience}
          cfg={cfg}
          value={editing}
          onDirtyChange={setEditorDirty}
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
            {cfg.emptyTitle}
          </div>
          <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.55, margin: "0 auto 16px", maxWidth: 420 }}>
            {cfg.emptyBody}
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
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: INK }}>{template.name}</div>
          {PURPOSE_LABEL[template.purpose] && (
            <span style={{
              fontSize: 11, fontWeight: 600, color: "#5a3fa0", background: "#efe9f7",
              padding: "2px 9px", borderRadius: 999, whiteSpace: "nowrap",
            }}>
              Feeds: {PURPOSE_LABEL[template.purpose]}
            </span>
          )}
        </div>
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

function TemplateEditor({ org, audience, cfg, value, onDirtyChange, onCancel, onSaved }) {
  const [name, setName] = useState(value.name);
  const [subject, setSubject] = useState(value.subject);
  const [editableText, setEditableText] = useState(value.editableText);
  const [purpose, setPurpose] = useState(value.purpose ?? "");
  const [emailAttachments, setEmailAttachments] = useState(
    Array.isArray(value.email_attachments) ? value.email_attachments : [],
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const isInstructor = audience === "instructors";
  const bodyHtml = editableToHtml(editableText);
  const canSave = name.trim().length > 0 && !saving;

  // Dirty = any field differs from what we opened with. Powers both the Cancel
  // confirm and the parent's audience-switch nudge. Attachments compare by value.
  const dirty =
    name !== value.name ||
    subject !== value.subject ||
    editableText !== value.editableText ||
    (purpose ?? "") !== (value.purpose ?? "") ||
    JSON.stringify(emailAttachments ?? []) !== JSON.stringify(value.email_attachments ?? []);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false); // reset the parent when the editor closes
  }, [dirty, onDirtyChange]);

  const handleCancel = () => {
    if (dirty && !window.confirm("Discard your unsaved changes to this template?")) return;
    onCancel();
  };

  const save = async () => {
    if (!name.trim()) { setErr("Give your template a name so you can find it later."); return; }
    if (!org?.id) { setErr("Couldn't find your org. Refresh and try again."); return; }
    setSaving(true);
    setErr(null);
    const row = {
      organization_id: org.id,
      audience,
      name: name.trim(),
      subject: subject.trim() || null,
      body_html: bodyHtml || null,
      body_text: stripHtml(bodyHtml) || null,
      email_attachments: emailAttachments ?? [],
      // Purpose only applies to instructor board sends. Families/partners always
      // save null so a stray value can't linger if a template is re-audienced.
      purpose: isInstructor ? (purpose || null) : null,
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
          {cfg.nameHint}
        </p>
      </div>

      {isInstructor && (
        <div>
          <label style={labelStyle}>Use this for</label>
          <select
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            style={{ ...inputStyle, cursor: "pointer" }}
          >
            {INSTRUCTOR_PURPOSES.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <p style={{ margin: "6px 0 0", fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
            {purpose
              ? "When you send this from the Schedule board, your message box starts with this wording — you can tweak it before it goes out."
              : "Tie this to a Schedule-board send so its message box pre-fills with your wording. Leave as “General” to just keep it here for reuse."}
          </p>
        </div>
      )}

      <div>
        <label style={labelStyle}>Subject</label>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={cfg.subjectPlaceholder}
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
          {cfg.bodyHint}
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
          onClick={handleCancel}
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
