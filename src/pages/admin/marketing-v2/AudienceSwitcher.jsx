// AudienceSwitcher — the shared Families / Instructors / Partners segmented
// control used across the Comms hub (Contacts, Templates, Automations). One
// component so all three surfaces look and behave identically — the audience
// spine that makes Comms read as one CRM, not three bolted-on lists.
//
// Controlled: the parent owns `active` (usually URL-backed via ?audience=) and
// handles `onSelect`. `label` sets the aria-label for the tablist.
//
// `audiences` limits which pills render (default: all three). Not every org can
// see every audience — see lib/entitlements.commsAudiencesFor. Hiding the pill
// is only half the job: the PARENT must also clamp its `active` value against
// the same list, or a stale ?audience= in the URL selects a hidden audience and
// the operator gets an unexplained empty list. Every caller here does that.

import { BRIGHT, MUTED, RULE } from "../marketing/tokens.jsx";

const AUDIENCE_ITEMS = [
  { key: "families", label: "Families" },
  { key: "instructors", label: "Instructors" },
  { key: "partners", label: "Partners" },
];

const ALL_AUDIENCES = AUDIENCE_ITEMS.map((it) => it.key);

export default function AudienceSwitcher({ active, onSelect, label = "Audience", audiences = ALL_AUDIENCES }) {
  const items = AUDIENCE_ITEMS.filter((it) => audiences.includes(it.key));
  // A single pill is a label, not a choice. Rendering a one-option segmented
  // control invites a click that does nothing — the dead-control pattern.
  if (items.length < 2) return null;

  return (
    <div role="tablist" aria-label={label} style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
      {items.map((it) => {
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
