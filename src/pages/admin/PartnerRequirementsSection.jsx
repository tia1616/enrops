// "What <partner> requires", on that partner's page in the Partner portal admin
// (Jessica, 2026-10-26; one page per partner since 2026-10-27). The partner's
// portal shows and counts only what is ticked here, so Happy Valley, which does
// not ask for a business license, is never told one is missing, and West Linn,
// which does, is. Written through set_partner_requirement (20261026a); the page
// owns the list (partner_requirements_for, which also holds the defaults) so the
// record above re-counts the moment a tick saves.
//
// The partner edits the SAME list on its own page (spec v3 H3, 20261119p):
// `viewer="partner"` words it for them. One owner: once the partner has changed
// it, the provider sees "Set by <partner>" and can no longer change it
// (`control` from partner_requirements_control decides; `canManage` is the
// caller's own role check on top).

import { useState } from "react";
import { setPartnerRequirement, setPartnerRequirementDetail } from "../../lib/partnerPortal.js";
import { REQUIREMENTS } from "../../lib/partnerPortalLogic.js";
import { formatDate } from "../../lib/providerDocumentLogic.js";

const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";

const GROUPS = [
  { kind: "business", title: "Your business", partnerTitle: "The business" },
  { kind: "instructor", title: "Each instructor at their sites", partnerTitle: "Each instructor at your sites" },
];

/**
 * `rows` = partner_requirements_for() rows, or null when they couldn't load.
 * `viewer` "provider" (default) or "partner"; `orgName` = the provider, for the
 * partner's wording; `control` = partner_requirements_control() row, null when
 * it couldn't load, undefined while loading. `onSaved()` after any saved
 * change, so the caller can re-read `control` (the first partner change
 * makes the list the partner's).
 */
export default function PartnerRequirementsSection({ partner, rows, canManage: roleCanManage, onChange, onSaved, viewer = "provider", orgName = "", control }) {
  const isPartner = viewer === "partner";
  // The database has the last word (control.can_edit); the caller's role check
  // only hides controls a refusal would follow anyway.
  const canManage = !!roleCanManage && !!control?.can_edit;
  const setByPartner = !!control?.set_by_partner;
  const setOn = control?.set_by_partner_on ? formatDate(control.set_by_partner_on) : "";
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
      onSaved?.();
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
      onSaved?.();
      setNote(isPartner
        ? `Saved. ${req.label} is ${next ? "now required" : "no longer required"}.`
        : `Saved. ${req.label} is ${next ? "now required" : "no longer required"} for ${partner.partner_name}.`);
    } catch (err) {
      setError(`That didn't save: ${err?.message ?? "unknown error"}`);
    } finally {
      setSavingKey("");
    }
  }

  return (
    <section style={{ marginTop: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: "16px 20px" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 700, color: INK }}>
        {isPartner ? `What you require from ${orgName || "this provider"}` : `What ${partner.partner_name} requires`}
      </h2>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
        {isPartner
          ? (setByPartner
              ? `This is your list. ${orgName || "The provider"} sees it and is reminded to keep these current.`
              : `${orgName || "The provider"} filled this in from your paperwork. Change anything that's wrong; once you do, the list is yours and only your admins can change it.`)
          : (setByPartner
              ? `${partner.partner_name} set this list themselves${setOn ? ` on ${setOn}` : ""}, so only they can change it.`
              : "Tick what's in their packet. Their portal shows and counts only these, so they're never told something is missing that they don't ask for.")}
      </p>

      {!rows || rows.length === 0 ? (
        <div role="alert" style={{ fontSize: 13, color: "#991b1b" }}>Couldn't load this partner's list just now. Refresh to try again.</div>
      ) : (
        <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
          {GROUPS.map((g) => (
            <fieldset key={g.kind} style={{ border: "none", padding: 0, margin: 0, minWidth: 220 }}>
              <legend style={{ fontSize: 12, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{isPartner ? g.partnerTitle : g.title}</legend>
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
                            {row?.detail ? "Edit details" : (isPartner ? "Add what you require" : "Add what they require")}
                          </button>
                        )}
                      </div>
                    )}
                    {open && (
                      <div style={{ marginLeft: 24, display: "grid", gap: 6, maxWidth: 360 }}>
                        <textarea
                          aria-label={isPartner ? `What you require for ${r.label}` : `What ${partner.partner_name} requires for ${r.label}`} rows={3} maxLength={600}
                          value={editing.detail} onChange={(e) => setEditing({ ...editing, detail: e.target.value })}
                          placeholder={`${isPartner ? "In your words" : "In their words"}, e.g. General liability $1M per occurrence / $2M aggregate`}
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
      {rows && rows.length > 0 && !canManage && control !== undefined && (
        // Each branch true in its state: the check failed (null); the partner
        // took it over (provider reading); a partner viewer login; a provider
        // role that isn't owner/admin. undefined = still loading: say nothing.
        <div style={{ marginTop: 8, fontSize: 12, color: MUTED }}>
          {control === null
            ? "Couldn't check who can change this list just now. Refresh to try again."
            : !isPartner && setByPartner
              ? `Only ${partner.partner_name} can change this list now.`
              : isPartner
                ? "Only your admin logins can change these."
                : "Only an owner or admin can change these."}
        </div>
      )}
    </section>
  );
}
