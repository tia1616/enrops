// Q1_What — multi-topic chip input. State carries `string[]` so one campaign
// can promote multiple things at once (e.g., Fall + Summer). The deployed
// marketing-draft-campaign already accepts string | string[].

import { useState } from "react";
import QuestionStep from "../QuestionStep.jsx";
import { PURPLE, RULE, INK, MUTED } from "../../marketing/tokens.jsx";

const PRESETS = [
  "Fall 2026 early bird registration",
  "Summer 2026 last call",
  "Spring 2027 waitlist sign-up",
  "Note to partner schools",
  "Instructor reminder",
];

export default function Q1_What({ inputs, setField, onNext, canNext }) {
  const [pending, setPending] = useState("");
  const topics = inputs.what;

  function addTopic(label) {
    const trimmed = label.trim();
    if (!trimmed) return;
    if (topics.includes(trimmed)) return;
    setField("what", [...topics, trimmed]);
    setPending("");
  }

  function removeTopic(idx) {
    setField("what", topics.filter((_, i) => i !== idx));
  }

  return (
    <QuestionStep
      title="What are you promoting?"
      helper="Pick one or more — Ennie will weave them into a single campaign so families hear about each without overlap."
      onNext={onNext}
      canNext={canNext}
    >
      <div
        style={{
          background: "#fff", border: `2px solid ${RULE}`, borderRadius: 8,
          padding: 10, display: "flex", flexWrap: "wrap", gap: 6,
          alignItems: "center", minHeight: 56,
        }}
      >
        {topics.map((t, i) => (
          <span
            key={`${t}-${i}`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              background: "#f0e3e8", color: PURPLE, fontWeight: 500,
              fontSize: 13, padding: "4px 10px", borderRadius: 999,
            }}
          >
            {t}
            <button
              onClick={() => removeTopic(i)}
              aria-label="Remove topic"
              style={{ background: "transparent", border: "none", color: PURPLE, cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={pending}
          placeholder={topics.length === 0 ? "Type a topic and press Enter…" : "Add another…"}
          onChange={(e) => setPending(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && pending.trim()) {
              e.preventDefault();
              addTopic(pending);
            }
            if (e.key === "Backspace" && pending === "" && topics.length > 0) {
              removeTopic(topics.length - 1);
            }
          }}
          style={{
            flex: 1, minWidth: 200, border: "none", outline: "none",
            fontSize: 14, padding: "6px 4px", fontFamily: "inherit", color: INK,
          }}
        />
      </div>

      <p style={{ margin: "6px 0 12px", fontSize: 12, color: MUTED }}>
        Press Enter after each topic. Click × on a chip to drop it.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => addTopic(p)}
            disabled={topics.includes(p)}
            style={{
              padding: "5px 10px", background: topics.includes(p) ? "#f5f5f5" : "#fff",
              border: `1px solid ${topics.includes(p) ? "#e0e0e0" : RULE}`,
              borderRadius: 999, fontSize: 12,
              color: topics.includes(p) ? "#a0a0a0" : INK,
              cursor: topics.includes(p) ? "default" : "pointer",
              fontFamily: "inherit",
            }}
          >
            {topics.includes(p) ? "✓" : "+"} {p}
          </button>
        ))}
      </div>
    </QuestionStep>
  );
}
