// FamilyCommsTabs — the Comms section's tab strip, rendered inside each Comms
// page (Campaigns / Automations / Contacts / Templates). Comms owns this strip
// rather than the AdminLayout shell strip so the "Campaigns" tab can reset the
// list⇄wizard reducer state via onReset (see AICampaignBuilder) — those views
// share one route. File/component name kept as-is to avoid churning 5 imports;
// the operator-facing section name is "Comms".
//
// Campaigns vs Automations audiences differ:
//   Campaigns respect the promotional unsubscribe.
//   Automations bypass it — they're service comms to active families.

import { Link } from "react-router-dom";
import { PURPLE, BRIGHT, INK, MUTED, RULE } from "../marketing/tokens.jsx";

export default function FamilyCommsTabs({ active, onReset }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 0,
        borderBottom: `1px solid ${RULE}`,
        marginBottom: 24,
      }}
      role="tablist"
      aria-label="Comms surfaces"
    >
      <TabLink
        to="/admin/family-comms/marketing"
        active={active === "marketing"}
        // When we're already ON the marketing route but deep in the campaign
        // wizard (list vs wizard is internal state, not a route), a plain Link
        // to the same route is a no-op. onReset lets the host reset to the list.
        onClick={active === "marketing" && onReset ? (e) => { e.preventDefault(); onReset(); } : undefined}
      >
        Campaigns
      </TabLink>
      <TabLink to="/admin/family-comms/automations" active={active === "automations"}>
        Automations
      </TabLink>
      <TabLink to="/admin/family-comms/contacts" active={active === "contacts"}>
        Contacts
      </TabLink>
      <TabLink to="/admin/family-comms/templates" active={active === "templates"}>
        Templates
      </TabLink>
    </div>
  );
}

function TabLink({ to, active, children, onClick }) {
  return (
    <Link
      to={to}
      onClick={onClick}
      role="tab"
      aria-selected={active}
      style={{
        padding: "12px 20px",
        textDecoration: "none",
        color: active ? BRIGHT : MUTED,
        fontWeight: active ? 700 : 500,
        fontSize: 15,
        borderBottom: active ? `2px solid ${BRIGHT}` : "2px solid transparent",
        marginBottom: -1,
        transition: "color 120ms",
      }}
    >
      {children}
    </Link>
  );
}
