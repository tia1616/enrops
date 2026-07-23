// src/components/ScheduleStepBar.jsx
// The scheduling "cockpit" pipeline stepper — a clickable map of the term's five
// stages. Presentational: the parent (the board Header/cockpit) derives the steps
// and owns which one is selected; clicking a step focuses it and the parent shows
// that stage's actions in a panel below.
//
//   steps: [{ key, name, meta, state: 'done' | 'active' | 'todo' }]
//   selected: key of the focused step
//   onSelect(key): fired on click
//
// The steps are a STATUS MAP, not a wizard — several can be 'active' at once (a
// cohort mid-offers while a new hire is still at the survey step), and every step
// stays clickable (nothing is greyed out for being "past").

import React from "react";

const BRIGHT = "#5847C9";   // indigo — active / selected
const GREEN = "#2C935F";    // done
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const SOFT = "#efecfb";     // selected fill

export default function ScheduleStepBar({ steps = [], selected, onSelect }) {
  return (
    <div role="tablist" aria-label="Scheduling steps" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {steps.map((s, i) => {
        const done = s.state === "done";
        const active = s.state === "active";
        const isSel = s.key === selected;
        return (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={isSel}
            onClick={() => onSelect && onSelect(s.key)}
            style={{
              flex: "1 1 132px", minWidth: 120, textAlign: "left", cursor: "pointer", fontFamily: "inherit",
              border: `1px solid ${isSel ? BRIGHT : RULE}`,
              background: isSel ? SOFT : "#fff",
              borderRadius: 10, padding: "9px 11px",
              boxShadow: isSel ? `inset 0 0 0 1px ${BRIGHT}` : "none",
              transition: "border-color .12s, background .12s",
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
              <span style={{ fontSize: 13, fontWeight: 700, color: isSel ? BRIGHT : done ? MUTED : INK, letterSpacing: -0.1 }}>{s.name}</span>
            </div>
            <div style={{ marginTop: 4, fontSize: 11.5, color: MUTED, fontVariantNumeric: "tabular-nums" }}>{s.meta}</div>
          </button>
        );
      })}
    </div>
  );
}
