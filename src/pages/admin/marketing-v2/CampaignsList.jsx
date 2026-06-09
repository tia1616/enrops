// CampaignsList — landing view for the Campaigns tab.
//
// Lists the org's scheduled campaigns (anything that was approved, plus any
// that were later paused/cancelled) so an operator can see what's going out
// and stop a campaign that shouldn't. "Build a campaign" enters the wizard.
//
// Cancel: flips the campaign's still-queued touchpoints to 'cancelled' and the
// campaign to 'cancelled'. The send cron only fires touchpoints whose parent
// campaign is status='sending' AND whose own status is 'queued', so a cancelled
// campaign is invisible to it — no further sends. Already-sent emails are NOT
// recalled (you can't unsend); cancel only stops future touchpoints. Both
// writes are RLS-scoped to org admins (tp_org_admin_write / org_read_campaigns).
//
// Recipient count is read from approved_recipient_ids (the approve flow's
// audience snapshot) — total_recipients isn't populated on this path.

import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import { PURPLE, INK, MUTED, RULE, OK, INFO } from "../marketing/tokens.jsx";
import FamilyCommsTabs from "./FamilyCommsTabs.jsx";

export default function CampaignsList({ onNew }) {
  const { org } = useOutletContext() ?? {};
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [cancelingId, setCancelingId] = useState(null);

  useEffect(() => {
    if (org?.id) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { data, error: e } = await supabase
        .from("marketing_campaigns")
        .select(
          "id, name, status, approved_at, created_at, approved_recipient_ids, marketing_campaign_touchpoints(id, status, scheduled_at)",
        )
        .eq("organization_id", org.id)
        .not("approved_at", "is", null)
        .order("created_at", { ascending: false })
        .limit(50);
      if (e) throw e;
      setCampaigns(data ?? []);
    } catch (err) {
      setError(err?.message ?? "Couldn't load your campaigns. Refresh and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function cancelCampaign(c) {
    const queued = (c.marketing_campaign_touchpoints ?? []).filter((t) => t.status === "queued").length;
    const ok = window.confirm(
      `Cancel "${shortName(c.name)}"?\n\nThis stops ${queued} unsent email${queued === 1 ? "" : "s"} from going out. Emails already sent can't be recalled.`,
    );
    if (!ok) return;
    setCancelingId(c.id);
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
        .eq("id", c.id);
      if (cRes.error) throw cRes.error;

      await load();
    } catch (err) {
      setError(`Couldn't cancel that campaign: ${err?.message ?? "unknown error"}`);
    } finally {
      setCancelingId(null);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", paddingBottom: 96 }}>
      <FamilyCommsTabs active="marketing" />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, color: PURPLE, margin: 0 }}>Campaigns</h1>
        <button
          onClick={onNew}
          style={{
            padding: "10px 16px", background: PURPLE, color: "#fff", border: "none",
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
      ) : campaigns.length === 0 ? (
        <div style={{ border: `1px dashed ${RULE}`, borderRadius: 8, padding: 32, textAlign: "center", color: MUTED }}>
          <p style={{ margin: "0 0 4px", color: INK, fontWeight: 600 }}>No campaigns scheduled yet</p>
          <p style={{ margin: 0, fontSize: 13 }}>Click “Build a campaign” to set one up with Enni.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {campaigns.map((c) => (
            <CampaignRow
              key={c.id}
              campaign={c}
              onCancel={() => cancelCampaign(c)}
              canceling={cancelingId === c.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CampaignRow({ campaign, onCancel, canceling }) {
  const tps = campaign.marketing_campaign_touchpoints ?? [];
  const queued = tps.filter((t) => t.status === "queued");
  const sent = tps.filter((t) => t.status === "sent");
  const recipients = campaign.approved_recipient_ids?.length ?? 0;
  const display = deriveStatus(campaign, tps);
  // Cancel is only meaningful while unsent touchpoints remain — a fully-sent
  // or already-cancelled campaign has nothing left to stop.
  const canCancel = campaign.status !== "cancelled" && queued.length > 0;

  const nextSend = queued.length > 0
    ? queued.map((t) => t.scheduled_at).sort()[0]
    : null;

  return (
    <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: 16, background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: INK }}>{shortName(campaign.name)}</p>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: MUTED }}>
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
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: display.color, whiteSpace: "nowrap" }}>
            {display.label}
          </span>
          {canCancel && (
            <button
              onClick={onCancel}
              disabled={canceling}
              style={{
                padding: "6px 12px", background: "#fff", color: "#b3261e",
                border: "1px solid #e7b4ae", borderRadius: 6,
                cursor: canceling ? "default" : "pointer", opacity: canceling ? 0.6 : 1,
                fontSize: 13, fontWeight: 500, fontFamily: "inherit", whiteSpace: "nowrap",
              }}
            >
              {canceling ? "Cancelling…" : "Cancel"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Display status is derived from the touchpoints, not the raw campaign.status —
// a campaign stays status='sending' even after all its touchpoints have sent,
// so the campaign column alone is a poor progress signal.
function deriveStatus(campaign, tps) {
  if (campaign.status === "cancelled") return { label: "Cancelled", color: MUTED };
  if (campaign.status === "paused") return { label: "Paused", color: MUTED };
  if (tps.some((t) => t.status === "sending")) return { label: "Sending now", color: INFO };
  if (tps.some((t) => t.status === "queued")) return { label: "Scheduled", color: INFO };
  if (tps.length > 0 && tps.every((t) => t.status === "sent" || t.status === "skipped")) {
    return { label: "Sent", color: OK };
  }
  return { label: "Scheduled", color: INFO };
}

// Campaign names are an auto-joined list of every curriculum ("A + B + C + …"),
// which can run hundreds of chars. Show the first program plus a "+N more".
function shortName(name) {
  if (!name) return "Untitled campaign";
  const parts = name.split(" + ");
  if (parts.length <= 1) return name.length > 60 ? `${name.slice(0, 57)}…` : name;
  const more = parts.length - 1;
  const first = parts[0].length > 50 ? `${parts[0].slice(0, 47)}…` : parts[0];
  return `${first} + ${more} more`;
}
