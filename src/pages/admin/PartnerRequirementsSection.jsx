// "What <partner> requires", on that partner's page in the Partner portal admin
// (Jessica, 2026-10-26; one page per partner since 2026-10-27). The partner's
// portal shows and counts only what is ticked here, so Happy Valley, which does
// not ask for a business license, is never told one is missing, and West Linn,
// which does, is. Written through set_partner_requirement (20261026a); the page
// owns the list (partner_requirements_for, which also holds the defaults) so the
// record above re-counts the moment a tick saves. Spec v3 H3 later lets the host
// edit the same list itself.

import { useState } from "react";
import { setPartnerRequirement, setPartnerRequirementDetail } from "../../lib/partnerPortal.js";
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
  const rowFor = (key) => rows?.find((r) => r.requirement_key === key) ?? null;
  // The item whose "what they require" text is open for editing (20261104b).
  const [editing, setEditing] = useState(null); // { key, detail, source } | null

  async function saveDetail() {
    if (!editing) return;
    setSavingKey(editing.key);
    setNote("");
    setError("");
    try {
      const detail = editing.detail.trim();
      const source = editing.source.trim();
      await setPartnerRequirementDetail(partner.id, editing.key, detail, source);
      onChange((rs) => (rs || []).map((r) => (r.requirement_key === editing.key
        ? { ...r, detail: detail || null, source: detail ? source || null : null } : r)));
      setEditing(null);
      setNote("Saved.");
    } catch (err) {
      setError(`That didn't save: ${err?.message ?? "unknown error"}`);
    } finally {
      setSavingKey("");
    }
  }

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
              {REQUIREMENTS.filter((r) => r.kind === g.kind).map((r) => {
                const row = rowFor(r.key);
                const open = editing?.key === r.key;
                return (
                  <div key={r.key} style={{ padding: "5px 0" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: INK, cursor: canManage ? "pointer" : "default" }}>
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
                    {/* What they require for this item, in their words, and where
                        it is written (spec v3 H3 "what you require" + "source"). */}
                    {isRequired(r.key) && !open && (
                      <div style={{ marginLeft: 24, fontSize: 12, color: MUTED, lineHeight: 1.45, maxWidth: 360 }}>
                        {row?.detail ? <span style={{ color: INK }}>{row.detail}</span> : null}
                        {row?.source ? <div>Source: {row.source}</div> : null}
                        {canManage && (
                          <button
                            type="button" disabled={!!savingKey}
                            onClick={() => setEditing({ key: r.key, detail: row?.detail ?? "", source: row?.source ?? "" })}
                            style={{ background: "none", border: "none", padding: 0, color: "#5847C9", fontSize: 12, fontWeight: 600, cursor: "pointer", textDecoration: "underline", fontFamily: "inherit" }}
                          >
                            {row?.detail ? "Edit details" : "Add what they require"}
                          </button>
                        )}
                      </div>
                    )}
                    {open && (
                      <div style={{ marginLeft: 24, display: "grid", gap: 6, maxWidth: 360 }}>
                        <textarea
                          aria-label={`What ${partner.partner_name} requires for ${r.label}`} rows={3} maxLength={600}
                          value={editing.detail} onChange={(e) => setEditing({ ...editing, detail: e.target.value })}
                          placeholder="In their words, e.g. General liability $1M per occurrence / $2M aggregate"
                          style={{ fontSize: 13, padding: 6, borderRadius: 6, border: `1px solid ${RULE}`, fontFamily: "inherit" }}
                        />
                        <input
                          aria-label="Where it's written" maxLength={200}
                          value={editing.source} onChange={(e) => setEditing({ ...editing, source: e.target.value })}
                          placeholder="Where it's written, e.g. 2026 agreement, page 6"
                          style={{ fontSize: 13, padding: 6, borderRadius: 6, border: `1px solid ${RULE}`, fontFamily: "inherit" }}
                        />
                        <div style={{ display: "flex", gap: 10 }}>
                          <button type="button" onClick={saveDetail} disabled={!!savingKey}
                            style={{ padding: "5px 12px", borderRadius: 6, border: "none", background: "#1C004F", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                            {savingKey === r.key ? "Saving…" : "Save"}
                          </button>
                          <button type="button" onClick={() => setEditing(null)} disabled={!!savingKey}
                            style={{ background: "none", border: "none", color: MUTED, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
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
