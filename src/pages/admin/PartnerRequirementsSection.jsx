// "What <partner> requires", on that partner's page in the Partner portal admin
// (Jessica, 2026-10-26; one page per partner since 2026-10-27). The partner's
// portal shows and counts only what is ticked here, so Happy Valley, which does
// not ask for a business license, is never told one is missing, and West Linn,
// which does, is. Written through set_partner_requirement (20261026a); the page
// owns the list (partner_requirements_for, which also holds the defaults) so the
// record above re-counts the moment a tick saves. Spec v3 H3 later lets the host
// edit the same list itself.

import { useState } from "react";
import { setPartnerRequirement } from "../../lib/partnerPortal.js";
import { REQUIREMENTS } from "../../lib/partnerPortalLogic.js";

const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";

const GROUPS = [
  { kind: "business", title: "Your business" },
  { kind: "instructor", title: "Each instructor at their sites" },
];

/** `rows` = partner_requirements_for() rows, or null when they couldn't load. */
export default function PartnerRequirementsSection({ partner, rows, canManage, onChange }) {
  const [savingKey, setSavingKey] = useState("");
  const [error, setError] = useState("");
  // Shown under the checkboxes, where the person is looking.
  const [note, setNote] = useState("");

  const isRequired = (key) => !!rows?.find((r) => r.requirement_key === key)?.required;

  async function toggle(req) {
    const next = !isRequired(req.key);
    setSavingKey(req.key);
    setNote("");
    setError("");
    try {
      await setPartnerRequirement(partner.id, req.key, next);
      // An updater, not the rows captured at click time, so a reload that
      // landed meanwhile is never overwritten with a stale list.
      onChange((rs) => (rs || []).map((r) => (r.requirement_key === req.key ? { ...r, required: next } : r)));
      setNote(`Saved. ${req.label} is ${next ? "now required" : "no longer required"} for ${partner.partner_name}.`);
    } catch (err) {
      setError(`That didn't save: ${err?.message ?? "unknown error"}`);
    } finally {
      setSavingKey("");
    }
  }

  return (
    <section style={{ marginTop: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: "16px 20px" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 700, color: INK }}>What {partner.partner_name} requires</h2>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
        Tick what's in their packet. Their portal shows and counts only these, so they're never told something is
        missing that they don't ask for.
      </p>

      {!rows || rows.length === 0 ? (
        <div role="alert" style={{ fontSize: 13, color: "#991b1b" }}>Couldn't load this partner's list just now. Refresh to try again.</div>
      ) : (
        <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
          {GROUPS.map((g) => (
            <fieldset key={g.kind} style={{ border: "none", padding: 0, margin: 0, minWidth: 220 }}>
              <legend style={{ fontSize: 12, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{g.title}</legend>
              {REQUIREMENTS.filter((r) => r.kind === g.kind).map((r) => (
                <label key={r.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 14, color: INK, cursor: canManage ? "pointer" : "default" }}>
                  <input
                    type="checkbox"
                    checked={isRequired(r.key)}
                    disabled={!canManage || !!savingKey}
                    onChange={() => toggle(r)}
                    style={{ width: 16, height: 16 }}
                  />
                  {r.label}
                  {savingKey === r.key && <span style={{ fontSize: 12, color: MUTED }}>Saving…</span>}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      )}
      {error && <div role="alert" style={{ marginTop: 10, fontSize: 13, color: "#991b1b" }}>{error}</div>}
      {note && <div role="status" style={{ marginTop: 10, fontSize: 13, color: "#166534" }}>{note}</div>}
      {rows && rows.length > 0 && !canManage && (
        <div style={{ marginTop: 8, fontSize: 12, color: MUTED }}>Only an owner or admin can change these.</div>
      )}
    </section>
  );
}
