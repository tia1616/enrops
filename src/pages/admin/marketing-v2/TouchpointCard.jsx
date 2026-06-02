// TouchpointCard — one card per scheduled email in the campaign.
// Expandable. Shows summary collapsed; editor + preview when open.
// Edits are local until "Save as draft" or "Approve & Schedule" (chunk 07 wires).

import { useState } from "react";
import EditableField from "./EditableField.jsx";
import { supabase } from "../../../lib/supabase.js";
import { INK, MUTED, PURPLE, RULE, OK, INFO } from "../marketing/tokens.jsx";

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
  onSendTest,
  onRegenerate,
  // Picked schools for the per-school preview dropdown. Each {id, name}.
  // Empty array hides the dropdown (camps-only campaigns, one-off mode).
  pickedLocations = [],
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
    if (!id) { setPreviewData(null); setPreviewError(null); return; }
    loadPreview(id);
  };

  return (
    <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, marginBottom: 10, background: "#fff", overflow: "hidden" }}>
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
        <span style={{ color: MUTED, fontSize: 14, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s ease" }}>▶</span>
      </button>

      {open && (
        <div style={{ padding: 14, display: "grid", gap: 12 }}>
          <EditableField
            label="Subject"
            value={tp.subject}
            onChange={(v) => onUpdate(tp.id, { subject: v })}
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
                if (!isNaN(local.getTime())) onUpdate(tp.id, { scheduled_at: local.toISOString() });
              }}
              style={{
                padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 6,
                fontSize: 13, fontFamily: "inherit", background: "#fff", color: INK,
              }}
            />
          </div>

          {/* Per-school preview dropdown. Lets the operator flip through
              schools and see exactly what a parent at each school will
              receive — same code path as a real send, just no Resend call.
              Catches "this school doesn't have VIP" / "this school's
              first session is a different date" issues before approve.
              Rendered visible-but-disabled when no schools are available
              (loading or camps-only campaign) so the operator knows the
              feature is there and what state it's in — silently hiding
              made the dropdown look broken / absent. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
              Preview as parent at
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
                  ? "(loading schools, or campaign has no school picks)"
                  : "— show tokens (no school picked) —"}
              </option>
              {pickedLocations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
              {previewLoading && <span style={{ fontSize: 11, color: MUTED }}>rendering…</span>}
              {previewData?.vip_block_shown === false && isPreviewing && (
                <span style={{
                  fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5,
                  color: "#854F0B", padding: "2px 8px", borderRadius: 999, background: "#FAEEDA",
                }}>
                  VIP block suppressed for this school
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
              {previewData?.program_matched === false && isPreviewing && (
                <span style={{
                  fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5,
                  color: "#b3261e", padding: "2px 8px", borderRadius: 999, background: "#fce4ec",
                }}>
                  No program at this school in your picks
                </span>
              )}
            </div>
          )}

          <BodyEditor
            value={tp.body_html ?? ""}
            onChange={(v) => onUpdate(tp.id, { body_html: v, body_text: stripHtml(v) })}
            // Preview overrides: when an operator picks a school in the
            // dropdown, BodyEditor shows the SERVER-rendered body (tokens
            // resolved, VIP shown/suppressed) instead of the raw
            // body_html with merge-token highlighting. Edit button is
            // still available — clicking Edit hides the preview and
            // shows the raw body so the operator can keep iterating.
            previewHtml={isPreviewing ? previewData?.body_html : null}
            previewSubject={isPreviewing ? previewData?.subject : null}
            previewSchoolName={isPreviewing ? previewData?.used_school_name : null}
            previewError={previewError}
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

function BodyEditor({ value, onChange, previewHtml, previewSubject, previewSchoolName, previewError }) {
  const [editing, setEditing] = useState(false);
  // When a school is picked in the dropdown above, we hide the raw-tokens
  // view and show the server-rendered body for that school. Editing the
  // body is always allowed — clicking Edit drops out of preview mode for
  // this card visually, but the parent's previewLocationId is unchanged
  // so de-selecting Edit returns to the preview view.
  const showingPreview = !!previewHtml && !editing;

  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 4,
      }}>
        <span style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
          {showingPreview ? `Preview for parents at ${previewSchoolName}` : "Email body"}
        </span>
        <button
          onClick={() => setEditing((v) => !v)}
          style={{
            background: "transparent", border: "none", color: PURPLE,
            cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600,
          }}
        >
          {editing ? "Done editing" : "Edit"}
        </button>
      </div>

      {previewError && (
        <div style={{
          padding: "8px 12px", marginBottom: 6,
          border: "1px solid #b3261e", borderRadius: 6,
          background: "#fce4ec", color: "#b3261e", fontSize: 12,
        }}>
          Preview failed: {previewError}
        </div>
      )}

      {showingPreview ? (
        <>
          {previewSubject && (
            <div style={{
              padding: "8px 12px", marginBottom: 6,
              border: `1px solid ${RULE}`, borderRadius: 6,
              background: "#faf8f1", fontSize: 13, color: INK,
            }}>
              <span style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginRight: 6 }}>
                Subject
              </span>
              {previewSubject}
            </div>
          )}
          {/* Server-rendered, real send-time output for the picked school.
              Includes the email-shell wrapper + unsubscribe footer the
              parent will actually see. Using an iframe srcDoc isolates
              the rendered HTML from the admin app's stylesheet (the email
              ships in a fresh document). */}
          <iframe
            title="email preview"
            srcDoc={previewHtml}
            sandbox=""
            style={{
              width: "100%", minHeight: 480,
              border: `1px solid ${RULE}`, borderRadius: 6,
              background: "#fff",
            }}
          />
        </>
      ) : editing ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={10}
          style={{
            width: "100%", padding: "10px 12px",
            border: `1px solid ${RULE}`, borderRadius: 6,
            fontFamily: "ui-monospace, monospace", fontSize: 12,
            lineHeight: 1.5, color: INK, background: "#fff",
            resize: "vertical", boxSizing: "border-box",
          }}
        />
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

      {!editing && !showingPreview && (
        <div style={{ margin: "6px 0 0", fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
          <p style={{ margin: 0 }}>
            Highlighted tags like <span style={{ fontFamily: "ui-monospace, monospace" }}>{"{{first_name}}"}</span> get filled in for each parent when the email sends. Pick a school above to see exactly what parents there will receive.
          </p>
          <p style={{ margin: "4px 0 0", color: OK, fontStyle: "italic" }}>
            ✨ Every edit teaches Ennie a phrase you prefer or drop. Future drafts will reflect your voice automatically — less editing each campaign.
          </p>
        </div>
      )}
    </div>
  );
}
