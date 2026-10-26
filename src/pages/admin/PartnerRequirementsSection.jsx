// "What each partner requires" on the Partner portal admin screen (Jessica,
// 2026-10-26). A partner's portal shows and counts only what is ticked here, so
// Happy Valley, which does not ask for a business license, is never told one is
// missing, and West Linn, which does, is. One list per partner, read and
// written through partner_requirements_for / set_partner_requirement
// (20261026a), which also hold the defaults. Spec v3 H3 later lets the host
// edit the same list itself.

import { useEffect, useState } from "react";
import { listPartnerRequirements, setPartnerRequirement } from "../../lib/partnerPortal.js";
import { REQUIREMENTS } from "../../lib/partnerPortalLogic.js";

const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const input = { width: "100%", padding: "10px 12px", border: `1.5px solid ${RULE}`, borderRadius: 8, fontSize: 14, color: INK, background: "#fff", fontFamily: "inherit", boxSizing: "border-box" };

const GROUPS = [
  { kind: "business", title: "Your business" },
  { kind: "instructor", title: "Each instructor at their sites" },
];

export default function PartnerRequirementsSection({ partners, canManage }) {
  const active = (partners ?? []).filter((p) => !p.inactive);
  const [partnerId, setPartnerId] = useState("");
  const [rows, setRows] = useState(null); // [{ requirement_key, required }] | null
  const [loadError, setLoadError] = useState("");
  const [savingKey, setSavingKey] = useState("");
  // Shown under the checkboxes, where the person is looking. The page's toast
  // sits at the top, out of view from this section.
  const [note, setNote] = useState("");

  useEffect(() => {
    setRows(null);
    setLoadError("");
    setNote("");
    if (!partnerId) return;
    let cancelled = false;
    listPartnerRequirements(partnerId)
      .then((r) => { if (!cancelled) setRows(r); })
      .catch((err) => { if (!cancelled) setLoadError(`Couldn't load this partner's requirements: ${err?.message ?? "unknown error"}`); });
    return () => { cancelled = true; };
  }, [partnerId]);

  const partnerName = active.find((p) => p.id === partnerId)?.partner_name ?? "this partner";
  const isRequired = (key) => !!rows?.find((r) => r.requirement_key === key)?.required;

  async function toggle(req) {
    const next = !isRequired(req.key);
    setSavingKey(req.key);
    setNote("");
    setLoadError("");
    try {
      await setPartnerRequirement(partnerId, req.key, next);
      setRows((rs) => rs.map((r) => (r.requirement_key === req.key ? { ...r, required: next } : r)));
      setNote(`Saved. ${req.label} is ${next ? "now required" : "no longer required"} for ${partnerName}.`);
    } catch (err) {
      setLoadError(`That didn't save: ${err?.message ?? "unknown error"}`);
    } finally {
      setSavingKey("");
    }
  }

  return (
    <section style={{ marginTop: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: "16px 20px" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 700, color: INK }}>What each partner requires</h2>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
        Tick what's in each partner's packet. Their portal shows and counts only these, so they're never told
        something is missing that they don't ask for.
      </p>
      <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)} style={{ ...input, maxWidth: 360 }} aria-label="Partner">
        <option value="">Choose a partner</option>
        {active.map((p) => <option key={p.id} value={p.id}>{p.partner_name}</option>)}
      </select>

      {loadError && <div role="alert" style={{ marginTop: 10, fontSize: 13, color: "#991b1b" }}>{loadError}</div>}
      {partnerId && rows === null && !loadError && <div style={{ marginTop: 12, fontSize: 13, color: MUTED }}>Loading…</div>}

      {rows && (
        <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginTop: 14 }}>
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
      {note && <div role="status" style={{ marginTop: 10, fontSize: 13, color: "#166534" }}>{note}</div>}
      {rows && !canManage && (
        <div style={{ marginTop: 8, fontSize: 12, color: MUTED }}>Only an owner or admin can change these.</div>
      )}
    </section>
  );
}
