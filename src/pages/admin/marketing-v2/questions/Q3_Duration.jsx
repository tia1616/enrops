// Q3_Duration — radio-card group + a custom date range. Ennie uses this to
// space touchpoints; the deadline-proximity rule in the edge function can
// still override (when a deadline is days away, the campaign shrinks
// regardless of what duration the operator picked).

import { useMemo } from "react";
import QuestionStep from "../QuestionStep.jsx";
import { PURPLE, RULE, INK, MUTED, OK } from "../../marketing/tokens.jsx";

const PRESETS = [
  { value: "2 weeks", label: "2 weeks", hint: "Punchy: kickoff + 2 reminders" },
  { value: "1 month", label: "1 month", hint: "Standard pace" },
  { value: "2 months", label: "2 months", hint: "Slow build" },
];

// Stored as a single string ("custom: YYYY-MM-DD to YYYY-MM-DD") to keep the
// edge-function contract simple (duration is always a string). The custom
// parser is on the client only; the prompt sees the human-readable form.
function isCustom(duration) {
  return typeof duration === "string" && duration.startsWith("custom:");
}
function parseCustom(duration) {
  const m = duration?.match(/^custom:\s*(\d{4}-\d{2}-\d{2})\s*to\s*(\d{4}-\d{2}-\d{2})/);
  return m ? { start: m[1], end: m[2] } : { start: "", end: "" };
}
function buildCustom(start, end) {
  if (!start && !end) return "custom:";
  return `custom: ${start || "?"} to ${end || "?"}`;
}
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function Q3_Duration({ inputs, setField, onNext, onBack, canNext }) {
  const duration = inputs.duration ?? "";
  const customSelected = isCustom(duration) || duration === "custom";
  const { start, end } = useMemo(() => parseCustom(duration), [duration]);

  return (
    <QuestionStep
      title="How long should this run?"
      helper="Ennie spaces the touchpoints out so they land at the right moments. If a deadline is close, she'll tighten automatically."
      onNext={onNext}
      onBack={onBack}
      canNext={canNext}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
        {PRESETS.map((o) => {
          const selected = duration === o.value;
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

        {/* Custom card — expands inline when selected */}
        <label
          style={{
            cursor: "pointer", padding: 12,
            background: customSelected ? "#faf7ed" : "#fff",
            border: `2px solid ${customSelected ? PURPLE : RULE}`,
            borderRadius: 8,
            gridColumn: customSelected ? "1 / -1" : "auto",
          }}
        >
          <input
            type="radio"
            name="duration"
            checked={customSelected}
            onChange={() => setField("duration", buildCustom(start || todayIso(), end))}
            style={{ display: "none" }}
          />
          <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>Custom…</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>Pick your own dates</div>

          {customSelected && (
            <div
              onClick={(e) => e.preventDefault()}
              style={{ marginTop: 12, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}
            >
              <div>
                <label style={{ display: "block", fontSize: 11, color: MUTED, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
                  Start
                </label>
                <input
                  type="date"
                  value={start}
                  min={todayIso()}
                  onChange={(e) => setField("duration", buildCustom(e.target.value, end))}
                  style={{ padding: "6px 8px", border: `1px solid ${RULE}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 11, color: MUTED, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
                  End
                </label>
                <input
                  type="date"
                  value={end}
                  min={start || todayIso()}
                  onChange={(e) => setField("duration", buildCustom(start, e.target.value))}
                  style={{ padding: "6px 8px", border: `1px solid ${RULE}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit" }}
                />
              </div>
            </div>
          )}
        </label>
      </div>

      <div style={{ marginTop: 14, padding: 10, background: "#eaf3de", color: OK, fontSize: 13, borderRadius: 6, display: "flex", gap: 8, alignItems: "flex-start" }}>
        <span>📊</span>
        <span>1-month windows convert best for early-bird campaigns. When a deadline is within the first week, Ennie shrinks to 2 emails (announce + final reminder) regardless of duration.</span>
      </div>
    </QuestionStep>
  );
}
