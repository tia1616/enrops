// Chevron — the one expand/collapse affordance used across the app, replacing
// the old ▸/▾/▶ triangle glyphs. Points down when closed; rotates to point up
// when open. Inherits color via `currentColor` by default so it adapts to its
// context (indigo on admin, tenant color on tenant surfaces).

export default function Chevron({ open = false, size = 12, color = "currentColor", style = {}, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={className}
      style={{
        flexShrink: 0,
        display: "inline-block",
        transform: open ? "rotate(180deg)" : "none",
        transition: "transform 0.15s ease",
        ...style,
      }}
    >
      <path d="M3 4.5 L6 7.5 L9 4.5" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
