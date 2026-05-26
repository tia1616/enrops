// src/pages/admin/Rosters.jsx
// /admin/rosters — list every camp in the active scheduling cycle with
// its current_enrollment (from camp_sessions) and the per-camper roster
// count in Enrops (from registrations linked via camp_session_id).
// Per-camp "Upload roster" opens a modal with two paths:
//   1. CSV upload with column mapping
//   2. Manual single-camper entry
//
// Multi-tenant: org from outlet context. RLS on registrations + students
// limits everything to the operator's org.

import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase";

const PURPLE = "#1C004F";
const VIOLET = "#8C88FF";
const CREAM = "#FBFBFB";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const OK = "#3a7c3a";
const AMBER = "#b67e00";
const RED = "#b53737";

function fmtDate(d) {
  if (!d) return "";
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Column-name auto-mapping. Keys are normalized header (lowercase, no
// non-alpha), values are the target field name. First match wins. Aliases
// cover common Squarespace + Google Forms + spreadsheet header variants.
const FIELD_DEFS = [
  { key: "student_first_name", label: "Camper first name", required: true,
    aliases: ["camperfirstname", "studentfirstname", "childfirstname", "firstname", "first"] },
  { key: "student_last_name", label: "Camper last name", required: false,
    aliases: ["camperlastname", "studentlastname", "childlastname", "lastname", "last", "surname"] },
  { key: "grade", label: "Grade", required: false,
    aliases: ["grade", "gradelevel", "currentgrade", "school grade"] },
  { key: "birthdate", label: "Birthdate", required: false,
    aliases: ["birthdate", "dob", "dateofbirth", "birthday"] },
  { key: "pronouns", label: "Pronouns", required: false,
    aliases: ["pronouns"] },
  { key: "allergies", label: "Allergies", required: false,
    aliases: ["allergies", "allergy", "foodallergies"] },
  { key: "dietary_restrictions", label: "Dietary restrictions", required: false,
    aliases: ["dietary", "dietaryrestrictions", "dietneeds", "foodrestrictions"] },
  { key: "medical_notes", label: "Medical notes", required: false,
    aliases: ["medicalnotes", "medicalinfo", "medicalconcerns"] },
  { key: "medical_conditions", label: "Medical conditions", required: false,
    aliases: ["medicalconditions"] },
  { key: "epipen_required", label: "EpiPen required (Y/N)", required: false,
    aliases: ["epipen", "epipenrequired", "carriesepipen"] },
  { key: "medications_at_program", label: "Medications at program", required: false,
    aliases: ["medications", "medicationsatprogram", "meds"] },
  { key: "emergency_contact_name", label: "Emergency contact name", required: false,
    aliases: ["emergencycontactname", "emergencyname", "emergencycontact"] },
  { key: "emergency_contact_phone", label: "Emergency contact phone", required: false,
    aliases: ["emergencycontactphone", "emergencyphone"] },
  { key: "special_needs_accommodations", label: "Accommodations", required: false,
    aliases: ["accommodations", "specialneeds", "specialneedsaccommodations"] },
  { key: "photo_release_consent", label: "Photo release (Y/N)", required: false,
    aliases: ["photorelease", "photoconsent", "photoreleaseconsent"] },
  { key: "authorized_pickup_contacts", label: "Authorized pickup", required: false,
    aliases: ["authorizedpickup", "authorizedpickupcontacts", "pickupcontacts", "pickuplist"] },
  { key: "notes", label: "Notes", required: false,
    aliases: ["notes", "parentnotes", "comments"] },
  { key: "parent_first_name", label: "Parent first name", required: false,
    aliases: ["parentfirstname", "guardianfirstname", "parentfirst"] },
  { key: "parent_last_name", label: "Parent last name", required: false,
    aliases: ["parentlastname", "guardianlastname", "parentlast"] },
  { key: "parent_email", label: "Parent email", required: false,
    aliases: ["parentemail", "guardianemail", "email", "emailaddress"] },
  { key: "parent_phone", label: "Parent phone", required: false,
    aliases: ["parentphone", "guardianphone", "phone", "phonenumber"] },
];

function normalizeHeader(h) {
  return (h || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function autoMap(headers) {
  const map = {};
  const normHeaders = headers.map(normalizeHeader);
  for (const def of FIELD_DEFS) {
    for (const alias of def.aliases) {
      const idx = normHeaders.indexOf(normalizeHeader(alias));
      if (idx !== -1) {
        map[def.key] = headers[idx];
        break;
      }
    }
  }
  return map;
}

// Tiny CSV parser. Handles quoted fields with embedded commas + escaped
// quotes (""), CRLF/LF row endings. Plenty for Squarespace / Google
// Sheets exports.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* swallow */ }
      else field += c;
    }
  }
  // Tail row
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  // Strip trailing empty row a final newline produces.
  if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }
  if (rows.length === 0) return { headers: [], data: [] };
  const headers = rows[0];
  const data = rows.slice(1).filter((r) => r.some((c) => c !== ""));
  return { headers, data };
}

export default function Rosters() {
  const { org } = useOutletContext() ?? {};
  const [camps, setCamps] = useState(null); // null = loading
  const [error, setError] = useState("");
  const [uploadingFor, setUploadingFor] = useState(null); // camp_session row

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setCamps(null);
      setError("");
      try {
        // 1. Fetch camps for the org. Could scope to active cycle but
        //    showing everything is simpler + lets operator backfill past
        //    camps if needed.
        const { data: campRows, error: cErr } = await supabase
          .from("camp_sessions")
          .select("id, curriculum_name, starts_on, ends_on, location_name, week_num, session_type, current_enrollment")
          .eq("organization_id", org.id)
          .order("starts_on", { ascending: true });
        if (cErr) throw cErr;
        if (cancelled) return;

        // 2. Per-camp roster count.
        const ids = (campRows ?? []).map((c) => c.id);
        const rosterCounts = new Map();
        if (ids.length > 0) {
          const { data: rosterRows } = await supabase
            .from("registrations")
            .select("camp_session_id")
            .in("camp_session_id", ids);
          for (const r of rosterRows ?? []) {
            rosterCounts.set(r.camp_session_id, (rosterCounts.get(r.camp_session_id) ?? 0) + 1);
          }
        }

        if (!cancelled) {
          setCamps(
            (campRows ?? []).map((c) => ({
              ...c,
              roster_count: rosterCounts.get(c.id) ?? 0,
            }))
          );
        }
      } catch (e) {
        console.error("[Rosters] load failed", e);
        if (!cancelled) {
          setError(e.message ?? "Couldn't load camps.");
          setCamps([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  return (
    <div>
      <header style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.3 }}>
          Rosters
        </h1>
        <p style={{ color: MUTED, marginTop: 6, fontSize: 14 }}>
          Upload per-camper data so your instructors see names, allergies, emergency contacts when they open a camp.
        </p>
      </header>

      {error && (
        <div style={{ background: `${RED}1A`, color: RED, padding: 12, borderRadius: 6, fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {camps === null && <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>}

      {camps !== null && camps.length === 0 && !error && (
        <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: 28, color: MUTED, textAlign: "center" }}>
          No camps in this org yet.
        </div>
      )}

      {camps !== null && camps.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {camps.map((c) => (
            <CampRow
              key={c.id}
              camp={c}
              onUpload={() => setUploadingFor(c)}
              orgId={org?.id}
              onRosterChanged={() => {
                // Re-fetch this camp's roster_count after an edit/delete
                // by triggering a top-level reload. Cheap and simple.
                if (!org?.id) return;
                supabase
                  .from("registrations")
                  .select("camp_session_id", { count: "exact", head: true })
                  .eq("camp_session_id", c.id)
                  .then(({ count }) => {
                    setCamps((cs) => (cs ?? []).map((cc) => cc.id === c.id ? { ...cc, roster_count: count ?? 0 } : cc));
                  });
              }}
            />
          ))}
        </div>
      )}

      {uploadingFor && (
        <RosterUploadModal
          camp={uploadingFor}
          onClose={() => setUploadingFor(null)}
          onImported={(summary) => {
            // Bump roster_count optimistically so the operator sees it
            // change before a reload.
            setCamps((cs) => (cs ?? []).map((c) =>
              c.id === uploadingFor.id
                ? { ...c, roster_count: c.roster_count + (summary.imported ?? 0) }
                : c
            ));
          }}
        />
      )}
    </div>
  );
}

function CampRow({ camp, onUpload, orgId, onRosterChanged }) {
  const [expanded, setExpanded] = useState(false);
  const gap = (camp.current_enrollment ?? 0) - (camp.roster_count ?? 0);
  return (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderLeft: camp.roster_count > 0 ? `3px solid ${OK}` : `3px solid ${RULE}`,
        borderRadius: 8,
        padding: "12px 16px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            minWidth: 0,
            flex: "1 1 220px",
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: camp.roster_count > 0 ? "pointer" : "default",
            textAlign: "left",
            fontFamily: "inherit",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: INK, lineHeight: 1.3, display: "flex", alignItems: "center", gap: 6 }}>
            {camp.roster_count > 0 && (
              <span style={{ color: PURPLE, fontSize: 12, fontWeight: 700 }}>{expanded ? "▾" : "▸"}</span>
            )}
            <span>
              {camp.curriculum_name}
              {camp.week_num && (
                <span style={{ color: MUTED, marginLeft: 6, fontSize: 12, fontWeight: 400 }}>
                  · Week {camp.week_num}
                </span>
              )}
            </span>
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2, paddingLeft: camp.roster_count > 0 ? 18 : 0 }}>
            {fmtDate(camp.starts_on)}–{fmtDate(camp.ends_on)}
            {camp.location_name && ` · ${camp.location_name}`}
            {camp.session_type && ` · ${camp.session_type.replace("_", " ")}`}
          </div>
        </button>

        <div style={{ textAlign: "right", minWidth: 180 }}>
          <div style={{ fontSize: 12, color: INK, lineHeight: 1.4 }}>
            <strong>{camp.roster_count}</strong> in roster
            {camp.current_enrollment != null && (
              <span style={{ color: gap > 0 ? AMBER : MUTED, marginLeft: 6 }}>
                · {camp.current_enrollment} enrolled
                {gap > 0 && ` (${gap} missing)`}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onUpload}
            style={{
              marginTop: 6,
              padding: "6px 12px",
              background: PURPLE,
              color: "#fff",
              border: "none",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            Upload roster →
          </button>
        </div>
      </div>

      {expanded && camp.roster_count > 0 && (
        <RosterEditor
          campSessionId={camp.id}
          orgId={orgId}
          onChanged={onRosterChanged}
        />
      )}
    </div>
  );
}

function RosterEditor({ campSessionId, orgId, onChanged }) {
  const [campers, setCampers] = useState(null); // null = loading
  const [editingId, setEditingId] = useState(null);
  const [err, setErr] = useState("");

  async function load() {
    setErr("");
    setCampers(null);
    const { data, error } = await supabase
      .from("registrations")
      .select(`
        id, status, notes, authorized_pickup_contacts, photo_release_consent,
        student:students (
          id, first_name, last_name, grade, birthdate, pronouns,
          allergies, dietary_restrictions, medical_notes, medical_conditions,
          epipen_required, medications_at_program,
          emergency_contact_name, emergency_contact_phone,
          special_needs_accommodations
        )
      `)
      .eq("camp_session_id", campSessionId)
      .order("registered_at", { ascending: true });
    if (error) {
      console.error("[RosterEditor] load failed", error);
      setErr("Couldn't load the roster. Refresh.");
      setCampers([]);
      return;
    }
    setCampers(data ?? []);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campSessionId]);

  return (
    <div style={{ marginTop: 12, borderTop: `1px solid ${RULE}`, paddingTop: 10 }}>
      {err && (
        <div style={{ background: `${RED}1A`, color: RED, padding: 8, borderRadius: 6, marginBottom: 8, fontSize: 12 }}>
          {err}
        </div>
      )}

      {campers === null && (
        <div style={{ color: MUTED, fontSize: 12 }}>Loading roster…</div>
      )}

      {campers !== null && campers.length === 0 && (
        <div style={{ color: MUTED, fontSize: 12 }}>No campers yet.</div>
      )}

      {campers !== null && campers.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {campers.map((reg) => (
            <CamperEditableRow
              key={reg.id}
              registration={reg}
              isEditing={editingId === reg.id}
              onToggleEdit={() => setEditingId((cur) => (cur === reg.id ? null : reg.id))}
              orgId={orgId}
              onSaved={() => {
                setEditingId(null);
                load();
                if (onChanged) onChanged();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CamperEditableRow({ registration, isEditing, onToggleEdit, orgId, onSaved }) {
  const s = registration.student;
  if (!s) return null;
  const displayName = `${s.first_name ?? ""} ${s.last_name ?? ""}`.trim() || "Unnamed";
  const hasAllergies = (s.allergies ?? "").trim().length > 0;
  const flagged = hasAllergies || s.epipen_required;

  return (
    <div
      style={{
        background: CREAM,
        border: `1px solid ${RULE}`,
        borderLeft: flagged ? `3px solid ${RED}` : `1px solid ${RULE}`,
        borderRadius: 6,
        padding: isEditing ? "12px 14px" : "8px 12px",
      }}
    >
      {!isEditing && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>
              {displayName}
              {s.birthdate && (
                <span style={{ color: MUTED, fontSize: 11, marginLeft: 6, fontWeight: 500 }}>
                  · DOB {s.birthdate}
                </span>
              )}
              {s.epipen_required && (
                <span style={{ marginLeft: 8, fontSize: 10, color: RED, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  EpiPen
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
              {hasAllergies && <span style={{ color: RED, fontWeight: 600 }}>Allergies: {s.allergies}</span>}
              {!hasAllergies && (s.emergency_contact_name
                ? <>EC: {s.emergency_contact_name}{s.emergency_contact_phone && ` · ${s.emergency_contact_phone}`}</>
                : <em>no emergency contact</em>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onToggleEdit}
            style={{
              padding: "5px 10px",
              background: "transparent",
              color: PURPLE,
              border: `1px solid ${PURPLE}`,
              borderRadius: 5,
              fontSize: 11,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Edit →
          </button>
        </div>
      )}

      {isEditing && (
        <CamperEditForm
          registration={registration}
          orgId={orgId}
          onCancel={onToggleEdit}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

function CamperEditForm({ registration, orgId, onCancel, onSaved }) {
  const s = registration.student;
  const [form, setForm] = useState({
    allergies: s.allergies ?? "",
    dietary_restrictions: s.dietary_restrictions ?? "",
    medical_notes: s.medical_notes ?? "",
    medical_conditions: s.medical_conditions ?? "",
    epipen_required: !!s.epipen_required,
    medications_at_program: s.medications_at_program ?? "",
    emergency_contact_name: s.emergency_contact_name ?? "",
    emergency_contact_phone: s.emergency_contact_phone ?? "",
    special_needs_accommodations: s.special_needs_accommodations ?? "",
    authorized_pickup_contacts: registration.authorized_pickup_contacts ?? "",
    notes: registration.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function update(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function save() {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const studentFields = {
        allergies: emptyOrNull(form.allergies),
        dietary_restrictions: emptyOrNull(form.dietary_restrictions),
        medical_notes: emptyOrNull(form.medical_notes),
        medical_conditions: emptyOrNull(form.medical_conditions),
        epipen_required: !!form.epipen_required,
        medications_at_program: emptyOrNull(form.medications_at_program),
        emergency_contact_name: emptyOrNull(form.emergency_contact_name),
        emergency_contact_phone: emptyOrNull(form.emergency_contact_phone),
        special_needs_accommodations: emptyOrNull(form.special_needs_accommodations),
      };
      const regFields = {
        authorized_pickup_contacts: emptyOrNull(form.authorized_pickup_contacts),
        notes: emptyOrNull(form.notes),
      };
      const { error: sErr } = await supabase
        .from("students")
        .update(studentFields)
        .eq("id", s.id);
      if (sErr) throw sErr;
      const { error: rErr } = await supabase
        .from("registrations")
        .update(regFields)
        .eq("id", registration.id);
      if (rErr) throw rErr;
      if (onSaved) onSaved();
    } catch (e) {
      console.error("[CamperEditForm] save failed", e);
      if (/permission denied|policy/i.test(e.message ?? "")) {
        setErr("You don't have permission to edit this camper.");
      } else {
        setErr(e.message ?? "Couldn't save.");
      }
      setBusy(false);
    }
  }

  const name = `${s.first_name ?? ""} ${s.last_name ?? ""}`.trim() || "Unnamed";

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>
          Editing: {name}
          {s.birthdate && (
            <span style={{ color: MUTED, fontSize: 11, marginLeft: 6, fontWeight: 500 }}>
              · DOB {s.birthdate}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          style={{ background: "transparent", border: "none", color: MUTED, fontSize: 14, cursor: "pointer" }}
          aria-label="Cancel"
        >
          ✕
        </button>
      </div>

      {err && (
        <div style={{ background: `${RED}1A`, color: RED, padding: 8, borderRadius: 6, marginBottom: 8, fontSize: 12 }}>
          {err}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <FullField label="Allergies (flag for instructor)">
          <Inp value={form.allergies} onChange={(v) => update("allergies", v)} />
        </FullField>
        <Lbl label="Dietary restrictions">
          <Inp value={form.dietary_restrictions} onChange={(v) => update("dietary_restrictions", v)} />
        </Lbl>
        <Lbl label="Medical conditions">
          <Inp value={form.medical_conditions} onChange={(v) => update("medical_conditions", v)} />
        </Lbl>
        <Lbl label="Medical notes">
          <Inp value={form.medical_notes} onChange={(v) => update("medical_notes", v)} />
        </Lbl>
        <Lbl label="Medications at program">
          <Inp value={form.medications_at_program} onChange={(v) => update("medications_at_program", v)} />
        </Lbl>
        <Lbl label="EpiPen required">
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: INK, padding: "5px 0" }}>
            <input
              type="checkbox"
              checked={form.epipen_required}
              onChange={(e) => update("epipen_required", e.target.checked)}
            />
            Yes, instructor should be aware
          </label>
        </Lbl>
        <Lbl label="Emergency contact name">
          <Inp value={form.emergency_contact_name} onChange={(v) => update("emergency_contact_name", v)} />
        </Lbl>
        <Lbl label="Emergency contact phone">
          <Inp value={form.emergency_contact_phone} onChange={(v) => update("emergency_contact_phone", v)} />
        </Lbl>
        <FullField label="Authorized pickup (other than parent)">
          <Inp value={form.authorized_pickup_contacts} onChange={(v) => update("authorized_pickup_contacts", v)} placeholder="Names + relationships, e.g. 'Aunt Sara, grandparent John'" />
        </FullField>
        <FullField label="Accommodations / special needs">
          <Inp value={form.special_needs_accommodations} onChange={(v) => update("special_needs_accommodations", v)} />
        </FullField>
        <FullField label="Notes (admin-only)">
          <Inp value={form.notes} onChange={(v) => update("notes", v)} />
        </FullField>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 12 }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          style={{
            padding: "6px 12px",
            background: "transparent",
            color: MUTED,
            border: `1px solid ${RULE}`,
            borderRadius: 5,
            fontSize: 12,
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          style={{
            padding: "6px 14px",
            background: PURPLE,
            color: "#fff",
            border: "none",
            borderRadius: 5,
            fontSize: 12,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: busy ? "wait" : "pointer",
            opacity: busy ? 0.5 : 1,
          }}
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

function emptyOrNull(s) {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
}

function FullField({ label, children }) {
  return (
    <label style={{ display: "block", gridColumn: "1 / -1" }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: MUTED, display: "block", marginBottom: 3 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function RosterUploadModal({ camp, onClose, onImported }) {
  const [mode, setMode] = useState("csv"); // 'csv' or 'manual'
  const [csvHeaders, setCsvHeaders] = useState(null);
  const [csvRows, setCsvRows] = useState(null);
  const [mapping, setMapping] = useState({});
  const [parseError, setParseError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  function handleFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setParseError("");
    setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result);
        const { headers, data } = parseCsv(text);
        if (headers.length === 0) {
          setParseError("That file doesn't look like a CSV.");
          return;
        }
        setCsvHeaders(headers);
        setCsvRows(data);
        setMapping(autoMap(headers));
      } catch (err) {
        console.error("[RosterUploadModal] parse failed", err);
        setParseError("Couldn't parse that CSV. Try a different file.");
      }
    };
    reader.readAsText(f);
  }

  function mapRow(row) {
    const out = {};
    for (const def of FIELD_DEFS) {
      const headerName = mapping[def.key];
      if (!headerName) continue;
      const idx = csvHeaders.indexOf(headerName);
      if (idx === -1) continue;
      out[def.key] = row[idx];
    }
    return out;
  }

  async function submitCsv() {
    if (busy) return;
    if (!mapping.student_first_name) {
      setParseError("You need to map a 'Camper first name' column before importing.");
      return;
    }
    setBusy(true);
    setParseError("");
    setResult(null);
    try {
      const registrants = csvRows.map(mapRow);
      const { data, error } = await supabase.functions.invoke("admin-import-camp-roster", {
        body: { camp_session_id: camp.id, registrants },
      });
      if (error || data?.error) {
        setParseError(data?.error || error?.message || "Import failed.");
        setBusy(false);
        return;
      }
      setResult(data);
      if (onImported) onImported(data);
    } catch (err) {
      console.error("[RosterUploadModal] submit failed", err);
      setParseError(err.message ?? "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "40px 16px",
        zIndex: 100,
        overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          width: "100%",
          maxWidth: 760,
          border: `1px solid ${RULE}`,
          borderRadius: 10,
          padding: 22,
          boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: INK, margin: 0 }}>
              Roster: {camp.curriculum_name}
            </h2>
            <p style={{ color: MUTED, fontSize: 12, marginTop: 4 }}>
              {fmtDate(camp.starts_on)}–{fmtDate(camp.ends_on)} · {camp.location_name}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: MUTED, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1 }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${RULE}`, marginBottom: 16 }}>
          <TabBtn active={mode === "csv"} onClick={() => setMode("csv")} label="Upload CSV" />
          <TabBtn active={mode === "manual"} onClick={() => setMode("manual")} label="Add one by hand" />
        </div>

        {mode === "csv" && (
          <CsvPanel
            csvHeaders={csvHeaders}
            csvRows={csvRows}
            mapping={mapping}
            setMapping={setMapping}
            parseError={parseError}
            result={result}
            busy={busy}
            onFile={handleFile}
            onSubmit={submitCsv}
            onClose={onClose}
          />
        )}

        {mode === "manual" && (
          <ManualPanel
            campSessionId={camp.id}
            busy={busy}
            setBusy={setBusy}
            onSaved={(summary) => {
              setResult(summary);
              if (onImported) onImported(summary);
            }}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "8px 14px",
        background: "transparent",
        border: "none",
        borderBottom: active ? `2px solid ${PURPLE}` : "2px solid transparent",
        color: active ? PURPLE : MUTED,
        fontSize: 13,
        fontWeight: 600,
        fontFamily: "inherit",
        cursor: "pointer",
        marginBottom: -1,
      }}
    >
      {label}
    </button>
  );
}

function CsvPanel({ csvHeaders, csvRows, mapping, setMapping, parseError, result, busy, onFile, onSubmit, onClose }) {
  return (
    <div>
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={onFile}
        style={{ fontSize: 13, marginBottom: 10 }}
      />
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 10, lineHeight: 1.5 }}>
        Export from Squarespace / your registration platform. We&rsquo;ll guess which column is which; you confirm before we save.
      </div>

      {parseError && (
        <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>
          {parseError}
        </div>
      )}

      {result && (
        <div style={{ background: `${OK}1A`, border: `1px solid ${OK}55`, color: INK, padding: 12, borderRadius: 6, fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>
          <strong>{result.imported} added</strong>
          {result.updated > 0 && <>, <strong>{result.updated} updated</strong></>}
          {result.skipped > 0 && <>, <strong style={{ color: AMBER }}>{result.skipped} skipped</strong></>}.
          {result.errors && result.errors.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: "pointer", color: MUTED }}>Why {result.errors.length} skipped</summary>
              <ul style={{ margin: "6px 0 0 18px", padding: 0, fontSize: 12, color: MUTED }}>
                {result.errors.slice(0, 10).map((e, i) => (
                  <li key={i}>Row {e.row_index + 1}: {e.error}</li>
                ))}
                {result.errors.length > 10 && <li>…and {result.errors.length - 10} more</li>}
              </ul>
            </details>
          )}
        </div>
      )}

      {csvHeaders && csvRows && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>
            Map your CSV columns ({csvRows.length} rows detected)
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16, maxHeight: 280, overflowY: "auto", padding: 4, border: `1px solid ${RULE}`, borderRadius: 6 }}>
            {FIELD_DEFS.map((def) => (
              <div key={def.key} style={{ padding: "6px 8px" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: INK, marginBottom: 2 }}>
                  {def.label}{def.required && <span style={{ color: RED, marginLeft: 3 }}>*</span>}
                </div>
                <select
                  value={mapping[def.key] || ""}
                  onChange={(e) => setMapping({ ...mapping, [def.key]: e.target.value || undefined })}
                  style={{
                    width: "100%",
                    padding: "5px 8px",
                    border: `1px solid ${RULE}`,
                    borderRadius: 4,
                    fontSize: 12,
                    fontFamily: "inherit",
                    background: "#fff",
                    color: INK,
                  }}
                >
                  <option value="">— not in this file —</option>
                  {csvHeaders.map((h, i) => (
                    <option key={i} value={h}>{h}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>
            Preview (first 3 rows)
          </div>
          <div style={{ background: CREAM, padding: 10, borderRadius: 6, marginBottom: 14, maxHeight: 200, overflow: "auto" }}>
            {csvRows.slice(0, 3).map((row, i) => {
              const first = row[csvHeaders.indexOf(mapping.student_first_name)] ?? "";
              const last = row[csvHeaders.indexOf(mapping.student_last_name)] ?? "";
              const email = row[csvHeaders.indexOf(mapping.parent_email)] ?? "";
              return (
                <div key={i} style={{ fontSize: 12, color: INK, padding: "3px 0", borderBottom: i < 2 ? `1px dashed ${RULE}` : "none" }}>
                  <strong>{first} {last}</strong> {email && <span style={{ color: MUTED }}>· {email}</span>}
                </div>
              );
            })}
          </div>
        </>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          style={{
            padding: "8px 14px",
            background: "transparent",
            color: MUTED,
            border: `1px solid ${RULE}`,
            borderRadius: 6,
            fontSize: 13,
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          {result ? "Done" : "Cancel"}
        </button>
        {!result && csvHeaders && csvRows && (
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy}
            style={{
              padding: "8px 16px",
              background: PURPLE,
              color: "#fff",
              border: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: busy ? "wait" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >
            {busy ? "Importing…" : `Import ${csvRows.length} rows`}
          </button>
        )}
      </div>
    </div>
  );
}

function ManualPanel({ campSessionId, busy, setBusy, onSaved, onClose }) {
  const [form, setForm] = useState({
    student_first_name: "",
    student_last_name: "",
    grade: "",
    birthdate: "",
    allergies: "",
    medical_notes: "",
    emergency_contact_name: "",
    emergency_contact_phone: "",
    parent_first_name: "",
    parent_last_name: "",
    parent_email: "",
    parent_phone: "",
  });
  const [error, setError] = useState("");
  const [savedFlash, setSavedFlash] = useState("");

  function update(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    if (busy) return;
    if (!form.student_first_name.trim()) {
      setError("Camper first name is required.");
      return;
    }
    setBusy(true);
    setError("");
    setSavedFlash("");
    try {
      const { data, error } = await supabase.functions.invoke("admin-import-camp-roster", {
        body: { camp_session_id: campSessionId, registrants: [form] },
      });
      if (error || data?.error) {
        setError(data?.error || error?.message || "Couldn't save.");
        setBusy(false);
        return;
      }
      const name = `${form.student_first_name} ${form.student_last_name}`.trim();
      setSavedFlash(`Added ${name} to the roster.`);
      if (onSaved) onSaved(data);
      // Clear form for next entry
      setForm({
        student_first_name: "",
        student_last_name: "",
        grade: "",
        birthdate: "",
        allergies: "",
        medical_notes: "",
        emergency_contact_name: "",
        emergency_contact_phone: "",
        parent_first_name: "",
        parent_last_name: "",
        parent_email: "",
        parent_phone: "",
      });
    } catch (err) {
      console.error("[ManualPanel] save failed", err);
      setError(err.message ?? "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 12, lineHeight: 1.5 }}>
        Add one camper at a time — useful for partner-venue camps that don&rsquo;t come through Squarespace, or last-minute adds.
      </div>

      {savedFlash && (
        <div style={{ background: `${OK}1A`, border: `1px solid ${OK}55`, color: OK, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>
          ✓ {savedFlash} Add another below, or close.
        </div>
      )}

      {error && (
        <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <Lbl label="Camper first name *">
          <Inp value={form.student_first_name} onChange={(v) => update("student_first_name", v)} />
        </Lbl>
        <Lbl label="Camper last name">
          <Inp value={form.student_last_name} onChange={(v) => update("student_last_name", v)} />
        </Lbl>
        <Lbl label="Grade">
          <Inp value={form.grade} onChange={(v) => update("grade", v)} placeholder="K, 1, 2…" />
        </Lbl>
        <Lbl label="Birthdate">
          <Inp value={form.birthdate} onChange={(v) => update("birthdate", v)} placeholder="YYYY-MM-DD or MM/DD/YYYY" />
        </Lbl>
        <Lbl label="Allergies" full>
          <Inp value={form.allergies} onChange={(v) => update("allergies", v)} />
        </Lbl>
        <Lbl label="Medical notes" full>
          <Inp value={form.medical_notes} onChange={(v) => update("medical_notes", v)} />
        </Lbl>
        <Lbl label="Emergency contact name">
          <Inp value={form.emergency_contact_name} onChange={(v) => update("emergency_contact_name", v)} />
        </Lbl>
        <Lbl label="Emergency contact phone">
          <Inp value={form.emergency_contact_phone} onChange={(v) => update("emergency_contact_phone", v)} />
        </Lbl>
        <Lbl label="Parent first name">
          <Inp value={form.parent_first_name} onChange={(v) => update("parent_first_name", v)} />
        </Lbl>
        <Lbl label="Parent last name">
          <Inp value={form.parent_last_name} onChange={(v) => update("parent_last_name", v)} />
        </Lbl>
        <Lbl label="Parent email">
          <Inp value={form.parent_email} onChange={(v) => update("parent_email", v)} type="email" />
        </Lbl>
        <Lbl label="Parent phone">
          <Inp value={form.parent_phone} onChange={(v) => update("parent_phone", v)} />
        </Lbl>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          style={{
            padding: "8px 14px",
            background: "transparent",
            color: MUTED,
            border: `1px solid ${RULE}`,
            borderRadius: 6,
            fontSize: 13,
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          Done
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          style={{
            padding: "8px 16px",
            background: PURPLE,
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: busy ? "wait" : "pointer",
            opacity: busy ? 0.5 : 1,
          }}
        >
          {busy ? "Saving…" : "Add to roster"}
        </button>
      </div>
    </div>
  );
}

function Lbl({ label, full, children }) {
  return (
    <label style={{ display: "block", gridColumn: full ? "1 / -1" : "auto" }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: MUTED, display: "block", marginBottom: 3 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function Inp({ value, onChange, placeholder, type = "text" }) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: "100%",
        padding: "7px 10px",
        border: `1px solid ${RULE}`,
        borderRadius: 5,
        fontSize: 13,
        fontFamily: "inherit",
        background: "#fff",
        color: INK,
        boxSizing: "border-box",
      }}
    />
  );
}
