// PeriodCards — Q1 intent-first surface.
//
// Renders the auto-detected period cards above the catalog picker. Each card
// shows the period label, counts, time signal, and the intent buttons
// computed by lib/intents.js. Clicking an intent calls
// `onPickIntent(period, intent)` which applies the intent's preselects to
// the reducer (Step 3 wires this up).
//
// If onPickIntent is null (e.g., during a spike), buttons render disabled —
// useful for visual verification without hitting Q2.

import { useMemo } from "react";
import { usePeriodCards } from "./lib/periodDetection.js";
import { getIntentsForPeriod, OTHER_INTENTS } from "./lib/intents.js";
import { PURPLE, RULE, INK, MUTED, OK } from "../marketing/tokens.jsx";

// `periodsState` is optional — when the parent (Q1_What) already calls
// `usePeriodCards`, it passes the state down so both components share one
// fetch + react to it consistently (Q1 needs `periods.length` to decide
// whether to auto-expand the picker). When omitted, falls back to internal
// fetch so the component still works standalone.
export default function PeriodCards({ orgId, periodsState, onPickIntent }) {
  const internalState = usePeriodCards(periodsState ? null : orgId);
  const { status, periods, error } = periodsState ?? internalState;

  if (!orgId) return null;
  if (status === "loading") {
    return <Skeleton text="Detecting what's marketable right now…" />;
  }
  if (status === "error") {
    return (
      <ErrorHint>
        Couldn't detect your active periods. {error?.message ? `(${error.message})` : ""}
        <br />Use the catalog picker below to pick programs manually.
      </ErrorHint>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 14 }}>
      {periods.length === 0 && (
        <EmptyHint>
          No active periods detected. Use the picker below to pick programs manually, or send a one-off note from "Something else."
        </EmptyHint>
      )}
      {periods.map((p) => (
        <PeriodCard key={p.key} period={p} allPeriods={periods} onPickIntent={onPickIntent} />
      ))}
      <OtherCard onPickIntent={onPickIntent} />
    </div>
  );
}

// "Something else" card — top-level, always rendered alongside period cards
// (per spec). Holds 4 sub-intents (schedule change, photo gallery, partner
// event, free-form). Click handling mirrors period intents: the click handler
// in Q1_What dispatches APPLY_PRESELECT + NEXT, except for free-form which
// just opens the picker on the 'other' tab.
function OtherCard({ onPickIntent }) {
  return (
    <div style={{
      background: "#fff",
      border: `1px solid ${RULE}`,
      borderRadius: 8,
      padding: 14,
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: INK }}>Send a one-off note</div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
          For schedule changes, photo galleries, partner invites, or anything else
        </div>
      </div>
      <IntentSubactions intents={OTHER_INTENTS} period={null} onPickIntent={onPickIntent} />
    </div>
  );
}

function PeriodCard({ period, allPeriods, onPickIntent }) {
  const { label, programCount, schoolCount, campCount, timeSignal, facts } = period;
  const isAfterschool = facts.programType === "afterschool";

  // Compute the visible intents for this period. Memoized on facts identity —
  // periods only re-create on usePeriodCards refetch, so this is cheap.
  const intents = useMemo(
    () => getIntentsForPeriod(period, allPeriods),
    [period, allPeriods],
  );

  // Counts line — "26 programs · 24 schools" or "14 sessions · 4 locations"
  const countsLine = isAfterschool
    ? `${programCount} program${programCount === 1 ? "" : "s"} · ${schoolCount} school${schoolCount === 1 ? "" : "s"}`
    : `${campCount} session${campCount === 1 ? "" : "s"} · ${schoolCount} location${schoolCount === 1 ? "" : "s"}`;

  // Time signal is the urgency note. Highlight green when an active deadline
  // is within the urgency window (so the eye lands on the soonest deadline).
  const urgent = isUrgent(facts);

  return (
    <div style={{
      background: "#fff",
      border: `1px solid ${RULE}`,
      borderRadius: 8,
      padding: 14,
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: INK }}>{label}</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{countsLine}</div>
        </div>
        <div style={{
          fontSize: 12,
          fontWeight: 600,
          color: urgent ? OK : MUTED,
          background: urgent ? "#EAF3DE" : "transparent",
          padding: urgent ? "3px 8px" : 0,
          borderRadius: 999,
        }}>
          {urgent ? "🔥 " : ""}{timeSignal}
        </div>
      </div>

      <IntentSubactions intents={intents} period={period} onPickIntent={onPickIntent} />
    </div>
  );
}

// Renders the intent buttons computed by getIntentsForPeriod. When the card
// has no applicable intent (period exists but nothing to push), shows a
// hint rather than going silent — the operator should know the card was seen.
function IntentSubactions({ intents, period, onPickIntent }) {
  if (intents.length === 0) {
    return (
      <div style={{ fontSize: 12, color: MUTED, fontStyle: "italic" }}>
        Nothing to push right now for this period.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", borderTop: `1px solid ${RULE}`, marginTop: 4 }}>
      {intents.map((intent) => (
        <button
          key={intent.key}
          onClick={onPickIntent ? () => onPickIntent(period, intent) : undefined}
          disabled={!onPickIntent}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            background: "transparent", border: "none",
            borderBottom: `1px solid ${RULE}`,
            padding: "10px 4px",
            fontSize: 14, color: INK, fontWeight: 500,
            cursor: onPickIntent ? "pointer" : "not-allowed",
            opacity: onPickIntent ? 1 : 0.7,
            fontFamily: "inherit", textAlign: "left",
            width: "100%",
          }}
          onMouseEnter={(e) => { if (onPickIntent) e.currentTarget.style.background = "#faf7ed"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        >
          <span>
            {intent.icon ? <span style={{ marginRight: 6 }}>{intent.icon}</span> : null}
            {intent.label}
            {intent.subtitle && (
              <span style={{ color: MUTED, fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
                {intent.subtitle}
              </span>
            )}
          </span>
          <span style={{ color: PURPLE, fontSize: 16 }}>→</span>
        </button>
      ))}
    </div>
  );
}

function isUrgent(facts) {
  if (facts.daysUntilEarlyBird != null && facts.daysUntilEarlyBird <= 7) return true;
  if (facts.daysUntilFirstSession != null && facts.daysUntilFirstSession <= 7) return true;
  return false;
}

// ---------- Lightweight states ----------
function Skeleton({ text }) {
  return (
    <div style={{
      padding: 14, marginBottom: 14, background: "#fff",
      border: `1px solid ${RULE}`, borderRadius: 8,
      fontSize: 13, color: MUTED, fontStyle: "italic",
    }}>
      {text}
    </div>
  );
}
function ErrorHint({ children }) {
  return (
    <div style={{
      padding: 14, marginBottom: 14, background: "#fdecea",
      border: "1px solid #f5c2c0", borderRadius: 8,
      fontSize: 13, color: "#7a2018", lineHeight: 1.5,
    }}>
      {children}
    </div>
  );
}
function EmptyHint({ children }) {
  return (
    <div style={{
      padding: 14, marginBottom: 14, background: "#fff",
      border: `1px solid ${RULE}`, borderRadius: 8,
      fontSize: 13, color: MUTED, lineHeight: 1.5,
    }}>
      {children}
    </div>
  );
}
