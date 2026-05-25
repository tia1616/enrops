// Q4_Channels — checkbox group. Email is the only enabled channel in v1.
// Flyer + Social render disabled with "Coming soon" badges per spec.
// Includes "Remind me later" per the approved mockup — saves nothing in chunk 05
// (no API), just kicks the user back to /admin so the affordance is visible.

import { useNavigate } from "react-router-dom";
import QuestionStep from "../QuestionStep.jsx";
import { PURPLE, RULE, INK, MUTED, WARN } from "../../marketing/tokens.jsx";

const CHANNELS = [
  { key: "email", label: "Email + parent portal", icon: "✉️", helper: "Personalized per recipient." },
  { key: "flyer", label: "Flyer (PDF)", icon: "📄", helper: "Branded handout for partners.", disabled: true },
  { key: "social", label: "Social post", icon: "📣", helper: "Caption + hashtags + tags.", disabled: true },
];

export default function Q4_Channels({ inputs, setField, onBack, canNext, loading, onStartDrafting }) {
  const navigate = useNavigate();
  const channels = inputs.channels;

  function toggle(key) {
    if (channels.includes(key)) {
      setField("channels", channels.filter((c) => c !== key));
    } else {
      setField("channels", [...channels, key]);
    }
  }

  return (
    <QuestionStep
      title="How are you reaching them?"
      helper="Pick any combo — Don will draft each one."
      onBack={onBack}
      canNext={canNext}
      isLast
      loading={loading}
      onStartDrafting={onStartDrafting}
      rightExtras={
        <button
          onClick={() => {
            // Remind-me-later in chunk 05 is just a friendly bail-out. Chunk 06
            // wires this to write a partial campaigns row + a homescreen card.
            navigate("/admin/marketing");
          }}
          disabled={loading}
          style={{
            background: "#fff", border: `1px solid ${RULE}`,
            color: INK, padding: "10px 14px", borderRadius: 6,
            cursor: loading ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 500,
            fontFamily: "inherit",
          }}
        >
          Remind me later
        </button>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
        {CHANNELS.map((c) => {
          const checked = channels.includes(c.key);
          return (
            <label
              key={c.key}
              style={{
                cursor: c.disabled ? "not-allowed" : "pointer",
                opacity: c.disabled ? 0.55 : 1,
                padding: 12,
                background: checked ? "#faf7ed" : "#fff",
                border: `2px solid ${checked ? PURPLE : RULE}`,
                borderRadius: 8,
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => !c.disabled && toggle(c.key)}
                disabled={c.disabled}
                style={{ display: "none" }}
              />
              <div style={{ fontSize: 20, lineHeight: 1 }}>{c.icon}</div>
              <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: INK }}>{c.label}</span>
                {c.disabled && (
                  <span style={{ fontSize: 10, padding: "2px 6px", background: "#FAEEDA", color: WARN, borderRadius: 999, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>
                    Soon
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>{c.helper}</div>
            </label>
          );
        })}
      </div>
    </QuestionStep>
  );
}
