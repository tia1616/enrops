// DraftingScreen — full-view takeover while marketing-draft-campaign runs.
// Mirrors the curriculum extraction loading idiom: friendly headline, time
// estimate, animated step list with ✓ (done) and → (current) markers.
//
// We don't have realtime streaming from the edge function, so step advancement
// is timed locally. The four steps map honestly to phases the edge function
// genuinely runs through (resolve recipients → Claude draft → mechanical check
// → persist); the timings are rough averages, so the "current" marker stays
// loosely aligned with what's actually happening server-side.

import { useEffect, useState } from "react";
import { INK, MUTED, PURPLE, RULE, VIOLET } from "../marketing/tokens.jsx";

const STEPS = [
  { at: 0,  label: "Finding the parents you asked for…" },
  { at: 6,  label: "Ennie's planning the schedule…" },
  { at: 14, label: "Writing each email for you…" },
  { at: 38, label: "Checking the copy against your brand rules…" },
];

export default function DraftingScreen() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const currentIndex = (() => {
    let i = 0;
    for (let k = 0; k < STEPS.length; k++) {
      if (elapsed >= STEPS[k].at) i = k;
    }
    return i;
  })();

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "32px 16px 48px", textAlign: "center" }}>
      <h1 style={{ margin: 0, color: PURPLE, fontSize: 28, fontWeight: 700 }}>
        Ennie's drafting your campaign…
      </h1>
      <p style={{ margin: "10px 0 0", fontSize: 14, color: MUTED, lineHeight: 1.5 }}>
        This usually takes 30–60 seconds. You can stay here or come back later — we'll keep going either way.
      </p>

      <ul style={{
        listStyle: "none", padding: 0, margin: "28px auto 0",
        textAlign: "left", maxWidth: 460,
      }}>
        {STEPS.map((step, i) => {
          const isDone = i < currentIndex;
          const isCurrent = i === currentIndex;
          return (
            <li
              key={step.label}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 0", borderBottom: i === STEPS.length - 1 ? "none" : `1px solid ${RULE}`,
                opacity: isCurrent || isDone ? 1 : 0.45,
              }}
            >
              <span style={{
                width: 18, fontWeight: 700,
                color: isDone ? VIOLET : isCurrent ? PURPLE : MUTED,
              }}>
                {isDone ? "✓" : isCurrent ? "→" : "·"}
              </span>
              <span style={{
                fontSize: 15,
                fontWeight: isCurrent ? 600 : 400,
                color: isCurrent ? PURPLE : isDone ? INK : MUTED,
              }}>
                {step.label}
              </span>
            </li>
          );
        })}
      </ul>

      <p style={{ marginTop: 22, fontSize: 12, color: MUTED }}>
        {elapsed}s elapsed
      </p>
    </div>
  );
}
