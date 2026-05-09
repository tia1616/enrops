// src/pages/admin/marketing/PlansTab.jsx
// Plans list — default landing tab for Marketing.
// Shows active/scheduled/complete plans. Wave 2 appears as a scheduled plan.

import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase.js";
import { INK, MUTED, RULE, PLUM, OK, INFO, WARN, Card, Pill, btn } from "./tokens.jsx";

export default function PlansTab({ org, goCompose }) {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ groups: 0, emailsThisWeek: 0, parents: 0 });

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      // Load plans
      const { data: planRows } = await supabase
        .from("marketing_plans")
        .select("*")
        .order("created_at", { ascending: false });
      setPlans(planRows ?? []);

      // Also check for legacy campaigns (Wave 2 etc) to show them in the list
      const { data: legacyCampaigns } = await supabase
        .from("marketing_campaigns")
        .select("id, name, status, wave, scheduled_at, sent_at, total_recipients, total_sent, campaign_type")
        .order("created_at", { ascending: false });

      // Merge legacy campaigns as pseudo-plans
      const legacyAsPlans = (legacyCampaigns ?? []).map(c => ({
        id: `legacy-${c.id}`,
        name: c.name,
        status: c.status === "ready" ? "scheduled" : c.status === "sent" ? "complete" : c.status,
        goal: c.campaign_type || "custom",
        total_sends: 1,
        sends_complete: c.status === "sent" ? 1 : 0,
        date_start: c.scheduled_at,
        scheduled_at: c.scheduled_at,
        sent_at: c.sent_at,
        total_recipients: c.total_recipients,
        total_sent: c.total_sent,
        wave: c.wave,
        _legacy: true,
      }));

      setPlans([...legacyAsPlans, ...(planRows ?? [])]);

      // Stats
      const { count: groupCount } = await supabase
        .from("marketing_groups")
        .select("id", { count: "exact", head: true });
      
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const { count: emailCount } = await supabase
        .from("marketing_emails")
        .select("id", { count: "exact", head: true })
        .eq("status", "sent")
        .gte("sent_at", weekAgo);

      setStats({
        groups: groupCount ?? 0,
        emailsThisWeek: emailCount ?? 0,
        parents: "—", // would come from a parent count query
      });
    } catch (e) {
      console.error("Plans load error:", e);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 4px", letterSpacing: -0.3, color: INK }}>
            Campaigns
          </h1>
          <p style={{ fontSize: 13, color: MUTED, margin: 0 }}>
            Scheduled and one-off email sends. AI-planned multi-send campaigns coming in Stage 2.
          </p>
        </div>
        <button style={btn(PLUM)} disabled title="AI campaign builder coming in Stage 2">
          + New campaign
        </button>
      </div>

      {loading && <p style={{ color: MUTED, fontSize: 14 }}>Loading plans…</p>}

      {!loading && plans.length === 0 && (
        <Card dashed style={{ padding: 32, textAlign: "center" }}>
          <p style={{ color: MUTED, fontSize: 14, margin: 0 }}>
            No campaigns yet. Your scheduled sends and Wave 2 will appear here.
          </p>
          <p style={{ color: MUTED, fontSize: 12, marginTop: 8 }}>
            Use <strong>Compose</strong> to create and send emails.
          </p>
        </Card>
      )}

      {plans.map(p => (
        <Card key={p.id}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 3, color: INK }}>{p.name}</div>
              <div style={{ fontSize: 11, color: MUTED }}>
                {p.goal && p.goal !== "custom" ? p.goal.replace("_", " ") + " · " : ""}
                {p.total_sends ? `${p.total_sends} send${p.total_sends > 1 ? "s" : ""}` : "Single send"}
                {p.total_recipients ? ` · ${p.total_recipients} recipients` : ""}
                {p.wave ? ` · ${p.wave}` : ""}
              </div>
            </div>
            <Pill status={p.status} />
          </div>

          {/* Progress bar for multi-send plans */}
          {p.total_sends > 1 && (
            <>
              <div style={{ height: 6, background: "#f1efe8", borderRadius: 3, overflow: "hidden", marginTop: 8 }}>
                <div style={{
                  background: OK, height: "100%",
                  width: `${Math.round((p.sends_complete / p.total_sends) * 100)}%`,
                }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: MUTED, marginTop: 6 }}>
                <span>{p.sends_complete} of {p.total_sends} complete</span>
              </div>
            </>
          )}

          {/* Scheduled date for single-send */}
          {p.scheduled_at && !p.sent_at && (
            <div style={{ fontSize: 11, color: MUTED, marginTop: 8 }}>
              Sends: <strong style={{ color: INK, fontWeight: 600 }}>
                {new Date(p.scheduled_at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </strong>
            </div>
          )}

          {p.sent_at && (
            <div style={{ fontSize: 11, color: OK, marginTop: 8 }}>
              ✓ sent {new Date(p.sent_at).toLocaleString()}
              {p.total_sent ? ` · ${p.total_sent} delivered` : ""}
            </div>
          )}
        </Card>
      ))}

      {/* Footer stats */}
      {!loading && (
        <div style={{
          paddingTop: 14, borderTop: `1px solid ${RULE}`, marginTop: 14,
          display: "flex", gap: 28, fontSize: 11, color: MUTED,
        }}>
          <div>
            <strong style={{ color: INK, fontSize: 16, display: "block", fontWeight: 600 }}>
              {stats.groups}
            </strong>
            groups
          </div>
          <div>
            <strong style={{ color: INK, fontSize: 16, display: "block", fontWeight: 600 }}>
              {stats.emailsThisWeek}
            </strong>
            emails sent this week
          </div>
        </div>
      )}
    </div>
  );
}
