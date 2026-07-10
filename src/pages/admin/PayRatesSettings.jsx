// /admin/pay-rates — set what this org pays instructors per session.
//
// Writes the org's rate card into tenant_pay_rates (keyed by role +
// session_type). The pay-writing edge functions (confirm-session-taught,
// confirm-session-delivery, session-confirmation-cron, confirm-sub-delivery)
// read these amounts when an instructor's session is confirmed. A blank box =
// no configured rate → the admin sets that amount by hand on Payroll. Money
// surface: owner/admin only (RLS is admin-gated too).
//
// UI grouping vs DB shape: the DB stores camp session_types morning/afternoon
// separately, but they pay the same half-day rate, so the UI shows a single
// "Half day" input that writes to BOTH morning + afternoon. The confirm
// functions look pay up by the real session_type, so both rows must exist.

import { Fragment, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";
import { usePermissions } from "../../lib/permissions.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const LAVENDER = "#F2F0FF";
const GREEN_BG = "#f0fdf4";
const GREEN_INK = "#166534";

const ROLES = [
  { key: "lead", label: "Lead" },
  { key: "developing", label: "Developing" },
];

// Boxed groups. After-school on top, then Camps. "Half day" writes to both
// morning + afternoon (same rate); the confirm functions look pay up by the
// real session_type so both DB rows must exist.
const GROUPS = [
  { title: "After-school", rows: [
    { key: "after_school", label: "Per session", dbTypes: ["after_school"] },
  ] },
  { title: "Camps", rows: [
    { key: "half_day", label: "Half day", dbTypes: ["morning", "afternoon"] },
    { key: "full_day", label: "Full day", dbTypes: ["full_day"] },
  ] },
];
const ALL_ROWS = GROUPS.flatMap((g) => g.rows);

const cellKey = (role, rowKey) => `${role}|${rowKey}`;

// cents (int) -> dollars string for display, e.g. 8000 -> "80", 8050 -> "80.50"
function centsToDollars(cents) {
  if (cents == null) return "";
  const d = cents / 100;
  return Number.isInteger(d) ? String(d) : d.toFixed(2);
}

export default function PayRatesSettings() {
  const { org } = useOutletContext();
  const perm = usePermissions();
  // values: { `${role}|${rowKey}`: dollarString } where rowKey is a UI row
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
      // Index DB rows, then map each UI row to its first DB session_type
      // (morning drives the Half day box; morning/afternoon are kept in sync).
      const dbMap = {};
      for (const r of data ?? []) dbMap[`${r.role}|${r.session_type}`] = centsToDollars(r.amount_cents);
      const next = {};
      for (const role of ROLES) {
        for (const row of ALL_ROWS) {
          const v = dbMap[`${role.key}|${row.dbTypes[0]}`];
          if (v != null && v !== "") next[cellKey(role.key, row.key)] = v;
        }
      }
      setValues(next);
      setSaved(next);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  function setCell(role, rowKey, raw) {
    // Allow only digits + a single decimal point (dollars-and-cents entry).
    const clean = raw.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
    setValues((v) => ({ ...v, [cellKey(role, rowKey)]: clean }));
  }

  // A cell is invalid if it's non-empty but not a non-negative number.
  function invalidCells() {
    const bad = [];
    for (const role of ROLES) {
      for (const row of ALL_ROWS) {
        const val = (values[cellKey(role.key, row.key)] ?? "").trim();
        if (val === "") continue;
        const n = Number(val);
        if (!Number.isFinite(n) || n < 0) bad.push(cellKey(role.key, row.key));
      }
    }
    return bad;
  }

  const dirty = ROLES.some((role) =>
    ALL_ROWS.some((row) => {
      const k = cellKey(role.key, row.key);
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
        for (const row of ALL_ROWS) {
          const k = cellKey(role.key, row.key);
          const val = (values[k] ?? "").trim();
          // Expand each UI row to its DB session_types (Half day -> morning+afternoon).
          for (const st of row.dbTypes) {
            if (val === "") {
              if ((saved[k] ?? "") !== "") toDelete.push({ role: role.key, session_type: st });
            } else {
              toUpsert.push({
                organization_id: org.id,
                role: role.key,
                session_type: st,
                amount_cents: Math.round(Number(val) * 100),
                updated_at: now,
              });
            }
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
        for (const row of ALL_ROWS) {
          const k = cellKey(role.key, row.key);
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
        What you pay instructors, per session. When a session is confirmed, Enrops fills in the amount
        from here so payroll adds up automatically. Leave a box blank and you'll set that amount by hand
        on the Payroll screen instead.
      </p>

      {error && <div style={{ marginTop: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}
      {toast && <div style={{ marginTop: 16, padding: "10px 12px", background: GREEN_BG, border: "1px solid #bbf7d0", borderRadius: 8, color: GREEN_INK, fontSize: 13 }}>{toast}</div>}

      <div style={{ marginTop: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 12, alignItems: "end" }}>
          <div />
          {ROLES.map((role) => (
            <div key={role.key} style={{ fontSize: 13, fontWeight: 700, color: PURPLE, textAlign: "left" }}>{role.label}</div>
          ))}

          {GROUPS.map((group) => (
            <Fragment key={group.title}>
              <div style={groupHeader}>{group.title}</div>
              {group.rows.map((row) => (
                <RateRow key={row.key} row={row} bad={bad} values={values} setCell={setCell} />
              ))}
            </Fragment>
          ))}
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

// One rate row: label cell + a dollar input per role.
function RateRow({ row, bad, values, setCell }) {
  return (
    <>
      <div style={{ paddingBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>{row.label}</div>
        {row.sub && <div style={{ fontSize: 12, color: MUTED }}>{row.sub}</div>}
      </div>
      {ROLES.map((role) => {
        const k = cellKey(role.key, row.key);
        const isBad = bad.has(k);
        return (
          <div key={role.key} style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: MUTED, fontSize: 14, pointerEvents: "none" }}>$</span>
            <input
              type="text"
              inputMode="decimal"
              value={values[k] ?? ""}
              onChange={(e) => setCell(role.key, row.key, e.target.value)}
              placeholder="—"
              aria-label={`${role.label} ${row.label} pay`}
              style={{ ...input, paddingLeft: 22, borderColor: isBad ? "#dc2626" : RULE }}
            />
          </div>
        );
      })}
    </>
  );
}

const groupHeader = { gridColumn: "1 / -1", background: LAVENDER, color: PURPLE, fontSize: 13, fontWeight: 700, padding: "8px 12px", borderRadius: 8, marginTop: 6 };
const input = { width: "100%", padding: "10px 12px", border: `1.5px solid ${RULE}`, borderRadius: 8, fontSize: 14, color: INK, background: "#fff", fontFamily: "inherit", boxSizing: "border-box" };
function primaryBtn(disabled) { return { padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
