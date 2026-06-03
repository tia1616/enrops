// AutomationEditor — per-template editor drawer.
//
// Opens from the right side. Operator can:
//   - Edit subject (default = template.default_subject, override = automations.subject_override)
//   - Edit body  (HTML textarea — operators see the same markup the engine renders)
//   - See live preview with sample tokens substituted, in a sandboxed iframe
//   - Send a test email to themselves (uses POST {mode:"test_send"} on lifecycle cron)
//   - Reset overrides → revert to template defaults
//
// Token chip row is informational (read-only) for v1 — clickable insertion is
// a v2 polish if operators ask for it. The displayed token list is per-template
// since different workflows have different tokens available.
//
// Preview iframe uses sandbox="allow-popups allow-popups-to-escape-sandbox" +
// server-injected <base target="_blank"> per guardrails section 6C — keeps
// clicks safe AND opens links in a new tab instead of blanking the iframe.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../../lib/supabase.js";
import { PURPLE, INK, MUTED, RULE, OK, WARN } from "../marketing/tokens.jsx";
import { editableToHtml, highlightTokens, htmlToEditable } from "./bodyEditorUtils.js";

// Per-template token availability. Mirrors what the cron's buildTokens emits
// for each trigger type. Keep in sync with lifecycle-automations-cron/index.ts.
// {{sender_name}} = the person who sends (stripped of " @ Org" suffix);
// useful in sign-offs for a personal touch.
const TOKENS_BY_TEMPLATE_KEY = {
  thank_you:              ["first_name", "child_first_name", "org_name", "sender_name", "registration_summary_block"],
  welcome_camp:           ["first_name", "child_first_name", "org_name", "sender_name", "program_name", "program_start_date", "location_name", "final_showcase_block", "next_term_link_block", "register_url"],
  welcome_afterschool:    ["first_name", "child_first_name", "org_name", "sender_name", "program_name", "program_start_date", "location_name", "next_term_link_block", "register_url"],
  check_in:               ["first_name", "child_first_name", "org_name", "sender_name", "program_name", "register_url"],
  mid_recap:              ["first_name", "child_first_name", "org_name", "sender_name", "program_name", "register_url"],
  final_recap:            ["first_name", "child_first_name", "org_name", "sender_name", "program_name", "program_end_date", "final_showcase_block", "next_term_link_block", "register_url"],
  birthday:               ["first_name", "child_first_name", "org_name", "sender_name", "age_turning"],
  abandoned_registration: ["first_name", "child_first_name", "org_name", "sender_name", "program_name", "abandoned_resume_url"],
  survey_nudge:           ["first_name", "child_first_name", "org_name", "sender_name", "program_name"],
};

// HTML-pre-rendered tokens — preview passes their sample HTML through verbatim.
const PRE_RENDERED_HTML_TOKENS = new Set(["final_showcase_block", "registration_summary_block", "next_term_link_block"]);

// Sample values for the live preview. Tenant-aware — pre-rendered blocks
// use the org's actual primary_color so what operators see matches what
// parents receive. {{sender_name}} sample is intentionally just a first name
// to demonstrate the stripped form that lands in sign-offs.
function sampleTokens(orgName, senderName, primaryColor) {
  const color = primaryColor || "#1C004F";
  return {
    first_name: "Sarah",
    child_first_name: "Mia",
    org_name: orgName || "Your organization",
    sender_name: (senderName?.split(" @ ")[0]?.trim()) || "You",
    program_name: "Mini Robotics",
    program_start_date: "Monday, June 17",
    program_end_date: "Friday, June 21",
    location_name: "Beaverton STEAM Hub",
    age_turning: "8",
    abandoned_resume_url: "#",
    register_url: "https://enrops.com/your-org",
    final_showcase_block:
      `<div style="background:#f5f4ee;border-left:3px solid ${color};padding:12px 16px;margin:16px 0;border-radius:0 6px 6px 0;"><strong>On the final day:</strong> Campers host a Playtest Arcade where every kid loads their finished platformer onto a Chromebook and the whole group rotates through playing each other's games.</div>`,
    registration_summary_block:
      '<div style="background:#f5f4ee;padding:16px;margin:16px 0;border-radius:6px;color:#6b6880;font-style:italic;">[Auto-generated registration details will appear here in the real send — program rows, location, day/time, payment summary.]</div>',
    next_term_link_block:
      `<p style="margin-top:24px;padding-top:16px;border-top:1px solid #ede9fe;font-size:14px;color:#1A1530;">Looking ahead? <a href="#" style="color:${color};font-weight:600;text-decoration:none;">See what's coming next &rarr;</a></p>`,
  };
}

function escapeHtmlSafe(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTokens(template, tokens) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const v = tokens[key];
    if (v == null) return match;
    return PRE_RENDERED_HTML_TOKENS.has(key) ? v : escapeHtmlSafe(v);
  });
}

function buildPreviewHtml(subject, body, orgName, senderName, logoUrl, primaryColor) {
  const tokens = sampleTokens(orgName, senderName, primaryColor);
  const renderedSubject = renderTokens(subject, tokens);
  const renderedBody = renderTokens(body, tokens);
  // Shell matches the cron's wrapInShell — tenant logo on white, no generic
  // platform gradient. Wordmark fallback when no logo is set.
  const safeName = escapeHtmlSafe(orgName || "Your organization");
  const color = primaryColor || "#1C004F";
  const logoBlock = logoUrl
    ? `<img src="${escapeHtmlSafe(logoUrl)}" alt="${safeName}" style="max-height:56px;display:block;margin:0 auto;" />`
    : `<div style="color:${color};font-size:18px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;text-align:center;">${safeName}</div>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><base target="_blank"><title>${escapeHtmlSafe(renderedSubject)}</title></head>
<body style="margin:0;padding:0;background:#fbfaf6;font-family:'Nunito Sans',Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;background:#fff;">
  <div style="padding:8px 30px 12px;color:#6b6880;font-size:12px;background:#fbfaf6;"><strong>Subject:</strong> ${escapeHtmlSafe(renderedSubject)}</div>
  <div style="padding:32px 30px 8px;text-align:center;">${logoBlock}</div>
  <div style="padding:16px 30px 32px;color:#1A1530;font-size:16px;line-height:1.6;">${renderedBody}</div>
  <div style="padding:18px 30px;text-align:center;color:#888;font-size:11px;border-top:1px solid #eee;">${safeName} &middot; Powered by Enrops &middot; ${new Date().getFullYear()}</div>
</div>
</body></html>`;
}

export default function AutomationEditor({ template, automation, orgId, orgName, orgLogoUrl, orgSenderName, orgPrimaryColor, userEmail, onClose, onSaved }) {
  const [subject, setSubject] = useState(automation?.subject_override ?? template.default_subject);
  const [body, setBody] = useState(automation?.body_override ?? template.default_body);
  // Toggle: false = render the HTML with token pills; true = textarea with
  // markdown-ish editable text. body stays canonical HTML throughout.
  const [editingBody, setEditingBody] = useState(false);
  const [editableText, setEditableText] = useState("");
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [testEmail, setTestEmail] = useState(userEmail || "");
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  function toggleBodyEdit() {
    if (editingBody) {
      // Done editing — already pushed each keystroke into body via editableToHtml.
      setEditingBody(false);
    } else {
      setEditableText(htmlToEditable(body));
      setEditingBody(true);
    }
  }

  function handleEditableChange(newText) {
    setEditableText(newText);
    setBody(editableToHtml(newText));
  }

  // Reset success/error after a few seconds
  useEffect(() => {
    if (!success && !error) return;
    const t = setTimeout(() => { setSuccess(null); setError(null); }, 6000);
    return () => clearTimeout(t);
  }, [success, error]);

  const previewHtml = useMemo(
    () => buildPreviewHtml(subject, body, orgName, orgSenderName, orgLogoUrl, orgPrimaryColor),
    [subject, body, orgName, orgSenderName, orgLogoUrl, orgPrimaryColor],
  );

  const tokens = TOKENS_BY_TEMPLATE_KEY[template.key] ?? [];
  const hasOverride = (automation?.subject_override != null) || (automation?.body_override != null);
  const subjectDirty = subject !== (automation?.subject_override ?? template.default_subject);
  const bodyDirty = body !== (automation?.body_override ?? template.default_body);
  const dirty = subjectDirty || bodyDirty;

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      // Only set overrides for fields that actually differ from defaults —
      // keeps the table clean and makes "Reset" semantically simple.
      const subjectOverride = subject !== template.default_subject ? subject : null;
      const bodyOverride = body !== template.default_body ? body : null;
      let result;
      if (automation?.id) {
        const { data, error: upErr } = await supabase
          .from("automations")
          .update({ subject_override: subjectOverride, body_override: bodyOverride })
          .eq("id", automation.id)
          .select()
          .single();
        if (upErr) throw upErr;
        result = data;
      } else {
        const { data, error: insErr } = await supabase
          .from("automations")
          .insert({
            organization_id: orgId,
            template_id: template.id,
            enabled: false,
            subject_override: subjectOverride,
            body_override: bodyOverride,
          })
          .select()
          .single();
        if (insErr) throw insErr;
        result = data;
      }
      setSuccess("Saved.");
      if (onSaved) onSaved(result);
    } catch (e) {
      setError(e?.message ?? "Save failed — try again");
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!automation?.id) {
      // No row to reset — just revert local editor state.
      setSubject(template.default_subject);
      setBody(template.default_body);
      return;
    }
    setResetting(true);
    setError(null);
    setSuccess(null);
    try {
      const { data, error: upErr } = await supabase
        .from("automations")
        .update({ subject_override: null, body_override: null })
        .eq("id", automation.id)
        .select()
        .single();
      if (upErr) throw upErr;
      setSubject(template.default_subject);
      setBody(template.default_body);
      setSuccess("Reset to template defaults.");
      if (onSaved) onSaved(data);
    } catch (e) {
      setError(e?.message ?? "Reset failed — try again");
    } finally {
      setResetting(false);
    }
  }

  async function handleSendTest() {
    if (!testEmail || !testEmail.includes("@")) {
      setError("Enter a valid email to send a test.");
      return;
    }
    setSendingTest(true);
    setError(null);
    setSuccess(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke(
        "lifecycle-automations-cron",
        {
          body: {
            mode: "test_send",
            organization_id: orgId,
            template_key: template.key,
            test_to_email: testEmail,
            // Use current editor state (not saved values) so the operator
            // tests what they're looking at right now.
            preview_subject: subject,
            preview_body: body,
          },
        },
      );
      if (fnErr) throw fnErr;
      if (data?.ok === false) {
        throw new Error(data?.error ?? "Send failed");
      }
      setSuccess(`Test sent to ${testEmail}. Check your inbox.`);
    } catch (e) {
      setError(e?.message ?? "Test send failed — try again");
    } finally {
      setSendingTest(false);
    }
  }

  return (
    <div
      role="region"
      aria-label={`Edit ${template.display_name}`}
      style={{
        marginTop: 12, borderTop: `1px dashed ${RULE}`, paddingTop: 16,
      }}
    >
      {/* Body — inline expansion within the parent row. No drawer, no
          backdrop. The Edit button on the row owns the open/close toggle. */}
      <div style={{ padding: 0 }}>
          {/* Subject */}
          <label style={{ display: "block", marginBottom: 16 }}>
            <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: INK, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
              Subject
            </span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              style={{
                width: "100%", padding: "10px 12px", fontSize: 14, color: INK,
                border: `1px solid ${RULE}`, borderRadius: 6, outline: "none",
                background: "#fff",
              }}
            />
          </label>

          {/* Body — toggle between rendered display (default) and markdown-ish
              edit mode. Operators never see raw HTML tags. Pattern mirrors
              the campaign BodyEditor in TouchpointCard.jsx. */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: INK, textTransform: "uppercase", letterSpacing: 1 }}>
                Body
              </span>
              <button
                type="button"
                onClick={toggleBodyEdit}
                style={{
                  background: "transparent", border: "none", color: PURPLE,
                  cursor: "pointer", fontSize: 13, fontWeight: 600,
                }}
              >
                {editingBody ? "Done editing" : "Edit"}
              </button>
            </div>
            {editingBody ? (
              <>
                <textarea
                  value={editableText}
                  onChange={(e) => handleEditableChange(e.target.value)}
                  rows={14}
                  style={{
                    width: "100%", padding: "12px 14px", fontSize: 14, color: INK,
                    border: `1px solid ${RULE}`, borderRadius: 6, outline: "none",
                    background: "#fff", resize: "vertical", lineHeight: 1.55,
                    fontFamily: "inherit", boxSizing: "border-box",
                  }}
                />
                <p style={{ margin: "6px 0 0", fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
                  Blank line = new paragraph. <strong>**text**</strong> = bold,
                  <em> _text_</em> = italic.
                  <span style={{ fontFamily: "ui-monospace, monospace" }}> [link text]({"{{register_url}}"})</span> = clickable link.
                </p>
              </>
            ) : (
              <div
                onClick={toggleBodyEdit}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); toggleBodyEdit(); } }}
                style={{
                  padding: "14px 16px", border: `1px solid ${RULE}`, borderRadius: 6,
                  background: "#fff", fontSize: 14, color: INK, lineHeight: 1.55,
                  cursor: "text",
                }}
                dangerouslySetInnerHTML={{ __html: highlightTokens(body) }}
              />
            )}
          </div>

          {/* Available tokens */}
          <div style={{ marginBottom: 24 }}>
            <span style={{ display: "block", fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
              Available tokens
            </span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {tokens.map((t) => (
                <code
                  key={t}
                  style={{
                    background: "#f5f4ee", color: PURPLE, padding: "3px 8px", borderRadius: 4,
                    fontSize: 12, fontFamily: "monospace",
                  }}
                  title={PRE_RENDERED_HTML_TOKENS.has(t) ? "Pre-rendered HTML — drop into body where you want the block" : "Plain text — safe in body or attributes"}
                >
                  {`{{${t}}}`}
                </code>
              ))}
            </div>
          </div>

          {/* Live preview */}
          <div style={{ marginBottom: 8 }}>
            <span style={{ display: "block", fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
              Live preview · sample data
            </span>
            <iframe
              title="email preview"
              srcDoc={previewHtml}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              style={{
                width: "100%", height: 480, border: `1px solid ${RULE}`, borderRadius: 8,
                background: "#fff",
              }}
            />
          </div>

          {/* Status banner */}
          {(error || success) && (
            <div
              role="alert"
              style={{
                marginTop: 12,
                padding: "10px 14px",
                borderRadius: 6,
                fontSize: 13,
                background: error ? "#fef2f2" : "#ecf6ec",
                color: error ? "#7c2d12" : OK,
                border: `1px solid ${error ? WARN : OK}`,
              }}
            >
              {error || success}
            </div>
          )}
        </div>

        {/* Action bar — sits below the editor content, no longer a fixed footer */}
        <div style={{ marginTop: 16, padding: "16px", borderTop: `1px solid ${RULE}`, background: "#fbfaf6", borderRadius: 8, display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Send test row */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="email"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              placeholder="test@example.com"
              style={{
                flex: 1, padding: "8px 12px", fontSize: 13,
                border: `1px solid ${RULE}`, borderRadius: 6, outline: "none",
                background: "#fff", color: INK,
              }}
            />
            <button
              type="button"
              onClick={handleSendTest}
              disabled={sendingTest || !testEmail}
              style={{
                background: "#fff", color: PURPLE, border: `1px solid ${PURPLE}`,
                padding: "8px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600,
                cursor: sendingTest || !testEmail ? "not-allowed" : "pointer",
                opacity: sendingTest || !testEmail ? 0.5 : 1,
                whiteSpace: "nowrap",
              }}
            >
              {sendingTest ? "Sending…" : "Send test"}
            </button>
          </div>
          {/* Save / Reset row */}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={handleReset}
              disabled={resetting || saving || !hasOverride}
              style={{
                background: "transparent", color: MUTED, border: "none",
                padding: "8px 12px", fontSize: 13, cursor: resetting || saving || !hasOverride ? "not-allowed" : "pointer",
                opacity: resetting || saving || !hasOverride ? 0.4 : 1,
              }}
              title={!hasOverride ? "No overrides to reset" : "Revert to template defaults"}
            >
              {resetting ? "Resetting…" : "Reset to default"}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !dirty}
              style={{
                background: dirty ? PURPLE : "#d6d3c8",
                color: "#fff", border: "none",
                padding: "8px 20px", borderRadius: 6, fontSize: 13, fontWeight: 700,
                cursor: saving || !dirty ? "not-allowed" : "pointer",
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
    </div>
  );
}
