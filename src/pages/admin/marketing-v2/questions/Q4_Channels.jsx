// Q4_Channels — checkbox group. Email is the only enabled channel in v1.
// Flyer + Social render disabled with "Coming soon" badges per spec.
// Includes "Remind me later" per the approved mockup — saves nothing in chunk 05
// (no API), just kicks the user back to /admin so the affordance is visible.

import { useNavigate } from "react-router-dom";
import QuestionStep from "../QuestionStep.jsx";
import { PURPLE, RULE, INK, MUTED, WARN } from "../../marketing/tokens.jsx";

const CHANNELS = [
  // Was "Email + parent portal" — but the parent portal feed doesn't exist
  // yet (target with the lifecycle automations build). Misleading copy on the
  // operator's review screen; downgraded to plain "Email" until that ships.
  { key: "email", label: "Email", icon: "✉️", helper: "Personalized per recipient." },
  { key: "flyer", label: "Flyer (PDF)", icon: "📄", helper: "Branded handout for partners.", disabled: true },
  { key: "social", label: "Social post", icon: "📣", helper: "Caption + hashtags + tags.", disabled: true },
];

export default function Q4_Channels({ inputs, setField, onBack, canNext, loading, onStartDrafting }) {
  const navigate = useNavigate();
  const channels = inputs.channels;

  function toggle(key) {
    if (channels.includes(key)) {
      setField("channels", channels.filter((c) => c !== key));
    } else {
      setField("channels", [...channels, key]);
    }
  }

  return (
    <QuestionStep
      title="How are you reaching them?"
      helper="Pick any combo — Ennie will draft each one."
      onBack={onBack}
      canNext={canNext}
      isLast
      loading={loading}
      onStartDrafting={onStartDrafting}
      rightExtras={
        <button
          onClick={() => {
            // Friendly bail-out — kick back to the admin home. The Family
            // Comms surface auto-creates a draft row when Ennie's draft pass
            // runs, so this button doesn't need to persist anything. Future
            // (when a drafts list ships): land on /admin/family-comms/marketing/drafts
            // so the operator can pick this back up.
            // Was navigate("/admin/marketing") — that route was retired with
            // the old Marketing tab; would 404 / catch-all.
            navigate("/admin");
          }}
          disabled={loading}
          style={{
            background: "#fff", border: `1px solid ${RULE}`,
            color: INK, padding: "10px 14px", borderRadius: 6,
            cursor: loading ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 500,
            fontFamily: "inherit",
          }}
        >
          Remind me later
        </button>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
        {CHANNELS.map((c) => {
          const checked = channels.includes(c.key);
          return (
            <label
              key={c.key}
              style={{
                cursor: c.disabled ? "not-allowed" : "pointer",
                opacity: c.disabled ? 0.55 : 1,
                padding: 12,
                background: checked ? "#faf7ed" : "#fff",
                border: `2px solid ${checked ? PURPLE : RULE}`,
                borderRadius: 12,
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => !c.disabled && toggle(c.key)}
                disabled={c.disabled}
                style={{ display: "none" }}
              />
              <div style={{ fontSize: 20, lineHeight: 1 }}>{c.icon}</div>
              <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: INK }}>{c.label}</span>
                {c.disabled && (
                  <span style={{ fontSize: 10, padding: "2px 6px", background: "#FAEEDA", color: WARN, borderRadius: 999, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>
                    Soon
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>{c.helper}</div>
            </label>
          );
        })}
      </div>

      {/* Operator notes — free-form context that overrides Ennie's defaults
          for this specific campaign. Use cases: tenant-level offers Ennie
          can't infer (VIP pricing, partner showcase events), tone overrides,
          things to NOT mention. Promo picker (task #6) will add structured
          choices alongside. */}
      <div style={{ marginTop: 20 }}>
        <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: INK, marginBottom: 4 }}>
          Anything else Ennie should know? <span style={{ color: MUTED, fontWeight: 400 }}>(Optional)</span>
        </label>
        <p style={{ fontSize: 12, color: MUTED, margin: "0 0 6px" }}>
          Tell Ennie anything you'd like her to mention in the emails. Examples: "Lead with the savings, not the program list" · "Don't talk about prices in the kickoff" · "Mention our parent showcase event on June 15"
          {/* Removed "Mention our STEAM VIP full-year option, $720 total"
              from the examples — the VIP/annual-pass offering is now
              centralized in organizations.vip_offering and Ennie places it
              via {{vip_block}} automatically. Asking the operator to retype
              it in operator_notes contradicts that architecture. */}
        </p>
        <textarea
          value={inputs.operator_notes ?? ""}
          onChange={(e) => setField("operator_notes", e.target.value.slice(0, 500))}
          placeholder="Mention our parent showcase event on June 15…"
          rows={3}
          style={{
            width: "100%", padding: 10, fontSize: 13, fontFamily: "inherit",
            border: `1px solid ${RULE}`, borderRadius: 6, resize: "vertical",
            color: INK, background: "#fff", boxSizing: "border-box",
          }}
        />
        <div style={{ textAlign: "right", fontSize: 11, color: MUTED, marginTop: 2 }}>
          {(inputs.operator_notes ?? "").length}/500
        </div>
      </div>

      {/* Optional CTA link to include in the body. Used for any campaign type
          — registration page, photo gallery, rebook tool, makeup-class form,
          updated schedule PDF. Field name (registration_url_override) is
          legacy; the operator-facing label is generic 'Link to include' so
          providers don't have to think 'registration' for every campaign. */}
      <div style={{ marginTop: 16 }}>
        <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: INK, marginBottom: 4 }}>
          Link to include <span style={{ color: MUTED, fontWeight: 400 }}>(Optional)</span>
        </label>
        <p style={{ fontSize: 12, color: MUTED, margin: "0 0 6px" }}>
          If your email needs a link — registration page, photo gallery, makeup-class form, updated schedule, rebook tool — paste it here. Ennie weaves it in naturally. Leave blank if no link.
        </p>
        <input
          type="url"
          value={inputs.registration_url_override ?? ""}
          onChange={(e) => setField("registration_url_override", e.target.value.slice(0, 300))}
          placeholder="https://your-site.com/register"
          style={{
            width: "100%", padding: 10, fontSize: 13, fontFamily: "inherit",
            border: `1px solid ${RULE}`, borderRadius: 6,
            color: INK, background: "#fff", boxSizing: "border-box",
          }}
        />
      </div>
    </QuestionStep>
  );
}
