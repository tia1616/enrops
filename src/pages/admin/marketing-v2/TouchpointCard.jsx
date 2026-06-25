// TouchpointCard — one card per scheduled email in the campaign.
// Expandable. Shows summary collapsed; editor + preview when open.
// Edits are local until "Save as draft" or "Approve & Schedule" (chunk 07 wires).

import { useState } from "react";
import EditableField from "./EditableField.jsx";
import EmailPreviewDrawer from "./EmailPreviewDrawer.jsx";
import Chevron from "../../../components/Chevron.jsx";
import { supabase } from "../../../lib/supabase.js";
import { INK, MUTED, PURPLE, BRIGHT, RULE, OK, INFO } from "../marketing/tokens.jsx";

function fmtScheduled(iso, timezone) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
      timeZoneName: "short", timeZone: timezone,
    });
  } catch {
    return iso;
  }
}

function fmtDatetimeInput(iso) {
  if (!iso) return "";
  // Strip timezone for <input type="datetime-local">
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const LABEL_COLORS = {
  kickoff: "#185FA5",
  "mid-window": "#854F0B",
  "48h-promo": "#BA7517",
  "24h-promo": "#BA7517",
  "48h-reg-close": "#BA7517",
  "24h-reg-close": "#BA7517",
  "final-call": "#b3261e",
  thanks: "#3B6D11",
};

export default function TouchpointCard({
  touchpoint,
  defaultOpen = false,
  timezone,
  topicColors,
  onUpdate,
  onCommit,
  onSendTest,
  onRegenerate,
  // Picked schools for the per-school preview dropdown. Each {id, name}.
  // Empty array hides the dropdown (camps-only campaigns, one-off mode).
  pickedLocations = [],
  // True when the operator picked any curricula in Q1. When false (schedule-
  // change / photo-gallery / partner-event / free-form intents), suppress
  // the "no picked content for this audience" badge — there's nothing to
  // pick for those intents, so a red badge looks like an error when nothing
  // is actually wrong.
  hasContentPicks = true,
  // Campaign id for the preview API call. Empty disables preview.
  campaignId,
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Local pending state for the per-card Send-test button so the operator
  // gets immediate visual feedback (grayed bg + "Sending test…" label) the
  // moment they click — instead of waiting ~2s for the browser alert to pop.
  // Awaits the parent's async handler so the spinner clears on real completion.
  const [sendingTest, setSendingTest] = useState(false);
  const tp = touchpoint;
  const labelColor = LABEL_COLORS[tp.label] ?? MUTED;

  const handleSendTest = async () => {
    if (sendingTest) return;
    setSendingTest(true);
    try { await onSendTest?.(tp.id); }
    finally { setSendingTest(false); }
  };

  // Per-school preview state. previewLocationId is what the operator
  // selected from the dropdown. previewData holds the server's rendered
  // subject + body for that school. Defaults to "" (i.e. show Ennie's
  // raw {{token}} body so the operator can see which tokens get replaced).
  const [previewLocationId, setPreviewLocationId] = useState("");
  const [previewData, setPreviewData] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  // The rendered email shows in a right-side drawer (not inline) so the tall
  // email gets dedicated space while the card keeps the editor in view.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isPreviewing = !!previewLocationId;

  const loadPreview = async (locationId) => {
    if (!locationId || !campaignId) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const { data, error } = await supabase.functions.invoke("marketing-touchpoint-send", {
        body: {
          campaign_id: campaignId,
          touchpoint_id: tp.id,
          mode: "preview",
          preview_location_id: locationId,
        },
      });
      if (error) {
        let msg = error.message ?? "Preview failed.";
        try {
          const resp = error?.context?.response ?? error?.context;
          if (resp && typeof resp.clone === "function") {
            const text = await resp.clone().text();
            try { const payload = JSON.parse(text); if (payload?.error) msg = payload.error; }
            catch { /* not JSON */ }
          }
        } catch { /* ignore */ }
        setPreviewError(msg);
        return;
      }
      setPreviewData(data);
    } finally {
      setPreviewLoading(false);
    }
  };

  const onPickPreviewLocation = (e) => {
    const id = e.target.value;
    setPreviewLocationId(id);
    if (!id) { setPreviewData(null); setPreviewError(null); setDrawerOpen(false); return; }
    setDrawerOpen(true);
    loadPreview(id);
  };

  // Status badges (VIP shown/suppressed, no-content) shown both inline by the
  // dropdown and inside the preview drawer.
  const previewBadges = [];
  if (isPreviewing && previewData) {
    if (previewData.vip_block_shown === false) previewBadges.push({ label: "VIP block suppressed here", color: "#854F0B", bg: "#FAEEDA" });
    if (previewData.vip_block_shown === true) previewBadges.push({ label: "VIP block shown", color: OK, bg: "#EAF3DE" });
    if (previewData.program_matched === false && hasContentPicks) previewBadges.push({ label: "No picked content for this audience", color: "#b3261e", bg: "#fce4ec" });
  }

  return (
    <>
    <div style={{ border: `1px solid ${RULE}`, borderRadius: 12, marginBottom: 10, background: "#fff", overflow: "hidden" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 12,
          background: open ? "#faf8f1" : "#fff", border: "none", borderBottom: open ? `1px solid ${RULE}` : "none",
          padding: 12, cursor: "pointer", textAlign: "left", fontFamily: "inherit",
        }}
      >
        <span style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 34, height: 34, borderRadius: 6, background: "#f0e3e8", color: PURPLE,
          fontWeight: 700, fontSize: 16, flexShrink: 0,
        }}>
          {tp.type === "email" ? "✉" : tp.type === "social" ? "📣" : "📄"}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{
              fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5,
              color: labelColor, padding: "2px 6px", borderRadius: 999, background: "rgba(0,0,0,0.04)",
            }}>{tp.label}</span>
            {/* Topic chips intentionally dropped 2026-06-01: with grounded
                program picks they enumerate the same N curricula on every
                touchpoint -- noisy and not informative. Subject + body
                carry what the touchpoint is about. */}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: INK, marginTop: 4, lineHeight: 1.3 }}>
            {tp.subject || "(no subject yet)"}
          </div>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
            {fmtScheduled(tp.scheduled_at, timezone)}
          </div>
        </div>
        <Chevron open={open} color={MUTED} size={14} />
      </button>

      {open && (
        <div style={{ padding: 14, display: "grid", gap: 12 }}>
          <EditableField
            label="Subject"
            value={tp.subject}
            onChange={(v) => (onCommit ?? onUpdate)(tp.id, { subject: v })}
            placeholder="Click to write a subject"
          />

          <div>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
              Send time
            </div>
            <input
              type="datetime-local"
              value={fmtDatetimeInput(tp.scheduled_at)}
              onChange={(e) => {
                const local = new Date(e.target.value);
                if (!isNaN(local.getTime())) (onCommit ?? onUpdate)(tp.id, { scheduled_at: local.toISOString() });
              }}
              style={{
                padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 6,
                fontSize: 13, fontFamily: "inherit", background: "#fff", color: INK,
              }}
            />
          </div>

          {/* Per-recipient preview dropdown. Entries vary by campaign type:
              - Afterschool catalog picks → list of schools
              - Camps catalog picks → list of areas (each area = many camps)
              - One-off scoped to schools/areas → list of those
              Picking an entry renders the touchpoint AS IF a parent at that
              school / in that area received it. Same code path as a real
              send, just no Resend call. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
              Preview as parent in
            </span>
            <select
              value={previewLocationId}
              onChange={onPickPreviewLocation}
              disabled={pickedLocations.length === 0}
              style={{
                padding: "6px 10px", border: `1px solid ${RULE}`, borderRadius: 6,
                fontSize: 13, fontFamily: "inherit",
                background: pickedLocations.length === 0 ? "#f7f4ec" : "#fff",
                color: pickedLocations.length === 0 ? MUTED : INK,
                cursor: pickedLocations.length === 0 ? "not-allowed" : "pointer",
              }}
            >
              <option value="">
                {pickedLocations.length === 0
                  ? "(no preview audience — pick a school/area scope in Q2, or this is a one-off blast to your master list)"
                  : (
                      ((kinds) => {
                        const allArea = kinds.size === 1 && kinds.has("area");
                        const allSchool = kinds.size === 1 && kinds.has("school");
                        const noun = allArea ? "area" : allSchool ? "school" : "recipient";
                        return `Pick ${allArea ? "an" : "a"} ${noun} to preview as a parent there…`;
                      })(new Set(pickedLocations.map((l) => l.kind)))
                    )}
              </option>
              {pickedLocations.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
              {isPreviewing && !drawerOpen && (
                <button
                  type="button"
                  onClick={() => setDrawerOpen(true)}
                  style={{
                    padding: "6px 12px", background: BRIGHT, color: "#fff", border: "none",
                    borderRadius: 999, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
                  }}
                >
                  Show preview
                </button>
              )}
              {previewLoading && <span style={{ fontSize: 11, color: MUTED }}>rendering…</span>}
              {previewData?.vip_block_shown === false && isPreviewing && (
                <span style={{
                  fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5,
                  color: "#854F0B", padding: "2px 8px", borderRadius: 999, background: "#FAEEDA",
                }}>
                  VIP block suppressed here
                </span>
              )}
              {previewData?.vip_block_shown === true && isPreviewing && (
                <span style={{
                  fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5,
                  color: OK, padding: "2px 8px", borderRadius: 999, background: "#EAF3DE",
                }}>
                  VIP block shown
                </span>
              )}
              {previewData?.program_matched === false && isPreviewing && hasContentPicks && (
                <span style={{
                  fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5,
                  color: "#b3261e", padding: "2px 8px", borderRadius: 999, background: "#fce4ec",
                }}>
                  No picked content for this audience
                </span>
              )}
            </div>

          {/* Always the raw editor now — the rendered, token-resolved email
              for a picked school renders in EmailPreviewDrawer (right side). */}
          <BodyEditor
            value={tp.body_html ?? ""}
            onChange={(v) => onUpdate(tp.id, { body_html: v, body_text: stripHtml(v) })}
            onCommit={(v) => onCommit?.(tp.id, { body_html: v, body_text: stripHtml(v) })}
          />

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {/* Regenerate button hidden until task #7's regenerate flag ships
                in marketing-draft-campaign. Currently fires a dev stub alert
                that we don't want operators to see. */}
            <button
              onClick={handleSendTest}
              disabled={sendingTest}
              style={{
                background: sendingTest ? "#efeae0" : "#fff",
                border: `1px solid ${RULE}`,
                color: sendingTest ? MUTED : INK,
                padding: "6px 12px", borderRadius: 999,
                cursor: sendingTest ? "wait" : "pointer",
                fontSize: 12, fontFamily: "inherit",
                transition: "background 0.15s ease, color 0.15s ease",
              }}
            >
              {sendingTest ? "Sending test…" : "Send test to me"}
            </button>
            {/* "Also lands in the parent portal feed" was sitting next to
                Send-test and read as if the test sent to parents too.
                Dropped — when the parent-portal feed ships we'll re-surface
                this info in the right place (probably on the Approve button). */}
          </div>
        </div>
      )}
    </div>

      <EmailPreviewDrawer
        open={drawerOpen && isPreviewing}
        onClose={() => setDrawerOpen(false)}
        schoolName={previewData?.used_school_name}
        subject={previewData?.subject}
        bodyHtml={previewData?.body_html}
        loading={previewLoading}
        error={previewError}
        badges={previewBadges}
      />
    </>
  );
}

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// Wraps merge tokens like {{first_name}} in a styled span so operators can
// see at a glance which bits get personalized at send time.
//
// CRITICAL: only highlights tokens in TEXT content, not tokens inside HTML
// attribute values. Wrapping a token in <span> inside <a href="..."> would
// produce `<a href="<span...>...">` — invalid HTML that the browser parses
// unpredictably, swallowing the anchor tag entirely and leaking the href as
// plain text. The negative lookahead `(?![^<]*>)` matches a token only when
// there's an unclosed `<` before the next `>`, i.e. the token sits in text
// content not inside an attribute. Bug surfaced 2026-06-02 when Ennie wrote
// `<a href="{{register_url}}">Grab the rate →</a>` and operators saw the
// rendered preview as `{{register_url}}">Grab the rate →` with no link.
function highlightTokens(html) {
  if (!html) return "";
  return html.replace(/\{\{(\w+)\}\}(?![^<]*>)/g, (_, name) =>
    `<span style="display:inline-block;padding:0 6px;border-radius:4px;background:#f0e3e8;color:#1C004F;font-size:0.9em;font-weight:600;font-family:ui-monospace,monospace;">{{${name}}}</span>`,
  );
}

// Convert stored HTML (what Ennie writes, what the server renders) into the
// plain-text form an operator edits.
// - <p>...</p> blocks become blank-line-separated blocks.
// - <a href="X">Y</a> becomes [Y](X) so the operator can edit the visible
//   text without breaking the URL.
// - <em>X</em>/<i>X</i> become _X_ and <strong>X</strong>/<b>X</b> become
//   **X**, so Ennie's emphasis survives a no-touch round-trip.
// - Merge tokens like {{first_name}} pass through untouched.
function htmlToEditable(html) {
  if (!html) return "";
  let text = html;
  text = text.replace(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => `[${inner.trim()}](${href})`);
  text = text.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => `**${inner}**`);
  text = text.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => `_${inner}_`);
  text = text.replace(/<\/p>\s*<p[^>]*>/gi, "\n\n");
  text = text.replace(/<p[^>]*>/gi, "");
  text = text.replace(/<\/p>/gi, "");
  return text.trim();
}

// Reverse: convert markdown back to HTML, then wrap each blank-line-separated
// block in <p>...</p>. Links first (so a paragraph that's just a link still
// wraps in <p>); then **bold** and _italic_. The underscore pattern requires
// non-space content so plain identifiers like _internal_method don't match
// unless they sit next to spaces or line boundaries on both sides.
function editableToHtml(text) {
  if (!text) return "";
  let html = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`);
  html = html.replace(/\*\*([^*\n]+)\*\*/g, (_, inner) => `<strong>${inner}</strong>`);
  html = html.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, (_m, pre, inner) => `${pre}<em>${inner}</em>`);
  const paragraphs = html.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paragraphs.map((p) => `<p>${p}</p>`).join("");
}

function BodyEditor({ value, onChange, onCommit }) {
  const [editing, setEditing] = useState(false);
  // Plain-text working copy used only while the textarea is open. Seeded
  // from `value` (HTML) when Edit is clicked. Bubbled back up as HTML on
  // every keystroke via onChange(editableToHtml(...)), so the parent's
  // body_html stays canonical. On Done editing we additionally call
  // onCommit(html) which PATCHes the touchpoint row to the DB so the
  // edits survive Send test, reloads, and Approve.
  const [editableText, setEditableText] = useState("");

  const toggleEditing = () => {
    if (editing) {
      const finalHtml = editableToHtml(editableText);
      onCommit?.(finalHtml);
    } else {
      setEditableText(htmlToEditable(value));
    }
    setEditing((v) => !v);
  };

  const handleTextChange = (newText) => {
    setEditableText(newText);
    onChange(editableToHtml(newText));
  };

  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 4,
      }}>
        <span style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
          Email body
        </span>
        <button
          onClick={toggleEditing}
          style={{
            background: "transparent", border: "none", color: PURPLE,
            cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600,
          }}
        >
          {editing ? "Done editing" : "Edit"}
        </button>
      </div>

      {editing ? (
        <>
          <textarea
            value={editableText}
            onChange={(e) => handleTextChange(e.target.value)}
            rows={12}
            style={{
              width: "100%", padding: "12px 14px",
              border: `1px solid ${RULE}`, borderRadius: 6,
              fontFamily: "inherit", fontSize: 14,
              lineHeight: 1.55, color: INK, background: "#fff",
              resize: "vertical", boxSizing: "border-box",
            }}
          />
          <p style={{ margin: "6px 0 0", fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
            Blank line = new paragraph. Square brackets <span style={{ fontFamily: "ui-monospace, monospace" }}>[link text]({"{{register_url}}"})</span> mark a clickable button — keep the brackets so the link still works.
          </p>
        </>
      ) : (
        <div
          style={{
            padding: "14px 16px",
            border: `1px solid ${RULE}`, borderRadius: 6,
            background: "#fff", fontSize: 14, color: INK, lineHeight: 1.55,
          }}
          dangerouslySetInnerHTML={{ __html: highlightTokens(value) }}
        />
      )}

      {!editing && (
        <div style={{ margin: "6px 0 0", fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
          <p style={{ margin: 0 }}>
            Highlighted tags like <span style={{ fontFamily: "ui-monospace, monospace" }}>{"{{first_name}}"}</span> get filled in for each parent when the email sends. Pick a school in the dropdown above to preview the real email in a side panel.
          </p>
          <p style={{ margin: "4px 0 0", color: OK, fontStyle: "italic" }}>
            ✨ Every edit teaches Ennie a phrase you prefer or drop. Future drafts will reflect your voice automatically — less editing each campaign.
          </p>
        </div>
      )}
    </div>
  );
}
