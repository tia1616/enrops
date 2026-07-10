// /admin/pay-rates — set what this org pays instructors per session.
//
// Writes the org's rate card into tenant_pay_rates (keyed by role +
// session_type). The pay-writing edge functions (confirm-session-taught,
// confirm-session-delivery, session-confirmation-cron, confirm-sub-delivery)
// read these amounts when an instructor's session is confirmed. A blank box =
// no configured rate → the admin sets that amount by hand on Payroll. Money
// surface: owner/admin only (RLS is admin-gated too).

import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";
import { usePermissions } from "../../lib/permissions.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const GREEN_BG = "#f0fdf4";
const GREEN_INK = "#166534";

const ROLES = [
  { key: "lead", label: "Lead" },
  { key: "developing", label: "Developing" },
];
const SESSION_TYPES = [
  { key: "morning", label: "Morning", sub: "half day" },
  { key: "afternoon", label: "Afternoon", sub: "half day" },
  { key: "full_day", label: "Full day", sub: "camp" },
  { key: "after_school", label: "After-school", sub: "per session" },
];

const cellKey = (role, sessionType) => `${role}|${sessionType}`;

// cents (int) -> dollars string for display, e.g. 8000 -> "80", 8050 -> "80.50"
function centsToDollars(cents) {
  if (cents == null) return "";
  const d = cents / 100;
  return Number.isInteger(d) ? String(d) : d.toFixed(2);
}

export default function PayRatesSettings() {
  const { org } = useOutletContext();
  const perm = usePermissions();
  // values: { `${role}|${session_type}`: dollarString }
  const [values, setValues] = useState({});
  const [saved, setSaved] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  function flash(msg) { setToast(msg); setTimeout(() => setToast(""), 3000); }

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      const { data, error: e } = await supabase
        .from("tenant_pay_rates")
        .select("role, session_type, amount_cents")
        .eq("organization_id", org.id);
      if (cancelled) return;
      if (e) {
        setError(e.message ?? "Couldn't load your pay rates.");
        setLoading(false);
        return;
      }
      const next = {};
      for (const r of data ?? []) {
        next[cellKey(r.role, r.session_type)] = centsToDollars(r.amount_cents);
      }
      setValues(next);
      setSaved(next);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  function setCell(role, sessionType, raw) {
    // Allow only digits + a single decimal point (dollars-and-cents entry).
    const clean = raw.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
    setValues((v) => ({ ...v, [cellKey(role, sessionType)]: clean }));
  }

  // A cell is invalid if it's non-empty but not a non-negative number.
  function invalidCells() {
    const bad = [];
    for (const role of ROLES) {
      for (const st of SESSION_TYPES) {
        const val = (values[cellKey(role.key, st.key)] ?? "").trim();
        if (val === "") continue;
        const n = Number(val);
        if (!Number.isFinite(n) || n < 0) bad.push(cellKey(role.key, st.key));
      }
    }
    return bad;
  }

  const dirty = ROLES.some((role) =>
    SESSION_TYPES.some((st) => {
      const k = cellKey(role.key, st.key);
      return (values[k] ?? "") !== (saved[k] ?? "");
    })
  );

  async function save() {
    const bad = invalidCells();
    if (bad.length) {
      setError("Enter a dollar amount (0 or more) or leave the box blank.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const toUpsert = [];
      const toDelete = []; // { role, session_type }
      const now = new Date().toISOString();
      for (const role of ROLES) {
        for (const st of SESSION_TYPES) {
          const k = cellKey(role.key, st.key);
          const val = (values[k] ?? "").trim();
          if (val === "") {
            // Only bother deleting if it previously had a value.
            if ((saved[k] ?? "") !== "") toDelete.push({ role: role.key, session_type: st.key });
          } else {
            toUpsert.push({
              organization_id: org.id,
              role: role.key,
              session_type: st.key,
              amount_cents: Math.round(Number(val) * 100),
              updated_at: now,
            });
          }
        }
      }
      if (toUpsert.length) {
        const { error: e } = await supabase
          .from("tenant_pay_rates")
          .upsert(toUpsert, { onConflict: "organization_id,role,session_type" });
        if (e) throw e;
      }
      for (const d of toDelete) {
        const { error: e } = await supabase
          .from("tenant_pay_rates")
          .delete()
          .eq("organization_id", org.id)
          .eq("role", d.role)
          .eq("session_type", d.session_type);
        if (e) throw e;
      }
      // Snapshot the values we just persisted, normalized through the cents
      // round-trip so the display cleans up (e.g. "80." -> "80").
      const nextSaved = {};
      for (const role of ROLES) {
        for (const st of SESSION_TYPES) {
          const k = cellKey(role.key, st.key);
          const val = (values[k] ?? "").trim();
          if (val !== "") nextSaved[k] = centsToDollars(Math.round(Number(val) * 100));
        }
      }
      setValues(nextSaved);
      setSaved(nextSaved);
      flash("Pay rates saved.");
    } catch (e) {
      setError(e.message ?? "Couldn't save your pay rates.");
    } finally {
      setSaving(false);
    }
  }

  // Belt-and-suspenders: money surface. The layout nav also gates this route,
  // but block direct access for non-admins.
  if (!perm.canHandleMoney) {
    return (
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "8px 0 40px" }}>
        <Link to="/admin/settings" style={{ fontSize: 13, color: MUTED, textDecoration: "none" }}>← Settings</Link>
        <div style={{ marginTop: 20, padding: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, color: MUTED, fontSize: 14 }}>
          Pay rates aren't available for your role.
        </div>
      </div>
    );
  }

  if (loading) {
    return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>;
  }

  const bad = new Set(invalidCells());

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "8px 0 40px" }}>
      <Link to="/admin/settings" style={{ fontSize: 13, color: MUTED, textDecoration: "none" }}>← Settings</Link>
      <h1 style={{ margin: "8px 0 4px", color: PURPLE, fontSize: 24, fontWeight: 700 }}>Pay rates</h1>
      <p style={{ color: MUTED, fontSize: 14, marginTop: 0, lineHeight: 1.5, maxWidth: 560 }}>
        What you pay instructors for each session. When an instructor's session is confirmed, Enrops
        fills in the amount from here so payroll adds up automatically. Leave a box blank and you'll set
        that amount by hand on the Payroll screen instead.
      </p>

      {error && <div style={{ marginTop: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}
      {toast && <div style={{ marginTop: 16, padding: "10px 12px", background: GREEN_BG, border: "1px solid #bbf7d0", borderRadius: 8, color: GREEN_INK, fontSize: 13 }}>{toast}</div>}

      <div style={{ marginTop: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 12, alignItems: "end" }}>
          <div />
          {ROLES.map((role) => (
            <div key={role.key} style={{ fontSize: 13, fontWeight: 700, color: PURPLE, textAlign: "left" }}>{role.label}</div>
          ))}

          {SESSION_TYPES.map((st) => (
            <FragmentRow key={st.key} st={st} bad={bad} values={values} setCell={setCell} />
          ))}
        </div>

        <div style={hint}>
          Amounts are per instructor, per session. Morning and Afternoon are half-day camp sessions;
          Full day is a full camp day; After-school is one after-school session.
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
          <button type="button" onClick={save} disabled={saving || !dirty} style={primaryBtn(saving || !dirty)}>
            {saving ? "Saving…" : dirty ? "Save" : "Saved ✓"}
          </button>
        </div>
      </div>
    </div>
  );
}

// One session-type row: label cell + a dollar input per role.
function FragmentRow({ st, bad, values, setCell }) {
  return (
    <>
      <div style={{ paddingBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>{st.label}</div>
        <div style={{ fontSize: 12, color: MUTED }}>{st.sub}</div>
      </div>
      {ROLES.map((role) => {
        const k = cellKey(role.key, st.key);
        const isBad = bad.has(k);
        return (
          <div key={role.key} style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: MUTED, fontSize: 14, pointerEvents: "none" }}>$</span>
            <input
              type="text"
              inputMode="decimal"
              value={values[k] ?? ""}
              onChange={(e) => setCell(role.key, st.key, e.target.value)}
              placeholder="—"
              aria-label={`${role.label} ${st.label} pay`}
              style={{ ...input, paddingLeft: 22, borderColor: isBad ? "#dc2626" : RULE }}
            />
          </div>
        );
      })}
    </>
  );
}

const hint = { fontSize: 12.5, color: MUTED, marginTop: 14, lineHeight: 1.5 };
const input = { width: "100%", padding: "10px 12px", border: `1.5px solid ${RULE}`, borderRadius: 8, fontSize: 14, color: INK, background: "#fff", fontFamily: "inherit", boxSizing: "border-box" };
function primaryBtn(disabled) { return { padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
