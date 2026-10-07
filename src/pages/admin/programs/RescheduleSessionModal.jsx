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
  // Credit families for a lost day? null = not answered yet. Deliberately no
  // default: it is the provider's own policy, and a pre-ticked answer is one
  // somebody could submit without reading.
  const [credit, setCredit] = useState(null);
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
        .select("role, instructor_id, instructors:instructor_id(id, first_name, preferred_name, last_name, email)")
        .eq("program_id", program.id)
        // "On this class" = accepted (confirmed) OR offered and not yet answered
        // (published) - the set email-program-roster and the curriculum-change
        // notice already use. An instructor holding an open offer would accept
        // later and turn up on a day that is not happening.
        .in("status", ["confirmed", "published"]);
      if (cancelled) return;
      if (error) { setLeadsErr(error.message); setLeads([]); return; }
      setLeads((data ?? []).filter((r) => r.instructors).map((r) => ({ ...r.instructors, role: r.role })));
    })();
    return () => { cancelled = true; };
  }, [program?.id]);

  // The sign-off, spelled the way cancel-sub-cover spells it for the sub on
  // the same day: the first word of the org's email sender name ("Jessica"
  // from "Jessica @ Journey to STEAM"), falling back to the org name. A miss
  // just leaves the org name - this is a signature, not a decision.
  const [signOff, setSignOff] = useState(senderName || "");
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("org_branding").select("email_from_name").eq("organization_id", orgId).maybeSingle();
      if (cancelled) return;
      const first = (data?.email_from_name ?? senderName ?? "").split(" ")[0];
      if (first) setSignOff(first);
    })();
    return () => { cancelled = true; };
  }, [orgId, senderName]);

  const isLast = date && date === lastDate;
  // The two server rules, mirrored so the operator is never offered a choice
  // that will be refused: a date-range class has no make-up, and the last class
  // can only move with one.
  const makeupAllowed = !isRange;
  const noMakeupAllowed = !isLast;
  const effectiveMakeup = !makeupAllowed ? false : !noMakeupAllowed ? true : makeup;
  // Both rules at once: the LAST class of a date-range class has no allowed
  // choice, so say that instead of offering a button the server will refuse.
  const noChoice = !makeupAllowed && !noMakeupAllowed;

  async function doSkip() {
    setBusy(true); setErr("");
    const { data, error } = await supabase.rpc("skip_program_session", {
      p_program_id: program.id, p_date: date, p_makeup: effectiveMakeup,
      p_credit_families: !effectiveMakeup && credit === true,
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

  // Credits are written INSIDE skip_program_session (same transaction as the
  // day itself), so by the time the tell step shows they have all happened or
  // the whole save failed - there is no half-credited state to warn about.
  // Declared above familyDraft, which reads it.
  const creditedCount = (result?.credits?.credited ?? []).length;

  // ── the "tell" step: what changed, and who to tell ────────────────────
  const told = result?.date ?? skip?.session_date ?? date;
  const nextAfter = (d) => sessions.find((x) => x > d) ?? null;

  const familyDraft = step === "tell"
    ? familyRescheduledDraft({
        date: told, makeup: result?.makeup, lastDate: result?.last_date, nextDate: nextAfter(told),
        // Only once a credit has actually been written: the sentence promises
        // money on the family's account.
        credited: result?.credit_families === true && creditedCount > 0,
      })
    : step === "tell-back"
      ? familyBackOnDraft({ date: told, makeup: skip?.makeup, previousLastDate: result?.last_date, creditsRemoved: (result?.credits_voided ?? 0) > 0 && (result?.credits_kept ?? []).length === 0 })
      // Only when EVERY credit was removed: a family whose credit was kept
      // (already used) would otherwise read that theirs was taken back. With
      // any kept, the panel names them and the operator words that one.
      : null;

  const [showFamilies, setShowFamilies] = useState(false);
  const [familiesOpened, setFamiliesOpened] = useState(false);

  // Accepted subs this panel has released. Done warns once while anyone is
  // left: the RPC's confirmed_covers exists only in THIS response, and nothing
  // else ever releases an accepted sub, so closing here would leave a person
  // booked for a day with no class.
  const [releasedIds, setReleasedIds] = useState(() => new Set());
  const [doneWarned, setDoneWarned] = useState(false);
  const unreleased = step === "tell"
    ? (result?.confirmed_covers ?? []).filter((c) => !releasedIds.has(c.substitution_id))
    : [];
  function done() {
    if (unreleased.length > 0 && !doneWarned) { setDoneWarned(true); return; }
    onClose?.();
  }

  // Put back, but a no-school day now covers that date: nothing to be "back
  // on" for, so no "good news" drafts.
  const backButStillOff = step === "tell-back" && result && result.back_on_schedule === false;

  return (
    <>
    {/* Message families opens ON TOP; this panel stays mounted underneath so
        the instructor's "Emailed" and the sub's "Released" survive the trip -
        unmounting it put the Send and Release buttons back, one click from a
        second email. */}
    {showFamilies && familyDraft && (
      <MessageFamiliesModal
        programs={[program]}
        orgId={orgId}
        initialSubject={familyDraft.subject}
        initialBodyHtml={familyDraft.bodyHtml}
        onClose={() => { setShowFamilies(false); setFamiliesOpened(true); }}
      />
    )}
    <div
      // A stray click outside may close the CHOICE, never the "let people
      // know" step: by then the day is already off the schedule, and closing
      // would silently drop the instructor, the sub and the families.
      onClick={() => !busy && (step === "choose" || step === "confirm-restore") && onClose?.()}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: showFamilies ? "none" : "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", zIndex: 300, overflowY: "auto" }}
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

            {!effectiveMakeup && !noChoice && (
              <>
                <div style={{ fontSize: 12, color: MUTED, margin: "6px 0" }}>Credit families for the missed day?</div>
                <button type="button" disabled={busy} onClick={() => setCredit(true)} style={choiceStyle(credit === true, false)}>
                  <strong>Yes, credit families.</strong>{" "}
                  Each family gets 1/{program?.session_count || sessions.length} of what they paid for the class (not counting fees), added to their account automatically.
                </button>
                <button type="button" disabled={busy} onClick={() => setCredit(false)} style={choiceStyle(credit === false, false)}>
                  <strong>No credit.</strong>{" "}
                  For example, if your sign-up policy says a skipped day isn't refunded.
                </button>
              </>
            )}
            {noChoice && (
              <div style={{ fontSize: 12.5, color: RED, margin: "8px 0" }}>
                This is the last class of a class that runs between fixed dates, so it can't be rescheduled here.
                To move it, change the class's end date instead.
              </div>
            )}
            {err && <div style={{ fontSize: 12.5, color: RED, margin: "8px 0" }}>{err}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
              <button type="button" onClick={onClose} disabled={busy} style={btn(false, busy)}>Close</button>
              <button type="button" onClick={doSkip} disabled={busy || !date || noChoice || (!effectiveMakeup && credit === null)} style={btn(true, busy || !date || noChoice || (!effectiveMakeup && credit === null))}>
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
            {backButStillOff ? (
              <>
                <div style={{ fontSize: 16, fontWeight: 700, color: RED, marginBottom: 6 }}>
                  {longDate(told)} is still not a class day.
                </div>
                <div style={{ fontSize: 13, color: INK, lineHeight: 1.5, marginBottom: 12 }}>
                  It's no longer a rescheduled day, but a no-school day now covers that date, so there's still no class.
                  Nobody needs to be told anything new.
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button type="button" onClick={onClose} style={btn(false, false)}>Done</button>
                </div>
              </>
            ) : (
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
                      makeup: result?.makeup, lastDate: result?.last_date, nextDate: nextAfter(told), senderName: signOff,
                    })
                  : instructorBackOnDraft({
                      firstName: inst.preferred_name || inst.first_name, className, school, date: told,
                      makeup: skip?.makeup, previousLastDate: result?.last_date, senderName: signOff,
                    })}
              />
            ))}

            {step === "tell" && (result?.confirmed_covers ?? []).map((c) => (
              <SubRow
                key={c.substitution_id}
                cover={c}
                onReleased={(id) => setReleasedIds((prev) => new Set(prev).add(id))}
              />
            ))}

            {step === "tell" && result?.credit_families && (
              <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: "10px 12px", marginBottom: 8, fontSize: 13, color: INK }}>
                <strong>Credits for families</strong>
                {creditedCount > 0 ? (
                  <div style={{ fontSize: 12, color: OK_GREEN, fontWeight: 600 }}>
                    ✓ {creditedCount} famil{creditedCount === 1 ? "y" : "ies"} credited,
                    {" "}${((result.credits?.total_cents ?? 0) / 100).toFixed(2)} in total. It's on their account now.
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: MUTED }}>
                    No family had paid for this class yet, so nobody was credited.
                  </div>
                )}
                {(result.credits?.credited ?? []).some((c) => c.capped) && (
                  <div style={{ fontSize: 12, color: MUTED }}>
                    {(result.credits.credited.filter((c) => c.capped)).map((c) => c.name || "A family").join(", ")}: credited what they've paid so far, which is less than one session's share.
                  </div>
                )}
                {(result.credits?.skipped ?? []).length > 0 && (
                  <div style={{ fontSize: 12, color: MUTED }}>
                    Not credited: {result.credits.skipped.map((s) => `${s.name || "a family"} (${s.why})`).join(", ")}.
                  </div>
                )}
              </div>
            )}
            {step === "tell-back" && (result?.credits_voided > 0 || (result?.credits_kept ?? []).length > 0) && (
              <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: "10px 12px", marginBottom: 8, fontSize: 13, color: INK }}>
                <strong>Credits</strong>
                {result.credits_voided > 0 && (
                  <div style={{ fontSize: 12, color: OK_GREEN }}>
                    ✓ {result.credits_voided} credit{result.credits_voided === 1 ? "" : "s"} for this day removed (nobody had used them yet).
                  </div>
                )}
                {(result.credits_kept ?? []).length > 0 && (
                  <div style={{ fontSize: 12, color: RED }}>
                    Kept, because it has already been used or is being used at a checkout: {result.credits_kept.map((k) => k.name || "a family").join(", ")}.
                  </div>
                )}
              </div>
            )}

            <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: "10px 12px", marginBottom: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 220px", fontSize: 13, color: INK }}>
                <strong>Families</strong>
                <div style={{ fontSize: 12, color: MUTED }}>Opens Message families with a draft you can read and edit first.</div>
              </div>
              <button type="button" onClick={() => setShowFamilies(true)} style={btn(!familiesOpened, false)}>
                {familiesOpened ? "Write to families again" : "Write to families"}
              </button>
            </div>

            {doneWarned && unreleased.length > 0 && (
              <div style={{ fontSize: 12.5, color: RED, marginTop: 8 }}>
                {unreleased.map((c) => c.name || "A sub").join(", ")} {unreleased.length === 1 ? "is" : "are"} still booked for {longDate(told)}.
                Release them above, or press Done again and let them know yourself.
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button type="button" onClick={done} style={btn(false, false)}>Done</button>
            </div>
            </>
            )}
          </>
        )}
      </div>
    </div>
    </>
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
          <strong>{name}</strong> {inst.role === "developing" ? "assists with" : "teaches"} this class.
          {/* No address here: this one was read when the panel opened, and the
              server sends to whatever is on file at send time. */}
          {state === "sent" && <div style={{ fontSize: 12, color: OK_GREEN, fontWeight: 600 }}>✓ Emailed {name}</div>}
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
function SubRow({ cover, onReleased }) {
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
    onReleased?.(cover.substitution_id);
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
          {state === "sending" ? "Releasing…" : (cover.name ? `Release ${cover.name.split(" ")[0]}` : "Release")}
        </button>
      )}
    </div>
  );
}
