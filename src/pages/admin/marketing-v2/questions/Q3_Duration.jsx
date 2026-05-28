// Q3_Duration — radio-card group. Ennie uses this to space touchpoints.

import QuestionStep from "../QuestionStep.jsx";
import { PURPLE, RULE, INK, MUTED, OK } from "../../marketing/tokens.jsx";

const OPTIONS = [
  { value: "2 weeks", label: "2 weeks", hint: "Punchy: kickoff + 2 reminders" },
  { value: "1 month", label: "1 month", hint: "Standard: 3 emails + 1 social" },
  { value: "2 months", label: "2 months", hint: "Slow build: 4 emails + social" },
  { value: "custom", label: "Custom…", hint: "Pick your own deadlines" },
];

export default function Q3_Duration({ inputs, setField, onNext, onBack, canNext }) {
  return (
    <QuestionStep
      title="How long should this run?"
      helper="Ennie spaces the touchpoints out so they land at the right moments."
      onNext={onNext}
      onBack={onBack}
      canNext={canNext}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
        {OPTIONS.map((o) => {
          const selected = inputs.duration === o.value;
          return (
            <label
              key={o.value}
              style={{
                cursor: "pointer", padding: 12,
                background: selected ? "#faf7ed" : "#fff",
                border: `2px solid ${selected ? PURPLE : RULE}`,
                borderRadius: 8,
              }}
            >
              <input
                type="radio"
                name="duration"
                checked={selected}
                onChange={() => setField("duration", o.value)}
                style={{ display: "none" }}
              />
              <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>{o.label}</div>
              <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>{o.hint}</div>
            </label>
          );
        })}
      </div>

      <div style={{ marginTop: 14, padding: 10, background: "#eaf3de", color: OK, fontSize: 13, borderRadius: 6, display: "flex", gap: 8, alignItems: "flex-start" }}>
        <span>📊</span>
        <span>1-month windows convert best for early-bird campaigns. Ennie adds 48h and 24h reminders automatically before each deadline.</span>
      </div>
    </QuestionStep>
  );
}
