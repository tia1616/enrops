// FamilyCommsTabs — shared tab strip rendered atop both Family Comms surfaces:
//   /admin/family-comms/marketing    (AI Campaign Builder — promotional)
//   /admin/family-comms/automations  (Lifecycle automations — informational)
//
// Two surfaces, two different audiences:
//   Marketing campaigns respect the promotional unsubscribe.
//   Automations bypass it — they're service comms to active families.

import { Link } from "react-router-dom";
import { PURPLE, INK, MUTED, RULE } from "../marketing/tokens.jsx";

export default function FamilyCommsTabs({ active }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 0,
        borderBottom: `1px solid ${RULE}`,
        marginBottom: 24,
      }}
      role="tablist"
      aria-label="Family Comms surfaces"
    >
      <TabLink to="/admin/family-comms/marketing" active={active === "marketing"}>
        Campaigns
      </TabLink>
      <TabLink to="/admin/family-comms/automations" active={active === "automations"}>
        Automations
      </TabLink>
    </div>
  );
}

function TabLink({ to, active, children }) {
  return (
    <Link
      to={to}
      role="tab"
      aria-selected={active}
      style={{
        padding: "12px 20px",
        textDecoration: "none",
        color: active ? PURPLE : MUTED,
        fontWeight: active ? 700 : 500,
        fontSize: 15,
        borderBottom: active ? `2px solid ${PURPLE}` : "2px solid transparent",
        marginBottom: -1,
        transition: "color 120ms",
      }}
    >
      {children}
    </Link>
  );
}
