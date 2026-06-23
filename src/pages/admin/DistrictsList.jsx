// src/pages/admin/DistrictsList.jsx
// Admin management for the districts entity (the "home" for the redesign's
// "set up a district once, attach many schools" model). Create / rename /
// delete districts and see how many schools are attached. Schools are attached
// from each school's District field on the Locations tab; a district's academic
// calendar is set on the Calendars tab.
//
// Deleting a district unlinks its schools + calendars (FK ON DELETE SET NULL) —
// they fall back to the legacy free-text district for calendar matching.
//
// Multi-tenant: all reads + writes scoped by org from useOutletContext.
// Flyer-distribution rules + gatekeeper contacts (also on the districts table)
// are intentionally NOT surfaced here yet — a separate, product-shaped pass.

import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase";

const BRIGHT = "#5847C9";
const CORAL = "#D9694F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

export default function DistrictsList() {
  const { org } = useOutletContext() ?? {};
  const [districts, setDistricts] = useState([]); // [{ id, name, school_count }]
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [busyId, setBusyId] = useState(null); // 'new' | district id | null

  useEffect(() => {
    if (org?.id) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [dRes, lRes] = await Promise.all([
        supabase.from("districts").select("id, name").eq("organization_id", org.id).order("name", { ascending: true }),
        supabase.from("program_locations").select("district_id").eq("organization_id", org.id),
      ]);
      if (dRes.error) throw dRes.error;
      if (lRes.error) throw lRes.error;
      const counts = new Map();
      for (const r of lRes.data ?? []) {
        if (r.district_id) counts.set(r.district_id, (counts.get(r.district_id) ?? 0) + 1);
      }
      setDistricts((dRes.data ?? []).map((d) => ({ ...d, school_count: counts.get(d.id) ?? 0 })));
    } catch (e) {
      console.error("Load districts failed:", e);
      setError(`Couldn't load: ${e.message ?? "unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  // Case-insensitive duplicate check, matching the DB unique index. Lets us show
  // a friendly message instead of a raw constraint error.
  function dupExists(name, exceptId) {
    const n = name.trim().toLowerCase();
    return districts.some((d) => d.id !== exceptId && (d.name ?? "").trim().toLowerCase() === n);
  }

  async function createDistrict() {
    const name = newName.trim();
    if (!name) { setError("Enter a district name."); return; }
    if (dupExists(name, null)) { setError(`A district called "${name}" already exists.`); return; }
    setBusyId("new");
    setError(null);
    try {
      const { error: e } = await supabase.from("districts").insert({ organization_id: org.id, name });
      if (e) throw e;
      setNewName("");
      setCreating(false);
      await load();
    } catch (e) {
      console.error("Create district failed:", e);
      setError(`Couldn't add: ${e.message ?? "unknown error"}`);
    } finally {
      setBusyId(null);
    }
  }

  function startRename(d) {
    setEditingId(d.id);
    setEditName(d.name ?? "");
    setError(null);
  }

  async function saveRename(d) {
    const name = editName.trim();
    if (!name) { setError("District name can't be blank."); return; }
    if (dupExists(name, d.id)) { setError(`A district called "${name}" already exists.`); return; }
    setBusyId(d.id);
    setError(null);
    try {
      const { error: e } = await supabase.from("districts").update({ name }).eq("id", d.id);
      if (e) throw e;
      setEditingId(null);
      await load();
    } catch (e) {
      console.error("Rename district failed:", e);
      setError(`Couldn't rename: ${e.message ?? "unknown error"}`);
    } finally {
      setBusyId(null);
    }
  }

  async function deleteDistrict(d) {
    const msg = d.school_count > 0
      ? `Delete "${d.name}"? ${d.school_count} school${d.school_count === 1 ? "" : "s"} will be unlinked from it (they keep their legacy district field for calendar matching). This can't be undone.`
      : `Delete "${d.name}"? This can't be undone.`;
    if (!window.confirm(msg)) return;
    setBusyId(d.id);
    setError(null);
    try {
      const { error: e } = await supabase.from("districts").delete().eq("id", d.id);
      if (e) throw e;
      await load();
    } catch (e) {
      console.error("Delete district failed:", e);
      setError(`Couldn't delete: ${e.message ?? "unknown error"}`);
    } finally {
      setBusyId(null);
    }
  }

  if (!org) return <div style={{ color: MUTED, fontSize: 14 }}>Loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header style={headerBox}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.4 }}>Districts</h1>
          <div style={{ color: MUTED, marginTop: 4, fontSize: 14, maxWidth: 720 }}>
            Group schools under a district so its academic calendar applies to all
            of them at once. Attach schools from each school's <strong>District</strong>
            {" "}field on the Locations tab, then set the calendar on the Calendars tab.
          </div>
        </div>
        <button type="button" onClick={() => { setCreating(true); setError(null); }} disabled={creating} style={btn(BRIGHT, "#fff", false, creating)}>
          + Add district
        </button>
      </header>

      {error && <div style={errorBanner}>{error}</div>}

      {creating && (
        <div style={cardBox}>
          <label style={labelStyle}>New district name</label>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createDistrict();
                if (e.key === "Escape") { setCreating(false); setNewName(""); setError(null); }
              }}
              placeholder="e.g. Portland Public Schools"
              style={{ ...inputStyle, flex: 1 }}
            />
            <button type="button" onClick={createDistrict} disabled={busyId === "new"} style={btn(BRIGHT, "#fff", false, busyId === "new")}>
              {busyId === "new" ? "Adding…" : "Add"}
            </button>
            <button type="button" onClick={() => { setCreating(false); setNewName(""); setError(null); }} style={btn("transparent", MUTED, true)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ color: MUTED, fontSize: 14, padding: 16 }}>Loading districts…</div>
      ) : districts.length === 0 ? (
        <div style={emptyState}>
          No districts yet. Click <strong>+ Add district</strong>, or create one from a
          school's <strong>District</strong> field on the Locations tab.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {districts.map((d) => (
            <div key={d.id} style={rowBox}>
              {editingId === d.id ? (
                <div style={{ display: "flex", gap: 8, flex: 1, alignItems: "center" }}>
                  <input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveRename(d);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button type="button" onClick={() => saveRename(d)} disabled={busyId === d.id} style={btn(BRIGHT, "#fff", false, busyId === d.id)}>
                    {busyId === d.id ? "Saving…" : "Save"}
                  </button>
                  <button type="button" onClick={() => setEditingId(null)} style={btn("transparent", MUTED, true)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 17, fontWeight: 700, color: INK }}>{d.name}</div>
                    <div style={{ fontSize: 12.5, color: MUTED, marginTop: 2 }}>
                      {d.school_count} school{d.school_count === 1 ? "" : "s"} attached
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" onClick={() => startRename(d)} style={btn("transparent", BRIGHT, true)}>
                      Rename
                    </button>
                    <button type="button" onClick={() => deleteDistrict(d)} disabled={busyId === d.id} style={btn("transparent", CORAL, true, busyId === d.id)}>
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const headerBox = {
  background: "#fff",
  border: `1px solid ${RULE}`,
  borderRadius: 12,
  padding: "18px 22px",
  display: "flex",
  flexWrap: "wrap",
  gap: 16,
  alignItems: "center",
  justifyContent: "space-between",
};

const cardBox = {
  background: "#fff",
  border: `2px solid ${BRIGHT}`,
  borderRadius: 12,
  padding: "16px 20px",
};

const rowBox = {
  background: "#fff",
  border: `1px solid ${RULE}`,
  borderRadius: 8,
  padding: "14px 20px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
};

const emptyState = {
  background: "#fff",
  border: `1px dashed ${RULE}`,
  borderRadius: 12,
  padding: 36,
  textAlign: "center",
  color: MUTED,
  fontSize: 14,
};

const labelStyle = {
  fontSize: 12,
  fontWeight: 600,
  color: INK,
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const inputStyle = {
  padding: "8px 10px",
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  color: INK,
  background: "#fff",
  outline: "none",
  boxSizing: "border-box",
};

const errorBanner = {
  background: `${CORAL}1F`,
  border: `1px solid ${CORAL}`,
  borderRadius: 6,
  padding: "8px 12px",
  color: CORAL,
  fontWeight: 500,
  fontSize: 13,
};

function btn(bg, fg, outlined = false, disabled = false) {
  return {
    display: "inline-block",
    padding: "8px 14px",
    background: bg,
    color: fg,
    border: outlined ? `1px solid ${fg}` : "none",
    borderRadius: 6,
    cursor: disabled ? "default" : "pointer",
    fontSize: 14,
    fontWeight: 500,
    fontFamily: "inherit",
    opacity: disabled ? 0.5 : 1,
  };
}
