// /admin/programs/:programId/roster
// Operator-facing roster for ONE afterschool program. Reads enrolled students
// from native registrations (no CSV import — that data already exists).
//
// Enrollment definition MATCHES ProgramsCalendar exactly so this list and the
// "X enrolled" count on /admin/programs agree: un-cancelled registrations where
// payment_status='paid' OR status='confirmed'. Pending/incomplete checkouts are
// NOT seats and are surfaced separately, not in the roster.
//
// Safety/PII: scoped to one program at a time (per-program route). RLS on
// registrations + students keeps everything org-scoped. No unbounded "all
// students" endpoint. Read-only view — no edits here.

import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import EmailRosterModal from "../EmailRosterModal.jsx";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const CREAM = "#FBFBFB";
const PANEL = "#fff";
const RED = "#b53737";
const AMBER = "#a16207";
const OK_GREEN = "#3a7c3a";

const DAY_LABELS = {
  monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
  thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday",
};

function fmtDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso ?? "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    timeZone: "UTC", month: "short", day: "numeric", year: "numeric",
  });
}

function fmtTime(t) {
  if (!t) return "";
  if (/[ap]\s?m/i.test(t)) return t.toLowerCase().replace(/\s+/g, "");
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h)) return t;
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? "pm" : "am";
  return m === 0 ? `${hr12}${ampm}` : `${hr12}:${String(m).padStart(2, "0")}${ampm}`;
}

function gradeLabel(g) {
  if (g == null) return "";
  return g === 0 ? "K" : String(g);
}

// Translate the raw payment/status enums into plain English (no codes on screen).
function paymentPhrase(reg) {
  if (reg.payment_status === "paid") return "Paid";
  if (reg.status === "confirmed") return "On installments";
  return "Pending";
}

function studentName(s) {
  return `${s?.first_name ?? ""} ${s?.last_name ?? ""}`.trim() || "Unnamed";
}

function parentName(p) {
  const n = `${p?.first_name ?? ""} ${p?.last_name ?? ""}`.trim();
  return n || "";
}

export default function ProgramRoster() {
  const { org } = useOutletContext();
  const { programId } = useParams();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [program, setProgram] = useState(null);
  const [rows, setRows] = useState([]); // all un-cancelled regs (enrolled + pending)

  useEffect(() => {
    if (!org?.id || !programId) return;
    let mounted = true;
    (async () => {
      setLoading(true);
      setError("");
      try {
        // Load the program, scoped to the caller's org. A :programId from
        // another org returns nothing here (and RLS would block the roster
        // rows anyway) → "not found".
        const { data: prog, error: pErr } = await supabase
          .from("programs")
          .select(`
            id, curriculum, term, day_of_week, start_time, end_time, room,
            instructor_name, max_capacity, status, program_location_id,
            first_session_date, session_count,
            program_locations ( name, district )
          `)
          .eq("id", programId)
          .eq("organization_id", org.id)
          .maybeSingle();
        if (pErr) throw pErr;
        if (!prog) {
          if (mounted) { setError("notfound"); setLoading(false); }
          return;
        }

        // Roster rows: un-cancelled registrations for this program, joined to
        // the student (safety fields) and the parent (contact). Mirror of the
        // camp RosterEditor join + the Dashboard parent join (with email/phone).
        const { data: regRows, error: rErr } = await supabase
          .from("registrations")
          .select(`
            id, status, payment_status, authorized_pickup_contacts,
            photo_release_consent, photo_release_consent_at, registered_at,
            student:students (
              id, first_name, last_name, grade, pronouns, birthdate,
              allergies, dietary_restrictions, medical_notes, medical_conditions,
              epipen_required, medications_at_program,
              emergency_contact_name, emergency_contact_phone,
              special_needs_accommodations, homeroom_teacher
            ),
            parent:parents ( first_name, last_name, email, phone )
          `)
          .eq("program_id", programId)
          .is("cancelled_at", null)
          .order("registered_at", { ascending: true });
        if (rErr) throw rErr;

        if (mounted) {
          setProgram(prog);
          setRows(regRows ?? []);
        }
      } catch (e) {
        if (mounted) setError(e.message ?? String(e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [org?.id, programId]);

  // Partition into enrolled (seats) vs pending — exactly like ProgramsCalendar.
  const { enrolled, pendingCount } = useMemo(() => {
    const enr = [];
    let pend = 0;
    for (const r of rows) {
      if (r.payment_status === "paid" || r.status === "confirmed") enr.push(r);
      else pend += 1;
    }
    // Alphabetical by last, then first — print/sign-in friendly.
    enr.sort((a, b) => {
      const an = `${a.student?.last_name ?? ""} ${a.student?.first_name ?? ""}`.toLowerCase();
      const bn = `${b.student?.last_name ?? ""} ${b.student?.first_name ?? ""}`.toLowerCase();
      return an.localeCompare(bn);
    });
    return { enrolled: enr, pendingCount: pend };
  }, [rows]);

  function downloadCsv() {
    const headers = [
      "Student", "Grade", "Allergies", "EpiPen", "Medical conditions",
      "Medical notes", "Dietary", "Medications", "Accommodations",
      "Parent", "Parent email", "Parent phone",
      "Emergency contact", "Emergency phone", "Authorized pickup",
      "Photo release", "Homeroom", "Payment",
    ];
    const lines = enrolled.map((r) => {
      const s = r.student ?? {};
      return [
        studentName(s),
        gradeLabel(s.grade),
        s.allergies ?? "",
        s.epipen_required ? "YES" : "",
        s.medical_conditions ?? "",
        s.medical_notes ?? "",
        s.dietary_restrictions ?? "",
        s.medications_at_program ?? "",
        s.special_needs_accommodations ?? "",
        parentName(r.parent),
        r.parent?.email ?? "",
        r.parent?.phone ?? "",
        s.emergency_contact_name ?? "",
        s.emergency_contact_phone ?? "",
        r.authorized_pickup_contacts ?? "",
        r.photo_release_consent ? "OK" : "No",
        s.homeroom_teacher ?? "",
        paymentPhrase(r),
      ].map(csvCell).join(",");
    });
    const csv = [headers.map(csvCell).join(","), ...lines].join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = (program?.curriculum ?? "program").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    a.href = url;
    a.download = `roster-${safe}-${program?.term ?? ""}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Rosters go to the PARTNER (school/venue logistics) — never to families.
  const [emailing, setEmailing] = useState(false);

  // ---- Render ----

  if (loading) {
    return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading roster…</div>;
  }
  if (error === "notfound") {
    return (
      <div style={{ padding: 40 }}>
        <Link to="/admin/programs" style={backLink}>← Back to programs</Link>
        <div style={{ marginTop: 16, color: MUTED }}>That program isn't in your account.</div>
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 40 }}>
        <Link to="/admin/programs" style={backLink}>← Back to programs</Link>
        <div style={{ marginTop: 16, color: RED }}>Couldn't load the roster: {error}</div>
      </div>
    );
  }

  const loc = program?.program_locations;
  const meta = [
    loc?.name,
    program?.day_of_week ? `${DAY_LABELS[program.day_of_week.toLowerCase()] ?? program.day_of_week}s` : null,
    (program?.start_time || program?.end_time)
      ? `${fmtTime(program.start_time)}${program.end_time ? `–${fmtTime(program.end_time)}` : ""}`
      : null,
    program?.room ? `Room ${program.room}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div style={{ maxWidth: 880, margin: "0 auto" }}>
      <div className="roster-noprint">
        <Link to="/admin/programs" style={backLink}>← Back to programs</Link>
      </div>

      {/* Header */}
      <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, color: PURPLE, fontSize: 24, fontWeight: 700 }}>
            {program?.curriculum ?? "Program"} <span style={{ color: MUTED, fontWeight: 500, fontSize: 16 }}>roster</span>
          </h1>
          <div style={{ color: MUTED, fontSize: 13, marginTop: 4 }}>{meta || "—"}</div>
          <div style={{ color: INK, fontSize: 14, marginTop: 8 }}>
            <strong>{enrolled.length}</strong> enrolled
            {program?.max_capacity ? <span style={{ color: MUTED }}> / {program.max_capacity} seats</span> : null}
            {program?.instructor_name ? <span style={{ color: MUTED }}> · Instructor: {program.instructor_name}</span> : null}
            {pendingCount > 0 && (
              <span style={{ color: MUTED, marginLeft: 8 }}>(+{pendingCount} pending checkout{pendingCount === 1 ? "" : "s"}, not counted)</span>
            )}
          </div>
        </div>
        <div className="roster-noprint" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={downloadCsv} disabled={enrolled.length === 0} style={primaryBtn(enrolled.length === 0)}>
            Download CSV
          </button>
          <button type="button" onClick={() => window.print()} disabled={enrolled.length === 0} style={ghostBtn(enrolled.length === 0)}>
            Print
          </button>
          <button type="button" onClick={() => setEmailing(true)} disabled={enrolled.length === 0} style={ghostBtn(enrolled.length === 0)} title="Email a branded PDF roster to this location's partner / logistics contacts">
            Email roster to partner
          </button>
        </div>
      </div>

      {/* Roster */}
      <div style={{ marginTop: 18 }}>
        {enrolled.length === 0 ? (
          <div style={emptyState}>No one's enrolled yet. As families register, they'll show up here.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {enrolled.map((r) => <StudentCard key={r.id} reg={r} />)}
          </div>
        )}
      </div>

      {emailing && program && (
        <EmailRosterModal
          orgId={org?.id}
          target={{
            kind: "program",
            id: program.id,
            locationId: program.program_location_id,
            title: program.curriculum,
            subtitle: meta,
            functionName: "email-program-roster",
            bodyKey: "program_id",
          }}
          onClose={() => setEmailing(false)}
          onSent={() => setEmailing(false)}
        />
      )}
    </div>
  );
}

function StudentCard({ reg }) {
  const s = reg.student ?? {};
  const hasAllergy = (s.allergies ?? "").trim().length > 0;
  const hasMedCond = (s.medical_conditions ?? "").trim().length > 0;
  const flagged = hasAllergy || s.epipen_required || hasMedCond;

  // Secondary safety facts (shown but not red-flagged).
  const secondary = [
    s.dietary_restrictions && { label: "Dietary", value: s.dietary_restrictions },
    s.medications_at_program && { label: "Medications", value: s.medications_at_program },
    s.medical_notes && { label: "Medical notes", value: s.medical_notes },
    s.special_needs_accommodations && { label: "Accommodations", value: s.special_needs_accommodations },
  ].filter(Boolean);

  return (
    <div style={{
      background: PANEL,
      border: `1px solid ${RULE}`,
      borderLeft: flagged ? `4px solid ${RED}` : `4px solid ${RULE}`,
      borderRadius: 8,
      padding: "12px 16px",
    }}>
      {/* Name row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: INK }}>
          {studentName(s)}
          {s.grade != null && <span style={{ color: MUTED, fontWeight: 500, fontSize: 13, marginLeft: 8 }}>Grade {gradeLabel(s.grade)}</span>}
          {s.pronouns && <span style={{ color: MUTED, fontWeight: 400, fontSize: 12, marginLeft: 8 }}>({s.pronouns})</span>}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {s.epipen_required && <Badge color={RED}>EpiPen</Badge>}
          <Badge color={reg.photo_release_consent ? OK_GREEN : MUTED}>
            {reg.photo_release_consent ? "Photo OK" : "No photo"}
          </Badge>
          <span style={{ fontSize: 12, color: MUTED }}>{paymentPhrase(reg)}</span>
        </div>
      </div>

      {/* Safety flags — prominent */}
      {flagged && (
        <div style={{
          marginTop: 8, padding: "8px 12px",
          background: `${RED}10`, border: `1px solid ${RED}40`, borderRadius: 6,
          fontSize: 13, color: INK, lineHeight: 1.5,
        }}>
          {hasAllergy && <div><strong style={{ color: RED }}>Allergies:</strong> {s.allergies}</div>}
          {s.epipen_required && <div><strong style={{ color: RED }}>EpiPen required.</strong></div>}
          {hasMedCond && <div><strong style={{ color: RED }}>Medical:</strong> {s.medical_conditions}</div>}
        </div>
      )}

      {/* Secondary safety facts */}
      {secondary.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: INK, lineHeight: 1.5 }}>
          {secondary.map((f, i) => (
            <span key={f.label}>
              {i > 0 ? " · " : ""}
              <span style={{ color: MUTED, fontWeight: 600 }}>{f.label}:</span> {f.value}
            </span>
          ))}
        </div>
      )}

      {/* Contact + safety logistics */}
      <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "4px 18px", fontSize: 12.5, color: INK }}>
        <Field label="Parent">
          {parentName(reg.parent) || <Muted>—</Muted>}
          {reg.parent?.email && <div style={{ color: MUTED }}>{reg.parent.email}</div>}
          {reg.parent?.phone && <div style={{ color: MUTED }}>{reg.parent.phone}</div>}
        </Field>
        <Field label="Emergency contact">
          {s.emergency_contact_name
            ? <>{s.emergency_contact_name}{s.emergency_contact_phone ? <div style={{ color: MUTED }}>{s.emergency_contact_phone}</div> : null}</>
            : <Muted>none on file</Muted>}
        </Field>
        <Field label="Authorized pickup">
          {reg.authorized_pickup_contacts || <Muted>parent only</Muted>}
        </Field>
        {s.homeroom_teacher && (
          <Field label="Homeroom">{s.homeroom_teacher}</Field>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ marginTop: 1 }}>{children}</div>
    </div>
  );
}

function Muted({ children }) {
  return <span style={{ color: MUTED, fontStyle: "italic" }}>{children}</span>;
}

function Badge({ color, children }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, color,
      background: `${color}1A`, border: `1px solid ${color}55`,
      padding: "2px 8px", borderRadius: 999,
      textTransform: "uppercase", letterSpacing: 0.5,
    }}>
      {children}
    </span>
  );
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const backLink = {
  background: "none", border: "none", color: MUTED,
  fontSize: 14, cursor: "pointer", padding: 0, textDecoration: "none",
};

function primaryBtn(disabled) {
  return {
    padding: "8px 14px", background: BRIGHT, color: "#fff", border: "none",
    borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit",
    cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
  };
}
function ghostBtn(disabled) {
  return {
    padding: "8px 14px", background: "#fff", color: BRIGHT,
    border: `1.5px solid ${BRIGHT}`, borderRadius: 8, fontSize: 13, fontWeight: 600,
    fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
  };
}

const emptyState = {
  background: PANEL, border: `1px dashed ${RULE}`, borderRadius: 8,
  padding: 28, textAlign: "center", color: MUTED, fontSize: 14,
};
