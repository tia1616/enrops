// The curriculum's parent-facing prerequisite line (see lib/curriculumPrereqs.js).
// ONE component for every family-facing surface - catalog cards and the review
// screen - so the label cannot drift between them. Not clamped: it is the
// sentence that tells a parent whether Level 1 is required, so hiding it behind
// a "More" would defeat it. Renders nothing when the curriculum has none.
//
// variant: 'lean' (inline-styled lean catalog card) | 'card' (Tailwind card) |
// 'compact' (review line) | 'leg' (VIP bundle's Winter/Spring rows).
export default function PrereqLine({ text, variant = 'card', className = '' }) {
  if (!text) return null;
  const label = <span style={{ fontWeight: 700 }}>Prerequisites: </span>;
  if (variant === 'lean') {
    return (
      <div style={{ fontSize: 13, color: '#4a4a4a', marginTop: 4, marginBottom: 6, lineHeight: 1.4, whiteSpace: 'pre-line' }}>
        {label}{text}
      </div>
    );
  }
  const base = {
    compact: 'whitespace-pre-line text-sm text-j2s-ink/70',
    leg: 'whitespace-pre-line pl-3 text-xs text-j2s-ink/70',
  }[variant] || 'mt-1 mb-2.5 whitespace-pre-line text-sm text-j2s-ink/75 leading-snug';
  return <p className={`${base} ${className}`.trim()}>{label}{text}</p>;
}
