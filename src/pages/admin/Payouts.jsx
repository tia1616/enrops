// src/pages/admin/Payouts.jsx
// /admin/payouts — money going out from the operator.
//   - Bank:    Stripe payout schedule + history to operator's bank (coming).
//   - Payroll: existing /admin/payroll content, rendered as a tab here.
//   - Reports: 1099s, statement exports (coming).
//
// Operator chrome (sidebar nav, brand colors) lives in AdminLayout. This
// page only renders inside its <Outlet />. Multi-tenant: org comes from
// useOutletContext; no hardcoded tenant assumptions.

import { useState } from "react";
import Payroll from "./Payroll.jsx";

const PURPLE = "#1C004F";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

export default function Payouts() {
  const [tab, setTab] = useState("payroll");

  return (
    <div style={{ maxWidth: 1100 }}>
      <h1 style={{ margin: "0 0 4px", color: PURPLE, fontSize: 28, fontWeight: 700 }}>
        Payouts
      </h1>
      <p style={{ margin: "0 0 24px", color: MUTED, fontSize: 14 }}>
        Money going out — your bank, your team.
      </p>

      <TabsNav tab={tab} onTab={setTab} />

      {tab === "bank"    && <BankTab />}
      {tab === "payroll" && <Payroll />}
      {tab === "reports" && <ReportsTab />}
    </div>
  );
}

function TabsNav({ tab, onTab }) {
  const items = [
    { key: "bank",    label: "Bank" },
    { key: "payroll", label: "Payroll" },
    { key: "reports", label: "Reports" },
  ];
  return (
    <div style={{
      display: "flex",
      gap: 4,
      borderBottom: `1px solid ${RULE}`,
      marginBottom: 16,
    }}>
      {items.map((it) => {
        const active = tab === it.key;
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onTab(it.key)}
            style={{
              padding: "10px 14px",
              background: "transparent",
              color: active ? PURPLE : MUTED,
              border: "none",
              borderBottom: active ? `2px solid ${PURPLE}` : "2px solid transparent",
              fontSize: 14,
              fontWeight: active ? 700 : 500,
              fontFamily: "inherit",
              cursor: "pointer",
              marginBottom: -1,
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function BankTab() {
  return (
    <div style={{
      background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10,
      padding: 32, textAlign: "center", color: MUTED, fontSize: 14,
    }}>
      Stripe payout schedule and history will show here — when Stripe sends
      money to your operator bank, see exactly what landed and when.
      <div style={{ fontSize: 12, marginTop: 8 }}>
        Coming next — choose daily/weekly/monthly payout cadence.
      </div>
    </div>
  );
}

function ReportsTab() {
  return (
    <div style={{
      background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10,
      padding: 32, textAlign: "center", color: MUTED, fontSize: 14,
    }}>
      Annual statements, instructor 1099s, and platform fee summaries will
      live here.
      <div style={{ fontSize: 12, marginTop: 8 }}>
        Coming next — exportable for your accountant.
      </div>
    </div>
  );
}
