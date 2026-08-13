// src/pages/admin/Payouts.jsx
// /admin/payouts — the payroll calculator. What each instructor is owed, and
// marking it paid.
//
// BANK AND REPORTS WERE DELETED, NOT HIDDEN (Jessica, 2026-08-13: "the payroll
// screen for all providers will just be the payroll calculater"). They were two
// static cards reading "will show here" and "coming next" — no query, no data,
// no action, on every provider's account since the page was built. They were not
// almost-finished; they were a promise in the shape of a feature, and a tab that
// never does anything teaches an operator to stop clicking tabs.
//
// They are also not coming back, because Stripe already does both and does them
// better:
//   - Bank was Stripe payout schedule + history to the operator's own bank. That
//     is their Stripe dashboard, which is authoritative, live, and ours would
//     only ever be a lagging copy of it.
//   - Reports was 1099s and statement exports. Stripe issues 1099s for Connect
//     payouts; anything else belongs to the provider's accountant.
// And for a provider who pays instructors by cheque or transfer — which is
// everyone except one — there are no Stripe payouts at all, so Bank would have
// been permanently empty for them no matter how much we built.
//
// With one thing left the tab strip goes too: a single tab is chrome pretending
// to be navigation.
//
// Operator chrome (sidebar nav, brand colors) lives in AdminLayout. This page
// only renders inside its <Outlet />. Multi-tenant: org comes from
// useOutletContext in Payroll; no hardcoded tenant assumptions.
//
// This file still exists rather than routing straight to Payroll.jsx because
// Payroll has no heading of its own — it was written to render inside this
// shell. /admin/payroll now redirects here (App.jsx) so there is one page, at
// one address, with a title on it.

import Payroll from "./Payroll.jsx";

const PURPLE = "#1C004F";
const MUTED = "#6b6b6b";

export default function Payouts() {
  return (
    <div style={{ maxWidth: 1100 }}>
      <h1 style={{ margin: "0 0 4px", color: PURPLE, fontSize: 28, fontWeight: 700 }}>
        Payroll calculator
      </h1>
      <p style={{ margin: "0 0 24px", color: MUTED, fontSize: 14 }}>
        What each instructor is owed, and marking it paid.
      </p>

      <Payroll />
    </div>
  );
}
