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
    const w = width ?? 88;
    const h = height ?? 48;
    return (
      <svg
        width={w}
        height={h}
        viewBox="0 0 88 48"
        fill="none"
        aria-hidden={ariaHidden}
        style={{ display: "block", overflow: "visible", ...style }}
      >
        {/* hand-drawn wavy tail (two humps) that lifts up to the right */}
        <path
          d="M5 32 C 9 22, 18 22, 22 31 C 25 37, 31 36, 35 27 C 43 11, 60 7, 77 12"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        {/* arrowhead at the tip, opening to the lower-left (points up-right) */}
        <path
          d="M65 8 L79 11 L74 24"
          stroke={color}
          strokeWidth="3"
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
