// QuestionStep — shared chrome for every question screen. Renders the question
// heading + helper text and the sticky bottom action bar with Back / Next.

import { INK, MUTED, PURPLE, RULE } from "../marketing/tokens.jsx";

export default function QuestionStep({
  title,
  helper,
  children,
  onBack,
  onNext,
  canNext,
  isLast = false,
  loading = false,
  loadingLabel,
  onStartDrafting,
  rightExtras,
}) {
  return (
    <div>
      <h2 style={{ margin: "0 0 6px", fontSize: 24, color: INK, fontWeight: 700, letterSpacing: -0.2 }}>
        {title}
      </h2>
      {helper && <p style={{ margin: "0 0 16px", color: MUTED, fontSize: 14 }}>{helper}</p>}
      <div>{children}</div>

      {/* Sticky bottom action bar */}
      <div
        style={{
          position: "fixed", bottom: 0, left: 0, right: 0,
          padding: "12px 16px", background: "rgba(255,255,255,0.96)",
          backdropFilter: "blur(6px)", borderTop: `1px solid ${RULE}`,
          display: "flex", justifyContent: "space-between", alignItems: "center",
          gap: 12, zIndex: 5,
        }}
      >
        <button
          onClick={onBack}
          disabled={!onBack || loading}
          style={{
            background: "transparent", border: "none", color: onBack ? MUTED : "#cfcfcf",
            cursor: onBack ? "pointer" : "not-allowed", fontSize: 13, fontFamily: "inherit",
          }}
        >
          ← Back
        </button>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {rightExtras}
          {isLast ? (
            <button
              onClick={onStartDrafting}
              disabled={!canNext || loading}
              style={{
                padding: "10px 18px", background: canNext && !loading ? PURPLE : "#cfcfcf",
                color: "#fff", border: "none", borderRadius: 6,
                cursor: canNext && !loading ? "pointer" : "not-allowed",
                fontSize: 14, fontWeight: 600,
              }}
            >
              {loading ? (loadingLabel ?? "Drafting your campaign...") : "Draft it ✨"}
            </button>
          ) : (
            <button
              onClick={onNext}
              disabled={!canNext}
              style={{
                padding: "10px 18px", background: canNext ? PURPLE : "#cfcfcf",
                color: "#fff", border: "none", borderRadius: 6,
                cursor: canNext ? "pointer" : "not-allowed",
                fontSize: 14, fontWeight: 600,
              }}
            >
              Next →
            </button>
          )}
        </div>
      </div>

      {loading && (
        <div
          style={{
            marginTop: 24, padding: 16, background: "#faf7ed",
            border: `1px dashed ${RULE}`, borderRadius: 6, fontSize: 13, color: MUTED,
            display: "flex", alignItems: "center", gap: 10,
          }}
        >
          <span style={{ display: "inline-block", width: 14, height: 14, border: `2px solid ${PURPLE}`, borderRightColor: "transparent", borderRadius: "50%", animation: "spin 0.9s linear infinite" }} />
          Pulling your brand voice, the right recipients, and the best timing…
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}
    </div>
  );
}
