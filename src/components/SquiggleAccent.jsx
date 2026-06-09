// SquiggleAccent — a hand-drawn decorative flourish used SPARINGLY to draw the
// eye to one key heading or CTA per screen. Two variants:
//   - "underline": a wavy hand-drawn underline (sits under a heading)
//   - "arrow":     a curving squiggle that ends in an arrowhead (points at a CTA)
//
// Color rules (multi-tenant):
//   - Enrops ADMIN surfaces use the fixed Enrops accent green (the default).
//   - TENANT surfaces (instructor portal, registration) should pass their own
//     brand color via `color` — e.g. color={branding?.primary_color}. Until a
//     tenant sets colors it falls back to the Enrops green, so the decoration
//     still reads. Never hardcode a tenant's identity here.
//
// Keep it rare. It's special because it's not everywhere.

// Enrops accent green — sampled from Jessica's design annotation (2026-06-09).
export const ENROPS_ACCENT_GREEN = "#22C3A0";

export default function SquiggleAccent({
  variant = "underline",
  color = ENROPS_ACCENT_GREEN,
  width,
  height,
  style = {},
  ariaHidden = true,
}) {
  if (variant === "arrow") {
    const w = width ?? 76;
    const h = height ?? 40;
    return (
      <svg
        width={w}
        height={h}
        viewBox="0 0 76 40"
        fill="none"
        aria-hidden={ariaHidden}
        style={{ display: "block", overflow: "visible", ...style }}
      >
        {/* a loose squiggle that curves down toward the target */}
        <path
          d="M4 7 Q 22 0, 33 13 T 58 26"
          stroke={color}
          strokeWidth="2.6"
          strokeLinecap="round"
          fill="none"
        />
        {/* arrowhead */}
        <path
          d="M49 22 L60 28 L50 33"
          stroke={color}
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    );
  }

  // underline (default)
  const w = width ?? 132;
  const h = height ?? 9;
  return (
    <svg
      width={w}
      height={h}
      viewBox="0 0 132 9"
      fill="none"
      preserveAspectRatio="none"
      aria-hidden={ariaHidden}
      style={{ display: "block", ...style }}
    >
      <path
        d="M2 6 Q 18 2, 34 5 T 66 5 T 98 5 T 130 4"
        stroke={color}
        strokeWidth="2.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
