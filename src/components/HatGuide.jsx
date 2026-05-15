// src/components/HatGuide.jsx
// Persistent "what should I do next" panel for an admin page.
// v1: presentational only — the parent computes which tip to show and passes it in.
// Each Enrops page surfaces its own "Hat" character (Director on home, Instructor
// on Schedule, etc.). Avatars are emoji placeholders until designed.
//
// Tip shape:
//   {
//     key: string|null,           // unique per cycle; null skips dismissal
//     message: string|ReactNode,
//     primary?:   { label, onClick, disabled? },
//     secondary?: { label, onClick },
//     celebrate?: boolean,        // hides "Not now" + actions for the done state
//   }
//
// Dismissal: "Not now" hides the tip for 24h via localStorage keyed by tip.key.
// Per platform principle: "Always offer Not now (24-hr hide, re-surfaces if
// condition still holds)."

import { useEffect, useState } from "react";

const PLUM = "#691D39";
const GOLD = "#CFB12F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

const CHARACTERS = {
  instructor: { emoji: "🎓", name: "Instructor Hat" },
};

const DISMISS_HOURS = 24;
const lsKey = (key) => `enrops.hatguide.dismissed.${key}`;

function isDismissed(key) {
  if (!key) return false;
  try {
    const raw = localStorage.getItem(lsKey(key));
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < DISMISS_HOURS * 3600 * 1000;
  } catch {
    return false;
  }
}

function setDismissed(key) {
  try { localStorage.setItem(lsKey(key), String(Date.now())); } catch {}
}

export default function HatGuide({ character = "instructor", tip }) {
  const [, force] = useState(0);
  useEffect(() => { force((x) => x + 1); }, [tip?.key]);

  if (!tip) return null;
  if (tip.key && isDismissed(tip.key)) return null;

  const char = CHARACTERS[character] ?? CHARACTERS.instructor;
  const showDismiss = !tip.celebrate && !!tip.key;
  const hasActions = tip.primary || tip.secondary || showDismiss;

  return (
    <section
      aria-label={`${char.name} suggestion`}
      style={{
        display: "flex",
        gap: 14,
        alignItems: "flex-start",
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderLeft: `4px solid ${GOLD}`,
        borderRadius: 8,
        padding: "16px 20px",
      }}
    >
      <div
        aria-hidden="true"
        style={{
          flex: "0 0 auto",
          width: 44,
          height: 44,
          borderRadius: "50%",
          background: `${GOLD}22`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 26,
          lineHeight: 1,
        }}
      >
        {char.emoji}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 11,
            color: MUTED,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.6,
            marginBottom: 4,
          }}
        >
          {char.name}
        </div>
        <div style={{ color: INK, fontSize: 15, lineHeight: 1.5 }}>{tip.message}</div>
        {hasActions && (
          <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {tip.primary && (
              <button
                type="button"
                onClick={tip.primary.onClick}
                disabled={tip.primary.disabled}
                style={{
                  padding: "9px 16px",
                  background: PLUM,
                  color: "#fff",
                  border: "none",
                  borderRadius: 6,
                  cursor: tip.primary.disabled ? "default" : "pointer",
                  opacity: tip.primary.disabled ? 0.5 : 1,
                  fontSize: 14,
                  fontWeight: 600,
                  fontFamily: "inherit",
                }}
              >
                {tip.primary.label}
              </button>
            )}
            {tip.secondary && (
              <button
                type="button"
                onClick={tip.secondary.onClick}
                style={{
                  padding: "9px 16px",
                  background: "transparent",
                  color: PLUM,
                  border: `1px solid ${PLUM}`,
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 14,
                  fontWeight: 500,
                  fontFamily: "inherit",
                }}
              >
                {tip.secondary.label}
              </button>
            )}
            {showDismiss && (
              <button
                type="button"
                onClick={() => { setDismissed(tip.key); force((x) => x + 1); }}
                style={{
                  padding: "9px 14px",
                  background: "transparent",
                  color: MUTED,
                  border: "none",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 14,
                  fontFamily: "inherit",
                }}
              >
                Not now
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
