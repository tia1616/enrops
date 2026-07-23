// src/components/ScheduleStepBar.jsx
// The scheduling "cockpit" step bar — a live map of where the operator is in the
// term, with Ennie beside it. Presentational: the parent board derives the steps
// from its own state and passes them in.
//
//   steps: [{ key, name, meta, state: 'done' | 'active' | 'todo' }]
//   ennieCaption: one-line "here's where you are / what's next" from Ennie.
//
// The steps are a STATUS MAP, not a wizard — several can be 'active' at once (a
// cohort mid-offers while a new hire is still at the survey step). Each step shows
// its own honest status; nothing is greyed out for being "past".

import React from "react";

const BRIGHT = "#5847C9";   // indigo — active
const GREEN = "#2C935F";    // done
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const SOFT = "#efecfb";     // active fill

export default function ScheduleStepBar({ steps = [], ennieCaption }) {
  return (
    <section
      aria-label="Where you are in the term"
      style={{
        display: "flex", gap: 16, alignItems: "stretch",
        background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: "14px 16px",
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 9 }}>
        {ennieCaption && <div style={{ fontSize: 13.5, color: INK, lineHeight: 1.4 }}>{ennieCaption}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {steps.map((s, i) => {
            const done = s.state === "done";
            const active = s.state === "active";
            return (
              <div
                key={s.key}
                style={{
                  flex: "1 1 132px", minWidth: 118,
                  border: `1px solid ${active ? BRIGHT : RULE}`,
                  background: active ? SOFT : "#fff",
                  borderRadius: 10, padding: "9px 11px",
                  boxShadow: active ? `inset 0 0 0 1px ${BRIGHT}` : "none",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 18, height: 18, flex: "0 0 auto", borderRadius: "50%",
                      display: "grid", placeItems: "center", fontSize: 11, fontWeight: 800,
                      background: done ? GREEN : active ? BRIGHT : "#fff",
                      color: done || active ? "#fff" : MUTED,
                      border: done || active ? "none" : `1.5px solid ${RULE}`,
                    }}
                  >{done ? "✓" : i + 1}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: active ? BRIGHT : done ? MUTED : INK, letterSpacing: -0.1 }}>{s.name}</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 11.5, color: MUTED, fontVariantNumeric: "tabular-nums" }}>{s.meta}</div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
