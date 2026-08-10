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

const ENTER_INFO = "Enter your program info";
const PUBLISH_IT = "Publish it";
const CONNECT_STRIPE = "Connect Stripe";
const BASE_STEPS = [ENTER_INFO, PUBLISH_IT];
// ORDER MATTERS, and it changed when publishing became gated on Stripe. This
// used to read Enter -> Publish -> Connect Stripe, i.e. Stripe as the thing you
// mop up afterwards. Since the publish gate shipped that sequence is not merely
// out of date, it is impossible: a paid class cannot leave draft until charges
// are enabled, so an operator following these pips in order hits a wall at
// step 2 that the strip told them was step 3.
const STEPS_NEEDING_STRIPE = [ENTER_INFO, CONNECT_STRIPE, PUBLISH_IT];

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
 * @param {number|null}  count           programs this org already has. null = still counting.
 * @param {boolean|null} chargesEnabled  can this org take money yet? null = not known yet.
 * @param {number} current               1-based step in progress. steps.length + 1 = all done.
 */
export default function ProgramSteps({ count, chargesEnabled, current = 1 }) {
  // Two things we may not know yet, and neither has a safe default. Claiming
  // "two steps and it's live" to an operator who cannot take payment, or calling
  // someone's fourth program their first, are both worse than showing nothing
  // for a beat.
  if (count === null || count === undefined) return null;
  if (chargesEnabled === null || chargesEnabled === undefined) return null;

  const isFirst = count === 0;
  // Connecting Stripe is a step whenever it HASN'T happened - which is not the
  // same question as whether this is their first program. Keying the step list
  // off `isFirst` alone told a returning operator with a disconnected account
  // that their program was live, directly above a panel saying it wasn't.
  const needsStripe = chargesEnabled === false;
  const steps = needsStripe ? STEPS_NEEDING_STRIPE : BASE_STEPS;

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
      {/* FOUR states, four sentences, each matching the number of pips below it.
          Said out loud:
            first + no Stripe   -> "three steps to live"   (3 pips)
            first + Stripe on   -> "two steps to live"     (2 pips)
            repeat + no Stripe  -> "three steps this time" (3 pips)
            repeat + Stripe on  -> "two steps, and it's live" (2 pips) */}
      <div style={{ fontSize: 13, fontWeight: 700, color: PURPLE, marginBottom: 10 }}>
        {isFirst
          ? (needsStripe
              ? "Your first program: three steps to live"
              : "Your first program: two steps to live")
          : (needsStripe
              ? "Three steps this time — Stripe still needs connecting"
              : "Two steps, and it's live")}
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
      {/* The Stripe timing belongs to the Stripe STEP, not to first-run - a
          returning operator who needs to connect deserves the same estimate. */}
      {needsStripe && (
        <p style={{ fontSize: 12, color: MUTED, lineHeight: 1.55, margin: "10px 0 0" }}>
          Connecting Stripe takes {STRIPE_CONNECT_ESTIMATE}.
        </p>
      )}
      {isFirst ? (
        <p style={{ fontSize: 12, color: MUTED, lineHeight: 1.55, margin: "10px 0 0" }}>
          Your waivers and cancellation policy are already written for you
          &mdash; they&rsquo;re templates, so you can turn them on or off and edit
          the wording in Settings any time.
        </p>
      ) : (
        <p style={{ fontSize: 12, color: MUTED, lineHeight: 1.55, margin: "10px 0 0" }}>
          {/* NOT "copy one in a click". The real flow is: open the program, type
              the term you want it in, then Copy - and the button stays disabled
              until that term is filled in. Promising one click sends an operator
              hunting for a button that is not there, which is the opposite of
              what this line is for. */}
          Run similar classes each term? Open one from Scheduled programs and copy
          it into another term, instead of building it again.
        </p>
      )}
    </div>
  );
}
