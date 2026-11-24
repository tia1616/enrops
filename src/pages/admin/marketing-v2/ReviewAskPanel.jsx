// Review ask: the settings that are not the wording, and the results.
//
// ReviewAskSettings is CONTROLLED by AutomationEditor (its values ride the
// editor's one Save), so there is one Save button in the drawer, not two.
// ReviewAskResults reads review_ask_stats(org): per class, how many families
// were asked, clicked, and got the reminder.

import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase.js";
import { PURPLE, INK, MUTED, RULE, WARN } from "../marketing/tokens.jsx";

const label = { display: "block", fontSize: 12, fontWeight: 700, color: INK, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 };
const help = { margin: "6px 0 0", fontSize: 11, color: MUTED, lineHeight: 1.45 };
const input = { padding: "8px 10px", fontSize: 14, color: INK, border: `1px solid ${RULE}`, borderRadius: 6, outline: "none", background: "#fff", boxSizing: "border-box" };

export function ReviewAskSettings({ value, onChange }) {
  const v = value;
  const set = (patch) => onChange({ ...v, ...patch });
  const lastSession = v.trigger === "days_after_last_session";
  const urlLooksOk = /^https:\/\/\S+$/i.test(v.googleUrl.trim());
  return (
    <div style={{ marginBottom: 24, padding: 14, border: `1px solid ${RULE}`, borderRadius: 8, background: "#FBFBFB" }}>
      <div style={{ marginBottom: 16 }}>
        <span style={label}>Google review link</span>
        <input
          type="url"
          value={v.googleUrl}
          onChange={(e) => set({ googleUrl: e.target.value })}
          placeholder="https://g.page/r/.../review"
          style={{ ...input, width: "100%", borderColor: urlLooksOk ? RULE : WARN }}
        />
        <p style={help}>
          {urlLooksOk
            ? "The button in the email opens this page. We count each family's click on the way."
            : "Paste the link that opens your Google review box. Until it is set, no review emails send."}
        </p>
      </div>

      <div style={{ marginBottom: 16 }}>
        <span style={label}>When to send</span>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: INK, marginBottom: 6 }}>
          <input type="radio" checked={lastSession} onChange={() => set({ trigger: "days_after_last_session" })} />
          <span>
            {lastSession ? (
              <>
                <input
                  type="number" min={0} max={30}
                  value={v.lastSessionDays}
                  onChange={(e) => set({ lastSessionDays: e.target.value })}
                  onBlur={() => { const n = parseInt(v.lastSessionDays, 10); if (!Number.isFinite(n) || n < 0) set({ lastSessionDays: "0" }); }}
                  style={{ ...input, width: 60, textAlign: "center", padding: "4px 6px" }}
                />{" "}
                days after the last class or camp day, at 6 pm
              </>
            ) : "After the last class or camp day"}
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: INK }}>
          <input type="radio" checked={!lastSession} onChange={() => set({ trigger: "days_after_engagement" })} />
          <span>Some days after a family joins (set below)</span>
        </label>
        <p style={help}>
          {lastSession
            ? (String(v.lastSessionDays) === "0"
              ? "0 sends the evening of the last session, while the showcase is fresh."
              : `Sends at 6 pm, ${v.lastSessionDays} days after the last session.`)
            : "For a business without classes in enrops (contacts only)."}
        </p>
      </div>

      <div>
        <span style={label}>Reminder</span>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: INK, flexWrap: "wrap" }}>
          <input type="checkbox" checked={v.reminderOn} onChange={(e) => set({ reminderOn: e.target.checked })} />
          <span>One reminder</span>
          <input
            type="number" min={1} max={14}
            value={v.reminderDays}
            disabled={!v.reminderOn}
            onChange={(e) => set({ reminderDays: e.target.value })}
            onBlur={() => { const n = parseInt(v.reminderDays, 10); if (!Number.isFinite(n) || n < 1) set({ reminderDays: "3" }); }}
            style={{ ...input, width: 60, textAlign: "center", padding: "4px 6px", opacity: v.reminderOn ? 1 : 0.5 }}
          />
          <span>days later, to families who have not clicked</span>
        </label>
        <p style={help}>Only whether they clicked decides it. One reminder per family, then it stops.</p>
      </div>
    </div>
  );
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ReviewAskResults({ orgId }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!orgId) return;
    let alive = true;
    (async () => {
      const { data, error } = await supabase.rpc("review_ask_stats", { p_org: orgId });
      if (!alive) return;
      if (error) { setErr(error.message); setRows([]); return; }
      setRows((data ?? []).slice().sort((a, b) => String(b.last_asked_at ?? "").localeCompare(String(a.last_asked_at ?? ""))));
    })();
    return () => { alive = false; };
  }, [orgId]);

  const totals = (rows ?? []).reduce((t, r) => ({
    asked: t.asked + Number(r.families_asked || 0),
    clicked: t.clicked + Number(r.clicked || 0),
    reminded: t.reminded + Number(r.reminded || 0),
  }), { asked: 0, clicked: 0, reminded: 0 });
  const th = { textAlign: "left", fontSize: 11, color: MUTED, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, padding: "6px 8px", borderBottom: `1px solid ${RULE}` };
  const td = { fontSize: 13, color: INK, padding: "7px 8px", borderBottom: `1px solid #F1F1F1` };

  return (
    <div style={{ marginBottom: 24 }}>
      <span style={label}>Results by class</span>
      {rows === null ? (
        <p style={help}>Loading…</p>
      ) : err ? (
        <p style={{ ...help, color: WARN }}>Couldn&apos;t load results: {err}</p>
      ) : rows.length === 0 ? (
        <p style={help}>No review emails have gone out yet. Each class shows up here the evening it ends.</p>
      ) : (
        <>
          <p style={{ ...help, margin: "0 0 8px", fontSize: 13, color: INK }}>
            <strong>{totals.clicked}</strong> of <strong>{totals.asked}</strong> families clicked through to Google
            {totals.reminded > 0 ? <> · {totals.reminded} got the reminder</> : null}.
          </p>
          <div style={{ overflowX: "auto", border: `1px solid ${RULE}`, borderRadius: 6 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Class</th>
                  <th style={th}>Term</th>
                  <th style={{ ...th, textAlign: "right" }}>Asked</th>
                  <th style={{ ...th, textAlign: "right" }}>Clicked</th>
                  <th style={{ ...th, textAlign: "right" }}>Reminded</th>
                  <th style={th}>Sent</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.program_id}|${r.term}`}>
                    <td style={td}>
                      {r.program_name}
                      {Number(r.withdrawn_asked) > 0 && (
                        <span style={{ color: MUTED, fontSize: 11 }}> · {r.withdrawn_asked} withdrawn or refunded</span>
                      )}
                    </td>
                    <td style={td}>{r.term}</td>
                    <td style={{ ...td, textAlign: "right" }}>{r.families_asked}</td>
                    <td style={{ ...td, textAlign: "right", color: Number(r.clicked) > 0 ? PURPLE : INK, fontWeight: Number(r.clicked) > 0 ? 700 : 400 }}>{r.clicked}</td>
                    <td style={{ ...td, textAlign: "right" }}>{r.reminded}</td>
                    <td style={td}>{fmtDate(r.last_asked_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={help}>Counts families. A click means they opened your Google review page; Google does not tell us whether they posted.</p>
        </>
      )}
    </div>
  );
}

/** Settings state from a saved automation row + the org's Google link. */
export function reviewSettingsFrom(automation, googleUrl) {
  const tt = automation?.timing_override ?? {};
  return {
    trigger: automation?.trigger_override || "days_after_engagement",
    lastSessionDays: String(Number.isFinite(tt.days_after_last_session) ? tt.days_after_last_session : 0),
    reminderOn: (automation?.reminder_days_after ?? 0) >= 1,
    reminderDays: String((automation?.reminder_days_after ?? 0) >= 1 ? automation.reminder_days_after : 3),
    googleUrl: googleUrl ?? "",
  };
}
