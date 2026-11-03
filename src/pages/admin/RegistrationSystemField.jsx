// "Where do you register families?" (spec v3 P2), on the provider's Partner
// portal page. One answer for the whole record: partners read it as plain text
// on the provider's page, and any system works (the record never depends on
// enrops registration). Stored in provider_record_settings (20261103a), written
// through set_registration_system (owner/admin; audited).

import { useEffect, useState } from "react";
import { getRecordSettings, setRegistrationSystem } from "../../lib/partnerPortal.js";
import { REGISTRATION_SYSTEMS } from "../../lib/partnerPortalLogic.js";

const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const GREEN_INK = "#166534";

export default function RegistrationSystemField({ orgId, canManage }) {
  const [saved, setSaved] = useState(undefined); // undefined = loading
  const [system, setSystem] = useState("");
  const [other, setOther] = useState("");
  const [status, setStatus] = useState({ kind: "", text: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getRecordSettings(orgId).then((s) => {
      if (cancelled) return;
      setSaved(s);
      setSystem(s?.registration_system ?? "");
      setOther(s?.registration_system_other ?? "");
    });
    return () => { cancelled = true; };
  }, [orgId]);

  if (saved === undefined) return null;

  const dirty = system !== (saved?.registration_system ?? "") || (system === "other" && other.trim() !== (saved?.registration_system_other ?? ""));
  const valid = system && (system !== "other" || (other.trim().length > 0 && other.trim().length <= 80));

  async function save() {
    if (!valid || saving) return;
    setSaving(true);
    setStatus({ kind: "", text: "" });
    try {
      await setRegistrationSystem(orgId, system, system === "other" ? other.trim() : null);
      const next = { registration_system: system, registration_system_other: system === "other" ? other.trim() : null };
      setSaved(next);
      setStatus({ kind: "ok", text: "Saved." });
    } catch (e) {
      setStatus({ kind: "err", text: e?.message || "Couldn't save. Try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: 16, padding: "14px 16px", background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12 }}>
      <label htmlFor="registration-system" style={{ display: "block", fontSize: 14, fontWeight: 600, color: INK }}>
        Where do you register families?
      </label>
      <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>Any system works. Your record does not depend on it.</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 8 }}>
        <select
          id="registration-system" value={system} disabled={!canManage || saving}
          onChange={(e) => { setSystem(e.target.value); setStatus({ kind: "", text: "" }); }}
          style={{ padding: "7px 10px", borderRadius: 8, border: `1px solid ${RULE}`, fontSize: 14, fontFamily: "inherit" }}
        >
          <option value="" disabled>Choose one</option>
          {REGISTRATION_SYSTEMS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        {system === "other" && (
          <input
            aria-label="Name of the system" value={other} maxLength={80} disabled={!canManage || saving}
            onChange={(e) => { setOther(e.target.value); setStatus({ kind: "", text: "" }); }}
            placeholder="Name of the system"
            style={{ padding: "7px 10px", borderRadius: 8, border: `1px solid ${RULE}`, fontSize: 14, fontFamily: "inherit" }}
          />
        )}
        {canManage && dirty && (
          <button
            type="button" onClick={save} disabled={!valid || saving}
            style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "#1C004F", color: "#fff", fontSize: 14, fontWeight: 600, cursor: valid ? "pointer" : "default", opacity: valid ? 1 : 0.5, fontFamily: "inherit" }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
        {status.text && (
          <span role={status.kind === "err" ? "alert" : "status"} style={{ fontSize: 13, color: status.kind === "err" ? "#991b1b" : GREEN_INK }}>{status.text}</span>
        )}
      </div>
    </div>
  );
}
