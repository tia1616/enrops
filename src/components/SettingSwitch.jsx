// The on/off switch for a Settings card: the same 44x26 sliding switch the
// product already uses (RegistrationQuestions Toggle, InstructorDocuments
// DocToggle - same size, colours, role="switch" + aria-checked), plus a visible
// "On" / "Off" word beside it, so the state is read, not inferred.
//
// It replaced a button whose label was the CURRENT state: pressing a button that
// said "On" turned the setting off (Jessica 2026-11-24: "fix all three").
//
// busy = a save is in flight (switch dims, ignores clicks). loading = the value
// is not known yet (shows "...").
const BRIGHT = "#5847C9";
const MUTED = "#6b6b6b";
const INK = "#1a1a1a";

export default function SettingSwitch({ on, busy = false, loading = false, disabled = false, label, onChange }) {
  const off = disabled || busy || loading;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: on ? INK : MUTED, minWidth: 26, textAlign: "right" }}>
        {loading ? "..." : busy ? "Saving..." : on ? "On" : "Off"}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={!!on}
        aria-label={label}
        title={loading ? "" : on ? `${label}: on. Click to turn off` : `${label}: off. Click to turn on`}
        disabled={off}
        onClick={off ? undefined : () => onChange(!on)}
        style={{
          flexShrink: 0, width: 44, height: 26, borderRadius: 999, border: "none", position: "relative", padding: 0,
          cursor: off ? "default" : "pointer", background: on ? BRIGHT : "#cfcbc0",
          opacity: disabled ? 0.55 : busy || loading ? 0.7 : 1, transition: "background 120ms",
        }}
      >
        <span style={{ position: "absolute", top: 3, left: on ? 21 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left 120ms", boxShadow: "0 1px 2px rgba(0,0,0,0.2)" }} />
      </button>
    </div>
  );
}
