// src/pages/admin/marketing/SentTab.jsx
// Send log — lists all sent/scheduled/failed emails with stats.

import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase.js";
import { INK, MUTED, RULE, OK, INFO, DANGER, Card, Pill } from "./tokens.jsx";

export default function SentTab({ org }) {
  const [emails, setEmails] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("marketing_emails")
      .select("*")
      .in("status", ["sent", "sending", "scheduled", "failed"])
      .order("created_at", { ascending: false });

    // Also pull legacy campaigns
    const { data: legacy } = await supabase
      .from("marketing_campaigns")
      .select("*")
      .in("status", ["sent", "ready", "sending"])
      .order("created_at", { ascending: false });

    const legacyEmails = (legacy ?? []).map(c => ({
      id: `legacy-${c.id}`,
      subject: c.name,
      status: c.status === "ready" ? "scheduled" : c.status,
      send_mode: "split_by_school",
      total_recipients: c.total_recipients,
      total_sent: c.total_sent,
      sent_at: c.sent_at,
      scheduled_at: c.scheduled_at,
      created_at: c.created_at,
      _legacy: true,
    }));

    setEmails([...(data ?? []), ...legacyEmails].sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at)
    ));
    setLoading(false);
  }

  function sendModeLabel(mode) {
    switch (mode) {
      case "one": return "One email";
      case "split_by_school": return "By school";
      case "split_by_class": return "By class";
      case "split_by_area": return "By area";
      default: return mode ?? "—";
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 4px", letterSpacing: -0.3, color: INK }}>
        Sent
      </h1>
      <p style={{ fontSize: 13, color: MUTED, margin: "0 0 14px" }}>
        All scheduled and sent emails. Click any row for details.
      </p>

      {loading && <p style={{ color: MUTED, fontSize: 14 }}>Loading…</p>}

      {!loading && emails.length === 0 && (
        <Card dashed style={{ padding: 24, textAlign: "center" }}>
          <p style={{ color: MUTED, fontSize: 13, margin: 0 }}>
            No emails sent yet. Compose your first email in the Compose tab.
          </p>
        </Card>
      )}

      {!loading && emails.length > 0 && (
        <Card style={{ padding: 0 }}>
          {/* Header */}
          <div style={{
            display: "grid", gridTemplateColumns: "3fr 1fr 1fr 1fr 1fr",
            padding: "10px 14px", borderBottom: `1px solid ${RULE}`,
            fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, fontWeight: 600,
          }}>
            <span>Subject</span>
            <span>Mode</span>
            <span>Recipients</span>
            <span>Status</span>
            <span>Date</span>
          </div>

          {emails.map(e => (
            <div
              key={e.id}
              style={{
                display: "grid", gridTemplateColumns: "3fr 1fr 1fr 1fr 1fr",
                padding: "12px 14px", borderBottom: `1px solid ${RULE}`,
                fontSize: 12, alignItems: "center",
              }}
            >
              <span style={{ fontWeight: 500, color: INK }}>
                {e.subject || "(no subject)"}
                {e._legacy && <span style={{ fontSize: 10, color: MUTED, marginLeft: 6 }}>legacy</span>}
              </span>
              <span style={{ color: MUTED }}>{sendModeLabel(e.send_mode)}</span>
              <span>
                {e.total_sent ?? e.total_recipients ?? "—"}
                {e.total_recipients && e.total_sent ? ` / ${e.total_recipients}` : ""}
              </span>
              <span><Pill status={e.status} /></span>
              <span style={{ color: MUTED, fontSize: 11 }}>
                {e.sent_at
                  ? new Date(e.sent_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
                  : e.scheduled_at
                    ? `sched ${new Date(e.scheduled_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                    : "—"}
              </span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
