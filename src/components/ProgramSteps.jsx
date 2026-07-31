// ProgramSteps — the "this is how short the road is" strip above the builder.
//
// The point of this component is the CONTRAST, not the progress. Jessica's
// framing: the first program costs three steps, and every program after it costs
// two. Saying both, in the same place, is what makes the product's promise
// legible in a glance — and it stays honest, because the first run genuinely
// costs more than the ones after it.
//
// It lives in the builder permanently rather than being a first-run tour, which
// is also the cheapest answer to "the explanation should always be available":
// it is, by definition, and there is no second surface to maintain.
//
// Deliberately NOT reusing ScheduleStepBar: that is a clickable status map for
// the scheduling cockpit, where several steps are live at once and nothing is
// greyed out. "How close am I" is a different primitive.
//
// THREE states, not two. `count` is null until the builder has finished counting
// this org's programs, and the honest thing to render then is nothing — showing
// either variant early means showing the wrong one to somebody.

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const DONE = "#3a7c3a";

import { STRIPE_CONNECT_ESTIMATE } from "../lib/stripeConnectEstimate.js";

const FIRST_STEPS = ["Enter your program info", "Publish it", "Connect Stripe"];
const REPEAT_STEPS = ["Enter your program info", "Publish it"];

function Pip({ n, label, state }) {
  const bg = state === "done" ? DONE : state === "current" ? BRIGHT : "#fff";
  const fg = state === "upcoming" ? MUTED : "#fff";
  const border = state === "done" ? DONE : state === "current" ? BRIGHT : RULE;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
      <span
        aria-hidden="true"
        style={{
          width: 20, height: 20, borderRadius: 10, flexShrink: 0,
          background: bg, color: fg, border: `1.5px solid ${border}`,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          fontSize: 11, fontWeight: 700, lineHeight: 1,
        }}
      >
        {state === "done" ? "✓" : n}
      </span>
      <span
        style={{
          fontSize: 12.5,
          fontWeight: state === "current" ? 700 : 500,
          color: state === "upcoming" ? MUTED : INK,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
    </div>
  );
}

/**
 * @param {number|null} count    programs this org already has. null = still counting.
 * @param {number} current       1-based step in progress. Pass steps.length + 1 for "all done".
 */
export default function ProgramSteps({ count, current = 1 }) {
  if (count === null || count === undefined) return null;

  const isFirst = count === 0;
  const steps = isFirst ? FIRST_STEPS : REPEAT_STEPS;

  return (
    <div
      style={{
        background: "#FBFAFF",
        border: `1px solid ${RULE}`,
        borderRadius: 10,
        padding: "12px 14px",
        marginBottom: 20,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: PURPLE, marginBottom: 10 }}>
        {isFirst
          ? "Your first program: three steps to live"
          : "Two steps, and it's live"}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 10px" }}>
        {steps.map((label, i) => {
          const n = i + 1;
          const state = n < current ? "done" : n === current ? "current" : "upcoming";
          return (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: "8px 10px" }}>
              <Pip n={n} label={label} state={state} />
              {i < steps.length - 1 && (
                <span aria-hidden="true" style={{ color: RULE, fontSize: 13 }}>→</span>
              )}
            </div>
          );
        })}
      </div>

      {/* The ONLY timing claim here is one we actually measured, and it is READ
          from stripeConnectEstimate rather than restated — the Payments screen
          shows the same figure, and two hardcoded copies is how they drift apart.
          There is deliberately no headline "your first program takes N minutes":
          we have never timed that, and a number that turns out to be double
          reality is worse than no number. It goes in once there is data. */}
      {isFirst ? (
        <p style={{ fontSize: 12, color: MUTED, lineHeight: 1.55, margin: "10px 0 0" }}>
          Connecting Stripe takes {STRIPE_CONNECT_ESTIMATE}. Your waivers and
          cancellation policy are already written for you &mdash; they&rsquo;re
          templates, so you can turn them on or off and edit the wording in
          Settings any time.
        </p>
      ) : (
        <p style={{ fontSize: 12, color: MUTED, lineHeight: 1.55, margin: "10px 0 0" }}>
          Run similar classes each term? Copy one in a click from Programs instead
          of starting over.
        </p>
      )}
    </div>
  );
}
