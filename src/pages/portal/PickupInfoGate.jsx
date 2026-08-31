// PickupInfoGate — blocking parent-portal step (mirrors WaiverGate): a family with
// after-school kids who registered BEFORE the pickup/dismissal questions existed
// must complete that info before they see the dashboard. Backfill for the fall
// kids whose registrations predate customizable-registration.
//
// Reuses the exact registration fields (PickupDismissalSection /
// GuardianSecondarySection) so the parent sees the same form they'd have filled at
// checkout. Saves through replace_student_pickup_dnr_guardian — one parent-authorized
// RPC per child that replaces all contact roles + dismissal_method in a single
// transaction (so a pickup<->do-not-release move can't race and half-save). onComplete
// re-fetches the dashboard, which recomputes the gate (now empty) and lets them in.
//
// Scoped to after-school only (summer camps excluded upstream in Dashboard).

import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase.js";
import { needsAftercareProvider } from "../../lib/dismissal.js";
import {
  PickupDismissalSection,
  GuardianSecondarySection,
  parseRegFields,
} from "./register-steps/RegExtraFields.jsx";
// The validation, the payload and the "a parent cannot remove a saved
// do-not-release name" rule are shared with StudentCare.jsx and the operator's
// roster editor. What gets SAVED (anything with a name in either box, not the
// stricter "counts as an answer" rule) moved there with them - prod holds
// "Club K Teachers", "Casey Negrieff" and "AINSWORTH AFTERCARE - MOST DAYS",
// and filtering the save strictly would delete all three.
import {
  CARE_CONTACT_COLUMNS, careProblem, careRpcArgs, careSaveMessage, lockedDoNotRelease,
} from "../../lib/studentCare.js";

export default function PickupInfoGate({ students, parent, orgId, onComplete }) {
  const [std, setStd] = useState(null);
  const [guardianCfg, setGuardianCfg] = useState(null);
  const [byStudent, setByStudent] = useState({}); // student_id -> { dismissal_method, pickup, doNotRelease, guardian2 }
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ids = students.map((s) => s.student_id);
        const [{ data: fields }, { data: contacts }, { data: studs }] = await Promise.all([
          supabase.rpc("get_active_registration_fields", { p_org_id: orgId }),
          // EVERY column the RPC re-inserts, from the shared list. This select
          // used to stop at email, so `relationship` and `notes` were written
          // NULL on every save this screen made. Nothing populates those columns
          // on either environment today, which is exactly why it went unnoticed.
          supabase.from("student_contacts").select(CARE_CONTACT_COLUMNS).in("student_id", ids),
          // aftercare_provider selected alongside the method. Without it the
          // "Which aftercare program?" box renders EMPTY for a child who already
          // has one on file, and re-saving would blank a name the family had
          // already given - the select/read mismatch turning into data loss.
          supabase.from("students").select("id, dismissal_method, aftercare_provider").in("id", ids),
        ]);
        if (cancelled) return;
        const parsed = parseRegFields(fields || []);
        setStd(parsed.std);
        setGuardianCfg(parsed.std.guardian_secondary || null);

        const init = {};
        for (const s of students) {
          const cs = (contacts || []).filter((c) => c.student_id === s.student_id);
          const stu = (studs || []).find((x) => x.id === s.student_id);
          const dm = stu?.dismissal_method || "";
          init[s.student_id] = {
            dismissal_method: dm,
            aftercare_provider: stu?.aftercare_provider || "",
            pickup: cs.filter((c) => c.role === "authorized_pickup"),
            // Locked, exactly as on the parent's own editor. This screen is
            // parent-facing too, so the same rule applies: a family may add a
            // do-not-release name here but not take one off. Two parent screens
            // disagreeing about a custody record is the failure this shares one
            // helper to avoid.
            doNotRelease: lockedDoNotRelease(cs),
            guardian2: cs.find((c) => c.role === "guardian") || {},
          };
        }
        setByStudent(init);
        setLoading(false);
      } catch (e) {
        if (!cancelled) { setError("We couldn't load the form. Please refresh."); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(studentId, patch) {
    setByStudent((m) => ({ ...m, [studentId]: { ...m[studentId], ...patch } }));
  }

  // Per-child validation. The rules THEMSELVES live in lib/studentCare.js,
  // because as of 2026-08-31 this is no longer the only screen that writes these
  // facts: the parent's own editor (StudentCare.jsx) and the operator's roster
  // editor save the same rows. Three spellings of "is this complete" is how the
  // dismissal vocabulary ended up written six times and disagreeing.
  const problemFor = (s) => careProblem(std, byStudent[s.student_id]);

  // problemFor has always written a specific sentence for each thing that blocks
  // this screen, and none of them was ever rendered - the only signal was Save
  // going grey, which on a gate a parent cannot skip reads as a broken button
  // rather than as missing information. Surfaced next to the button they just
  // pressed. Named per child, because "add the aftercare program" is useless when
  // two siblings are on screen and only one is missing it.
  //
  // ONE pass over the students, because "is this blocked" and "what do we tell
  // them" answering the same question twice is how you get a dead grey button with
  // nothing next to it - the bug this box exists to prevent. unresolved decides
  // the button; blockers is the subset that has something a parent can act on.
  // Note allValid canNOT just be `blockers.length === 0`: problemFor's "loading"
  // sentinel is deliberately not shown to a parent, so that would enable Save for
  // a student whose data has not arrived and submit() would deref an undefined
  // byStudent entry.
  const problems = loading ? [] : students.map((s) => ({ name: s.name, msg: problemFor(s) }));
  const unresolved = problems.filter((p) => p.msg !== null);
  const allValid = !loading && unresolved.length === 0;
  const blockers = unresolved.filter((p) => p.msg !== "loading");
  // True when something blocks Save but has no sentence a parent can act on, so
  // the box still says something rather than nothing.
  const awaitingDetails = unresolved.length > blockers.length;

  async function submit() {
    if (!allValid || saving) return;
    setSaving(true);
    setError("");
    try {
      // One atomic RPC per student: all contact roles + dismissal method are
      // replaced in a single transaction, so a pickup<->do-not-release move can't
      // race the exclusion trigger and half-save (audit P2).
      for (const s of students) {
        // The payload is built by careRpcArgs, shared with the parent and
        // operator editors - including the 7th argument, which migration
        // 20260807b deliberately gave no default so the 6-arg and 7-arg
        // overloads coexist. Omitting it resolves to the OLD function and
        // silently drops the aftercare destination, which is exactly the kind of
        // detail that rots when three screens each spell the call out.
        const { error: saveErr } = await supabase.rpc(
          "replace_student_pickup_dnr_guardian",
          careRpcArgs({ studentId: s.student_id, organizationId: orgId, data: byStudent[s.student_id] }),
        );
        if (saveErr) throw saveErr;
      }
      onComplete();
    } catch (e) {
      // Was `e.message`, which put raw plpgsql raises in front of a parent -
      // including 'not authorized to edit contacts for student <uuid>'.
      // careSaveMessage passes through the two the database already wrote to a
      // person (the pickup conflict, which names the contact) and replaces the
      // two that carry raw ids.
      setError(careSaveMessage(e));
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="mx-auto max-w-2xl px-4 py-8 text-j2s-ink/70">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="font-titan text-2xl text-j2s-ink sm:text-3xl">One quick step before you're in</h1>
      <p className="mt-2 text-j2s-ink/70">
        We now ask every family how their child leaves and who's allowed to pick them up, so dismissal is safe.
        Please add this for {students.length === 1 ? "your child" : "each child"} below.
      </p>

      <div className="mt-8 space-y-6">
        {students.map((s) => {
          const d = byStudent[s.student_id] || {};
          return (
            <div key={s.student_id} className="rounded-2xl border-2 border-j2s-purple/10 bg-white p-6">
              <h2 className="font-titan text-xl text-j2s-ink">{s.name || "Your child"}</h2>
              <PickupDismissalSection
                std={std}
                lockSavedDoNotRelease
                // Every child renders at once here, so the radio group name and
                // the provider input id have to differ per child.
                instanceKey={s.student_id}
                dismissalMethod={d.dismissal_method}
                // Same clear-on-change rule as the registration form: a provider
                // name must never outlive the answer it describes, or a roster
                // shows a destination for a child who now walks home.
                onDismissalChange={(v) => update(
                  s.student_id,
                  needsAftercareProvider(v)
                    ? { dismissal_method: v }
                    : { dismissal_method: v, aftercare_provider: "" },
                )}
                aftercareProvider={d.aftercare_provider}
                onAftercareProviderChange={(v) => update(s.student_id, { aftercare_provider: v })}
                pickup={d.pickup}
                onPickupChange={(v) => update(s.student_id, { pickup: v })}
                doNotRelease={d.doNotRelease}
                onDoNotReleaseChange={(v) => update(s.student_id, { doNotRelease: v })}
              />
              {guardianCfg && (
                <GuardianSecondarySection
                  config={guardianCfg}
                  value={d.guardian2}
                  onChange={(v) => update(s.student_id, { guardian2: v })}
                />
              )}
            </div>
          );
        })}
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {/* Why the button below is greyed out. Sits directly above it so it is in
          the same glance as the control it explains, and keyed off !allValid (the
          same condition that disables the button) rather than off the message list,
          so the button can never be disabled with nothing here.

          role="alert" matches the pickup/do-not-release conflict warning inside
          this same flow (RegExtraFields). Without it the only explanation for a
          disabled button, on a gate a parent cannot skip, is silent to a screen
          reader. */}
      {!allValid && !saving && (
        <div
          role="alert"
          className="mt-6 rounded-lg border-2 border-j2s-purple/15 bg-j2s-purple-soft/40 px-4 py-3 text-sm text-j2s-ink/80"
        >
          {blockers.length > 0 && (
            <>
              <p className="font-semibold text-j2s-ink">Still needed before you continue:</p>
              <ul className="mt-1 grid gap-1">
                {blockers.map((b, i) => (
                  <li key={i}>{students.length > 1 && b.name ? `${b.name}: ${b.msg}` : b.msg}</li>
                ))}
              </ul>
            </>
          )}
          {awaitingDetails && (
            <p className={blockers.length > 0 ? "mt-2" : ""}>
              Still loading {students.length > 1 ? "one of your children's details" : "your child's details"}…
            </p>
          )}
        </div>
      )}

      <button
        onClick={submit}
        disabled={!allValid || saving}
        className={`mt-8 w-full rounded-xl px-6 py-3.5 font-bold text-white transition ${allValid && !saving ? "bg-j2s-purple hover:bg-j2s-purple-dark" : "cursor-not-allowed bg-j2s-purple/40"}`}
      >
        {saving ? "Saving…" : "Save & continue"}
      </button>
    </div>
  );
}
