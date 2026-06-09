// Shared helpers + UI for the Chunk 3.5 capability strip + celebration tiles.
//
// Used by both CurriculaList.jsx (per-card strip) and CurriculumReview.jsx
// (8-tile celebration grid on PublishModal step 3). Both pages render the
// same CapabilityDetailModal when an icon/tile is clicked.

import { useNavigate } from "react-router-dom";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const PLUM_SOFT = "rgba(105, 29, 57, 0.08)";
const GOLD_SOFT = "rgba(207, 177, 47, 0.13)";
const GOLD_BORDER = "rgba(207, 177, 47, 0.55)";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";

// Map capability_definitions.icon_name -> emoji glyph used in the strip + tiles.
// Lucide icons would be the production target; emojis are the v1 placeholder.
export const CAPABILITY_ICONS = {
  "file-text": "📝",
  "printer": "🖨",
  "book-open": "📚",
  "mail": "✉",
  "calendar": "📅",
  "clipboard-check": "🎟",
  "mail-check": "📩",
  "send": "📬",
  "user": "👤",
  "user-check": "🧑",
  "tag": "🏷",
  "repeat": "🔁",
  "users": "👥",
  "inbox": "📥",
};

// Compute which org-state slugs are satisfied for a given curriculum +
// its current linked schedule count. Only the cheap-to-derive states are
// returned; others (registrations_received, program_running, etc.) stay
// locked until later chunks add the signals.
export function deriveOrgStatesForCurriculum(curriculum, linkedCount) {
  const states = new Set();
  if (curriculum?.status === "published") states.add("curriculum_published");
  if ((linkedCount ?? 0) > 0) states.add("program_scheduled");
  return states;
}

export function isCapabilityUnlocked(capability, satisfiedStates) {
  if (!Array.isArray(capability.required_states) || capability.required_states.length === 0) return true;
  for (const req of capability.required_states) if (!satisfiedStates.has(req)) return false;
  return true;
}

// Click detail modal for any capability tile or strip icon.
// Reads the rich why_it_matters / stat content from capability_definitions
// so the operator sees the same argument whether they click from the library
// strip or the post-publish celebration grid.
export function CapabilityDetailModal({ capability, unlocked, onClose }) {
  const navigate = useNavigate();
  if (!capability) return null;

  // For locked capabilities we offer a "do the next step" CTA. The mapping
  // from required_states[0] -> destination is intentionally simple; routes
  // that don't exist yet (registration_open, program_running, etc.) fall
  // back to /admin/curricula so the operator isn't dead-ended.
  let ctaLabel = null;
  let ctaTo = null;
  if (!unlocked && Array.isArray(capability.required_states) && capability.required_states.length > 0) {
    const next = capability.required_states[0];
    if (next === "program_scheduled" || next === "registration_open" || next === "registrations_received" || next === "program_running") {
      ctaLabel = "Schedule a program →";
      ctaTo = "/admin/schedule";
    } else if (next === "past_registrations_exist") {
      ctaLabel = "Open marketing →";
      ctaTo = "/admin/marketing";
    } else if (next === "program_at_capacity") {
      ctaLabel = "Open programs →";
      ctaTo = "/admin/programs";
    } else if (next === "boss_mode_enabled") {
      ctaLabel = "Settings →";
      ctaTo = "/admin/settings";
    }
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, background: "rgba(0, 0, 0, 0.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 100, padding: 20,
      }}
    >
      <div style={{
        background: PANEL,
        borderRadius: 10,
        maxWidth: 460,
        width: "100%",
        padding: 24,
        boxShadow: "0 10px 32px rgba(0,0,0,0.18)",
        maxHeight: "90vh",
        overflowY: "auto",
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
          <div style={{
            width: 38, height: 38, borderRadius: "50%",
            background: unlocked ? "rgba(78, 145, 78, 0.12)" : "#f3f0e6",
            color: unlocked ? "#2d5a2d" : MUTED,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 18, flexShrink: 0,
          }}>
            {unlocked ? "✓" : (CAPABILITY_ICONS[capability.icon_name] ?? "•")}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
              {unlocked ? "Unlocked" : "Locked"} · {capability.category}
            </div>
            <h3 style={{ margin: "2px 0 0", color: INK, fontSize: 17, fontWeight: 700 }}>
              {capability.display_name}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: MUTED, fontSize: 20, cursor: "pointer", padding: 0, lineHeight: 1 }}
            title="Close"
          >×</button>
        </div>

        {capability.why_it_matters && (
          <p style={{ color: INK, fontSize: 14, lineHeight: 1.55, margin: "0 0 12px" }}>
            {capability.why_it_matters}
          </p>
        )}

        {capability.stat_text && (
          <div style={{
            background: GOLD_SOFT,
            border: `1px solid ${GOLD_BORDER}`,
            borderRadius: 6,
            padding: "10px 12px",
            marginBottom: 12,
            fontSize: 12,
            lineHeight: 1.5,
          }}>
            {capability.stat_source && (
              <strong style={{ color: "#5c4a00" }}>{capability.stat_source}:</strong>
            )}{" "}
            <span style={{ color: INK }}>{capability.stat_text}</span>
          </div>
        )}

        {!unlocked && capability.required_states_human && (
          <div style={{
            background: PLUM_SOFT,
            borderLeft: `3px solid ${PURPLE}`,
            borderRadius: 4,
            padding: "10px 12px",
            marginBottom: 14,
            fontSize: 13,
            color: INK,
          }}>
            <strong>To unlock:</strong> {capability.required_states_human}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: MUTED, padding: "8px 12px", cursor: "pointer", fontSize: 14, fontFamily: "inherit" }}
          >
            {unlocked ? "Got it" : "Not now"}
          </button>
          {ctaTo && (
            <button
              type="button"
              onClick={() => { onClose(); navigate(ctaTo); }}
              style={{ background: BRIGHT, color: "white", border: "none", borderRadius: 6, padding: "8px 14px", cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: "inherit" }}
            >
              {ctaLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
