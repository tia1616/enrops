// /admin/platform/revenue-by-state
//
// Money doc section 9 item 14 / section 2A: a monthly report of what enrops
// earned, by US state, so Jessica can watch every state against its sales-tax
// registration threshold. Stripe's own threshold monitoring cannot see this -
// it does not count Connect application fees, and never counts direct-charge
// volume at all - so this screen is the ONLY view of where enrops revenue
// lands. See docs/handoffs/money-item14-revenue-by-state-2026-10-06.md.
//
// PLATFORM ADMINS ONLY, same shape as StripeMoves.jsx: this component checks
// platform_admins before rendering, and the underlying data function carries
// its own boundary - platform_revenue_by_state() is NOT security definer, so
// RLS on registrations/installments (is_platform_admin() in their SELECT
// policies) is what actually limits a non-admin to their own org, same as
// StripeMoves relies on organizations' RLS. The UI check is convenience, not
// the boundary.
//
// WHAT THE NUMBERS ARE, AND ARE NOT:
//   - State is the SITE's state (program_locations.address), not the paying
//     family's or business's billing address - enrops records neither today.
//     For a local after-school/camp business this is a reasonable stand-in,
//     not an exact one. "Unknown" is a site with no address on file.
//   - Figures are GROSS: a registration whose fee was later refunded still
//     counts in the month it was charged. Nexus thresholds are gross-sales
//     tests, so this matches what the monitoring actually needs.
//   - Pro is always $0. There is no Pro-subscription billing anywhere in the
//     schema yet (money doc section 8 item 15 - the milestone gate has not
//     flipped). The column is here so the shape is ready the day it exists;
//     nothing on this screen invents a number before then.

import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase.js";

const PURPLE = "#1C004F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const CREAM = "#FBFBFB";
const FLAG = "#B3261E";

const MONTHS_BACK = 12;

function fmtMoney(cents) {
  return `$${((cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtMonth(isoDate) {
  // isoDate is YYYY-MM-DD (the first of the month). Parsed as local-noon to
  // dodge the UTC-midnight-rolls-back-a-day timezone trap on a bare date.
  const d = new Date(`${isoDate}T12:00:00`);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long" });
}

export default function RevenueByState() {
  const [adminCheck, setAdminCheck] = useState("loading"); // loading | denied | ok
  const [rows, setRows] = useState(null);
  const [loadErr, setLoadErr] = useState("");

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

  useEffect(() => {
    if (adminCheck !== "ok") return;
    (async () => {
      const { data, error } = await supabase.rpc("platform_revenue_by_state", { p_months_back: MONTHS_BACK });
      if (error) {
        console.error("[RevenueByState] load failed", error);
        setLoadErr("Couldn't load the revenue report. Refresh to try again.");
        setRows([]);
        return;
      }
      setRows(data ?? []);
    })();
  }, [adminCheck]);

  if (adminCheck === "loading") {
    return <div style={{ color: MUTED, padding: 24 }}>Checking platform-admin access…</div>;
  }
  if (adminCheck === "denied") {
    return (
      <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8, padding: 24, maxWidth: 520 }}>
        <h2 style={{ marginTop: 0, color: PURPLE }}>Platform admin only</h2>
        <p style={{ color: INK, fontSize: 14 }}>
          This screen shows enrops' own revenue across every business, so it's restricted to
          platform admins. Org-level admin access alone is not enough.
        </p>
      </div>
    );
  }

  // Group the flat (month, state) rows into one block per month, newest
  // first - the RPC already orders this way, so grouping just has to not
  // reorder what it was handed.
  const months = [];
  const byMonth = new Map();
  for (const r of rows ?? []) {
    if (!byMonth.has(r.month)) {
      byMonth.set(r.month, []);
      months.push(r.month);
    }
    byMonth.get(r.month).push(r);
  }

  return (
    <div style={{ maxWidth: 900 }}>
      <h1 style={{ color: PURPLE, margin: "0 0 4px", fontSize: 24 }}>Revenue by state</h1>
      <p style={{ color: MUTED, fontSize: 14, margin: "0 0 20px", maxWidth: 700 }}>
        What enrops earned each month, by the state of the site where the family registered -
        the only view of this, since Stripe's own threshold monitoring can't see application
        fees or direct-charge volume at all. Gross figures (not reduced by later refunds). "Pro"
        is $0 until Pro-subscription billing exists.
      </p>

      {loadErr && (
        <div style={{ background: "#fdecea", border: `1px solid ${FLAG}`, color: FLAG, borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 14 }}>
          {loadErr}
        </div>
      )}

      {rows === null ? (
        <div style={{ color: MUTED }}>Loading…</div>
      ) : loadErr ? null : months.length === 0 ? (
        // loadErr gates this: a failed fetch also leaves rows=[] (so the
        // spinner doesn't hang forever), and without this check that failure
        // rendered as "No recorded revenue" right below its own error banner
        // - a checked zero and a failed load must never look the same.
        <div style={{ color: MUTED }}>No recorded revenue in the last {MONTHS_BACK} months yet.</div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {months.map((month) => {
            const monthRows = byMonth.get(month);
            const monthFeeTotal = monthRows.reduce((s, r) => s + Number(r.enrops_fee_cents || 0), 0);
            const monthProTotal = monthRows.reduce((s, r) => s + Number(r.pro_fee_cents || 0), 0);
            return (
              <div key={month} style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8, padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                  <strong style={{ color: INK, fontSize: 16 }}>{fmtMonth(month)}</strong>
                  <span style={{ color: MUTED, fontSize: 13 }}>
                    {fmtMoney(monthFeeTotal + monthProTotal)} total
                  </span>
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ color: MUTED, textAlign: "left" }}>
                      <th style={{ padding: "4px 8px 4px 0", fontWeight: 600 }}>State</th>
                      <th style={{ padding: "4px 8px", fontWeight: 600, textAlign: "right" }}>enrops service fee</th>
                      <th style={{ padding: "4px 0 4px 8px", fontWeight: 600, textAlign: "right" }}>Pro</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthRows.map((r) => (
                      <tr key={r.state} style={{ borderTop: `1px solid ${CREAM}` }}>
                        <td style={{ padding: "4px 8px 4px 0", color: r.state === "Unknown" ? MUTED : INK }}>
                          {r.state}
                        </td>
                        <td style={{ padding: "4px 8px", textAlign: "right", color: INK }}>
                          {fmtMoney(r.enrops_fee_cents)}
                        </td>
                        <td style={{ padding: "4px 0 4px 8px", textAlign: "right", color: MUTED }}>
                          {fmtMoney(r.pro_fee_cents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
