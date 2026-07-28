// /admin/dev/refund-watch
// Arielle's refund checklist v4, section 4: abuse monitoring — FLAG, don't block.
//
// Her wording is the whole spec: "Set a threshold (e.g., 15%) that flags the
// operator account for internal review. This never blocks or delays any
// individual refund — it's a dashboard flag for us, not a gate on the
// transaction." So this screen is read-only over refund data, nothing on it
// can stop a refund, and no refund code path reads the flag.
//
// Platform-admin only, same shape as ExtractionTest: AdminLayout already gates
// on org_members, and we add a second platform_admins check because this reports
// across EVERY tenant. get_operator_refund_rates() enforces the same rule again
// in the database, so the UI check is convenience, not the security boundary.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase.js";

const PURPLE = "#1C004F";
const CREAM = "#FBFBFB";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const FLAG = "#B3261E";
const OK = "#1B7F4C";

const fmtCents = (c) =>
  typeof c === "number" ? `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";

export default function RefundWatch() {
  const [adminCheck, setAdminCheck] = useState("loading"); // loading | denied | ok
  const [rows, setRows] = useState(null); // null = loading
  const [loadErr, setLoadErr] = useState("");

  // Threshold settings, editable here so tuning never needs a deploy.
  const [threshold, setThreshold] = useState("");
  const [minTxn, setMinTxn] = useState("");
  const [windowDays, setWindowDays] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState(null); // { ok: bool, text }

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) { setAdminCheck("denied"); return; }
      const { data: adminRow } = await supabase
        .from("platform_admins")
        .select("auth_user_id")
        .eq("auth_user_id", session.user.id)
        .maybeSingle();
      setAdminCheck(adminRow ? "ok" : "denied");
    })();
  }, []);

  const load = useCallback(async () => {
    setLoadErr("");
    const [{ data, error }, { data: cfgRow }] = await Promise.all([
      supabase.rpc("get_operator_refund_rates"),
      supabase.from("platform_settings").select("value").eq("key", "refund_watch").maybeSingle(),
    ]);
    if (error) {
      console.error("[RefundWatch] load failed", error);
      setLoadErr("Couldn't load refund rates. Refresh to try again.");
      setRows([]);
      return;
    }
    setRows(data ?? []);
    const cfg = cfgRow?.value ?? {};
    // Seed the inputs from the stored settings, not from the first row, so the
    // form still shows the real config when no operator has any transactions.
    setThreshold(String(cfg.rate_threshold_pct ?? 15));
    setMinTxn(String(cfg.min_transactions ?? 5));
    setWindowDays(String(cfg.window_days ?? 30));
  }, []);

  useEffect(() => { if (adminCheck === "ok") load(); }, [adminCheck, load]);

  async function saveSettings() {
    if (saving) return;
    const t = Number(threshold), m = Number(minTxn), w = Number(windowDays);
    if (!Number.isFinite(t) || t < 0 || t > 100) { setSaveNote({ ok: false, text: "Threshold must be between 0 and 100." }); return; }
    if (!Number.isInteger(m) || m < 0) { setSaveNote({ ok: false, text: "Minimum sales must be a whole number, 0 or more." }); return; }
    if (!Number.isInteger(w) || w < 1 || w > 365) { setSaveNote({ ok: false, text: "Window must be between 1 and 365 days." }); return; }

    setSaving(true);
    setSaveNote(null);
    const { error } = await supabase
      .from("platform_settings")
      .update({ value: { rate_threshold_pct: t, min_transactions: m, window_days: w }, updated_at: new Date().toISOString() })
      .eq("key", "refund_watch");
    if (error) {
      // Never let a failed save look like a successful one. The next decision
      // (who to review) depends on this number being what it says it is.
      console.error("[RefundWatch] save failed", error);
      setSaveNote({ ok: false, text: "Couldn't save. Nothing changed." });
      setSaving(false);
      return;
    }
    // Re-read so the table reflects the new threshold immediately — a save that
    // updates the number but leaves stale flags on screen is a lie.
    await load();
    setSaving(false);
    setSaveNote({ ok: true, text: "Saved. Flags below use the new settings." });
  }

  if (adminCheck === "loading") {
    return <div style={{ color: MUTED, padding: 24 }}>Checking platform-admin access…</div>;
  }
  if (adminCheck === "denied") {
    return (
      <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8, padding: 24, maxWidth: 520 }}>
        <h2 style={{ marginTop: 0, color: PURPLE }}>Platform admin only</h2>
        <p style={{ color: INK, fontSize: 14 }}>
          This screen shows refund rates across every operator, so it's restricted to platform admins.
          Org-level admin access alone is not enough.
        </p>
      </div>
    );
  }

  const flaggedCount = (rows ?? []).filter((r) => r.flagged).length;

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0, color: PURPLE, fontSize: 26, fontWeight: 700 }}>Refund watch</h1>
        <div style={{ color: MUTED, fontSize: 13, marginTop: 4, maxWidth: 620 }}>
          How much of what each operator sold came back as a refund. This is a flag for us to look at,
          not a block — nothing here stops or delays a refund for anyone.
        </div>
      </div>

      {/* settings */}
      <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8, padding: 16, marginBottom: 16, maxWidth: 620 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: PURPLE, marginBottom: 10 }}>When to flag an operator</div>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ fontSize: 12, color: MUTED }}>
            Refund rate at or above
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
              <input type="number" min="0" max="100" step="0.5" value={threshold} disabled={saving}
                onChange={(e) => { setThreshold(e.target.value); setSaveNote(null); }}
                style={{ width: 84, padding: "6px 8px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 14, color: INK }} />
              <span style={{ fontSize: 14, color: INK }}>%</span>
            </div>
          </label>
          <label style={{ fontSize: 12, color: MUTED }}>
            Only once they've had
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
              <input type="number" min="0" step="1" value={minTxn} disabled={saving}
                onChange={(e) => { setMinTxn(e.target.value); setSaveNote(null); }}
                style={{ width: 72, padding: "6px 8px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 14, color: INK }} />
              <span style={{ fontSize: 14, color: INK }}>sales</span>
            </div>
          </label>
          <label style={{ fontSize: 12, color: MUTED }}>
            Looking back
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
              <input type="number" min="1" max="365" step="1" value={windowDays} disabled={saving}
                onChange={(e) => { setWindowDays(e.target.value); setSaveNote(null); }}
                style={{ width: 72, padding: "6px 8px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 14, color: INK }} />
              <span style={{ fontSize: 14, color: INK }}>days</span>
            </div>
          </label>
          <button type="button" onClick={saveSettings} disabled={saving}
            style={{ padding: "8px 16px", borderRadius: 6, border: `1px solid ${PURPLE}`, background: saving ? CREAM : PURPLE,
                     color: saving ? MUTED : "#fff", fontSize: 13, fontWeight: 600, cursor: saving ? "default" : "pointer" }}>
            {saving ? "Saving…" : "Save"}
          </button>
          {/* Feedback sits next to the button that caused it, not at the top of the page. */}
          {saveNote && (
            <div style={{ fontSize: 12.5, fontWeight: 600, color: saveNote.ok ? OK : FLAG, paddingBottom: 8 }}>
              {saveNote.text}
            </div>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: MUTED, marginTop: 10, lineHeight: 1.5 }}>
          The minimum-sales rule stops a brand-new operator being flagged for one refund in their first week.
        </div>
      </div>

      {loadErr && (
        <div style={{ background: `${FLAG}12`, color: FLAG, padding: 10, borderRadius: 6, fontSize: 12.5, marginBottom: 12, maxWidth: 620 }}>
          {loadErr}
        </div>
      )}

      {rows === null && <div style={{ color: MUTED, fontSize: 13, padding: "16px 0" }}>Loading…</div>}

      {rows !== null && rows.length === 0 && !loadErr && (
        <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8, padding: 24, maxWidth: 620, color: MUTED, fontSize: 13 }}>
          No operator has taken a payment in this window yet, so there's nothing to measure.
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <>
          <div style={{ fontSize: 13, color: flaggedCount ? FLAG : MUTED, fontWeight: flaggedCount ? 700 : 400, marginBottom: 8 }}>
            {flaggedCount === 0
              ? `No operator is over the threshold in the last ${rows[0].window_days} days.`
              : `${flaggedCount} operator${flaggedCount === 1 ? "" : "s"} over the threshold in the last ${rows[0].window_days} days.`}
          </div>

          <div style={{ overflowX: "auto", maxWidth: 720 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8 }}>
              <thead>
                <tr style={{ textAlign: "left", color: MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em" }}>
                  <th style={{ padding: "10px 12px", borderBottom: `1px solid ${RULE}` }}>Operator</th>
                  <th style={{ padding: "10px 12px", borderBottom: `1px solid ${RULE}`, textAlign: "right" }}>Sales</th>
                  <th style={{ padding: "10px 12px", borderBottom: `1px solid ${RULE}`, textAlign: "right" }}>Refunded</th>
                  <th style={{ padding: "10px 12px", borderBottom: `1px solid ${RULE}`, textAlign: "right" }}>Rate</th>
                  <th style={{ padding: "10px 12px", borderBottom: `1px solid ${RULE}`, textAlign: "right" }}>Money back</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.organization_id}>
                    <td style={{ padding: "10px 12px", borderBottom: `1px solid ${RULE}`, color: INK }}>
                      <span style={{ fontWeight: 600 }}>{r.name}</span>
                      {r.flagged && (
                        <span style={{ marginLeft: 8, fontSize: 10, color: FLAG, fontWeight: 700, textTransform: "uppercase",
                                       letterSpacing: ".05em", border: `1px solid ${FLAG}`, borderRadius: 4, padding: "1px 5px" }}>
                          Review
                        </span>
                      )}
                      <div style={{ fontSize: 11.5, color: MUTED }}>
                        {r.refund_events > r.refunds
                          ? `${r.refund_events} refunds across ${r.refunds} sale${r.refunds === 1 ? "" : "s"}`
                          : `${r.refund_events} refund${r.refund_events === 1 ? "" : "s"}`}
                      </div>
                    </td>
                    <td style={{ padding: "10px 12px", borderBottom: `1px solid ${RULE}`, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.transactions}</td>
                    <td style={{ padding: "10px 12px", borderBottom: `1px solid ${RULE}`, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.refunds}</td>
                    <td style={{ padding: "10px 12px", borderBottom: `1px solid ${RULE}`, textAlign: "right", fontVariantNumeric: "tabular-nums",
                                 color: r.flagged ? FLAG : INK, fontWeight: r.flagged ? 700 : 400 }}>
                      {Number(r.refund_rate_pct).toFixed(1)}%
                    </td>
                    <td style={{ padding: "10px 12px", borderBottom: `1px solid ${RULE}`, textAlign: "right", fontVariantNumeric: "tabular-nums", color: MUTED }}>
                      {fmtCents(r.refunded_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 11.5, color: MUTED, marginTop: 10, maxWidth: 620, lineHeight: 1.6 }}>
            "Sales" counts charges, not registrations, so a payment plan counts once per instalment taken.
            "Refunded" counts how many of those charges had money returned — a charge refunded in several
            parts still counts once. Operators with no payments in the window are left out.
          </div>
        </>
      )}
    </div>
  );
}
