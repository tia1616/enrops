// Q3 — when/how-long question. Behavior depends on what was picked in Q1:
//   - mode='programs' or 'camps': multi-touchpoint campaign → asks DURATION
//     (2 weeks / 1 month / 2 months / custom range). Ennie spaces touchpoints
//     across the window.
//   - mode='other': one-off send (cancellation notice, recap, holiday note) →
//     asks SEND TIME (now / tomorrow morning / custom date+time). Ennie
//     produces a single touchpoint scheduled at that moment.
// The deadline-proximity rule in the edge function can still tighten cadence
// for multi-touchpoint campaigns when a deadline is days away.

import { useEffect, useState } from "react";
import QuestionStep from "../QuestionStep.jsx";
import { PURPLE, RULE, INK, MUTED, OK } from "../../marketing/tokens.jsx";

const PRESETS = [
  { value: "2 weeks", label: "2 weeks", hint: "Punchy: kickoff + 2 reminders" },
  { value: "1 month", label: "1 month", hint: "Standard pace" },
  { value: "2 months", label: "2 months", hint: "Slow build" },
];

// Stored as a single string in parent state ("custom: YYYY-MM-DD to YYYY-MM-DD")
// to keep the edge-function contract simple. The date inputs use LOCAL state
// so partial typing doesn't round-trip and reset.
function isCustom(duration) {
  return typeof duration === "string" && (duration === "custom" || duration.startsWith("custom:"));
}
function parseCustom(duration) {
  if (typeof duration !== "string") return { start: "", end: "" };
  const m = duration.match(/^custom:\s*(\d{4}-\d{2}-\d{2})\s*to\s*(\d{4}-\d{2}-\d{2})/);
  return m ? { start: m[1], end: m[2] } : { start: "", end: "" };
}
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function Q3_Duration({ inputs, setField, onNext, onBack, canNext }) {
  // Route: one-off send picker (mode='other') vs duration picker
  if (inputs.what?.mode === "other") {
    return <SendTimePicker inputs={inputs} setField={setField} onNext={onNext} onBack={onBack} canNext={canNext} />;
  }

  const duration = inputs.duration ?? "";
  const customSelected = isCustom(duration);

  // Local state for the date inputs so partial typing doesn't round-trip
  // and reset. Synced to parent state only when both dates are valid.
  const initial = parseCustom(duration);
  const [localStart, setLocalStart] = useState(initial.start);
  const [localEnd, setLocalEnd] = useState(initial.end);

  // Re-sync local state when parent duration changes externally (e.g. navigating
  // back to Q3 from a different step that already had custom dates).
  useEffect(() => {
    if (customSelected) {
      const parsed = parseCustom(duration);
      if (parsed.start !== localStart) setLocalStart(parsed.start);
      if (parsed.end !== localEnd) setLocalEnd(parsed.end);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  function pushDates(s, e) {
    if (s && e) {
      setField("duration", `custom: ${s} to ${e}`);
    } else {
      // Marker that custom is selected but dates aren't both filled yet — Next stays disabled
      setField("duration", "custom");
    }
  }
  function onStartChange(v) {
    setLocalStart(v);
    pushDates(v, localEnd);
  }
  function onEndChange(v) {
    setLocalEnd(v);
    pushDates(localStart, v);
  }
  function selectCustom() {
    if (!customSelected) {
      setField("duration", localStart && localEnd ? `custom: ${localStart} to ${localEnd}` : "custom");
    }
  }

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
                borderRadius: 12,
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

        {/* Custom card — expands inline when selected. Plain div (not label)
            so the date inputs inside can be clicked / typed in without the
            label/radio association eating the click. */}
        <div
          role="button"
          tabIndex={0}
          onClick={selectCustom}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectCustom(); } }}
          style={{
            cursor: customSelected ? "default" : "pointer",
            padding: 12,
            background: customSelected ? "#faf7ed" : "#fff",
            border: `2px solid ${customSelected ? PURPLE : RULE}`,
            borderRadius: 12,
            gridColumn: customSelected ? "1 / -1" : "auto",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>Custom…</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>Pick your own dates</div>

          {customSelected && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{ marginTop: 12, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}
            >
              <div>
                <div style={{ fontSize: 11, color: MUTED, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
                  Start
                </div>
                <input
                  type="date"
                  value={localStart}
                  min={todayIso()}
                  onChange={(e) => onStartChange(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ padding: "6px 8px", border: `1px solid ${RULE}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit", background: "#fff" }}
                />
              </div>
              <div>
                <div style={{ fontSize: 11, color: MUTED, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
                  End
                </div>
                <input
                  type="date"
                  value={localEnd}
                  min={localStart || todayIso()}
                  onChange={(e) => onEndChange(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ padding: "6px 8px", border: `1px solid ${RULE}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit", background: "#fff" }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 14, padding: 10, background: "#eaf3de", color: OK, fontSize: 13, borderRadius: 6, display: "flex", gap: 8, alignItems: "flex-start" }}>
        <span>📊</span>
        <span>1-month windows convert best for early-bird campaigns. When a deadline is within the first week, Ennie shrinks to 2 emails (announce + final reminder) regardless of duration.</span>
      </div>
    </QuestionStep>
  );
}

// ---------- One-off send-time picker (mode='other') ----------
// Renders when the campaign is a one-off note (cancellation, recap, holiday).
// Operator picks WHEN to send: now / tomorrow morning / custom. Ennie produces
// a single touchpoint scheduled at that moment.
function SendTimePicker({ inputs, setField, onNext, onBack, canNext }) {
  const sendAt = inputs.send_at ?? "";
  const isNow = sendAt === "now";
  const isTomorrow = sendAt === "tomorrow_morning";
  const isCustomTime = sendAt && !isNow && !isTomorrow;

  // Local state for custom date+time so partial typing doesn't reset, same
  // pattern as the duration custom picker above.
  const [localDate, setLocalDate] = useState(isCustomTime ? sendAt.slice(0, 10) : "");
  const [localTime, setLocalTime] = useState(isCustomTime ? sendAt.slice(11, 16) : "");

  useEffect(() => {
    if (isCustomTime) {
      setLocalDate(sendAt.slice(0, 10));
      setLocalTime(sendAt.slice(11, 16));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendAt]);

  function pushCustom(d, t) {
    if (d && t) {
      setField("send_at", `${d}T${t}:00`);
    } else {
      setField("send_at", "custom_pending");
    }
  }
  function selectCustom() {
    if (!isCustomTime && sendAt !== "custom_pending") {
      setField("send_at", localDate && localTime ? `${localDate}T${localTime}:00` : "custom_pending");
    }
  }
  const customSelected = isCustomTime || sendAt === "custom_pending";

  return (
    <QuestionStep
      title="When should this send?"
      helper="One-off notes go out at a specific moment. Pick when."
      onNext={onNext}
      onBack={onBack}
      canNext={canNext}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
        <label
          style={{
            cursor: "pointer", padding: 12,
            background: isNow ? "#faf7ed" : "#fff",
            border: `2px solid ${isNow ? PURPLE : RULE}`,
            borderRadius: 12,
          }}
        >
          <input type="radio" name="send_at" checked={isNow} onChange={() => setField("send_at", "now")} style={{ display: "none" }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>Send right away</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>Fires within ~5 minutes</div>
        </label>

        <label
          style={{
            cursor: "pointer", padding: 12,
            background: isTomorrow ? "#faf7ed" : "#fff",
            border: `2px solid ${isTomorrow ? PURPLE : RULE}`,
            borderRadius: 12,
          }}
        >
          <input type="radio" name="send_at" checked={isTomorrow} onChange={() => setField("send_at", "tomorrow_morning")} style={{ display: "none" }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>Tomorrow morning</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>Tomorrow at 10am</div>
        </label>

        <div
          role="button"
          tabIndex={0}
          onClick={selectCustom}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectCustom(); } }}
          style={{
            cursor: customSelected ? "default" : "pointer",
            padding: 12,
            background: customSelected ? "#faf7ed" : "#fff",
            border: `2px solid ${customSelected ? PURPLE : RULE}`,
            borderRadius: 12,
            gridColumn: customSelected ? "1 / -1" : "auto",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>Custom date + time</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>Pick exactly when</div>

          {customSelected && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{ marginTop: 12, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}
            >
              <div>
                <div style={{ fontSize: 11, color: MUTED, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
                  Date
                </div>
                <input
                  type="date"
                  value={localDate}
                  min={todayIso()}
                  onChange={(e) => { setLocalDate(e.target.value); pushCustom(e.target.value, localTime); }}
                  onClick={(e) => e.stopPropagation()}
                  style={{ padding: "6px 8px", border: `1px solid ${RULE}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit", background: "#fff" }}
                />
              </div>
              <div>
                <div style={{ fontSize: 11, color: MUTED, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
                  Time
                </div>
                <input
                  type="time"
                  value={localTime}
                  onChange={(e) => { setLocalTime(e.target.value); pushCustom(localDate, e.target.value); }}
                  onClick={(e) => e.stopPropagation()}
                  style={{ padding: "6px 8px", border: `1px solid ${RULE}`, borderRadius: 4, fontSize: 13, fontFamily: "inherit", background: "#fff" }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 14, padding: 10, background: "#eaf3de", color: OK, fontSize: 13, borderRadius: 6, display: "flex", gap: 8, alignItems: "flex-start" }}>
        <span>💌</span>
        <span>For urgent notes (weather cancellations, schedule changes), pick "Send right away." For warmer one-offs (recaps, holiday greetings), tomorrow morning lands well.</span>
      </div>
    </QuestionStep>
  );
}
