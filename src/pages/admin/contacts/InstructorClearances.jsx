// "Other clearances" on an instructor's record: statuses from outside enrops
// (spec v3 P3 "Add a status from another source"; instructor_clearances,
// 20261103a). A district fingerprint clearance, the Oregon CBR, a WA DCYF
// portable check, a check run by a screening
// company (never named to partners), or another agency. Status only: who,
// what kind, scope, completed, expires. Partners see these on the instructor's
// row once the instructor has agreed to share; a current background check from
// another source counts for the background-check column.
//
// Owner/admin only (add_/remove_instructor_clearance enforce it).

import { useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { addInstructorClearance, listAgencyNames, listInstructorClearances, removeInstructorClearance } from "../../../lib/partnerPortal.js";
import { CHECK_TYPES, CLEARANCE_BODIES, clearanceLabel } from "../../../lib/partnerPortalLogic.js";
import { formatDate } from "../../../lib/providerDocumentLogic.js";
import { usePermissions } from "../../../lib/permissions.js";

const PURPLE = "#1C004F";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

const input = { padding: "6px 8px", borderRadius: 6, border: `1px solid ${RULE}`, fontSize: 13, fontFamily: "inherit", width: "100%", boxSizing: "border-box" };
const linkBtn = { background: "transparent", border: "none", color: PURPLE, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", padding: 0, textDecoration: "underline" };

const EMPTY = { clearance_body: "", clearance_body_other: "", check_type: "", item_name: "", scope: "", completed_on: "", expires_on: "" };

/** Why the form can't be saved yet, or null. */
export function clearanceFormProblem(f) {
  if (!f.clearance_body) return "Choose who cleared them.";
  if (f.clearance_body === "other" && !f.clearance_body_other.trim()) return "Name the agency.";
  if (!f.check_type) return "Choose the kind of check.";
  if (f.check_type === "training" && !f.item_name.trim()) return "Name the training.";
  if (!f.completed_on) return "Add the date it was completed.";
  if (f.expires_on && f.expires_on < f.completed_on) return "The expiry can't be before the completed date.";
  return null;
}

export default function InstructorClearances({ instructorId }) {
  const perm = usePermissions();
  const canManage = perm.canManageSettings;
  const { org } = useOutletContext() ?? {};
  // Agencies this provider typed before, offered under "Another agency".
  const [agencies, setAgencies] = useState([]);
  const [list, setList] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState(null); // null = closed
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listInstructorClearances(instructorId)
      .then((l) => { if (!cancelled) setList(l); })
      .catch((e) => { if (!cancelled) { setList([]); setError(`Couldn't load: ${e?.message ?? "unknown error"}`); } });
    return () => { cancelled = true; };
  }, [instructorId]);

  // Read when the form opens, so a name typed for another instructor a
  // minute ago is already offered.
  useEffect(() => {
    let cancelled = false;
    if (form && org?.id) listAgencyNames(org.id).then((n) => { if (!cancelled) setAgencies(n); });
    return () => { cancelled = true; };
  }, [form !== null, org?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refresh() {
    setList(await listInstructorClearances(instructorId));
  }

  async function save() {
    if (busy.current) return;
    const problem = clearanceFormProblem(form);
    if (problem) { setError(problem); return; }
    busy.current = true; setSaving(true); setError("");
    try {
      await addInstructorClearance(instructorId, form);
      setForm(null);
      await refresh().catch(() => setError("Saved. Refresh to see it."));
    } catch (e) {
      setError(e?.message || "Couldn't save. Try again.");
    } finally {
      busy.current = false; setSaving(false);
    }
  }

  async function remove(c) {
    if (busy.current) return;
    if (!window.confirm(`Remove ${clearanceLabel(c)} (completed ${formatDate(c.completed_on)})? Partners stop seeing it.`)) return;
    busy.current = true; setError("");
    try {
      await removeInstructorClearance(c.id);
      await refresh();
    } catch (e) {
      setError(e?.message || "Couldn't remove. Try again.");
    } finally {
      busy.current = false;
    }
  }

  if (list === null) return <div style={{ color: MUTED, fontSize: 12 }}>Loading…</div>;

  return (
    <div>
      {list.length === 0 && !form && <div style={{ color: MUTED, fontStyle: "italic" }}>none entered</div>}
      {list.map((c) => (
        <div key={c.id} style={{ marginBottom: 4 }}>
          {clearanceLabel(c)}
          <div style={{ color: MUTED, fontSize: 12 }}>
            Completed {formatDate(c.completed_on)}{c.expires_on ? ` · Renews ${formatDate(c.expires_on)}` : " · No expiry"}
            {c.scope ? ` · ${c.scope}` : ""}
            {canManage && <> · <button type="button" style={linkBtn} onClick={() => remove(c)}>Remove</button></>}
          </div>
        </div>
      ))}

      {form ? (
        <div style={{ display: "grid", gap: 6, marginTop: 6, padding: 10, border: `1px solid ${RULE}`, borderRadius: 8, background: "#fff" }}>
          <select
            aria-label="Who cleared them" value={form.clearance_body} style={input}
            onChange={(e) => {
              const body = CLEARANCE_BODIES.find((b) => b.key === e.target.value);
              setForm({ ...form, clearance_body: e.target.value, check_type: form.check_type || body?.type || "" });
              setError("");
            }}
          >
            <option value="" disabled>Who cleared them?</option>
            {CLEARANCE_BODIES.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
          </select>
          {form.clearance_body === "other" && (
            <>
              <input aria-label="Agency name" placeholder="Agency name, e.g. Portland Public Schools" maxLength={80} value={form.clearance_body_other} style={input}
                list={`agencies-${instructorId}`}
                onChange={(e) => setForm({ ...form, clearance_body_other: e.target.value })} />
              <datalist id={`agencies-${instructorId}`}>
                {agencies.map((a) => <option key={a} value={a} />)}
              </datalist>
            </>
          )}
          <select aria-label="Kind of check" value={form.check_type} style={input} onChange={(e) => setForm({ ...form, check_type: e.target.value })}>
            <option value="" disabled>Kind of check</option>
            {CHECK_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          {form.check_type === "training" && (
            <input aria-label="Training name" placeholder="Training name, e.g. Pepper training" maxLength={120} value={form.item_name} style={input}
              onChange={(e) => setForm({ ...form, item_name: e.target.value })} />
          )}
          <input aria-label="Scope" placeholder="Scope, as the source states it (optional)" maxLength={200} value={form.scope} style={input}
            onChange={(e) => setForm({ ...form, scope: e.target.value })} />
          <label style={{ fontSize: 12, color: MUTED }}>Completed
            <input type="date" value={form.completed_on} style={input} onChange={(e) => setForm({ ...form, completed_on: e.target.value })} />
          </label>
          <label style={{ fontSize: 12, color: MUTED }}>Expires (leave empty if it doesn't)
            <input type="date" value={form.expires_on} style={input} onChange={(e) => setForm({ ...form, expires_on: e.target.value })} />
          </label>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button type="button" onClick={save} disabled={saving}
              style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: PURPLE, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" style={linkBtn} disabled={saving} onClick={() => { setForm(null); setError(""); }}>Cancel</button>
          </div>
        </div>
      ) : (
        canManage && <button type="button" style={{ ...linkBtn, display: "block", marginTop: 4 }} onClick={() => setForm({ ...EMPTY })}>Add a status from another source →</button>
      )}
      {error && <div role="alert" style={{ color: "#991b1b", fontSize: 12, marginTop: 4 }}>{error}</div>}
    </div>
  );
}
