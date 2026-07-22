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

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import EmailRosterModal from "./EmailRosterModal";
import InviteFamiliesModal from "./InviteFamiliesModal";
import RefundDrawer from "../../components/RefundDrawer";
import Chevron from "../../components/Chevron.jsx";
import {
  FIELD_DEFS,
  autoMap,
  buildRegistrants,
  detectStructure,
  excelCellToString,
  filterDataRows,
  parseCsvRows,
} from "./rosterParse";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
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

// Column auto-mapping, header detection, name-splitting, and file parsing all
// live in ./rosterParse (pure + unit-tested against real vendor export files).
//
// Fields that get their own dedicated inputs at the top of each review card
// (plus the full-name helpers, which are split into first/last before import).
// Everything else in FIELD_DEFS is an "extra" — shown below whenever it has a
// value, so the card is a faithful preview of everything being imported.
const DEDICATED_REVIEW_KEYS = new Set([
  "student_first_name", "student_last_name", "student_full_name",
  "grade", "birthdate",
  "parent_first_name", "parent_last_name", "parent_full_name",
  "parent_email", "parent_phone",
]);
const EXTRA_FIELD_DEFS = FIELD_DEFS.filter((d) => !DEDICATED_REVIEW_KEYS.has(d.key));

export default function Rosters() {
  const { org, orgMember } = useOutletContext() ?? {};
  const [camps, setCamps] = useState(null); // null = loading
  const [error, setError] = useState("");
  const [uploadingFor, setUploadingFor] = useState(null); // camp_session row
  const [emailingFor, setEmailingFor] = useState(null); // camp_session row
  const [view, setView] = useState("afterschool"); // 'afterschool' | 'camps'
  // Owner/admin gate for roster management (add/upload). Refunds live in the
  // money tab, not here.
  const canManage = orgMember?.role === "owner" || orgMember?.role === "admin";

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
          .select("id, curriculum_name, starts_on, ends_on, location_id, location_name, week_num, session_type, current_enrollment, start_time, end_time")
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

        // 3. Most recent successful roster email per camp.
        const lastEmailed = new Map();
        if (ids.length > 0) {
          const { data: emailRows } = await supabase
            .from("roster_email_sends")
            .select("camp_session_id, sent_at, status")
            .in("camp_session_id", ids)
            .eq("status", "sent")
            .order("sent_at", { ascending: false });
          for (const r of emailRows ?? []) {
            if (!lastEmailed.has(r.camp_session_id)) {
              lastEmailed.set(r.camp_session_id, r.sent_at);
            }
          }
        }

        if (!cancelled) {
          setCamps(
            (campRows ?? []).map((c) => ({
              ...c,
              roster_count: rosterCounts.get(c.id) ?? 0,
              last_emailed_at: lastEmailed.get(c.id) ?? null,
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
          View, edit, add, and email rosters. Afterschool rosters fill in as families register; you can also add kids by hand.
        </p>
      </header>

      {/* Tabs: each roster group is its own tab so neither buries the other. */}
      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${RULE}`, marginBottom: 18 }}>
        <TabBtn active={view === "afterschool"} onClick={() => setView("afterschool")} label="Afterschool" />
        <TabBtn active={view === "camps"} onClick={() => setView("camps")} label="Camps" />
      </div>

      {view === "afterschool" && <AfterschoolRostersSection org={org} canEdit={canManage} />}

      {view === "camps" && (
        <>
          {error && (
            <div style={{ background: `${RED}1A`, color: RED, padding: 12, borderRadius: 6, fontSize: 13, marginBottom: 14 }}>
              {error}
            </div>
          )}

          {camps === null && <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>}

          {camps !== null && camps.length === 0 && !error && (
            <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 28, color: MUTED, textAlign: "center" }}>
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
                  onEmail={() => setEmailingFor(c)}
                  orgId={org?.id}
                  canManage={canManage}
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
        </>
      )}


      {uploadingFor && (
        <RosterUploadModal
          target={{
            id: uploadingFor.id,
            functionName: "admin-import-camp-roster",
            bodyKey: "camp_session_id",
            noun: "camper",
            title: uploadingFor.curriculum_name,
            subtitle: `${fmtDate(uploadingFor.starts_on)}–${fmtDate(uploadingFor.ends_on)}${uploadingFor.location_name ? ` · ${uploadingFor.location_name}` : ""}`,
          }}
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

      {emailingFor && (
        <EmailRosterModal
          camp={emailingFor}
          orgId={org?.id}
          onClose={() => setEmailingFor(null)}
          onSent={() => {
            const now = new Date().toISOString();
            setCamps((cs) => (cs ?? []).map((c) =>
              c.id === emailingFor.id ? { ...c, last_emailed_at: now } : c
            ));
          }}
        />
      )}
    </div>
  );
}

function CampRow({ camp, onUpload, onEmail, orgId, onRosterChanged, canManage }) {
  const [expanded, setExpanded] = useState(false);
  const gap = (camp.current_enrollment ?? 0) - (camp.roster_count ?? 0);
  const lastEmailedLabel = camp.last_emailed_at
    ? new Date(camp.last_emailed_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : null;
  return (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderLeft: camp.roster_count > 0 ? `3px solid ${OK}` : `3px solid ${RULE}`,
        borderRadius: 12,
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
              <Chevron open={expanded} color={BRIGHT} />
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
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={onUpload}
              style={{
                padding: "6px 12px",
                background: BRIGHT,
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
            {camp.roster_count > 0 && (
              <button
                type="button"
                onClick={onEmail}
                style={{
                  padding: "6px 12px",
                  background: "transparent",
                  color: PURPLE,
                  border: `1px solid ${PURPLE}`,
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                }}
                title="Send a branded PDF roster to this partner's logistics contacts"
              >
                Email roster →
              </button>
            )}
          </div>
          {lastEmailedLabel && (
            <div style={{ fontSize: 11, color: MUTED, marginTop: 4, textAlign: "right" }}>
              Last emailed {lastEmailedLabel}
            </div>
          )}
        </div>
      </div>

      {expanded && camp.roster_count > 0 && (
        <RosterEditor
          target={{ column: "camp_session_id", id: camp.id }}
          orgId={orgId}
          onChanged={onRosterChanged}
          refreshToken={camp.refresh_token || 0}
          canManage={canManage}
        />
      )}
    </div>
  );
}

// target = { column: 'camp_session_id' | 'program_id', id }. Shared by the
// camp roster and the afterschool program roster so both edit through one
// implementation. excludeCancelled hides cancelled registrations (programs do;
// camps show everything).
function RosterEditor({ target, orgId, onChanged, refreshToken, excludeCancelled, canManage }) {
  const [campers, setCampers] = useState(null); // null = loading
  const [contactsByStudent, setContactsByStudent] = useState({}); // { [student_id]: [student_contacts] }
  const [editingId, setEditingId] = useState(null);
  const [justSavedId, setJustSavedId] = useState(null); // reg id to flash "Saved" + scroll into view
  const [err, setErr] = useState("");
  // Afterschool programs have "students"; camps have "campers".
  const noun = target.column === "program_id" ? "student" : "camper";

  // silent=true refreshes data in place (after a save/remove) without blanking
  // the list to "Loading…", which would unmount every row and yank the scroll
  // position. Only the initial load shows the loading state.
  async function load(silent = false) {
    setErr("");
    if (!silent) {
      setCampers(null);
      setContactsByStudent({});
    }
    let q = supabase
      .from("registrations")
      .select(`
        id, status, notes, authorized_pickup_contacts, photo_release_consent, custom_field_values,
        payment_status, amount_cents, stripe_payment_intent_id, organization_id, cancelled_at,
        student:students (
          id, first_name, last_name, grade, birthdate, pronouns,
          allergies, dietary_restrictions, medical_notes, medical_conditions,
          epipen_required, medications_at_program,
          emergency_contact_name, emergency_contact_phone,
          special_needs_accommodations, homeroom_teacher, dismissal_method
        ),
        parent:parents (
          id, first_name, last_name, email, phone
        )
      `)
      .eq(target.column, target.id);
    if (excludeCancelled) q = q.is("cancelled_at", null);
    const { data, error } = await q.order("registered_at", { ascending: true });
    if (error) {
      console.error("[RosterEditor] load failed", error);
      setErr("Couldn't load the roster. Refresh.");
      setCampers([]);
      return;
    }
    setCampers(data ?? []);

    // Structured contacts (guardians / pickup / do-not-release). do_not_release is
    // RLS-gated to org editors, so view-only users just don't receive those rows.
    const sids = [...new Set((data ?? []).map((r) => r.student?.id).filter(Boolean))];
    if (sids.length) {
      const { data: contacts } = await supabase
        .from("student_contacts")
        .select("id, student_id, role, first_name, last_name, phone, email, sort_order")
        .in("student_id", sids)
        .order("sort_order", { ascending: true });
      const byStudent = {};
      for (const c of contacts ?? []) (byStudent[c.student_id] ||= []).push(c);
      setContactsByStudent(byStudent);
    }
  }

  useEffect(() => {
    load();
    // refreshToken bumps after an add/import to force a re-fetch. target too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.column, target.id, refreshToken]);

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
        <div style={{ color: MUTED, fontSize: 12 }}>No {noun}s yet.</div>
      )}

      {campers !== null && campers.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {campers.map((reg) => (
            <CamperEditableRow
              key={reg.id}
              registration={reg}
              contacts={contactsByStudent[reg.student?.id] || []}
              isEditing={editingId === reg.id}
              onToggleEdit={() => setEditingId((cur) => (cur === reg.id ? null : reg.id))}
              orgId={orgId}
              canManage={canManage}
              justSaved={justSavedId === reg.id}
              onSaved={() => {
                setEditingId(null);
                setJustSavedId(reg.id);       // row scrolls itself into view + flashes "Saved"
                load(true);                    // in-place refresh, no unmount/scroll-yank
                if (onChanged) onChanged();
                setTimeout(() => setJustSavedId((cur) => (cur === reg.id ? null : cur)), 2600);
              }}
              onRemoved={() => {
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

const DISMISSAL_LABELS = {
  released_to_authorized_adult: "Released to an authorized adult",
  walks_or_bikes_home: "Walks or bikes home",
  bus: "Bus",
  aftercare: "Aftercare",
  other: "Other",
};
const cFullName = (c) => `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim();
function TelLink({ phone }) {
  if (!phone) return null;
  return <a href={`tel:${phone.replace(/[^0-9+]/g, "")}`} style={{ color: PURPLE, textDecoration: "underline" }}>{phone}</a>;
}

function CamperEditableRow({ registration, contacts = [], isEditing, onToggleEdit, orgId, onSaved, canManage, onRemoved, justSaved }) {
  const s = registration.student;
  const [confirming, setConfirming] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const rowRef = useRef(null);
  // After a save, bring the just-saved row back into view — a collapsing edit
  // form otherwise leaves the result below the fold and the operator has to
  // hunt for it. See memory feedback_feedback_in_viewport.
  useEffect(() => {
    if (justSaved && rowRef.current) {
      rowRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [justSaved]);
  if (!s) return null;
  const guardians = contacts.filter((c) => c.role === "guardian");
  const pickups = contacts.filter((c) => c.role === "authorized_pickup");
  const doNotRelease = contacts.filter((c) => c.role === "do_not_release");
  const displayName = `${s.first_name ?? ""} ${s.last_name ?? ""}`.trim() || "Unnamed";
  const hasAllergies = (s.allergies ?? "").trim().length > 0;
  const flagged = hasAllergies || s.epipen_required;
  // A registration has money on it once it's paid or carries a Stripe charge.
  // Those can't be hard-deleted (Remove refuses them) — they're refunded instead.
  const hasPayment = registration.payment_status === "paid" || !!registration.stripe_payment_intent_id;
  const isCancelled = !!registration.cancelled_at || registration.status === "cancelled";
  const payStatus = registration.payment_status;
  // Small status pill: cancelled regs still show on camp rosters, so label them.
  const badge = isCancelled
    ? { text: payStatus === "refunded" ? "Cancelled · Refunded" : payStatus === "partial" ? "Cancelled · Partial refund" : "Cancelled", color: MUTED }
    : payStatus === "refunded"
      ? { text: "Refunded", color: MUTED }
      : payStatus === "partial"
        ? { text: "Partially refunded", color: AMBER }
        : null;

  return (
    <div
      ref={rowRef}
      style={{
        background: CREAM,
        border: `1px solid ${justSaved ? OK : RULE}`,
        borderLeft: flagged ? `3px solid ${RED}` : `1px solid ${justSaved ? OK : RULE}`,
        borderRadius: 6,
        padding: isEditing ? "12px 14px" : "8px 12px",
        transition: "border-color 0.4s ease",
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
              {badge && (
                <span style={{ marginLeft: 8, fontSize: 10, color: badge.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, border: `1px solid ${badge.color}`, borderRadius: 4, padding: "1px 5px" }}>
                  {badge.text}
                </span>
              )}
              {justSaved && (
                <span style={{ marginLeft: 8, fontSize: 10, color: OK, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, border: `1px solid ${OK}`, borderRadius: 4, padding: "1px 5px" }}>
                  ✓ Saved
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
              {hasAllergies && <span style={{ color: RED, fontWeight: 600 }}>Allergies: {s.allergies}</span>}
              {!hasAllergies && (s.emergency_contact_name
                ? <>EC: {s.emergency_contact_name}{s.emergency_contact_phone && <> · <TelLink phone={s.emergency_contact_phone} /></>}</>
                : <em>no emergency contact</em>
              )}
            </div>
            {(s.dismissal_method || guardians.length > 0 || pickups.length > 0 || doNotRelease.length > 0) && (
              <div style={{ fontSize: 11, color: MUTED, marginTop: 3, lineHeight: 1.55 }}>
                {s.dismissal_method && (
                  <div><strong style={{ color: INK }}>Dismissal:</strong> {DISMISSAL_LABELS[s.dismissal_method] || s.dismissal_method}</div>
                )}
                {guardians.length > 0 && (
                  <div><strong style={{ color: INK }}>{guardians.length > 1 ? "Guardians" : "2nd guardian"}:</strong>{" "}
                    {guardians.map((g, i) => <span key={g.id}>{i ? "; " : ""}{cFullName(g)}{g.phone && <> · <TelLink phone={g.phone} /></>}</span>)}
                  </div>
                )}
                {pickups.length > 0 && (
                  <div><strong style={{ color: INK }}>Pickup:</strong>{" "}
                    {pickups.map((c, i) => <span key={c.id}>{i ? "; " : ""}{cFullName(c)}{c.phone && <> · <TelLink phone={c.phone} /></>}</span>)}
                  </div>
                )}
                {doNotRelease.length > 0 && (
                  <div><strong style={{ color: RED }}>Do NOT release:</strong> {doNotRelease.map(cFullName).filter(Boolean).join("; ")}</div>
                )}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
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
              View / Edit →
            </button>
            {canManage && hasPayment && payStatus !== "refunded" && (
              <button
                type="button"
                onClick={() => setRefunding(true)}
                style={{
                  padding: "5px 10px",
                  background: "transparent",
                  color: INK,
                  border: `1px solid ${RULE}`,
                  borderRadius: 5,
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
                title="Refund this family's payment (and optionally free their spot)"
              >
                Refund…
              </button>
            )}
            {canManage && !hasPayment && (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                style={{
                  padding: "5px 10px",
                  background: "transparent",
                  color: MUTED,
                  border: `1px solid ${RULE}`,
                  borderRadius: 5,
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
                title="Remove this student from the roster"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      )}

      {confirming && (
        <RemoveConfirm
          registration={registration}
          name={displayName}
          onClose={() => setConfirming(false)}
          onRemoved={() => { setConfirming(false); if (onRemoved) onRemoved(); }}
        />
      )}

      {refunding && (
        <RefundDrawer
          registration={{
            id: registration.id,
            organization_id: registration.organization_id,
            amount_cents: registration.amount_cents,
            payment_status: registration.payment_status,
            stripe_payment_intent_id: registration.stripe_payment_intent_id,
            studentName: displayName,
          }}
          onClose={() => setRefunding(false)}
          onDone={() => { setRefunding(false); if (onRemoved) onRemoved(); }}
        />
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

// Styled "are you sure" popup for removing a kid from a roster. Calls
// admin-remove-registration (money-safe hard delete). A registration with a
// real payment is refused server-side → we explain to use the Money tab.
function RemoveConfirm({ registration, name, onClose, onRemoved }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function remove() {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const { data, error } = await supabase.functions.invoke("admin-remove-registration", {
        body: { registration_id: registration.id },
      });
      if (error || data?.error) {
        const code = data?.error || error?.message;
        if (code === "has_payment") {
          setErr("This family has a payment on file, so they can't be deleted here. Cancel or refund them from the Money tab instead.");
        } else {
          setErr(typeof code === "string" ? code : "Couldn't remove. Try again.");
        }
        setBusy(false);
        return;
      }
      if (onRemoved) onRemoved();
    } catch (e) {
      console.error("[RemoveConfirm] failed", e);
      setErr(e.message ?? "Couldn't remove. Try again.");
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 16px", zIndex: 200 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "#fff", width: "100%", maxWidth: 420, border: `1px solid ${RULE}`, borderRadius: 12, padding: 22, boxShadow: "0 10px 40px rgba(0,0,0,0.2)" }}
      >
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: INK }}>Remove {name}?</h3>
        <p style={{ color: MUTED, fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
          This permanently deletes their spot on this roster. You can&rsquo;t undo it.
        </p>

        {err && (
          <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 12.5, marginTop: 10, lineHeight: 1.5 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            style={{ padding: "8px 16px", background: RED, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CamperEditForm({ registration, orgId, onCancel, onSaved }) {
  const s = registration.student;
  const existingParent = registration.parent;
  const [form, setForm] = useState({
    first_name: s.first_name ?? "",
    last_name: s.last_name ?? "",
    birthdate: s.birthdate ?? "",
    allergies: s.allergies ?? "",
    dietary_restrictions: s.dietary_restrictions ?? "",
    medical_notes: s.medical_notes ?? "",
    medical_conditions: s.medical_conditions ?? "",
    epipen_required: !!s.epipen_required,
    medications_at_program: s.medications_at_program ?? "",
    emergency_contact_name: s.emergency_contact_name ?? "",
    emergency_contact_phone: s.emergency_contact_phone ?? "",
    special_needs_accommodations: s.special_needs_accommodations ?? "",
    homeroom_teacher: s.homeroom_teacher ?? "",
    authorized_pickup_contacts: registration.authorized_pickup_contacts ?? "",
    notes: registration.notes ?? "",
    parent_first: existingParent?.first_name ?? "",
    parent_last: existingParent?.last_name ?? "",
    parent_email: existingParent?.email ?? "",
    parent_phone: existingParent?.phone ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function update(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function save() {
    if (busy) return;
    // Guard against blanking a name that was set (a blank student name is never
    // intended). Only blocks when the operator clears a previously-filled name —
    // a row that was already blank can still save its other fields.
    const firstName = (form.first_name ?? "").trim();
    const lastName = (form.last_name ?? "").trim();
    if ((!firstName && (s.first_name ?? "").trim()) || (!lastName && (s.last_name ?? "").trim())) {
      setErr("Student first and last name can't be left blank.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const studentFields = {
        first_name: firstName,
        last_name: lastName,
        birthdate: emptyOrNull(form.birthdate),
        allergies: emptyOrNull(form.allergies),
        dietary_restrictions: emptyOrNull(form.dietary_restrictions),
        medical_notes: emptyOrNull(form.medical_notes),
        medical_conditions: emptyOrNull(form.medical_conditions),
        epipen_required: !!form.epipen_required,
        medications_at_program: emptyOrNull(form.medications_at_program),
        emergency_contact_name: emptyOrNull(form.emergency_contact_name),
        emergency_contact_phone: emptyOrNull(form.emergency_contact_phone),
        special_needs_accommodations: emptyOrNull(form.special_needs_accommodations),
        homeroom_teacher: emptyOrNull(form.homeroom_teacher),
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

      // Parent: update existing or create new
      if (emptyOrNull(form.parent_email)) {
        const parentFields = {
          first_name: emptyOrNull(form.parent_first) ?? "",
          last_name: emptyOrNull(form.parent_last) ?? "",
          email: form.parent_email.trim(),
          phone: emptyOrNull(form.parent_phone),
        };
        if (existingParent) {
          const { error: pErr } = await supabase
            .from("parents")
            .update(parentFields)
            .eq("id", existingParent.id);
          if (pErr) throw pErr;
        } else {
          const { data: newParent, error: pErr } = await supabase
            .from("parents")
            .insert(parentFields)
            .select("id")
            .single();
          if (pErr) throw pErr;
          regFields.parent_id = newParent.id;
          const { error: relErr } = await supabase
            .from("parent_org_relationships")
            .insert({ parent_id: newParent.id, organization_id: orgId });
          if (relErr) console.error("[CamperEditForm] parent_org_rel failed", relErr);
        }
      }

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
        {/* Student name — parents sometimes enter their own name here at
            registration; correcting it also syncs the family's Contacts entry
            (marketing_recipients child name) via a DB trigger. */}
        <Lbl label="Student first name">
          <Inp value={form.first_name} onChange={(v) => update("first_name", v)} placeholder="Required" />
        </Lbl>
        <Lbl label="Student last name">
          <Inp value={form.last_name} onChange={(v) => update("last_name", v)} placeholder="Required" />
        </Lbl>
        <Lbl label="Date of birth">
          <input
            type="date"
            value={form.birthdate}
            onChange={(e) => update("birthdate", e.target.value)}
            style={{
              width: "100%", padding: "5px 8px", border: `1px solid ${RULE}`, borderRadius: 5,
              fontSize: 13, fontFamily: "inherit", color: INK, background: "#fff",
            }}
          />
        </Lbl>

        {/* Parent / guardian */}
        <Lbl label="Parent first name">
          <Inp value={form.parent_first} onChange={(v) => update("parent_first", v)} />
        </Lbl>
        <Lbl label="Parent last name">
          <Inp value={form.parent_last} onChange={(v) => update("parent_last", v)} />
        </Lbl>
        <Lbl label="Parent email">
          <Inp value={form.parent_email} onChange={(v) => update("parent_email", v)} type="email" placeholder="Required to receive emails" />
        </Lbl>
        <Lbl label="Parent phone">
          <Inp value={form.parent_phone} onChange={(v) => update("parent_phone", v)} />
        </Lbl>

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
        <Lbl label="Homeroom teacher (for after-school release)">
          <Inp value={form.homeroom_teacher} onChange={(v) => update("homeroom_teacher", v)} placeholder="e.g. Ms. Jones, Room 12" />
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

      {/* Error repeated right next to the Save button — the form scrolls, and
          the top copy is off-screen when the operator clicks Save down here.
          See memory feedback_feedback_in_viewport. */}
      {err && (
        <div style={{ background: `${RED}1A`, color: RED, padding: 8, borderRadius: 6, marginTop: 12, fontSize: 12 }}>
          {err}
        </div>
      )}

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
            background: BRIGHT,
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

// target = { id, functionName, bodyKey, title, subtitle, noun }.
// Shared by camps (admin-import-camp-roster / camp_session_id) and afterschool
// programs (admin-import-program-roster / program_id).
function RosterUploadModal({ target, onClose, onImported }) {
  const [mode, setMode] = useState("csv"); // 'csv' or 'manual'
  const [csvHeaders, setCsvHeaders] = useState(null);
  const [csvRows, setCsvRows] = useState(null);     // RAW post-header rows; re-filtered on every (re)map
  const [detectMulti, setDetectMulti] = useState(false);
  const [mapping, setMapping] = useState({});
  const [reviewRows, setReviewRows] = useState(null); // editable registrant list
  const [showMapping, setShowMapping] = useState(false); // detection escape hatch
  const [parseError, setParseError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  // Shared landing point once a file (CSV or Excel) is parsed into a raw
  // array-of-arrays (every row, header included). detectStructure finds the
  // real header row(s) — which may be row 2+ under a report title, or several
  // stacked/merged rows — collapses them into one header, and returns the rows
  // below. filterDataRows then strips spacer/title/echoed-header/junk rows
  // (grouped attendance reports repeat the header band per camp). What's left
  // is auto-mapped and turned into the editable review list.
  function ingest(aoa) {
    const { headers, dataRows, multi } = detectStructure(aoa);
    if (!headers || headers.length === 0 || headers.every((h) => !String(h ?? "").trim())) {
      setParseError("That file doesn't have a header row we can read. Make sure a row has column titles like Name, Email, Phone.");
      return;
    }
    const autoMapped = autoMap(headers);
    const cleaned = filterDataRows(dataRows, headers, autoMapped, multi);
    if (cleaned.length === 0) {
      setParseError("We read the columns but found no camper rows. Use “adjust columns” below to point us at the name column.");
    }
    setCsvHeaders(headers);
    setCsvRows(dataRows);       // keep raw so a re-map can re-run filterDataRows
    setDetectMulti(multi);
    setMapping(autoMapped);
    setReviewRows(buildRegistrants(cleaned, headers, autoMapped));
  }

  function handleFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setParseError("");
    setResult(null);
    setShowMapping(false);
    const name = (f.name || "").toLowerCase();
    const isExcel = name.endsWith(".xlsx") || name.endsWith(".xls")
      || /spreadsheetml|ms-excel/.test(f.type || "");

    if (isExcel) {
      // Excel / Google-Sheets export. Parse the first sheet into an
      // array-of-arrays; SheetJS is dynamically imported so it only loads when
      // someone actually uploads a spreadsheet (keeps it out of the main bundle).
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const XLSX = await import("xlsx");
          // cellDates: true decodes date-formatted cells into JS Date objects
          // instead of leaving them as raw serial numbers (which were being
          // misread as far-future years downstream).
          const wb = XLSX.read(new Uint8Array(reader.result), { type: "array", cellDates: true });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          if (!sheet) {
            setParseError("That spreadsheet has no sheets we could read.");
            return;
          }
          const aoa = XLSX.utils
            .sheet_to_json(sheet, { header: 1, blankrows: false, defval: "" })
            .map((row) => row.map(excelCellToString));
          ingest(aoa);
        } catch (err) {
          console.error("[RosterUploadModal] excel parse failed", err);
          setParseError("Couldn't read that Excel file. Try saving it as a CSV and uploading that.");
        }
      };
      reader.readAsArrayBuffer(f);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        ingest(parseCsvRows(String(reader.result)));
      } catch (err) {
        console.error("[RosterUploadModal] csv parse failed", err);
        setParseError("Couldn't read that file. Try saving it as a CSV.");
      }
    };
    reader.readAsText(f);
  }

  // Re-detect from a (possibly hand-corrected) column mapping. Discards inline
  // edits made in the review list, so only used from the "adjust columns" panel.
  function reDetect(nextMapping) {
    setMapping(nextMapping);
    if (csvRows && csvHeaders) {
      // Re-filter from the raw rows with the corrected mapping so pointing us at
      // the name column also strips title/junk rows (and mapping a real column
      // can bring rows back that a wrong auto-map had excluded).
      const cleaned = filterDataRows(csvRows, csvHeaders, nextMapping, detectMulti);
      setReviewRows(buildRegistrants(cleaned, csvHeaders, nextMapping));
    }
  }

  function editReviewRow(index, key, value) {
    setReviewRows((rows) => rows.map((r, i) => (i === index ? { ...r, [key]: value } : r)));
  }

  function removeReviewRow(index) {
    setReviewRows((rows) => rows.filter((_, i) => i !== index));
  }

  async function submitCsv() {
    if (busy) return;
    const registrants = (reviewRows || []).filter(
      (r) => (r.student_first_name || "").trim(),
    );
    if (registrants.length === 0) {
      setParseError("No campers to import — every row is missing a first name. Check the 'adjust columns' panel.");
      return;
    }
    setBusy(true);
    setParseError("");
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke(target.functionName, {
        body: { [target.bodyKey]: target.id, registrants },
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
          borderRadius: 12,
          padding: 22,
          boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: INK, margin: 0 }}>
              Roster: {target.title}
            </h2>
            {target.subtitle && (
              <p style={{ color: MUTED, fontSize: 12, marginTop: 4 }}>
                {target.subtitle}
              </p>
            )}
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
          <TabBtn active={mode === "csv"} onClick={() => setMode("csv")} label="Upload a file" />
          <TabBtn active={mode === "manual"} onClick={() => setMode("manual")} label="Add one by hand" />
        </div>

        {mode === "csv" && (
          <CsvPanel
            target={target}
            csvHeaders={csvHeaders}
            csvRows={csvRows}
            mapping={mapping}
            reDetect={reDetect}
            reviewRows={reviewRows}
            onEditRow={editReviewRow}
            onRemoveRow={removeReviewRow}
            showMapping={showMapping}
            setShowMapping={setShowMapping}
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
            target={target}
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
        borderBottom: active ? `2px solid ${BRIGHT}` : "2px solid transparent",
        color: active ? BRIGHT : MUTED,
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

// Small labeled input used in the review list.
function ReviewInput({ label, value, onChange, width, placeholder }) {
  return (
    <label style={{ display: "block", flex: width ? `0 0 ${width}` : 1, minWidth: 0 }}>
      <span style={{ fontSize: 9.5, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, display: "block", marginBottom: 1 }}>
        {label}
      </span>
      <input
        value={value ?? ""}
        placeholder={placeholder || ""}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%", padding: "5px 7px", border: `1px solid ${RULE}`, borderRadius: 4,
          fontSize: 12.5, fontFamily: "inherit", background: "#fff", color: INK, boxSizing: "border-box",
        }}
      />
    </label>
  );
}

function CsvPanel({ target, csvHeaders, csvRows, mapping, reDetect, reviewRows, onEditRow, onRemoveRow, showMapping, setShowMapping, parseError, result, busy, onFile, onSubmit, onClose }) {
  const noun = target?.noun === "student" ? "student" : "camper";
  const nounCap = noun.charAt(0).toUpperCase() + noun.slice(1);
  const validCount = (reviewRows || []).filter((r) => (r.student_first_name || "").trim()).length;

  return (
    <div>
      <input
        type="file"
        accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        onChange={onFile}
        style={{ fontSize: 13, marginBottom: 10 }}
      />
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 10, lineHeight: 1.5 }}>
        Upload a CSV or Excel file (.csv, .xlsx) — exported from Squarespace, Google Sheets, or your registration platform. We&rsquo;ll detect the names and details automatically, then you check the list below and fix anything before saving.
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

      {!result && reviewRows && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>
            Review {validCount} {validCount === 1 ? noun : `${noun}s`} — edit anything that looks off, then import
          </div>

          <div style={{ maxHeight: 360, overflowY: "auto", border: `1px solid ${RULE}`, borderRadius: 8, padding: 8, marginBottom: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            {reviewRows.map((r, i) => {
              const missingName = !(r.student_first_name || "").trim();
              return (
                <div key={i} style={{ border: `1px solid ${missingName ? RED + "66" : RULE}`, borderRadius: 6, padding: 8, background: missingName ? `${RED}0A` : "#fff" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
                    <ReviewInput label={`${nounCap} first`} value={r.student_first_name} onChange={(v) => onEditRow(i, "student_first_name", v)} placeholder="required" />
                    <ReviewInput label="Last" value={r.student_last_name} onChange={(v) => onEditRow(i, "student_last_name", v)} />
                    <ReviewInput label="Grade" value={r.grade} onChange={(v) => onEditRow(i, "grade", v)} width="58px" />
                    <ReviewInput label="Birthdate" value={r.birthdate} onChange={(v) => onEditRow(i, "birthdate", v)} width="120px" placeholder="YYYY-MM-DD" />
                    <button
                      type="button"
                      onClick={() => onRemoveRow(i)}
                      title="Remove this row"
                      style={{ flex: "0 0 auto", background: "transparent", border: `1px solid ${RULE}`, color: MUTED, borderRadius: 4, width: 28, height: 30, cursor: "pointer", fontSize: 14, lineHeight: 1 }}
                    >
                      ✕
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    <ReviewInput label="Parent first" value={r.parent_first_name} onChange={(v) => onEditRow(i, "parent_first_name", v)} />
                    <ReviewInput label="Parent last" value={r.parent_last_name} onChange={(v) => onEditRow(i, "parent_last_name", v)} />
                    <ReviewInput label="Email" value={r.parent_email} onChange={(v) => onEditRow(i, "parent_email", v)} />
                    <ReviewInput label="Phone" value={r.parent_phone} onChange={(v) => onEditRow(i, "parent_phone", v)} width="120px" />
                  </div>
                  {(() => {
                    // Show every other field that has a value — a faithful
                    // preview of everything being imported for this camper.
                    const extras = EXTRA_FIELD_DEFS.filter(
                      (d) => (r[d.key] ?? "").toString().trim() !== "",
                    );
                    if (extras.length === 0) return null;
                    return (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 6, marginTop: 6 }}>
                        {extras.map((d) => (
                          <ReviewInput key={d.key} label={d.label} value={r[d.key]} onChange={(v) => onEditRow(i, d.key, v)} />
                        ))}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
            {reviewRows.length === 0 && (
              <div style={{ fontSize: 12.5, color: MUTED, padding: 8 }}>No rows found in that file.</div>
            )}
          </div>

          {/* Escape hatch: only needed when auto-detection got a column wrong. */}
          {csvHeaders && (
            <div style={{ marginBottom: 14 }}>
              <button
                type="button"
                onClick={() => setShowMapping(!showMapping)}
                style={{ background: "transparent", border: "none", color: PURPLE, fontSize: 12, fontFamily: "inherit", cursor: "pointer", padding: 0, textDecoration: "underline" }}
              >
                {showMapping ? "Hide column detection" : "Something look wrong? Adjust which column is which"}
              </button>
              {showMapping && (
                <>
                  <div style={{ fontSize: 11, color: MUTED, margin: "8px 0 6px", lineHeight: 1.5 }}>
                    Changing a column re-reads the whole file, so it&rsquo;ll discard edits you made above.
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, maxHeight: 240, overflowY: "auto", padding: 4, border: `1px solid ${RULE}`, borderRadius: 6 }}>
                    {FIELD_DEFS.map((def) => (
                      <div key={def.key} style={{ padding: "6px 8px" }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: INK, marginBottom: 2 }}>{def.label}</div>
                        <select
                          value={mapping[def.key] || ""}
                          onChange={(e) => reDetect({ ...mapping, [def.key]: e.target.value || undefined })}
                          style={{ width: "100%", padding: "5px 8px", border: `1px solid ${RULE}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit", background: "#fff", color: INK }}
                        >
                          <option value="">— not in this file —</option>
                          {csvHeaders.map((h, idx) => (
                            <option key={idx} value={h}>{h || `(column ${idx + 1})`}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
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
        {!result && reviewRows && (
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || validCount === 0}
            style={{
              padding: "8px 16px",
              background: BRIGHT,
              color: "#fff",
              border: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: busy || validCount === 0 ? "not-allowed" : "pointer",
              opacity: busy || validCount === 0 ? 0.5 : 1,
            }}
          >
            {busy ? "Importing…" : `Import ${validCount} ${validCount === 1 ? noun : `${noun}s`}`}
          </button>
        )}
      </div>
    </div>
  );
}

function ManualPanel({ target, busy, setBusy, onSaved, onClose }) {
  const noun = target?.noun === "student" ? "student" : "camper";
  const nounCap = noun.charAt(0).toUpperCase() + noun.slice(1);
  const isProgram = target?.bodyKey === "program_id";
  const EMPTY = {
    student_first_name: "",
    student_last_name: "",
    grade: "",
    birthdate: "",
    allergies: "",
    medical_notes: "",
    emergency_contact_name: "",
    emergency_contact_phone: "",
    homeroom_teacher: "",
    parent_first_name: "",
    parent_last_name: "",
    parent_email: "",
    parent_phone: "",
    // Photo release is required to ENROLL (DB rule). Default true — every native
    // registration agreed to it; an offline add is the operator attesting the
    // same. Unchecking adds them as pending (not enrolled).
    photo_release_consent: true,
  };
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState("");
  const [savedFlash, setSavedFlash] = useState("");

  function update(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    if (busy) return;
    if (!form.student_first_name.trim()) {
      setError(`${nounCap} first name is required.`);
      return;
    }
    setBusy(true);
    setError("");
    setSavedFlash("");
    try {
      const payload = { ...form, photo_release_consent: form.photo_release_consent ? "yes" : "no" };
      const { data, error } = await supabase.functions.invoke(target.functionName, {
        body: { [target.bodyKey]: target.id, registrants: [payload] },
      });
      if (error || data?.error) {
        setError(data?.error || error?.message || "Couldn't save.");
        setBusy(false);
        return;
      }
      const name = `${form.student_first_name} ${form.student_last_name}`.trim();
      const asPending = isProgram && !form.photo_release_consent;
      setSavedFlash(asPending
        ? `Added ${name} as pending — they need photo release on file to count as enrolled.`
        : `Added ${name} to the roster.`);
      if (onSaved) onSaved(data);
      setForm(EMPTY); // clear for next entry
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
        {isProgram
          ? "Add one student at a time — for kids who registered offline or were added by a partner, not through Enrops."
          : "Add one camper at a time — useful for partner-venue camps that don’t come through Squarespace, or last-minute adds."}
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
        <Lbl label={`${nounCap} first name *`}>
          <Inp value={form.student_first_name} onChange={(v) => update("student_first_name", v)} />
        </Lbl>
        <Lbl label={`${nounCap} last name`}>
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
        <Lbl label="Homeroom teacher" full>
          <Inp value={form.homeroom_teacher} onChange={(v) => update("homeroom_teacher", v)} placeholder="e.g. Ms. Jones, Room 12" />
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
        <div style={{ gridColumn: "1 / -1", marginTop: 2 }}>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, color: INK, lineHeight: 1.4 }}>
            <input
              type="checkbox"
              checked={form.photo_release_consent}
              onChange={(e) => update("photo_release_consent", e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              Family has agreed to the photo release.
              {isProgram && (
                <span style={{ color: MUTED }}> Required to count as enrolled — uncheck only if this family declined (they'll be added as pending).</span>
              )}
            </span>
          </label>
        </div>
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
            background: BRIGHT,
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

// ─── Afterschool program rosters ───────────────────────────────────────────
// Fall/afterschool registration is native, so these rosters already exist —
// this lists programs for a term with their enrolled count (matching
// ProgramsCalendar: un-cancelled, paid OR confirmed), each linking to the
// per-program roster view + a partner-email action.

const DAY_SHORT = { monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun" };
function dayShort(d) { return DAY_SHORT[(d ?? "").toLowerCase()] ?? (d ?? ""); }

function AfterschoolRostersSection({ org, canEdit }) {
  const [term, setTerm] = useState("FA26");
  const [programs, setPrograms] = useState(null);
  const [error, setError] = useState("");
  const [emailingProgram, setEmailingProgram] = useState(null);
  const [uploadingProgram, setUploadingProgram] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setPrograms(null);
      setError("");
      try {
        const { data: progRows, error: pErr } = await supabase
          .from("programs")
          .select("id, curriculum, day_of_week, start_time, end_time, max_capacity, program_location_id, first_session_date, session_count, program_locations ( name, district )")
          .eq("organization_id", org.id)
          .eq("term", term);
        if (pErr) throw pErr;
        const ids = (progRows ?? []).map((p) => p.id);
        const counts = new Map();
        const lastEmailed = new Map();
        if (ids.length > 0) {
          const { data: regs } = await supabase
            .from("registrations")
            .select("program_id, status, payment_status")
            .in("program_id", ids)
            .is("cancelled_at", null);
          for (const r of regs ?? []) {
            if (r.payment_status === "paid" || r.status === "confirmed") {
              counts.set(r.program_id, (counts.get(r.program_id) ?? 0) + 1);
            }
          }
          const { data: emails } = await supabase
            .from("roster_email_sends")
            .select("program_id, sent_at, status")
            .in("program_id", ids)
            .eq("status", "sent")
            .order("sent_at", { ascending: false });
          for (const e of emails ?? []) {
            if (e.program_id && !lastEmailed.has(e.program_id)) lastEmailed.set(e.program_id, e.sent_at);
          }
        }
        if (!cancelled) {
          setPrograms((progRows ?? [])
            .map((p) => ({ ...p, enrolled: counts.get(p.id) ?? 0, last_emailed_at: lastEmailed.get(p.id) ?? null }))
            .sort((a, b) => (b.enrolled - a.enrolled) || (a.curriculum ?? "").localeCompare(b.curriculum ?? "")));
        }
      } catch (e) {
        if (!cancelled) { setError(e.message ?? "Couldn't load afterschool programs."); setPrograms([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [org?.id, term]);

  // Re-count one program's enrolled (paid OR confirmed) after an edit/import.
  function refreshProgramCount(programId, bump = 0) {
    supabase
      .from("registrations")
      .select("status, payment_status")
      .eq("program_id", programId)
      .is("cancelled_at", null)
      .then(({ data }) => {
        const n = (data ?? []).filter((r) => r.payment_status === "paid" || r.status === "confirmed").length;
        setPrograms((ps) => (ps ?? []).map((p) => p.id === programId ? { ...p, enrolled: n, refresh_token: (p.refresh_token || 0) + bump } : p));
      });
  }

  function subtitleFor(p) {
    return [
      p.program_locations?.name,
      p.day_of_week ? `${dayShort(p.day_of_week)}s` : null,
      p.start_time || null,
    ].filter(Boolean).join(" · ");
  }

  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, color: MUTED }}>
          Rosters fill in as families register. Add offline / partner kids by hand or upload a file.
        </div>
        <select value={term} onChange={(e) => { setTerm(e.target.value); setExpandedId(null); }} style={{ padding: "7px 10px", border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: "inherit", fontSize: 13, background: "#fff", color: INK }}>
          <option value="FA26">Fall 2026 (FA26)</option>
          <option value="WI27">Winter 2027 (WI27)</option>
          <option value="SP27">Spring 2027 (SP27)</option>
        </select>
      </div>

      {error && <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {programs === null && <div style={{ color: MUTED, fontSize: 13 }}>Loading…</div>}
      {programs !== null && programs.length === 0 && !error && (
        <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 20, color: MUTED, textAlign: "center", fontSize: 13 }}>
          No afterschool programs for {term} yet.
        </div>
      )}
      {programs !== null && programs.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {programs.map((p) => (
            <ProgramRosterRow
              key={p.id}
              program={p}
              orgId={org?.id}
              orgSlug={org?.slug}
              canEdit={canEdit}
              expanded={expandedId === p.id}
              onToggle={() => setExpandedId((cur) => (cur === p.id ? null : p.id))}
              onUpload={() => setUploadingProgram(p)}
              onEmail={() => setEmailingProgram(p)}
              subtitle={subtitleFor(p)}
              onChanged={() => refreshProgramCount(p.id)}
            />
          ))}
        </div>
      )}

      {emailingProgram && (
        <EmailRosterModal
          orgId={org?.id}
          target={{
            kind: "program",
            id: emailingProgram.id,
            locationId: emailingProgram.program_location_id,
            title: emailingProgram.curriculum,
            subtitle: subtitleFor(emailingProgram),
            functionName: "email-program-roster",
            bodyKey: "program_id",
          }}
          onClose={() => setEmailingProgram(null)}
          onSent={() => setEmailingProgram(null)}
        />
      )}

      {uploadingProgram && (
        <RosterUploadModal
          target={{
            id: uploadingProgram.id,
            functionName: "admin-import-program-roster",
            bodyKey: "program_id",
            noun: "student",
            title: uploadingProgram.curriculum,
            subtitle: subtitleFor(uploadingProgram),
          }}
          onClose={() => setUploadingProgram(null)}
          onImported={() => {
            // New rows just landed — refresh count + force the editor to re-fetch.
            refreshProgramCount(uploadingProgram.id, 1);
            setExpandedId(uploadingProgram.id);
          }}
        />
      )}
    </div>
  );
}

// One afterschool program in the roster list. Mirrors CampRow: expand to edit
// enrolled kids inline, plus add/upload + email + view/print actions.
function ProgramRosterRow({ program: p, orgId, orgSlug, canEdit, expanded, onToggle, onUpload, onEmail, subtitle, onChanged }) {
  const lastEmailedLabel = p.last_emailed_at
    ? new Date(p.last_emailed_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : null;
  const [showInvite, setShowInvite] = useState(false);
  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderLeft: p.enrolled > 0 ? `3px solid ${OK}` : `3px solid ${RULE}`, borderRadius: 12, padding: "12px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={onToggle}
          style={{ minWidth: 0, flex: "1 1 220px", background: "transparent", border: "none", padding: 0, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: INK, lineHeight: 1.3, display: "flex", alignItems: "center", gap: 6 }}>
            <Chevron open={expanded} color={BRIGHT} />
            <span>{p.curriculum ?? "Untitled"}</span>
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2, paddingLeft: 18 }}>{subtitle || "—"}</div>
        </button>

        <div style={{ textAlign: "right", minWidth: 180 }}>
          <div style={{ fontSize: 12, color: INK, lineHeight: 1.4 }}>
            <strong>{p.enrolled}</strong> enrolled
            {p.max_capacity ? <span style={{ color: MUTED }}> / {p.max_capacity} seats</span> : null}
          </div>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 6, flexWrap: "wrap" }}>
            {canEdit && (
              <button type="button" onClick={onUpload} style={{ padding: "6px 12px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
                Add / upload →
              </button>
            )}
            {p.enrolled > 0 && (
              <button type="button" onClick={onEmail} style={{ padding: "6px 12px", background: "transparent", color: BRIGHT, border: `1px solid ${BRIGHT}`, borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }} title="Send a branded PDF roster to this location's partner contacts">
                Email roster →
              </button>
            )}
            {canEdit && p.enrolled > 0 && (
              <button type="button" onClick={() => setShowInvite(true)} style={{ padding: "6px 12px", background: "transparent", color: BRIGHT, border: `1px solid ${BRIGHT}`, borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }} title="Preview and send a portal sign-in invite to this program's families.">
                Invite families →
              </button>
            )}
            <Link to={`/admin/programs/${p.id}/roster`} style={{ padding: "6px 12px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 12, fontWeight: 600, textDecoration: "none" }} title="Open the printable roster">
              View / print →
            </Link>
          </div>
          {lastEmailedLabel && <div style={{ fontSize: 11, color: MUTED, marginTop: 4, textAlign: "right" }}>Last emailed {lastEmailedLabel}</div>}
          {showInvite && (
            <InviteFamiliesModal
              orgId={orgId}
              orgSlug={orgSlug}
              programId={p.id}
              onClose={() => setShowInvite(false)}
            />
          )}
        </div>
      </div>

      {expanded && (
        <RosterEditor
          target={{ column: "program_id", id: p.id }}
          orgId={orgId}
          onChanged={onChanged}
          refreshToken={p.refresh_token || 0}
          excludeCancelled
          canManage={canEdit}
        />
      )}
    </div>
  );
}
