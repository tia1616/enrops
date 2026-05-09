// src/pages/admin/MarketingAdmin.jsx
// Marketing tab of the admin portal. Lists campaigns, previews per-school emails,
// supports test send + scheduled send + send-now (override).
// Multi-tenant: queries marketing_campaigns scoped by the user's org via RLS.

import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase";

const PLUM = "#691D39";
const GOLD = "#CFB12F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const DANGER = "#b3261e";
const OK = "#2e7d32";
const INFO = "#1565c0";

export default function MarketingAdmin() {
  const { org } = useOutletContext() ?? {};

  const [campaigns, setCampaigns] = useState([]);
  const [selected, setSelected] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState("");
  const [actionTone, setActionTone] = useState("info"); // info | ok | err
  const [expandedSchool, setExpandedSchool] = useState(null);
  const [testEmail, setTestEmail] = useState("");
  const [scheduleDate, setScheduleDate] = useState("");

  useEffect(() => {
    loadCampaigns();
  }, []);

  function setMsg(text, tone = "info") {
    setActionMsg(text);
    setActionTone(tone);
  }

  async function loadCampaigns() {
    const { data, error } = await supabase
      .from("marketing_campaigns")
      .select("id, name, status, wave, scheduled_at, sent_at, total_recipients, total_sent, campaign_type")
      .order("created_at", { ascending: false });
    if (error) {
      setMsg("Load error: " + error.message, "err");
      return;
    }
    setCampaigns(data ?? []);
  }

  async function loadPreview(campaign) {
    setSelected(campaign);
    setLoading(true);
    setPreviewData(null);
    setActionMsg("");
    setExpandedSchool(null);
    try {
      const { data, error } = await supabase.functions.invoke("marketing-render-preview", {
        body: { campaign_id: campaign.id },
      });
      if (error) throw error;
      setPreviewData(data);
      if (campaign.scheduled_at) {
        const d = new Date(campaign.scheduled_at);
        // Format for datetime-local input (YYYY-MM-DDTHH:MM in local time)
        const pad = (n) => String(n).padStart(2, "0");
        setScheduleDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
      } else {
        setScheduleDate("");
      }
    } catch (e) {
      setMsg("Preview error: " + (e.message ?? String(e)), "err");
    } finally {
      setLoading(false);
    }
  }

  async function sendTest() {
    if (!selected || !testEmail) return;
    if (!confirm(`Send a test of the FIRST school's email to ${testEmail}?`)) return;
    setLoading(true);
    setActionMsg("");
    try {
      const { data, error } = await supabase.functions.invoke("marketing-render-and-send", {
        body: { campaign_id: selected.id, test_email: testEmail },
      });
      if (error) throw error;
      setMsg(`Test sent. Check ${testEmail}.`, "ok");
    } catch (e) {
      setMsg("Test error: " + (e.message ?? String(e)), "err");
    } finally {
      setLoading(false);
    }
  }

  async function sendNow() {
    if (!selected) return;
    const recipients = previewData?.total_recipients ?? "?";
    const emails = previewData?.total_emails ?? "?";
    if (!confirm(`Send NOW to ${recipients} recipients across ${emails} schools? This cannot be undone.`)) return;
    setLoading(true);
    setActionMsg("");
    try {
      const { data, error } = await supabase.functions.invoke("marketing-render-and-send", {
        body: { campaign_id: selected.id, force: true },
      });
      if (error) throw error;
      setMsg(`Sent: ${data.sent ?? "?"} · skipped: ${data.skipped ?? 0} · errors: ${data.errors ?? 0}`, "ok");
      await loadCampaigns();
      // Refresh selected campaign status
      const updated = (await supabase.from("marketing_campaigns").select("id, name, status, wave, scheduled_at, sent_at, total_recipients, total_sent, campaign_type").eq("id", selected.id).maybeSingle()).data;
      if (updated) setSelected(updated);
    } catch (e) {
      setMsg("Send error: " + (e.message ?? String(e)), "err");
    } finally {
      setLoading(false);
    }
  }

  async function updateSchedule() {
    if (!selected || !scheduleDate) return;
    const isoDate = new Date(scheduleDate).toISOString();
    const { error } = await supabase
      .from("marketing_campaigns")
      .update({ scheduled_at: isoDate, status: "ready", updated_at: new Date().toISOString() })
      .eq("id", selected.id);
    if (error) {
      setMsg("Schedule error: " + error.message, "err");
      return;
    }
    setMsg(`Scheduled for ${new Date(isoDate).toLocaleString()}.`, "ok");
    await loadCampaigns();
    setSelected({ ...selected, scheduled_at: isoDate, status: "ready" });
  }

  return (
    <div>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.5 }}>
          Marketing
        </h1>
        <p style={{ color: MUTED, marginTop: 6, fontSize: 14 }}>
          Preview, schedule, test, and send campaigns.
        </p>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 24 }}>
        {/* Campaign list */}
        <div>
          <h2 style={{ fontSize: 12, textTransform: "uppercase", color: MUTED, letterSpacing: 0.8, fontWeight: 600, margin: "0 0 12px" }}>
            Campaigns
          </h2>
          {campaigns.length === 0 && (
            <p style={{ color: MUTED, fontSize: 14 }}>No campaigns yet.</p>
          )}
          {campaigns.map((c) => (
            <div
              key={c.id}
              onClick={() => loadPreview(c)}
              style={{
                padding: 14,
                marginBottom: 8,
                border: selected?.id === c.id ? `2px solid ${PLUM}` : `1px solid ${RULE}`,
                borderRadius: 6,
                cursor: "pointer",
                background: selected?.id === c.id ? "#fff" : "#fff",
                transition: "border-color 0.15s",
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 14, color: INK, lineHeight: 1.35 }}>
                {c.name}
              </div>
              <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
                <span style={{ color: statusColor(c.status), fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  {c.status}
                </span>
                {c.wave && <span> · {c.wave}</span>}
                {c.scheduled_at && (
                  <div style={{ marginTop: 2 }}>📅 {new Date(c.scheduled_at).toLocaleString()}</div>
                )}
                {c.sent_at && (
                  <div style={{ marginTop: 2, color: OK }}>✓ sent {new Date(c.sent_at).toLocaleString()}</div>
                )}
                {c.total_recipients !== null && (
                  <div style={{ marginTop: 2 }}>{c.total_recipients} recipients</div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Detail panel */}
        <div>
          {!selected && (
            <div style={{ padding: 32, textAlign: "center", border: `1px dashed ${RULE}`, borderRadius: 8, color: MUTED }}>
              Select a campaign on the left to preview.
            </div>
          )}

          {selected && (
            <>
              <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: 20, marginBottom: 16 }}>
                <h2 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 4px", color: INK }}>{selected.name}</h2>
                <p style={{ color: MUTED, margin: "0 0 16px", fontSize: 13 }}>
                  Status:{" "}
                  <strong style={{ color: statusColor(selected.status), textTransform: "uppercase", letterSpacing: 0.4 }}>
                    {selected.status}
                  </strong>
                  {" · "}{selected.campaign_type}
                </p>

                {/* Schedule control */}
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
                  <label style={{ fontSize: 13, color: INK, fontWeight: 500, minWidth: 120 }}>Scheduled send:</label>
                  <input
                    type="datetime-local"
                    value={scheduleDate}
                    onChange={(e) => setScheduleDate(e.target.value)}
                    style={input()}
                  />
                  <button onClick={updateSchedule} disabled={loading || !scheduleDate} style={btn(INFO)}>
                    Save schedule
                  </button>
                </div>

                {/* Test send */}
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
                  <label style={{ fontSize: 13, color: INK, fontWeight: 500, minWidth: 120 }}>Test email:</label>
                  <input
                    type="email"
                    placeholder="you@example.com"
                    value={testEmail}
                    onChange={(e) => setTestEmail(e.target.value)}
                    style={{ ...input(), minWidth: 240 }}
                  />
                  <button onClick={sendTest} disabled={loading || !testEmail} style={btn(MUTED)}>
                    Send test
                  </button>
                </div>

                {/* Send now */}
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14, paddingTop: 14, borderTop: `1px solid ${RULE}` }}>
                  <span style={{ fontSize: 13, color: MUTED, flex: 1 }}>
                    Override the schedule and send immediately:
                  </span>
                  <button onClick={sendNow} disabled={loading || selected.status === "sent"} style={btn(DANGER)}>
                    Send now
                  </button>
                </div>

                {actionMsg && (
                  <div style={{
                    marginTop: 14,
                    background: actionTone === "ok" ? "#e8f5e9" : actionTone === "err" ? "#fdecea" : "#fff8e1",
                    color: actionTone === "ok" ? OK : actionTone === "err" ? DANGER : INK,
                    padding: 10,
                    borderRadius: 4,
                    fontSize: 13,
                  }}>
                    {actionMsg}
                  </div>
                )}
              </div>

              {loading && <p style={{ color: MUTED }}>Loading…</p>}

              {previewData && (
                <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: 20 }}>
                  <p style={{ marginTop: 0, marginBottom: 14, fontSize: 14, color: INK }}>
                    <strong>{previewData.total_emails}</strong> emails to{" "}
                    <strong>{previewData.total_recipients}</strong> recipients. Click any school to expand.
                  </p>
                  {previewData.previews.map((p) => (
                    <div key={p.school} style={{ border: `1px solid ${RULE}`, borderRadius: 6, marginBottom: 8 }}>
                      <div
                        onClick={() => setExpandedSchool(expandedSchool === p.school ? null : p.school)}
                        style={{
                          padding: "12px 14px",
                          cursor: "pointer",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          background: expandedSchool === p.school ? "#faf8f0" : "#fff",
                          borderRadius: 6,
                        }}
                      >
                        <div>
                          <strong style={{ fontSize: 14, color: INK }}>{p.school}</strong>
                          {p.is_soft_open && (
                            <span style={{ marginLeft: 10, fontSize: 10, padding: "2px 8px", background: `${GOLD}44`, color: PLUM, borderRadius: 999, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                              soft-open follow-up
                            </span>
                          )}
                          {p.error && (
                            <span style={{ marginLeft: 10, fontSize: 12, color: DANGER }}>⚠ {p.error}</span>
                          )}
                        </div>
                        <div style={{ color: MUTED, fontSize: 13 }}>
                          {p.recipient_count} recipient{p.recipient_count === 1 ? "" : "s"}
                        </div>
                      </div>
                      {expandedSchool === p.school && (
                        <div style={{ padding: 16, borderTop: `1px solid ${RULE}`, background: "#fafafa" }}>
                          <div style={{ fontSize: 11, color: MUTED, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
                            Subject
                          </div>
                          <div style={{ marginBottom: 16, fontWeight: 600, fontSize: 14, color: INK }}>{p.subject}</div>
                          <div style={{ fontSize: 11, color: MUTED, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
                            Body
                          </div>
                          <pre style={{
                            whiteSpace: "pre-wrap",
                            fontFamily: "ui-sans-serif, system-ui, sans-serif",
                            margin: 0,
                            fontSize: 14,
                            lineHeight: 1.6,
                            color: INK,
                          }}>
                            {p.body}
                          </pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function statusColor(status) {
  switch (status) {
    case "draft": return MUTED;
    case "ready": return INFO;
    case "sending": return "#ed6c02";
    case "sent": return OK;
    case "paused": return DANGER;
    default: return MUTED;
  }
}

function btn(bg) {
  return {
    padding: "8px 14px",
    background: bg,
    color: "#fff",
    border: 0,
    borderRadius: 5,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
    fontFamily: "inherit",
  };
}

function input() {
  return {
    padding: "7px 10px",
    border: `1px solid ${RULE}`,
    borderRadius: 5,
    fontSize: 13,
    fontFamily: "inherit",
    background: "#fff",
    color: INK,
  };
}
