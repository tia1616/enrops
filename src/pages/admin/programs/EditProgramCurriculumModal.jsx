// Two-step admin flow for swapping a program's curriculum.
//
// Step 1 — pick the new curriculum + see what it touches.
// Step 2 — preview + edit the notes that go to enrolled families and the
//          confirmed instructor (if any). Per-channel toggles. Admin can
//          send + save, or skip the notes and just save.
//
// Atomicity: the DB write to programs.curriculum_id/curriculum AND the
// email sends AND the program_curriculum_changes audit row all happen
// together inside the notify-program-curriculum-change edge function.
// Closing the modal at step 2 leaves the program record untouched.
//
// Scoped by organization_id at every query; RLS blocks cross-tenant
// reads/writes even if a stale org slipped through.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../../lib/supabase.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const RED = "#b53737";
const SOFT_AMBER_BG = "#fff7ed";
const SOFT_AMBER_BORDER = "#fed7aa";
const SOFT_AMBER_INK = "#9a3412";
const SOFT_GREEN_BG = "#f0fdf4";
const SOFT_GREEN_BORDER = "#bbf7d0";
const SOFT_GREEN_INK = "#166534";

const DAY_LABELS = {
  monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
  thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday",
};

function describeProgram(p) {
  const parts = [];
  if (p.program_locations?.name) parts.push(p.program_locations.name);
  if (p.day_of_week) parts.push(DAY_LABELS[p.day_of_week.toLowerCase()] ?? p.day_of_week);
  if (p.start_time) parts.push(formatTime(p.start_time));
  return parts.join(" · ");
}

function programDayLabel(p) {
  if (!p?.day_of_week) return "weekly";
  return DAY_LABELS[p.day_of_week.toLowerCase()] ?? p.day_of_week;
}

function programLocationLabel(p) {
  return p?.program_locations?.name ?? "your school";
}

function formatTime(t) {
  if (!t) return "";
  if (/[ap]\s?m/i.test(t)) return t.toLowerCase().replace(/\s+/g, "");
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h)) return t;
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? "pm" : "am";
  return m === 0 ? `${hr12}${ampm}` : `${hr12}:${String(m).padStart(2, "0")}${ampm}`;
}

// Mirror of the edge fn's substitute(). Used here only for the live
// preview pane — the raw template (with placeholders) is what we send to
// the edge fn, which does the per-recipient substitution at send time.
function substitute(template, vars) {
  return (template ?? "").replace(/\{(\w+)\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m,
  );
}

function defaultFamilySubject() {
  return `A change to {student_first_name}'s {program_day} class`;
}

function defaultFamilyBody({ replyToEmail }) {
  return [
    `Hi {parent_first_name},`,
    ``,
    `A quick note about {student_first_name}'s {program_day} class at {program_location} — the class is changing from {from_curriculum} to {to_curriculum}, starting at the next session.`,
    ``,
    `Same day, same time — just a fresh set of projects {student_first_name} will work on with the same group.`,
    ``,
    `If this change isn't a fit and you'd like a refund for the remaining sessions, just email us at ${replyToEmail || "{reply_to_email}"} and we'll take care of it.`,
    ``,
    `Excited for what's coming up!`,
    ``,
    `— {org_name}`,
  ].join("\n");
}

function defaultInstructorSubject() {
  return `Update: {program_location} {program_day} class is switching to {to_curriculum}`;
}

function defaultInstructorBody() {
  return [
    `Hi {instructor_first_name},`,
    ``,
    `Heads up — the {program_location} {program_day} class is switching from {from_curriculum} to {to_curriculum}, starting at the next session.`,
    ``,
    `Same students, same time slot — just a new set of materials to teach. Your schedule in the portal will reflect the change once we save.`,
    ``,
    `Questions or need new materials? Just reply.`,
    ``,
    `— {org_name}`,
  ].join("\n");
}

export default function EditProgramCurriculumModal({
  program,
  org,
  curricula,
  enrollment,
  onSaved,
  onCancel,
}) {
  const currentId = program.curriculum_id ?? "";
  const [step, setStep] = useState(1);
  const [pickedId, setPickedId] = useState(currentId);
  const [impact, setImpact] = useState({ loading: true, assignments: 0, deliveries: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Captures the edge fn's payload after a successful save so step 3 can
  // narrate what happened ("note sent to 4 families", "instructor skipped",
  // etc.) and the admin gets explicit confirmation the change landed.
  const [result, setResult] = useState(null);

  // ── Step-2 state. Loaded lazily on entering step 2. ──────────────────
  const [recipientsLoading, setRecipientsLoading] = useState(false);
  const [recipientsError, setRecipientsError] = useState("");
  const [familyRecipientPreview, setFamilyRecipientPreview] = useState(null);
  // { count: int, first: { parent_first_name, student_first_name } | null }
  const [eligibleInstructor, setEligibleInstructor] = useState(null);
  // { id, first_name, name, email } | null

  const [familyNotify, setFamilyNotify] = useState(true);
  const [familySubject, setFamilySubject] = useState(defaultFamilySubject());
  const [familyBody, setFamilyBody] = useState("");

  const [instructorNotify, setInstructorNotify] = useState(true);
  const [instructorSubject, setInstructorSubject] = useState(defaultInstructorSubject());
  const [instructorBody, setInstructorBody] = useState(defaultInstructorBody());

  const [replyToEmail, setReplyToEmail] = useState("");

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [assignRes, deliverRes] = await Promise.all([
          supabase
            .from("program_assignments")
            .select("id", { count: "exact", head: true })
            .eq("program_id", program.id)
            .eq("organization_id", org.id),
          supabase
            .from("session_delivery_confirmations")
            .select("id", { count: "exact", head: true })
            .eq("program_id", program.id)
            .eq("organization_id", org.id),
        ]);
        if (!mounted) return;
        setImpact({
          loading: false,
          assignments: assignRes.count ?? 0,
          // session_delivery_confirmations may not exist in every org's schema yet;
          // a missing-table error reads as 0 rather than blocking the modal.
          deliveries: deliverRes.error ? 0 : (deliverRes.count ?? 0),
        });
      } catch {
        if (mounted) setImpact({ loading: false, assignments: 0, deliveries: 0 });
      }
    })();
    return () => { mounted = false; };
  }, [program.id, org.id]);

  // Lazily load family + instructor recipients when entering step 2.
  // We re-load every entry (cheap, two queries) so the count is fresh
  // — admins occasionally take a long time on step 2 and enrollment
  // could shift in the meantime.
  useEffect(() => {
    if (step !== 2) return;
    let mounted = true;
    setRecipientsLoading(true);
    setRecipientsError("");
    (async () => {
      try {
        const [regsRes, asgsRes, brandRes] = await Promise.all([
          supabase
            .from("registrations")
            .select(`
              id, status,
              student:students ( id, first_name ),
              parent:parents ( id, first_name, last_name, email )
            `)
            .eq("program_id", program.id)
            .eq("organization_id", org.id)
            .neq("status", "cancelled"),
          supabase
            .from("program_assignments")
            .select(`
              id, status, email_sent_at,
              instructor:instructors ( id, first_name, last_name, preferred_name, email )
            `)
            .eq("program_id", program.id)
            .eq("organization_id", org.id)
            .in("status", ["confirmed", "published"])
            .not("email_sent_at", "is", null),
          // Reply-to is informational here (so the admin can see what email
          // address families will be told to write to). The edge fn re-loads
          // it server-side at send time — never trust the client copy.
          supabase
            .from("organizations")
            .select("email, alert_email")
            .eq("id", org.id)
            .maybeSingle(),
        ]);
        if (!mounted) return;

        // Dedupe families by parent_id; one note per family even if
        // they've got two kids in the same program.
        const seen = new Set();
        const familyList = [];
        for (const r of regsRes.data ?? []) {
          const p = r.parent;
          if (!p?.id || !p.email) continue;
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          familyList.push({
            parent_first_name: (p.first_name ?? "").trim() || "there",
            student_first_name: (r.student?.first_name ?? "").trim() || "your child",
          });
        }
        setFamilyRecipientPreview({
          count: familyList.length,
          first: familyList[0] ?? null,
        });

        const asgMatches = (asgsRes.data ?? []).filter((a) => a.instructor?.email);
        const first = asgMatches[0];
        setEligibleInstructor(
          first
            ? {
                id: first.instructor.id,
                first_name:
                  first.instructor.preferred_name || first.instructor.first_name || "there",
                name: `${first.instructor.first_name ?? ""} ${first.instructor.last_name ?? ""}`.trim() || "(no name)",
                email: first.instructor.email,
              }
            : null,
        );

        const reply = brandRes.data?.email ?? brandRes.data?.alert_email ?? "";
        setReplyToEmail(reply);
        setFamilyBody((prev) => prev || defaultFamilyBody({ replyToEmail: reply }));

        // Default the toggles to OFF when there's nobody to notify.
        if (familyList.length === 0) setFamilyNotify(false);
        if (!first) setInstructorNotify(false);

        setRecipientsLoading(false);
      } catch (err) {
        if (!mounted) return;
        console.error("[EditProgramCurriculumModal] recipient load failed", err);
        setRecipientsError("Couldn't load who would be notified.");
        setRecipientsLoading(false);
      }
    })();
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const currentName = program.curriculum ?? "(none)";
  const pickedCurriculum = curricula.find((c) => c.id === pickedId) ?? null;
  const changed = pickedId && pickedId !== currentId;
  const enr = enrollment ?? { paid: 0, unpaid: 0, pending: 0 };
  const enrolled = enr.paid + enr.unpaid;

  function goToStep2() {
    if (!changed || !pickedCurriculum) return;
    setError("");
    setStep(2);
  }

  async function submit({ sendFamily, sendInstructor }) {
    if (!pickedCurriculum) return;
    setBusy(true);
    setError("");
    try {
      const { data, error: fnErr } = await supabase.functions.invoke(
        "notify-program-curriculum-change",
        {
          body: {
            program_id: program.id,
            organization_id: org.id,
            to_curriculum_id: pickedCurriculum.id,
            to_curriculum_name: pickedCurriculum.name,
            from_curriculum_id: program.curriculum_id ?? null,
            from_curriculum_name: program.curriculum ?? null,
            family: {
              send: sendFamily,
              subject: familySubject,
              body_text: familyBody,
            },
            instructor: {
              send: sendInstructor,
              subject: instructorSubject,
              body_text: instructorBody,
            },
          },
        },
      );
      if (fnErr || data?.error) {
        setError(data?.error || fnErr?.message || "Couldn't save the change.");
        setBusy(false);
        return;
      }
      // Show the confirmation step before closing — admin needs to see
      // what actually happened (DB write + which channels fired + counts).
      setResult(data ?? {});
      setStep(3);
      setBusy(false);
    } catch (err) {
      console.error("[EditProgramCurriculumModal] submit failed", err);
      setError("Something went wrong saving the change.");
      setBusy(false);
    }
  }

  // Called from Done in step 3 — and as a fallback when the admin X's out
  // of step 3 — so the parent's row patch lands either way.
  function finishAndClose() {
    if (!pickedCurriculum) {
      onCancel();
      return;
    }
    onSaved({
      programId: program.id,
      curriculum_id: pickedCurriculum.id,
      curriculum: pickedCurriculum.name,
      notify_result: result,
    });
  }

  // ── Live preview helpers (step 2). Render the template using the FIRST
  //    recipient's actual name, so the admin sees realistic text rather
  //    than {placeholder} tokens.
  const familyPreviewVars = useMemo(() => {
    const first = familyRecipientPreview?.first ?? null;
    return {
      parent_first_name: first?.parent_first_name ?? "there",
      student_first_name: first?.student_first_name ?? "your child",
      program_day: programDayLabel(program),
      program_location: programLocationLabel(program),
      program_summary: describeProgram(program) || "your class",
      from_curriculum: program.curriculum ?? "the current class",
      to_curriculum: pickedCurriculum?.name ?? "(new class)",
      org_name: org?.name ?? "Our team",
      reply_to_email: replyToEmail || "(your alert email)",
    };
  }, [familyRecipientPreview, program, pickedCurriculum, org, replyToEmail]);

  const instructorPreviewVars = useMemo(() => ({
    instructor_first_name: eligibleInstructor?.first_name ?? "there",
    program_day: programDayLabel(program),
    program_location: programLocationLabel(program),
    program_summary: describeProgram(program) || "your class",
    from_curriculum: program.curriculum ?? "the current class",
    to_curriculum: pickedCurriculum?.name ?? "(new class)",
    org_name: org?.name ?? "Our team",
    reply_to_email: replyToEmail || "(your alert email)",
  }), [eligibleInstructor, program, pickedCurriculum, org, replyToEmail]);

  return (
    <div
      onClick={busy ? undefined : (step === 3 ? finishAndClose : onCancel)}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "40px 16px",
        zIndex: 110,
        overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          width: "100%",
          maxWidth: step === 1 ? 580 : 720,
          border: `1px solid ${RULE}`,
          borderRadius: 10,
          padding: 22,
          boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: INK, margin: 0 }}>
              {step === 1 && "Change the class"}
              {step === 2 && "Send the news"}
              {step === 3 && (
                <span style={{ color: SOFT_GREEN_INK }}>✓ Change saved</span>
              )}
            </h2>
            <p style={{ color: MUTED, fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
              {step === 1 && (describeProgram(program) || "this program")}
              {step === 2 && `${describeProgram(program) || "this program"} · ${program.curriculum ?? "(none)"} → ${pickedCurriculum?.name ?? ""}`}
              {step === 3 && `${describeProgram(program) || "this program"} · ${result?.from_curriculum_name ?? program.curriculum ?? "(none)"} → ${pickedCurriculum?.name ?? ""}`}
            </p>
          </div>
          <button
            type="button"
            onClick={step === 3 ? finishAndClose : onCancel}
            disabled={busy}
            style={{
              background: "transparent",
              border: "none",
              color: MUTED,
              fontSize: 18,
              cursor: busy ? "wait" : "pointer",
              padding: 0,
              lineHeight: 1,
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {step === 1 && (
          <Step1
            curricula={curricula}
            currentId={currentId}
            currentName={currentName}
            pickedId={pickedId}
            setPickedId={setPickedId}
            pickedCurriculum={pickedCurriculum}
            changed={changed}
            impact={impact}
            enrolled={enrolled}
            busy={busy}
          />
        )}

        {step === 2 && (
          <Step2
            recipientsLoading={recipientsLoading}
            recipientsError={recipientsError}
            familyRecipientPreview={familyRecipientPreview}
            eligibleInstructor={eligibleInstructor}
            familyNotify={familyNotify}
            setFamilyNotify={setFamilyNotify}
            familySubject={familySubject}
            setFamilySubject={setFamilySubject}
            familyBody={familyBody}
            setFamilyBody={setFamilyBody}
            familyPreviewVars={familyPreviewVars}
            instructorNotify={instructorNotify}
            setInstructorNotify={setInstructorNotify}
            instructorSubject={instructorSubject}
            setInstructorSubject={setInstructorSubject}
            instructorBody={instructorBody}
            setInstructorBody={setInstructorBody}
            instructorPreviewVars={instructorPreviewVars}
            busy={busy}
            replyToEmail={replyToEmail}
          />
        )}

        {step === 3 && (
          <Step3
            result={result}
            toCurriculumName={pickedCurriculum?.name ?? ""}
            eligibleInstructor={eligibleInstructor}
          />
        )}

        {error && (
          <p style={{ color: RED, fontSize: 13, marginTop: 12 }}>{error}</p>
        )}

        {/* ── Footer buttons ─────────────────────────────────────────── */}
        {step === 1 && (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              style={ghostBtnStyle(busy)}
            >
              Not now
            </button>
            <button
              type="button"
              onClick={goToStep2}
              disabled={busy || !changed}
              style={primaryBtnStyle({ busy, disabled: !changed })}
            >
              Next: review notes
            </button>
          </div>
        )}

        {step === 2 && (
          <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 16, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => { setError(""); setStep(1); }}
              disabled={busy}
              style={ghostBtnStyle(busy)}
            >
              ← Back
            </button>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => submit({ sendFamily: false, sendInstructor: false })}
                disabled={busy || recipientsLoading}
                style={ghostBtnStyle(busy)}
                title="Save the curriculum change without emailing anyone."
              >
                Skip notes + save
              </button>
              <button
                type="button"
                onClick={() =>
                  submit({
                    sendFamily: familyNotify && (familyRecipientPreview?.count ?? 0) > 0,
                    sendInstructor: instructorNotify && !!eligibleInstructor,
                  })
                }
                disabled={
                  busy
                  || recipientsLoading
                  // Disable if both toggles are off (use the explicit Skip button instead).
                  || (!(familyNotify && (familyRecipientPreview?.count ?? 0) > 0) && !(instructorNotify && !!eligibleInstructor))
                }
                style={primaryBtnStyle({
                  busy,
                  disabled:
                    recipientsLoading
                    || (!(familyNotify && (familyRecipientPreview?.count ?? 0) > 0) && !(instructorNotify && !!eligibleInstructor)),
                })}
              >
                {busy ? "Saving…" : "Send notes + save"}
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
            <button
              type="button"
              onClick={finishAndClose}
              style={primaryBtnStyle({ busy: false, disabled: false })}
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Step 1 — pick the new curriculum
// ───────────────────────────────────────────────────────────────────────

function Step1({
  curricula, currentId, currentName, pickedId, setPickedId,
  pickedCurriculum, changed, impact, enrolled, busy,
}) {
  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Currently</label>
        <div style={{ ...readOnlyValue, color: INK }}>{currentName}</div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Change to</label>
        <select
          value={pickedId}
          onChange={(e) => setPickedId(e.target.value)}
          disabled={busy}
          style={{
            width: "100%",
            padding: "9px 11px",
            border: `1px solid ${RULE}`,
            borderRadius: 6,
            fontSize: 14,
            fontFamily: "inherit",
            background: "#fff",
            color: INK,
          }}
        >
          <option value="">Pick a class…</option>
          {curricula.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}{c.id === currentId ? " (current)" : ""}
            </option>
          ))}
        </select>
        {curricula.length === 0 && (
          <div style={{ color: MUTED, fontSize: 12, marginTop: 6 }}>
            No published classes in your library yet. Add one in Curricula first.
          </div>
        )}
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>What this touches</label>
        {impact.loading ? (
          <div style={{ color: MUTED, fontSize: 13, padding: "8px 0" }}>Checking…</div>
        ) : (
          <ul style={{ margin: 0, padding: "4px 0 0 18px", color: INK, fontSize: 13, lineHeight: 1.7 }}>
            <li>
              <strong>{enrolled}</strong> enrolled famil{enrolled === 1 ? "y" : "ies"}
              {enrolled > 0 && " — they'll see the new class name in their account and confirmations."}
            </li>
            <li>
              <strong>{impact.assignments}</strong> instructor confirmation{impact.assignments === 1 ? "" : "s"}
              {impact.assignments > 0 && " — the instructor's schedule will show the new class name."}
            </li>
            {impact.deliveries > 0 && (
              <li>
                <strong>{impact.deliveries}</strong> past session{impact.deliveries === 1 ? "" : "s"} already logged — those will be re-labeled in your records.
              </li>
            )}
            <li style={{ color: MUTED }}>
              Marketing emails don't auto-update — review any scheduled sends manually.
            </li>
          </ul>
        )}
      </div>

      {changed && pickedCurriculum && enrolled > 0 && (
        <div
          style={{
            background: SOFT_AMBER_BG,
            border: `1px solid ${SOFT_AMBER_BORDER}`,
            color: SOFT_AMBER_INK,
            borderRadius: 6,
            padding: "10px 12px",
            fontSize: 13,
            lineHeight: 1.5,
            marginBottom: 12,
          }}
        >
          <strong>{enrolled}</strong> famil{enrolled === 1 ? "y has" : "ies have"} already signed up for{" "}
          <strong>{currentName}</strong>. On the next screen you'll write the note they'll get.
        </div>
      )}
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Step 2 — preview + edit the notes
// ───────────────────────────────────────────────────────────────────────

function Step2({
  recipientsLoading, recipientsError,
  familyRecipientPreview, eligibleInstructor,
  familyNotify, setFamilyNotify, familySubject, setFamilySubject,
  familyBody, setFamilyBody, familyPreviewVars,
  instructorNotify, setInstructorNotify, instructorSubject, setInstructorSubject,
  instructorBody, setInstructorBody, instructorPreviewVars,
  busy, replyToEmail,
}) {
  if (recipientsLoading) {
    return <div style={{ color: MUTED, fontSize: 13, padding: "12px 0" }}>Loading who would be notified…</div>;
  }
  if (recipientsError) {
    return <div style={{ color: RED, fontSize: 13, padding: "12px 0" }}>{recipientsError}</div>;
  }

  const familyCount = familyRecipientPreview?.count ?? 0;
  const noFamily = familyCount === 0;
  const noInstructor = !eligibleInstructor;
  const nobody = noFamily && noInstructor;

  return (
    <>
      {/* Summary banner */}
      <div
        style={{
          background: nobody ? SOFT_AMBER_BG : SOFT_GREEN_BG,
          border: `1px solid ${nobody ? SOFT_AMBER_BORDER : SOFT_GREEN_BORDER}`,
          color: nobody ? SOFT_AMBER_INK : SOFT_GREEN_INK,
          borderRadius: 6,
          padding: "10px 12px",
          fontSize: 13,
          lineHeight: 1.5,
          marginBottom: 16,
        }}
      >
        {nobody ? (
          "Nobody to notify — no enrolled families and no confirmed instructor who's already been emailed. You can still save the change."
        ) : (
          <>
            <strong>{familyCount}</strong> famil{familyCount === 1 ? "y" : "ies"} will get a note
            {eligibleInstructor && (
              <> · <strong>{eligibleInstructor.name}</strong> (instructor) will get a note</>
            )}
            .
          </>
        )}
      </div>

      {/* Family channel */}
      <ChannelBlock
        title="Note to families"
        disabled={noFamily}
        disabledReason={noFamily ? "No enrolled families on this program." : null}
        notify={familyNotify}
        setNotify={setFamilyNotify}
        subject={familySubject}
        setSubject={setFamilySubject}
        body={familyBody}
        setBody={setFamilyBody}
        previewVars={familyPreviewVars}
        previewLabel={
          familyRecipientPreview?.first
            ? `Previewing as ${familyRecipientPreview.first.parent_first_name} (${familyCount} total, each personalized)`
            : "Preview"
        }
        meta={replyToEmail ? `Replies go to ${replyToEmail}.` : null}
        busy={busy}
      />

      {/* Instructor channel */}
      <ChannelBlock
        title="Note to instructor"
        disabled={noInstructor}
        disabledReason={
          noInstructor
            ? "No confirmed instructor who's already been emailed about this program."
            : null
        }
        notify={instructorNotify}
        setNotify={setInstructorNotify}
        subject={instructorSubject}
        setSubject={setInstructorSubject}
        body={instructorBody}
        setBody={setInstructorBody}
        previewVars={instructorPreviewVars}
        previewLabel={
          eligibleInstructor
            ? `Previewing as ${eligibleInstructor.name}`
            : "Preview"
        }
        meta={eligibleInstructor?.email ? `Sent to ${eligibleInstructor.email}.` : null}
        busy={busy}
      />
    </>
  );
}

// One per-channel block — toggle, subject, body, live preview.
function ChannelBlock({
  title, disabled, disabledReason,
  notify, setNotify, subject, setSubject, body, setBody,
  previewVars, previewLabel, meta, busy,
}) {
  const previewSubject = substitute(subject, previewVars);
  const previewBody = substitute(body, previewVars);

  return (
    <div
      style={{
        border: `1px solid ${RULE}`,
        borderRadius: 8,
        padding: 14,
        marginBottom: 14,
        background: disabled ? "#fafaf5" : "#fff",
        opacity: disabled ? 0.7 : 1,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: disabled ? "not-allowed" : "pointer" }}>
          <input
            type="checkbox"
            checked={notify && !disabled}
            disabled={disabled || busy}
            onChange={(e) => setNotify(e.target.checked)}
            style={{ width: 16, height: 16, cursor: disabled ? "not-allowed" : "pointer" }}
          />
          <span style={{ fontSize: 14, fontWeight: 600, color: INK }}>{title}</span>
        </label>
      </div>

      {disabled ? (
        <div style={{ color: MUTED, fontSize: 13, fontStyle: "italic" }}>{disabledReason}</div>
      ) : notify ? (
        <>
          <label style={{ ...labelStyle, marginTop: 4 }}>Subject</label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={busy}
            style={{
              width: "100%",
              padding: "9px 11px",
              border: `1px solid ${RULE}`,
              borderRadius: 6,
              fontSize: 14,
              color: INK,
              fontFamily: "inherit",
              marginBottom: 10,
            }}
          />

          <label style={labelStyle}>Message</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={busy}
            rows={9}
            style={{
              width: "100%",
              padding: "10px 12px",
              border: `1px solid ${RULE}`,
              borderRadius: 6,
              fontSize: 14,
              color: INK,
              fontFamily: "inherit",
              lineHeight: 1.5,
              resize: "vertical",
              marginBottom: 8,
            }}
          />

          <details style={{ marginTop: 4 }}>
            <summary
              style={{
                cursor: "pointer",
                fontSize: 12,
                color: MUTED,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              Preview ({previewLabel})
            </summary>
            <div
              style={{
                marginTop: 8,
                padding: "10px 12px",
                background: "#fafaf5",
                border: `1px dashed ${RULE}`,
                borderRadius: 6,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 }}>
                {previewSubject}
              </div>
              <div style={{ fontSize: 13, color: INK, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                {previewBody}
              </div>
            </div>
          </details>

          {meta && (
            <p style={{ color: MUTED, fontSize: 12, marginTop: 8, marginBottom: 0 }}>{meta}</p>
          )}
        </>
      ) : (
        <div style={{ color: MUTED, fontSize: 13, fontStyle: "italic" }}>
          Won't send this note.
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Step 3 — saved confirmation
// ───────────────────────────────────────────────────────────────────────
//
// Closes the loop on the admin's action. They picked a new class and
// hit save; this view tells them exactly what landed: the curriculum
// write, which surfaces show the new class now, which emails fired (if
// any), and which were skipped. Removes the "did anything happen?"
// ambiguity that prompted this build.

function Step3({ result, toCurriculumName, eligibleInstructor }) {
  const fam = result?.family ?? {};
  const ins = result?.instructor ?? {};

  function familyLine() {
    if (fam.choice === "sent") {
      const sent = fam.sent_count ?? 0;
      const failed = fam.failed_count ?? 0;
      if (failed > 0) {
        return `Note sent to ${sent} famil${sent === 1 ? "y" : "ies"}. ${failed} failed — check your audit log.`;
      }
      return `Note sent to ${sent} famil${sent === 1 ? "y" : "ies"}.`;
    }
    if (fam.choice === "skipped") return "No note sent to families (you skipped it).";
    if (fam.choice === "no_recipients") return "No registered families on this program yet — nothing to send.";
    return "—";
  }

  function instructorLine() {
    if (ins.choice === "sent") {
      const who = eligibleInstructor?.name ?? "the assigned instructor";
      return `Note sent to ${who}.`;
    }
    if (ins.choice === "skipped") return "No note sent to the instructor (you skipped it).";
    if (ins.choice === "no_recipient") return "No confirmed instructor on this program yet — nothing to send.";
    return "—";
  }

  return (
    <>
      <div
        style={{
          background: SOFT_GREEN_BG,
          border: `1px solid ${SOFT_GREEN_BORDER}`,
          color: SOFT_GREEN_INK,
          borderRadius: 6,
          padding: "12px 14px",
          fontSize: 14,
          lineHeight: 1.5,
          marginBottom: 18,
        }}
      >
        The class is now <strong>{toCurriculumName}</strong>. Everything below is updated and live.
      </div>

      <div style={{ marginBottom: 18 }}>
        <label style={labelStyle}>Where this shows up now</label>
        <ul style={listStyle}>
          <li>
            <strong>Your schedule.</strong> The program in <em>/admin/programs</em>, the by-school view, and the calendar all show <strong>{toCurriculumName}</strong>.
          </li>
          <li>
            <strong>Parent portal.</strong> Families already registered for this program see <strong>{toCurriculumName}</strong> in their account right now — no action on their side.
          </li>
          <li>
            <strong>Instructor portal.</strong> The assigned instructor's schedule shows <strong>{toCurriculumName}</strong> right now.
          </li>
          <li>
            <strong>Registration page.</strong> Anyone signing up from this point sees <strong>{toCurriculumName}</strong>.
          </li>
          <li>
            <strong>Future marketing.</strong> Campaigns generated from now on use <strong>{toCurriculumName}</strong>. Emails that already went out before this save still reference the old class — that's history, not future state.
          </li>
        </ul>
      </div>

      <div style={{ marginBottom: 4 }}>
        <label style={labelStyle}>Notes</label>
        <ul style={listStyle}>
          <li><strong>Families:</strong> {familyLine()}</li>
          <li><strong>Instructor:</strong> {instructorLine()}</li>
          {ins.extra_eligible_not_notified > 0 && (
            <li style={{ color: SOFT_AMBER_INK }}>
              <strong>Heads up:</strong> {ins.extra_eligible_not_notified} other eligible instructor{ins.extra_eligible_not_notified === 1 ? " was" : "s were"} not notified.
            </li>
          )}
          <li style={{ color: MUTED, fontSize: 12 }}>
            Logged for the record — visible later in this program's change history.
          </li>
        </ul>
      </div>
    </>
  );
}

const listStyle = {
  margin: 0,
  padding: "4px 0 0 18px",
  color: INK,
  fontSize: 13,
  lineHeight: 1.7,
};

// ───────────────────────────────────────────────────────────────────────
// Shared styles
// ───────────────────────────────────────────────────────────────────────

const labelStyle = {
  display: "block",
  fontSize: 11,
  fontWeight: 700,
  color: MUTED,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 6,
};

const readOnlyValue = {
  padding: "9px 11px",
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  fontSize: 14,
  background: "#fafaf5",
};

function ghostBtnStyle(busy) {
  return {
    padding: "9px 14px",
    border: `1px solid ${RULE}`,
    background: "transparent",
    color: INK,
    borderRadius: 6,
    cursor: busy ? "wait" : "pointer",
    fontSize: 14,
    fontFamily: "inherit",
  };
}

function primaryBtnStyle({ busy, disabled }) {
  return {
    padding: "9px 14px",
    border: "none",
    background: BRIGHT,
    color: "#fff",
    borderRadius: 6,
    cursor: busy ? "wait" : disabled ? "not-allowed" : "pointer",
    fontSize: 14,
    fontWeight: 600,
    fontFamily: "inherit",
    opacity: disabled ? 0.5 : 1,
  };
}
