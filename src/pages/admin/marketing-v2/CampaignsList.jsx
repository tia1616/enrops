// CampaignsList — landing view for the Campaigns tab.
//
// Lists BOTH of the org's campaign kinds so an operator can see and manage
// everything in one place:
//   - DRAFTS   (approved_at IS null): Ennie put a schedule together but it
//              hasn't been approved/scheduled yet. Resume to keep editing, or
//              Delete to throw it away.
//   - SCHEDULED (approved_at NOT null): approved campaigns that are going out
//              (or already went / were paused / cancelled). Open for detail +
//              engagement, rename, pause/resume, or cancel.
//
// Actions and their RLS story:
//   - Rename:  UPDATE marketing_campaigns.name — org admins (org_read_campaigns
//              + admin write policy). Allowed for authenticated org admins.
//   - Pause:   status 'sending' -> 'paused'. Resume: 'paused' -> 'sending'.
//              The send cron only fires touchpoints under a status='sending'
//              campaign, so pause/resume is a safe, reversible on/off switch.
//   - Cancel:  flips still-queued touchpoints + the campaign to 'cancelled'.
//              Already-sent emails are NOT recalled (you can't unsend).
//   - Delete:  drafts only. Authenticated CANNOT DELETE campaign rows (service-
//              role only), so this calls the `marketing-delete-draft` edge fn.
//
// Recipient count is read from approved_recipient_ids (the approve flow's
// audience snapshot) — total_recipients isn't populated on this path. Drafts
// may have no recipients captured yet.

import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import { usePermissions } from "../../../lib/permissions";
import { PURPLE, BRIGHT, INK, MUTED, RULE, OK, INFO, WARN } from "../marketing/tokens.jsx";
import FamilyCommsTabs from "./FamilyCommsTabs.jsx";
import SenderSetupNotice from "./SenderSetupNotice.jsx";
import EditableField from "./EditableField.jsx";

export default function CampaignsList({ onNew, onResume, onOpenDetail }) {
  const { org } = useOutletContext() ?? {};
  // Campaign writes (rename/pause/resume/cancel/delete) are owner/admin only at
  // the DB (RLS). Staff can reach this tab (Family Comms = send) but can't write,
  // so hide the write actions for them — showing buttons that silently no-op is
  // worse than not showing them.
  const perm = usePermissions();
  const isAdmin = perm.role === "owner" || perm.role === "admin";
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // null = unknown; gates the empty-state copy (add-offerings vs build-first).
  const [hasOfferings, setHasOfferings] = useState(null);
  // Tracks per-row in-flight actions so each row shows its own spinner without
  // freezing the whole list. Shape: { [campaignId]: 'cancel'|'pause'|'resume'|'delete'|'rename' }
  const [busyRows, setBusyRows] = useState({});

  useEffect(() => {
    if (org?.id) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // Load BOTH drafts (approved_at IS null) and scheduled/live campaigns
      // (approved_at NOT null) in one pass, then split client-side. RLS scopes
      // this to the org's members either way.
      const { data, error: e } = await supabase
        .from("marketing_campaigns")
        .select(
          "id, name, status, approved_at, created_at, approved_recipient_ids, marketing_campaign_touchpoints(id, status, scheduled_at)",
        )
        .eq("organization_id", org.id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (e) throw e;
      setCampaigns(data ?? []);

      // Does the org have anything to market yet? Ennie drafts FROM programs/
      // camps, so an org with none needs to add offerings before a campaign
      // makes sense. Drives which empty-state copy shows. Non-fatal: on failure
      // default to "has offerings" so we never wrongly nag.
      try {
        const [{ count: progCount }, { count: campCount }] = await Promise.all([
          supabase.from("programs").select("id", { count: "exact", head: true }).eq("organization_id", org.id),
          supabase.from("camp_sessions").select("id", { count: "exact", head: true }).eq("organization_id", org.id),
        ]);
        setHasOfferings((progCount ?? 0) + (campCount ?? 0) > 0);
      } catch {
        setHasOfferings(true);
      }
    } catch (err) {
      setError(err?.message ?? "Couldn't load your campaigns. Refresh and try again.");
    } finally {
      setLoading(false);
    }
  }

  function setRowBusy(id, action) {
    setBusyRows((prev) => {
      const next = { ...prev };
      if (action) next[id] = action;
      else delete next[id];
      return next;
    });
  }

  async function renameCampaign(c, name) {
    const trimmed = (name ?? "").trim();
    if (!trimmed || trimmed === c.name) return;
    setRowBusy(c.id, "rename");
    setError(null);
    try {
      const { error: e } = await supabase
        .from("marketing_campaigns")
        .update({ name: trimmed })
        .eq("id", c.id)
        .eq("organization_id", org.id);
      if (e) throw e;
      await load();
    } catch (err) {
      setError(`Couldn't rename that campaign: ${err?.message ?? "unknown error"}`);
    } finally {
      setRowBusy(c.id, null);
    }
  }

  async function setStatus(c, status, verb) {
    setRowBusy(c.id, verb);
    setError(null);
    try {
      const { error: e } = await supabase
        .from("marketing_campaigns")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", c.id)
        .eq("organization_id", org.id);
      if (e) throw e;
      await load();
    } catch (err) {
      setError(`Couldn't ${verb} that campaign: ${err?.message ?? "unknown error"}`);
    } finally {
      setRowBusy(c.id, null);
    }
  }

  async function cancelCampaign(c) {
    const queued = (c.marketing_campaign_touchpoints ?? []).filter((t) => t.status === "queued").length;
    const ok = window.confirm(
      `Cancel "${shortName(c.name)}"?\n\nThis stops ${queued} unsent email${queued === 1 ? "" : "s"} from going out. Emails already sent can't be recalled.`,
    );
    if (!ok) return;
    setRowBusy(c.id, "cancel");
    setError(null);
    try {
      const nowIso = new Date().toISOString();
      // Cancel the unsent touchpoints first. If this fails we stop before
      // touching the campaign, so a half-cancel can't leave queued touchpoints
      // orphaned under a cancelled campaign.
      const tpRes = await supabase
        .from("marketing_campaign_touchpoints")
        .update({ status: "cancelled", updated_at: nowIso })
        .eq("campaign_id", c.id)
        .eq("status", "queued");
      if (tpRes.error) throw tpRes.error;

      const cRes = await supabase
        .from("marketing_campaigns")
        .update({ status: "cancelled", updated_at: nowIso })
        .eq("id", c.id)
        .eq("organization_id", org.id);
      if (cRes.error) throw cRes.error;

      await load();
    } catch (err) {
      setError(`Couldn't cancel that campaign: ${err?.message ?? "unknown error"}`);
    } finally {
      setRowBusy(c.id, null);
    }
  }

  async function deleteDraft(c) {
    const ok = window.confirm(
      `Delete draft "${shortName(c.name)}"?\n\nThis throws away the whole draft — the schedule Ennie put together and any edits. This can't be undone.`,
    );
    if (!ok) return;
    setRowBusy(c.id, "delete");
    setError(null);
    try {
      // Authenticated users can't DELETE campaign rows (service-role only), so
      // this goes through the edge function which does the delete under
      // service role after re-checking org admin access.
      const { error: e } = await supabase.functions.invoke("marketing-delete-draft", {
        body: { organization_id: org.id, campaign_id: c.id },
      });
      if (e) {
        // Surface the edge function's own JSON error where we can.
        let msg = e.message ?? "Delete failed.";
        try {
          const resp = e?.context?.response ?? e?.context;
          if (resp && typeof resp.clone === "function") {
            const text = await resp.clone().text();
            try { const payload = JSON.parse(text); if (payload?.error) msg = payload.error; }
            catch { /* not JSON */ }
          }
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      await load();
    } catch (err) {
      setError(`Couldn't delete that draft: ${err?.message ?? "unknown error"}`);
    } finally {
      setRowBusy(c.id, null);
    }
  }

  const drafts = campaigns.filter((c) => !c.approved_at);
  const scheduled = campaigns.filter((c) => c.approved_at);
  const isEmpty = campaigns.length === 0;

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", paddingBottom: 96 }}>
      <FamilyCommsTabs active="marketing" />

      <SenderSetupNotice orgId={org?.id} />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, color: PURPLE, margin: 0 }}>Campaigns</h1>
        <button
          onClick={onNew}
          style={{
            padding: "10px 16px", background: BRIGHT, color: "#fff", border: "none",
            borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: "inherit",
          }}
        >
          Build a campaign
        </button>
      </div>

      {error && (
        <div style={{ background: "#fdecea", color: "#b3261e", padding: 12, borderRadius: 6, marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 24, color: MUTED }}>Loading your campaigns…</div>
      ) : isEmpty ? (
        hasOfferings === false ? (
          <div style={{ border: `1px dashed ${RULE}`, borderRadius: 12, padding: 32, textAlign: "center" }}>
            <p style={{ margin: "0 0 8px", color: INK, fontWeight: 700, fontSize: 16 }}>Add your offerings to get started</p>
            <p style={{ margin: "0 0 16px", fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
              Ennie writes campaigns from your programs, camps, and offerings.{" "}
              <Link to="/admin/programs" style={{ color: BRIGHT, fontWeight: 600 }}>Add offerings &amp; programs →</Link>
              <br />Once they’re in, she’ll turn each one into a ready-to-send email series.
            </p>
            <div style={{ background: "#faf7ed", border: `1px solid ${RULE}`, borderRadius: 8, padding: "12px 14px", fontSize: 12.5, color: INK, textAlign: "left", lineHeight: 1.6 }}>
              💡 <strong>A steady rhythm wins.</strong> Families re-enroll when they hear from you consistently — aim for about <strong>3–4 touchpoints a month</strong>. Structured, regular emails are the single biggest lever on parent lifetime value.
            </div>
          </div>
        ) : (
          <div style={{ border: `1px dashed ${RULE}`, borderRadius: 12, padding: 32, textAlign: "center", color: MUTED }}>
            <p style={{ margin: "0 0 4px", color: INK, fontWeight: 600 }}>No campaigns yet</p>
            <p style={{ margin: 0, fontSize: 13 }}>Click “Build a campaign” to set one up with Ennie.</p>
          </div>
        )
      ) : (
        <>
          {scheduled.length > 0 && (
            <Section title="Scheduled" hint="Approved campaigns Ennie is sending for you.">
              {scheduled.map((c) => (
                <ScheduledRow
                  key={c.id}
                  campaign={c}
                  busy={busyRows[c.id]}
                  isAdmin={isAdmin}
                  onRename={(name) => renameCampaign(c, name)}
                  onOpen={() => onOpenDetail?.(c.id)}
                  onPause={() => setStatus(c, "paused", "pause")}
                  onResume={() => setStatus(c, "sending", "resume")}
                  onCancel={() => cancelCampaign(c)}
                />
              ))}
            </Section>
          )}

          {drafts.length > 0 && (
            <Section title="Drafts" hint="Not scheduled yet — pick up where you left off, or clear it out.">
              {drafts.map((c) => (
                <DraftRow
                  key={c.id}
                  campaign={c}
                  busy={busyRows[c.id]}
                  isAdmin={isAdmin}
                  onRename={(name) => renameCampaign(c, name)}
                  onResume={() => onResume?.(c.id)}
                  onDelete={() => deleteDraft(c)}
                />
              ))}
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function Section({ title, hint, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ marginBottom: 8 }}>
        <h2 style={{ fontSize: 13, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5, margin: 0 }}>
          {title}
        </h2>
        {hint && <p style={{ margin: "2px 0 0", fontSize: 12, color: MUTED }}>{hint}</p>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </div>
  );
}

// Small building block: an inline-editable campaign name. Reuses EditableField
// (click-to-edit) and shows a subtle "renaming…" hint while the write lands.
function CampaignName({ campaign, onRename, renaming, canRename = true }) {
  // Non-admins can't rename (RLS blocks the UPDATE), so show the name as plain
  // text instead of a click-to-edit field.
  if (!canRename) {
    return (
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, color: INK }}>{shortName(campaign.name) || "Untitled campaign"}</div>
      </div>
    );
  }
  return (
    <div style={{ minWidth: 0, flex: 1 }}>
      <EditableField
        value={shortName(campaign.name)}
        onChange={onRename}
        placeholder="Untitled campaign"
        style={{ fontWeight: 600 }}
      />
      {renaming && <span style={{ fontSize: 11, color: MUTED }}>Renaming…</span>}
    </div>
  );
}

function DraftRow({ campaign, busy, isAdmin = true, onRename, onResume, onDelete }) {
  const tps = campaign.marketing_campaign_touchpoints ?? [];
  const badge = { label: "Draft", color: WARN };
  const deleting = busy === "delete";

  return (
    <div style={{ border: `1px solid ${RULE}`, borderRadius: 12, padding: 16, background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <CampaignName campaign={campaign} onRename={onRename} renaming={busy === "rename"} canRename={isAdmin} />
          <p style={{ margin: "6px 0 0", fontSize: 12, color: MUTED }}>
            {tps.length} email{tps.length === 1 ? "" : "s"} drafted
            {" · "}
            started {new Date(campaign.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </p>
        </div>
        <span style={{ fontSize: 12, fontWeight: 600, color: badge.color, whiteSpace: "nowrap", flexShrink: 0 }}>
          {badge.label}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <PrimaryBtn onClick={onResume} disabled={!!busy}>Resume</PrimaryBtn>
        {isAdmin && (
          <DangerBtn onClick={onDelete} disabled={!!busy}>
            {deleting ? "Deleting…" : "Delete"}
          </DangerBtn>
        )}
      </div>
    </div>
  );
}

function ScheduledRow({ campaign, busy, isAdmin = true, onRename, onOpen, onPause, onResume, onCancel }) {
  const tps = campaign.marketing_campaign_touchpoints ?? [];
  const queued = tps.filter((t) => t.status === "queued");
  const sent = tps.filter((t) => t.status === "sent");
  const recipients = campaign.approved_recipient_ids?.length ?? 0;
  const display = deriveStatus(campaign, tps);
  // Pause/resume/cancel are owner/admin-only writes (RLS). Cancel is only
  // meaningful while unsent touchpoints remain — a fully-sent or already-
  // cancelled campaign has nothing left to stop.
  const canCancel = isAdmin && campaign.status !== "cancelled" && queued.length > 0;
  const canPause = isAdmin && campaign.status === "sending";
  const canResume = isAdmin && campaign.status === "paused";

  const nextSend = queued.length > 0
    ? queued.map((t) => t.scheduled_at).sort()[0]
    : null;

  return (
    <div style={{ border: `1px solid ${RULE}`, borderRadius: 12, padding: 16, background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <CampaignName campaign={campaign} onRename={onRename} renaming={busy === "rename"} canRename={isAdmin} />
          <p style={{ margin: "6px 0 0", fontSize: 12, color: MUTED }}>
            {recipients} recipient{recipients === 1 ? "" : "s"}
            {" · "}
            {sent.length}/{tps.length} email{tps.length === 1 ? "" : "s"} sent
            {nextSend && (
              <>
                {" · "}next {new Date(nextSend).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </>
            )}
          </p>
        </div>
        <span style={{ fontSize: 12, fontWeight: 600, color: display.color, whiteSpace: "nowrap", flexShrink: 0 }}>
          {display.label}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <PrimaryBtn onClick={onOpen} disabled={!!busy}>Open</PrimaryBtn>
        {canPause && (
          <SecondaryBtn onClick={onPause} disabled={!!busy}>
            {busy === "pause" ? "Pausing…" : "Pause"}
          </SecondaryBtn>
        )}
        {canResume && (
          <SecondaryBtn onClick={onResume} disabled={!!busy}>
            {busy === "resume" ? "Resuming…" : "Resume"}
          </SecondaryBtn>
        )}
        {canCancel && (
          <DangerBtn onClick={onCancel} disabled={!!busy}>
            {busy === "cancel" ? "Cancelling…" : "Cancel"}
          </DangerBtn>
        )}
      </div>
    </div>
  );
}

// ---- Shared button styles ----
function PrimaryBtn({ onClick, disabled, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "6px 14px", background: BRIGHT, color: "#fff", border: "none",
        borderRadius: 6, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1,
        fontSize: 13, fontWeight: 600, fontFamily: "inherit", whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

function SecondaryBtn({ onClick, disabled, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "6px 12px", background: "#fff", color: INK,
        border: `1px solid ${RULE}`, borderRadius: 6,
        cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1,
        fontSize: 13, fontWeight: 500, fontFamily: "inherit", whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

function DangerBtn({ onClick, disabled, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "6px 12px", background: "#fff", color: "#b3261e",
        border: "1px solid #e7b4ae", borderRadius: 6,
        cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1,
        fontSize: 13, fontWeight: 500, fontFamily: "inherit", whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

// Display status is derived from campaign.status + touchpoints — a campaign
// stays status='sending' even after all its touchpoints have sent, so the
// campaign column alone is a poor progress signal.
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

// Campaign names are an auto-joined list of every offering ("A + B + C + …"),
// which can run hundreds of chars. Show the first offering plus a "+N more".
function shortName(name) {
  if (!name) return "Untitled campaign";
  const parts = name.split(" + ");
  if (parts.length <= 1) return name.length > 60 ? `${name.slice(0, 57)}…` : name;
  const more = parts.length - 1;
  const first = parts[0].length > 50 ? `${parts[0].slice(0, 47)}…` : parts[0];
  return `${first} + ${more} more`;
}
