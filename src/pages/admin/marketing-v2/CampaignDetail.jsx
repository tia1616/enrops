// CampaignDetail — the "open a scheduled/live campaign" view.
//
// Reached from CampaignsList → Open on a scheduled (approved) campaign. Shows:
//   - Header: inline-renamable name, status badge, created/approved dates,
//     recipient count (approved_recipient_ids.length).
//   - Engagement summary: aggregated client-side from marketing_sends for this
//     campaign — sent / delivered / opened / clicked / bounced, with % of sent.
//   - Per-touchpoint list: label + reason + scheduled_at + status, plus this
//     touchpoint's own opened/clicked counts. UN-SENT ('queued') touchpoints
//     are editable (subject / body / send-time) and can be SKIPPED. Everything
//     else (sent / sending / skipped / cancelled / failed) is READ-ONLY.
//
// Everything is org-scoped via org.id from useOutletContext (passed in as prop).
// RLS lets org members SELECT sends/touchpoints and lets org admins UPDATE the
// campaign name + touchpoint payload/scheduled_at/status.

import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase.js";
import { usePermissions } from "../../../lib/permissions";
import { PURPLE, BRIGHT, INK, MUTED, RULE, OK, INFO, WARN } from "../marketing/tokens.jsx";
import EditableField from "./EditableField.jsx";
import EmailPreviewDrawer from "./EmailPreviewDrawer.jsx";

// Sends that count as "left the building" — anything past 'pending'.
const NON_PENDING = new Set(["sent", "delivered", "opened", "clicked", "bounced", "failed", "throttled"]);
// Sends that reached the inbox (delivered or better — opened/clicked imply it).
const DELIVERED = new Set(["delivered", "opened", "clicked"]);

function fmtDate(iso, opts) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(undefined, opts ?? { month: "short", day: "numeric", year: "numeric" }); }
  catch { return iso; }
}
function fmtDateTime(iso, timezone) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: timezone,
    });
  } catch { return iso; }
}
function pct(part, whole) {
  if (!whole) return null;
  return Math.round((part / whole) * 100);
}

export default function CampaignDetail({ campaignId, org, onBack }) {
  const [campaign, setCampaign] = useState(null);
  const [touchpoints, setTouchpoints] = useState([]);
  const [sends, setSends] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const timezone = org?.timezone ?? "America/Los_Angeles";
  // Rename + touchpoint edits/skips are owner/admin-only writes (RLS). Staff can
  // open and read this view but shouldn't see write controls that no-op.
  const perm = usePermissions();
  const isAdmin = perm.role === "owner" || perm.role === "admin";

  useEffect(() => {
    if (campaignId && org?.id) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, org?.id]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [cRes, tpRes, sRes] = await Promise.all([
        supabase
          .from("marketing_campaigns")
          .select("id, name, status, approved_at, created_at, approved_recipient_ids")
          .eq("id", campaignId)
          .eq("organization_id", org.id)
          .maybeSingle(),
        supabase
          .from("marketing_campaign_touchpoints")
          .select("id, order_index, scheduled_at, status, payload, topics")
          .eq("campaign_id", campaignId)
          .eq("organization_id", org.id)
          .order("order_index", { ascending: true }),
        supabase
          .from("marketing_sends")
          .select("id, touchpoint_id, status, opened_at, clicked_at, sent_at")
          .eq("campaign_id", campaignId)
          .eq("organization_id", org.id),
      ]);
      if (cRes.error) throw cRes.error;
      if (tpRes.error) throw tpRes.error;
      if (sRes.error) throw sRes.error;
      if (!cRes.data) {
        setError("Couldn't find that campaign — it may have been deleted, or you don't have access.");
        setCampaign(null);
        return;
      }
      setCampaign(cRes.data);
      setTouchpoints(tpRes.data ?? []);
      setSends(sRes.data ?? []);
    } catch (err) {
      setError(err?.message ?? "Couldn't load this campaign. Go back and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function renameCampaign(name) {
    const trimmed = (name ?? "").trim();
    if (!trimmed || trimmed === campaign?.name) return;
    setError(null);
    try {
      const { error: e } = await supabase
        .from("marketing_campaigns")
        .update({ name: trimmed })
        .eq("id", campaignId)
        .eq("organization_id", org.id);
      if (e) throw e;
      setCampaign((c) => (c ? { ...c, name: trimmed } : c));
    } catch (err) {
      setError(`Couldn't rename this campaign: ${err?.message ?? "unknown error"}`);
    }
  }

  // Persist an edit to an un-sent touchpoint (subject/body/send-time). Merges
  // over the existing payload so we never drop a field we didn't touch.
  async function updateTouchpoint(tp, patch) {
    setError(null);
    const nextPayload = {
      label: tp.payload?.label ?? null,
      subject: tp.payload?.subject ?? null,
      body_html: tp.payload?.body_html ?? null,
      body_text: tp.payload?.body_text ?? null,
      reason: tp.payload?.reason ?? null,
      ...(patch.payload ?? {}),
    };
    const row = { payload: nextPayload, updated_at: new Date().toISOString() };
    if (patch.scheduled_at !== undefined) row.scheduled_at = patch.scheduled_at;
    try {
      const { error: e } = await supabase
        .from("marketing_campaign_touchpoints")
        .update(row)
        .eq("id", tp.id)
        .eq("organization_id", org.id);
      if (e) throw e;
      setTouchpoints((list) =>
        list.map((t) => (t.id === tp.id
          ? { ...t, payload: nextPayload, ...(row.scheduled_at !== undefined ? { scheduled_at: row.scheduled_at } : {}) }
          : t)),
      );
    } catch (err) {
      setError(`Couldn't save that change: ${err?.message ?? "unknown error"}`);
    }
  }

  async function skipTouchpoint(tp) {
    const ok = window.confirm(
      `Skip "${tp.payload?.label || "this email"}"?\n\nEnnie won't send it. The rest of the campaign keeps going. You can't un-skip it later.`,
    );
    if (!ok) return;
    setError(null);
    try {
      const { error: e } = await supabase
        .from("marketing_campaign_touchpoints")
        .update({ status: "skipped", updated_at: new Date().toISOString() })
        .eq("id", tp.id)
        .eq("organization_id", org.id);
      if (e) throw e;
      setTouchpoints((list) => list.map((t) => (t.id === tp.id ? { ...t, status: "skipped" } : t)));
    } catch (err) {
      setError(`Couldn't skip that email: ${err?.message ?? "unknown error"}`);
    }
  }

  const recipients = campaign?.approved_recipient_ids?.length ?? 0;
  const status = campaign ? deriveStatus(campaign, touchpoints) : null;

  // ---- Engagement aggregation (campaign-wide) ----
  const eng = aggregate(sends);
  // Per-touchpoint opened/clicked, grouped by touchpoint_id.
  const byTp = groupByTouchpoint(sends);

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", paddingBottom: 96 }}>
      <button
        onClick={onBack}
        style={{
          background: "transparent", border: "none", color: MUTED,
          cursor: "pointer", fontSize: 13, fontFamily: "inherit",
          padding: "0 0 12px", display: "inline-flex", alignItems: "center", gap: 4,
        }}
      >
        ← Back to campaigns
      </button>

      {error && (
        <div style={{ background: "#fdecea", color: "#b3261e", padding: 12, borderRadius: 6, marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 24, color: MUTED }}>Loading this campaign…</div>
      ) : !campaign ? (
        <div style={{ border: `1px dashed ${RULE}`, borderRadius: 12, padding: 32, textAlign: "center", color: MUTED }}>
          Nothing to show here.
        </div>
      ) : (
        <>
          {/* Header */}
          <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "18px 20px", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700, marginBottom: 4 }}>
                  Campaign
                </div>
                {isAdmin ? (
                  <EditableField
                    value={campaign.name || "Untitled campaign"}
                    onChange={renameCampaign}
                    placeholder="Untitled campaign"
                    style={{ fontWeight: 700 }}
                  />
                ) : (
                  <div style={{ fontWeight: 700, color: INK }}>{campaign.name || "Untitled campaign"}</div>
                )}
              </div>
              {status && (
                <span style={{ fontSize: 12, fontWeight: 700, color: status.color, whiteSpace: "nowrap", flexShrink: 0 }}>
                  {status.label}
                </span>
              )}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 20, marginTop: 14, fontSize: 12, color: MUTED }}>
              <Meta label="Recipients" value={`${recipients}`} />
              <Meta label="Created" value={fmtDate(campaign.created_at)} />
              <Meta label="Approved" value={campaign.approved_at ? fmtDate(campaign.approved_at) : "—"} />
            </div>
          </div>

          {/* Engagement */}
          <h3 style={{ margin: "16px 0 8px", fontSize: 14, color: INK, fontWeight: 700 }}>Engagement</h3>
          <Engagement eng={eng} />

          {/* Touchpoints */}
          <h3 style={{ margin: "20px 0 8px", fontSize: 14, color: INK, fontWeight: 700 }}>
            The schedule ({touchpoints.length} touchpoint{touchpoints.length === 1 ? "" : "s"})
          </h3>
          {touchpoints.length === 0 ? (
            <div style={{ border: `1px dashed ${RULE}`, borderRadius: 12, padding: 24, textAlign: "center", color: MUTED, fontSize: 13 }}>
              No touchpoints on this campaign.
            </div>
          ) : (
            touchpoints.map((tp) => (
              <TouchpointRow
                key={tp.id}
                tp={tp}
                stats={byTp[tp.id] ?? { sent: 0, opened: 0, clicked: 0 }}
                timezone={timezone}
                canEdit={isAdmin}
                onUpdate={(patch) => updateTouchpoint(tp, patch)}
                onSkip={() => skipTouchpoint(tp)}
              />
            ))
          )}
        </>
      )}
    </div>
  );
}

function Meta({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{label}</div>
      <div style={{ marginTop: 2, color: INK, fontSize: 13, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

// Engagement stat tiles. Zero-sent shows a gentle "nothing's gone out yet".
function Engagement({ eng }) {
  if (eng.sent === 0) {
    return (
      <div style={{ border: `1px dashed ${RULE}`, borderRadius: 12, padding: 20, textAlign: "center", color: MUTED, fontSize: 13 }}>
        Nothing's gone out yet — engagement shows up here once the first email sends.
      </div>
    );
  }
  const tiles = [
    { label: "Sent", value: eng.sent, sub: null, color: INK },
    { label: "Delivered", value: eng.delivered, sub: pct(eng.delivered, eng.sent), color: INFO },
    { label: "Opened", value: eng.opened, sub: pct(eng.opened, eng.sent), color: OK },
    { label: "Clicked", value: eng.clicked, sub: pct(eng.clicked, eng.sent), color: BRIGHT },
    { label: "Bounced", value: eng.bounced, sub: pct(eng.bounced, eng.sent), color: eng.bounced > 0 ? "#b3261e" : MUTED },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}>
      {tiles.map((t) => (
        <div key={t.label} style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "14px 16px" }}>
          <div style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{t.label}</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: t.color, marginTop: 4, lineHeight: 1 }}>{t.value}</div>
          {t.sub !== null && <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>{t.sub}% of sent</div>}
        </div>
      ))}
    </div>
  );
}

// One touchpoint row. Sent/other statuses render read-only; only 'queued'
// touchpoints get the editor + Skip button.
function TouchpointRow({ tp, stats, timezone, canEdit = true, onUpdate, onSkip }) {
  // Only owner/admin can edit/skip an un-sent touchpoint (RLS). Everyone else
  // sees the same read-only rendering used for already-sent touchpoints.
  const editable = canEdit && tp.status === "queued";
  const [open, setOpen] = useState(false);
  const badge = tpStatusBadge(tp.status);
  const label = tp.payload?.label || "email";
  const subject = tp.payload?.subject || "(no subject)";
  const reason = tp.payload?.reason;

  return (
    <div style={{ border: `1px solid ${RULE}`, borderRadius: 12, marginBottom: 10, background: "#fff", overflow: "hidden" }}>
      <div style={{ padding: 14 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <span style={{
              fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5,
              color: MUTED, padding: "2px 6px", borderRadius: 999, background: "rgba(0,0,0,0.04)",
            }}>{label}</span>
            <div style={{ fontSize: 14, fontWeight: 600, color: INK, marginTop: 6, lineHeight: 1.3 }}>{subject}</div>
            <div style={{ fontSize: 11, color: MUTED, marginTop: 3 }}>{fmtDateTime(tp.scheduled_at, timezone)}</div>
            {reason && (
              <div style={{ fontSize: 11, color: BRIGHT, marginTop: 3, display: "flex", gap: 4, alignItems: "flex-start", lineHeight: 1.35 }}>
                <span aria-hidden>⏱</span><span>{reason}</span>
              </div>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: badge.color, whiteSpace: "nowrap" }}>{badge.label}</span>
            {/* Per-touchpoint opens/clicks — only meaningful once it's sent. */}
            {stats.sent > 0 && (
              <span style={{ fontSize: 11, color: MUTED, whiteSpace: "nowrap" }}>
                {stats.opened} opened · {stats.clicked} clicked
              </span>
            )}
          </div>
        </div>

        {editable ? (
          <>
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <button
                onClick={() => setOpen((v) => !v)}
                style={{
                  padding: "6px 12px", background: "#fff", color: INK, border: `1px solid ${RULE}`,
                  borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit",
                }}
              >
                {open ? "Done editing" : "Edit"}
              </button>
              <button
                onClick={onSkip}
                style={{
                  padding: "6px 12px", background: "#fff", color: "#b3261e", border: "1px solid #e7b4ae",
                  borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit",
                }}
              >
                Skip this one
              </button>
            </div>
            {open && <TouchpointEditor tp={tp} onUpdate={onUpdate} />}
          </>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button
                onClick={() => setOpen((v) => !v)}
                style={{
                  padding: "6px 12px", background: "#fff", color: INK, border: `1px solid ${RULE}`,
                  borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit",
                }}
              >
                {open ? "Hide email" : "View email"}
              </button>
              <span style={{ fontSize: 11, color: MUTED, fontStyle: "italic" }}>
                {tp.status === "sent"
                  ? "Already sent — locked."
                  : tp.status === "sending"
                    ? "Sending now — locked."
                    : tp.status === "skipped"
                      ? "Skipped — Ennie won't send this."
                      : "Read-only."}
              </span>
            </div>
            {open && (
              <div style={{ marginTop: 10, border: `1px solid ${RULE}`, borderRadius: 8, padding: 14, background: "#fafafa" }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 8 }}>{subject}</div>
                <div
                  style={{ fontSize: 13, color: INK, lineHeight: 1.5 }}
                  dangerouslySetInnerHTML={{ __html: tp.payload?.body_html || "<em>(no content)</em>" }}
                />
                <div style={{ fontSize: 11, color: MUTED, marginTop: 10 }}>
                  Merge fields like {"{{first_name}}"} fill in per family at send time.
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Editor for an un-sent touchpoint: subject (inline), send-time, and body.
// Writes go straight to the row via onUpdate (RLS-allowed UPDATE).
function TouchpointEditor({ tp, onUpdate }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const bodyHtml = tp.payload?.body_html ?? "";

  // Send-time is edited locally while the field has focus and only persisted on
  // blur (and only if it actually changed) — writing on every keystroke fired a
  // DB write per character. `savingTime` locks the field while the write lands
  // so rapid edits can't race.
  const [timeInput, setTimeInput] = useState(fmtDatetimeInput(tp.scheduled_at));
  const [savingTime, setSavingTime] = useState(false);

  // Keep the local field in sync if the row's scheduled_at changes from outside
  // (e.g. a save elsewhere) — but not while we're mid-save.
  useEffect(() => {
    if (!savingTime) setTimeInput(fmtDatetimeInput(tp.scheduled_at));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tp.scheduled_at]);

  async function commitTime() {
    if (savingTime) return;
    const local = new Date(timeInput);
    if (isNaN(local.getTime())) {
      // Bad/blank value — snap back to the persisted time.
      setTimeInput(fmtDatetimeInput(tp.scheduled_at));
      return;
    }
    const nextIso = local.toISOString();
    if (nextIso === tp.scheduled_at) return; // no real change
    setSavingTime(true);
    try {
      await onUpdate({ scheduled_at: nextIso });
    } finally {
      setSavingTime(false);
    }
  }

  return (
    <div style={{ marginTop: 12, display: "grid", gap: 12, borderTop: `1px solid ${RULE}`, paddingTop: 12 }}>
      <EditableField
        label="Subject"
        value={tp.payload?.subject ?? ""}
        onChange={(v) => onUpdate({ payload: { subject: v } })}
        placeholder="Click to write a subject"
      />

      <div>
        <div style={{ fontSize: 11, color: MUTED, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
          Send time
        </div>
        <input
          type="datetime-local"
          value={timeInput}
          disabled={savingTime}
          onChange={(e) => setTimeInput(e.target.value)}
          onBlur={commitTime}
          style={{
            padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 6,
            fontSize: 13, fontFamily: "inherit", background: "#fff", color: INK,
            opacity: savingTime ? 0.6 : 1,
          }}
        />
      </div>

      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
            Email body
          </span>
          {bodyHtml && (
            <button
              onClick={() => setPreviewOpen(true)}
              style={{ background: "transparent", border: "none", color: PURPLE, cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600 }}
            >
              Preview
            </button>
          )}
        </div>
        <EditableField
          value={editableFromHtml(bodyHtml)}
          onChange={(v) => onUpdate({ payload: { body_html: htmlFromEditable(v), body_text: stripHtml(v) } })}
          multiline
          rows={10}
          placeholder="Click to write the email body"
        />
        <p style={{ margin: "6px 0 0", fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
          Blank line = new paragraph. Tags like <span style={{ fontFamily: "ui-monospace, monospace" }}>{"{{first_name}}"}</span> get filled in for each parent at send time.
        </p>
      </div>

      <EmailPreviewDrawer
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        subject={tp.payload?.subject}
        bodyHtml={bodyHtml}
      />
    </div>
  );
}

// ---- helpers ----

function aggregate(sends) {
  let sent = 0, delivered = 0, opened = 0, clicked = 0, bounced = 0;
  for (const s of sends) {
    if (NON_PENDING.has(s.status)) sent += 1;
    if (DELIVERED.has(s.status)) delivered += 1;
    if (s.opened_at) opened += 1;
    if (s.clicked_at) clicked += 1;
    if (s.status === "bounced") bounced += 1;
  }
  return { sent, delivered, opened, clicked, bounced };
}

function groupByTouchpoint(sends) {
  const map = {};
  for (const s of sends) {
    const id = s.touchpoint_id;
    if (!id) continue;
    if (!map[id]) map[id] = { sent: 0, opened: 0, clicked: 0 };
    if (NON_PENDING.has(s.status)) map[id].sent += 1;
    if (s.opened_at) map[id].opened += 1;
    if (s.clicked_at) map[id].clicked += 1;
  }
  return map;
}

function deriveStatus(campaign, tps) {
  if (campaign.status === "cancelled") return { label: "Cancelled", color: MUTED };
  if (campaign.status === "paused") return { label: "Paused", color: WARN };
  if (tps.some((t) => t.status === "sending")) return { label: "Sending now", color: INFO };
  if (tps.some((t) => t.status === "queued")) return { label: "Scheduled", color: INFO };
  // Nothing left pending (no queued/sending above). Treat failed/skipped/
  // cancelled as terminal so a single failed touchpoint no longer drops the
  // whole campaign back to "Scheduled" — if any touchpoint actually sent, the
  // campaign is "Sent".
  if (tps.length > 0 && tps.some((t) => t.status === "sent")) {
    return { label: "Sent", color: OK };
  }
  return { label: "Scheduled", color: INFO };
}

function tpStatusBadge(status) {
  switch (status) {
    case "sent": return { label: "Sent", color: OK };
    case "sending": return { label: "Sending", color: INFO };
    case "queued": return { label: "Scheduled", color: INFO };
    case "skipped": return { label: "Skipped", color: MUTED };
    case "cancelled": return { label: "Cancelled", color: MUTED };
    case "failed": return { label: "Failed", color: "#b3261e" };
    default: return { label: status || "—", color: MUTED };
  }
}

function fmtDatetimeInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// Mirror TouchpointCard's editable<->HTML round-trip so the editor here reads
// and writes the same shape the builder/renderer expect.
function editableFromHtml(html) {
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

function htmlFromEditable(text) {
  if (!text) return "";
  let html = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`);
  html = html.replace(/\*\*([^*\n]+)\*\*/g, (_, inner) => `<strong>${inner}</strong>`);
  html = html.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, (_m, pre, inner) => `${pre}<em>${inner}</em>`);
  const paragraphs = html.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paragraphs.map((p) => `<p>${p}</p>`).join("");
}
