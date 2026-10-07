// Reschedule a session: take one date off one class, then tell the people who
// need to know. Also handles the reverse, "Put this day back".
//
// Jessica, 2026-10-07: a button on the class, a pop-up that asks yes/no on a
// make-up week, reminds the operator to tell the instructor and the families,
// can be undone, and never says "cancel". It reuses what already works rather
// than building a parallel send path:
//   - the schedule change is ONE RPC (skip_program_session / restore_program_session),
//     which also withholds an unpaid pay line and closes open sub offers;
//   - the lead instructor is told through notify-instructor-removed, which sends
//     exactly the subject/body the operator sees and can edit here;
//   - an accepted sub is released through cancel-sub-cover, which tells them
//     there is no class that day (and does NOT tell the lead "you're back on");
//   - families are written to in Message families, opened with the approved
//     draft filled in - its own preview, test send, recipient list and log.
// Nothing is sent without the operator pressing a button for it.
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../../lib/supabase.js";
import MessageFamiliesModal from "./MessageFamiliesModal.jsx";
import {
  longDate,
  familyRescheduledDraft, familyBackOnDraft,
  instructorRescheduledDraft, instructorBackOnDraft,
} from "../../../lib/rescheduleCopy.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const RED = "#b53737";
const OK_GREEN = "#3a7c3a";

function todayLocalIso() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

const btn = (primary, disabled) => ({
  padding: "8px 14px", borderRadius: 6, fontSize: 13, fontWeight: primary ? 700 : 600,
  fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1,
  background: primary ? BRIGHT : "#fff", color: primary ? "#fff" : INK,
  border: primary ? "none" : `1px solid ${RULE}`,
});

const choiceStyle = (on, disabled) => ({
  display: "block", width: "100%", textAlign: "left", padding: "10px 12px", marginBottom: 8,
  borderRadius: 8, border: `1px solid ${on ? BRIGHT : RULE}`, background: on ? `${BRIGHT}12` : "#fff",
  fontFamily: "inherit", fontSize: 13, color: disabled ? MUTED : INK, cursor: disabled ? "not-allowed" : "pointer",
});

// mode: "skip" (pick a day and take it off) | "restore" (put `skip` back).
//   program   - the class row (id, curriculum, schedule_mode, program_locations)
//   schedule  - [{ date, kind }] from derive_program_session_schedule
//   skip      - restore mode only: the program_session_skips row being put back
//   orgId, senderName
//   onChanged - re-derive the schedule after a successful write; returns false if
//               that refresh failed
export default function RescheduleSessionModal({ mode = "skip", program, schedule, skip, orgId, senderName, onChanged, onClose }) {
  const sessions = useMemo(
    () => (schedule ?? []).filter((x) => x?.kind === "session").map((x) => x.date).sort(),
    [schedule],
  );
  const today = todayLocalIso();
  const upcoming = sessions.filter((d) => d >= today);
  const lastDate = sessions[sessions.length - 1] ?? null;
  const isRange = program?.schedule_mode === "range";
  const className = program?.curriculum || "this class";
  const school = program?.program_locations?.name || "";

  const [step, setStep] = useState(mode === "restore" ? "confirm-restore" : "choose");
  const [date, setDate] = useState(upcoming[0] ?? sessions[0] ?? "");
  const [makeup, setMakeup] = useState(isRange ? false : true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState(null); // RPC result
  const [refreshFailed, setRefreshFailed] = useState(false);

  // Who teaches it. Loaded up front so the "tell" step is ready the moment the
  // write lands; a failure is shown, not swallowed, because "nobody to tell"
  // and "couldn't look" are different things for the operator to act on.
  const [leads, setLeads] = useState(null);
  const [leadsErr, setLeadsErr] = useState("");
  useEffect(() => {
    if (!program?.id) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("program_assignments")
        .select("instructor_id, instructors:instructor_id(id, first_name, preferred_name, last_name, email)")
        .eq("program_id", program.id)
        .eq("status", "confirmed");
      if (cancelled) return;
      if (error) { setLeadsErr(error.message); setLeads([]); return; }
      setLeads((data ?? []).map((r) => r.instructors).filter(Boolean));
    })();
    return () => { cancelled = true; };
  }, [program?.id]);

  const isLast = date && date === lastDate;
  // The two server rules, mirrored so the operator is never offered a choice
  // that will be refused: a date-range class has no make-up, and the last class
  // can only move with one.
  const makeupAllowed = !isRange;
  const noMakeupAllowed = !isLast;
  const effectiveMakeup = !makeupAllowed ? false : !noMakeupAllowed ? true : makeup;

  async function doSkip() {
    setBusy(true); setErr("");
    const { data, error } = await supabase.rpc("skip_program_session", {
      p_program_id: program.id, p_date: date, p_makeup: effectiveMakeup,
    });
    if (error) { setErr(error.message || "That day couldn't be rescheduled."); setBusy(false); return; }
    const fresh = onChanged ? await onChanged(program.id) : true;
    setRefreshFailed(fresh === false);
    setResult(data);
    setStep("tell");
    setBusy(false);
  }

  async function doRestore() {
    setBusy(true); setErr("");
    const { data, error } = await supabase.rpc("restore_program_session", { p_skip_id: skip.id });
    if (error) { setErr(error.message || "That day couldn't be put back."); setBusy(false); return; }
    const fresh = onChanged ? await onChanged(program.id) : true;
    setRefreshFailed(fresh === false);
    setResult(data);
    setStep("tell-back");
    setBusy(false);
  }

  // ── the "tell" step: what changed, and who to tell ────────────────────
  const told = result?.date ?? skip?.session_date ?? date;
  const nextAfter = (d) => sessions.find((x) => x > d) ?? null;

  const familyDraft = step === "tell"
    ? familyRescheduledDraft({ date: told, makeup: result?.makeup, lastDate: result?.last_date, nextDate: nextAfter(told) })
    : step === "tell-back"
      ? familyBackOnDraft({ date: told, makeup: skip?.makeup, previousLastDate: result?.last_date })
      : null;

  const [showFamilies, setShowFamilies] = useState(false);
  const [familiesOpened, setFamiliesOpened] = useState(false);

  if (showFamilies && familyDraft) {
    return (
      <MessageFamiliesModal
        programs={[program]}
        orgId={orgId}
        initialSubject={familyDraft.subject}
        initialBodyHtml={familyDraft.bodyHtml}
        onClose={() => { setShowFamilies(false); setFamiliesOpened(true); }}
      />
    );
  }

  return (
    <div
      onClick={() => !busy && onClose?.()}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", zIndex: 300, overflowY: "auto" }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, maxWidth: 520, width: "100%", padding: 20, boxShadow: "0 10px 40px rgba(0,0,0,0.25)", fontFamily: "inherit", textAlign: "left" }}>

        {step === "choose" && (
          <>
            <div style={{ fontSize: 16, fontWeight: 700, color: PURPLE, marginBottom: 4 }}>Reschedule a session</div>
            <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 14 }}>{className}{school ? ` · ${school}` : ""}</div>

            <label style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>Which day?</label>
            <select
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={busy}
              style={{ width: "100%", padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", marginBottom: 14, background: "#fff", color: INK }}
            >
              {sessions.map((d) => (
                <option key={d} value={d}>{longDate(d)}{d < today ? " (past)" : ""}</option>
              ))}
            </select>

            <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Add a make-up session at the end?</div>
            <button
              type="button"
              disabled={busy || !makeupAllowed}
              onClick={() => setMakeup(true)}
              style={choiceStyle(effectiveMakeup, !makeupAllowed)}
            >
              <strong>Yes, add a make-up week.</strong>{" "}
              {makeupAllowed
                ? "The class gets one more week at the end, so families still get every session."
                : "Not available: this class runs between fixed dates."}
            </button>
            <button
              type="button"
              disabled={busy || !noMakeupAllowed}
              onClick={() => setMakeup(false)}
              style={choiceStyle(!effectiveMakeup, !noMakeupAllowed)}
            >
              <strong>No make-up, just skip this day.</strong>{" "}
              {noMakeupAllowed
                ? `Families get ${Math.max(sessions.length - 1, 0)} sessions instead of ${sessions.length}. The class still ends on its usual last day.`
                : "Not available for the last class: it can only move with a make-up."}
            </button>

            {err && <div style={{ fontSize: 12.5, color: RED, margin: "8px 0" }}>{err}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
              <button type="button" onClick={onClose} disabled={busy} style={btn(false, busy)}>Close</button>
              <button type="button" onClick={doSkip} disabled={busy || !date} style={btn(true, busy || !date)}>
                {busy ? "Saving…" : "Reschedule this session"}
              </button>
            </div>
          </>
        )}

        {step === "confirm-restore" && (
          <>
            <div style={{ fontSize: 16, fontWeight: 700, color: PURPLE, marginBottom: 8 }}>Put this day back?</div>
            <div style={{ fontSize: 13, color: INK, lineHeight: 1.5, marginBottom: 12 }}>
              <strong>{longDate(skip?.session_date)}</strong> goes back on {className}'s schedule
              {skip?.makeup ? ", and the make-up week added at the end comes off." : "."}
              {" "}Anyone you told it was off will need to hear it's back on. A sub who was released for that day is not re-booked.
            </div>
            {err && <div style={{ fontSize: 12.5, color: RED, marginBottom: 8 }}>{err}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={onClose} disabled={busy} style={btn(false, busy)}>Keep it off</button>
              <button type="button" onClick={doRestore} disabled={busy} style={btn(true, busy)}>{busy ? "Saving…" : "Put this day back"}</button>
            </div>
          </>
        )}

        {(step === "tell" || step === "tell-back") && (
          <>
            <div style={{ fontSize: 16, fontWeight: 700, color: OK_GREEN, marginBottom: 4 }}>
              ✓ {longDate(told)} is {step === "tell" ? "off the schedule" : "back on the schedule"}.
            </div>
            <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 6 }}>
              {step === "tell" && result?.makeup && result?.last_date && <>A make-up week was added: the last class is now {longDate(result.last_date)}. </>}
              {step === "tell" && !result?.makeup && <>No make-up: the class keeps its original last day. </>}
              {step === "tell-back" && result?.last_date && <>The last class is {longDate(result.last_date)}. </>}
              {step === "tell" && result?.voided_pay_lines > 0 && <>That day's pay line is marked "No class, not paid". </>}
            </div>
            {refreshFailed && (
              <div style={{ fontSize: 12.5, color: RED, marginBottom: 6 }}>
                Saved, but the date list behind this couldn't refresh. Reload the page to see the new dates.
              </div>
            )}
            <div style={{ fontSize: 13, fontWeight: 700, color: INK, margin: "12px 0 8px" }}>Now let people know:</div>

            {leadsErr && <div style={{ fontSize: 12.5, color: RED, marginBottom: 8 }}>Couldn't look up who teaches this class ({leadsErr}). Tell them yourself.</div>}
            {(leads ?? []).map((inst) => (
              <InstructorRow
                key={inst.id}
                inst={inst}
                orgId={orgId}
                draft={step === "tell"
                  ? instructorRescheduledDraft({
                      firstName: inst.preferred_name || inst.first_name, className, school, date: told,
                      makeup: result?.makeup, lastDate: result?.last_date, nextDate: nextAfter(told), senderName,
                    })
                  : instructorBackOnDraft({
                      firstName: inst.preferred_name || inst.first_name, className, school, date: told,
                      makeup: skip?.makeup, previousLastDate: result?.last_date, senderName,
                    })}
              />
            ))}

            {step === "tell" && (result?.confirmed_covers ?? []).map((c) => (
              <SubRow key={c.substitution_id} cover={c} />
            ))}

            <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: "10px 12px", marginBottom: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 220px", fontSize: 13, color: INK }}>
                <strong>Families</strong>
                <div style={{ fontSize: 12, color: MUTED }}>Opens Message families with a draft you can read and edit first.</div>
              </div>
              <button type="button" onClick={() => setShowFamilies(true)} style={btn(!familiesOpened, false)}>
                {familiesOpened ? "Write to families again" : "Write to families"}
              </button>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button type="button" onClick={onClose} style={btn(false, false)}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// One instructor: preview the email, edit it, send it. The send result is shown
// on this row, where the operator is looking.
function InstructorRow({ inst, orgId, draft }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.bodyText);
  const [state, setState] = useState("idle"); // idle | sending | sent | error
  const [err, setErr] = useState("");
  const name = inst.preferred_name || inst.first_name || "The instructor";

  async function send() {
    setState("sending"); setErr("");
    const { data, error } = await supabase.functions.invoke("notify-instructor-removed", {
      body: { instructor_id: inst.id, organization_id: orgId, subject, body_text: body },
    });
    if (error || !data?.sent) {
      let detail = data?.error || error?.message || "send failed";
      try { const j = await error?.context?.json?.(); if (j?.error) detail = j.error; } catch { /* keep detail */ }
      setErr(detail === "instructor_missing_email" ? `${name} has no email address on file.` : `Couldn't send (${detail}).`);
      setState("error");
      return;
    }
    setState("sent");
  }

  return (
    <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: "10px 12px", marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px", fontSize: 13, color: INK }}>
          <strong>{name}</strong> teaches this class.
          {state === "sent" && <div style={{ fontSize: 12, color: OK_GREEN, fontWeight: 600 }}>✓ Emailed {inst.email}</div>}
          {state === "error" && <div style={{ fontSize: 12, color: RED }}>{err}</div>}
        </div>
        {state !== "sent" && (
          <>
            <button type="button" onClick={() => setOpen((o) => !o)} style={btn(false, false)}>{open ? "Hide email" : "Preview email"}</button>
            <button type="button" onClick={send} disabled={state === "sending" || !subject.trim() || !body.trim()} style={btn(true, state === "sending")}>
              {state === "sending" ? "Sending…" : "Send"}
            </button>
          </>
        )}
      </div>
      {open && state !== "sent" && (
        <div style={{ marginTop: 10 }}>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            style={{ width: "100%", padding: "7px 9px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", marginBottom: 6, boxSizing: "border-box" }}
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={9}
            style={{ width: "100%", padding: "7px 9px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" }}
          />
        </div>
      )}
    </div>
  );
}

// A sub who had accepted this day. Releasing tells them there is no class; the
// lead is not told "you're back on" (cancel-sub-cover checks the schedule).
function SubRow({ cover }) {
  const [state, setState] = useState("idle");
  const [err, setErr] = useState("");
  const name = cover.name || "The sub";

  async function release() {
    setState("sending"); setErr("");
    const { data, error } = await supabase.functions.invoke("cancel-sub-cover", {
      body: { substitution_id: cover.substitution_id, still_needs_cover: false },
    });
    if (error || !data?.ok) {
      let detail = data?.detail || data?.error || error?.message || "release failed";
      try { const j = await error?.context?.json?.(); if (j?.detail || j?.error) detail = j.detail || j.error; } catch { /* keep detail */ }
      setErr(detail);
      setState("error");
      return;
    }
    setState(data.notified_sub ? "sent" : "released-untold");
  }

  return (
    <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: "10px 12px", marginBottom: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 220px", fontSize: 13, color: INK }}>
        <strong>{name}</strong> was covering this day.
        {state === "idle" && <div style={{ fontSize: 12, color: MUTED }}>They'll be told they're not needed and there's no class.</div>}
        {state === "sent" && <div style={{ fontSize: 12, color: OK_GREEN, fontWeight: 600 }}>✓ Released and told</div>}
        {state === "released-untold" && <div style={{ fontSize: 12, color: RED }}>Released, but the email didn't go out. Let {name} know yourself.</div>}
        {state === "error" && <div style={{ fontSize: 12, color: RED }}>{err}</div>}
      </div>
      {(state === "idle" || state === "error" || state === "sending") && (
        <button type="button" onClick={release} disabled={state === "sending"} style={btn(true, state === "sending")}>
          {state === "sending" ? "Releasing…" : `Release ${name.split(" ")[0]}`}
        </button>
      )}
    </div>
  );
}
