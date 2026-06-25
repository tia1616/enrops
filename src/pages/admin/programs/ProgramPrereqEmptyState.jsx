// Numbered "before you can create a program" checklist.
// Shown in two places:
//   - /admin/programs when 0 programs exist and prereqs are incomplete
//   - /admin/programs/new (the wizard) when a provider lands without prereqs
//
// Always renders all 3 items; check completed ones, link the next undone one.
// Voice is Ennie's ("I"). No tutorial bloat — onboarding tours carry the
// explainer load.

import { Link } from "react-router-dom";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const VIOLET = "#8C88FF";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const SOFT_GREEN = "#3a7c3a";

function StepRow({ number, done, focused, title, blurb, ctaLabel, ctaTo }) {
  const circleBg = done ? SOFT_GREEN : focused ? PURPLE : "#fff";
  const circleColor = done || focused ? "#fff" : MUTED;
  const circleBorder = done ? SOFT_GREEN : focused ? PURPLE : RULE;
  const titleColor = done ? MUTED : INK;
  return (
    <div
      style={{
        display: "flex",
        gap: 16,
        padding: "18px 0",
        borderBottom: `1px solid ${RULE}`,
        opacity: done ? 0.7 : 1,
      }}
    >
      <div
        aria-hidden
        style={{
          width: 32, height: 32, borderRadius: 16,
          background: circleBg, color: circleColor,
          border: `1.5px solid ${circleBorder}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontWeight: 700, fontSize: 15, flexShrink: 0,
        }}
      >
        {done ? "✓" : number}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{
          fontSize: 16, fontWeight: 600, color: titleColor,
          textDecoration: done ? "line-through" : "none",
        }}>
          {title}
        </div>
        <div style={{ fontSize: 14, color: MUTED, marginTop: 4, lineHeight: 1.5 }}>
          {blurb}
        </div>
        {!done && ctaTo && (
          <Link
            to={ctaTo}
            style={{
              display: "inline-block", marginTop: 10,
              padding: "8px 14px",
              background: focused ? BRIGHT : "#fff",
              color: focused ? "#fff" : BRIGHT,
              border: `1.5px solid ${BRIGHT}`,
              borderRadius: 8, fontSize: 14, fontWeight: 600,
              textDecoration: "none",
            }}
          >
            {ctaLabel}
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * @param {Object} props
 * @param {boolean} props.hasCurricula
 * @param {boolean} props.hasLocations
 * @param {string}  [props.heading]  optional override
 */
export default function ProgramPrereqEmptyState({ hasCurricula, hasLocations, heading }) {
  const bothDone = hasCurricula && hasLocations;
  // The next focusable step is the first undone item, OR step 3 if 1+2 are done.
  const focusedStep = !hasCurricula ? 1 : !hasLocations ? 2 : 3;

  const defaultHeading = bothDone
    ? "Ready to build your first program."
    : "Before we build your first program, two things need to be in place.";

  return (
    <div style={{
      maxWidth: 640, margin: "0 auto", padding: "40px 24px",
    }}>
      <h2 style={{
        fontSize: 22, fontWeight: 700, color: INK,
        margin: "0 0 8px", letterSpacing: "-0.01em",
      }}>
        {heading ?? defaultHeading}
      </h2>

      <div style={{ marginTop: 24 }}>
        <StepRow
          number={1}
          done={hasCurricula}
          focused={focusedStep === 1}
          title="Upload your curricula"
          blurb="The lesson content your programs will use. Once you have one, I can pull skills out, write marketing emails, and assign it to programs."
          ctaLabel="Add curricula"
          ctaTo="/admin/curricula/new"
        />
        <StepRow
          number={2}
          done={hasLocations}
          focused={focusedStep === 2}
          title="Add your program locations"
          blurb="Where your programs run — schools, studios, anywhere. For school-based programs, link each one to its district so I can pull in the school calendar."
          ctaLabel="Add locations"
          ctaTo="/admin/schools?tab=locations"
        />
        <StepRow
          number={3}
          done={false}
          focused={focusedStep === 3}
          title={bothDone ? "Create your first program" : "Create your first program (after 1 and 2)"}
          blurb="Pick the curriculum and location, set the time and price, and you're done."
          ctaLabel={bothDone ? "Start" : null}
          ctaTo={bothDone ? "/admin/programs/new" : null}
        />
      </div>

      {!bothDone && (
        <p style={{ marginTop: 24, fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
          When you've added what you need, come back here and I'll pick up where we left off.
        </p>
      )}
    </div>
  );
}
