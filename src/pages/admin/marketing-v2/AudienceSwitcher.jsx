// AudienceSwitcher — the shared Families / Instructors / Partners segmented
// control used across the Comms hub (Contacts, Templates, Automations). One
// component so all three surfaces look and behave identically — the audience
// spine that makes Comms read as one CRM, not three bolted-on lists.
//
// Controlled: the parent owns `active` (usually URL-backed via ?audience=) and
// handles `onSelect`. `label` sets the aria-label for the tablist.

import { BRIGHT, MUTED, RULE } from "../marketing/tokens.jsx";

const AUDIENCE_ITEMS = [
  { key: "families", label: "Families" },
  { key: "instructors", label: "Instructors" },
  { key: "partners", label: "Partners" },
];

export default function AudienceSwitcher({ active, onSelect, label = "Audience" }) {
  return (
    <div role="tablist" aria-label={label} style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
      {AUDIENCE_ITEMS.map((it) => {
        const on = active === it.key;
        return (
          <button
            key={it.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onSelect(it.key)}
            style={{
              padding: "7px 16px",
              borderRadius: 999,
              border: `1px solid ${on ? BRIGHT : RULE}`,
              background: on ? BRIGHT : "#fff",
              color: on ? "#fff" : MUTED,
              fontSize: 13,
              fontWeight: on ? 700 : 500,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
