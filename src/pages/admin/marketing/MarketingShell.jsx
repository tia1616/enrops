// src/pages/admin/marketing/MarketingShell.jsx
// Tab shell for the Marketing module. Renders sub-tab content inline.
// Tabs: Automations | Plans (default) | Compose | Groups | Sent

import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { PLUM, RULE, MUTED, INK } from "./tokens.jsx";
import PlansTab from "./PlansTab.jsx";
import AutomationsTab from "./AutomationsTab.jsx";
import ComposeTab from "./ComposeTab.jsx";
import GroupsTab from "./GroupsTab.jsx";
import SentTab from "./SentTab.jsx";

const TABS = [
  { key: "automations", label: "Automations" },
  { key: "plans", label: "Campaigns" },
  { key: "compose", label: "Compose" },
  { key: "groups", label: "Groups" },
  { key: "sent", label: "Sent" },
];

export default function MarketingShell() {
  const ctx = useOutletContext() ?? {};
  const [activeTab, setActiveTab] = useState("plans");
  // Allow compose to pre-select a group or plan context
  const [composeCtx, setComposeCtx] = useState(null);

  function goCompose(ctx) {
    setComposeCtx(ctx || null);
    setActiveTab("compose");
  }

  return (
    <div>
      {/* Tab bar */}
      <div style={{
        display: "flex", gap: 18, borderBottom: `1px solid ${RULE}`,
        marginBottom: 18, paddingBottom: 10, fontSize: 13,
      }}>
        {TABS.map(t => (
          <span
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            style={{
              color: activeTab === t.key ? PLUM : MUTED,
              fontWeight: activeTab === t.key ? 600 : 400,
              cursor: "pointer",
              paddingBottom: activeTab === t.key ? 8 : 0,
              marginBottom: activeTab === t.key ? -11 : 0,
              borderBottom: activeTab === t.key ? `2px solid ${PLUM}` : "none",
            }}
          >
            {t.label}
          </span>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "plans" && <PlansTab org={ctx.org} goCompose={goCompose} />}
      {activeTab === "automations" && <AutomationsTab org={ctx.org} />}
      {activeTab === "compose" && <ComposeTab org={ctx.org} composeCtx={composeCtx} />}
      {activeTab === "groups" && <GroupsTab org={ctx.org} />}
      {activeTab === "sent" && <SentTab org={ctx.org} />}
    </div>
  );
}
