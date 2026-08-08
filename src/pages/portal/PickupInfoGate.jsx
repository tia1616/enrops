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
import { needsAuthorizedPickup, needsAftercareProvider, dismissalAnswerIncomplete } from "../../lib/dismissal.js";
import {
  PickupDismissalSection,
  GuardianSecondarySection,
  parseRegFields,
  pickupDnrConflicts,
} from "./register-steps/RegExtraFields.jsx";

const nonEmpty = (list) => (Array.isArray(list) ? list : []).filter((p) => (p?.first_name || "").trim());

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
          supabase.from("student_contacts").select("student_id, role, first_name, last_name, phone, email").in("student_id", ids),
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
            doNotRelease: cs.filter((c) => c.role === "do_not_release"),
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

  // Per-child validation mirrors the registration rules.
  function problemFor(s) {
    const d = byStudent[s.student_id];
    if (!d) return "loading";
    if (std?.dismissal_method && !d.dismissal_method) return "Choose how this child leaves.";
    // Same completeness rule as the registration form, through the same helper -
    // this gate exists to finish missing pickup info, so it must not let a family
    // "finish" with the aftercare destination blank.
    if (dismissalAnswerIncomplete(d.dismissal_method, d.aftercare_provider)) {
      return "Add which aftercare program they go to.";
    }
    if (needsAuthorizedPickup(d.dismissal_method) && nonEmpty(d.pickup).length === 0) {
      return "Add at least one person who can pick them up.";
    }
    // Mirror Register's canAdvance: if the org marked do-not-release required, the
    // backfill gate must enforce it too (the label shows Required in both flows).
    if (std?.do_not_release?.required && nonEmpty(d.doNotRelease).length === 0) {
      return "Add the name(s) we should not release this child to.";
    }
    if (pickupDnrConflicts(d.pickup, d.doNotRelease).length > 0) {
      return "A name is on both the pickup and do-not-release lists. Remove it from one.";
    }
    return null;
  }

  const allValid = !loading && students.every((s) => problemFor(s) === null);

  // problemFor has always written a specific sentence for each thing that blocks
  // this screen, and none of them was ever rendered - the only signal was Save
  // going grey, which on a gate a parent cannot skip reads as a broken button
  // rather than as missing information. Surfaced next to the button they just
  // pressed. Named per child, because "add the aftercare program" is useless when
  // two siblings are on screen and only one is missing it.
  const blockers = loading
    ? []
    : students
        .map((s) => ({ name: s.name, msg: problemFor(s) }))
        .filter((b) => b.msg && b.msg !== "loading");

  async function submit() {
    if (!allValid || saving) return;
    setSaving(true);
    setError("");
    try {
      // One atomic RPC per student: all contact roles + dismissal method are
      // replaced in a single transaction, so a pickup<->do-not-release move can't
      // race the exclusion trigger and half-save (audit P2).
      for (const s of students) {
        const d = byStudent[s.student_id];
        const g2 = d.guardian2 || {};
        const { error: saveErr } = await supabase.rpc("replace_student_pickup_dnr_guardian", {
          p_student_id: s.student_id,
          p_organization_id: orgId,
          p_pickup: nonEmpty(d.pickup),
          p_do_not_release: nonEmpty(d.doNotRelease),
          p_guardian: (g2.first_name || "").trim() ? [g2] : [],
          p_dismissal_method: d.dismissal_method || null,
          // 7th argument, added by migration 20260807b. The parameter has NO
          // default there on purpose, so the old 6-arg signature and this one
          // coexist unambiguously while both environments roll forward - which
          // means this call must always pass it, even as null.
          p_aftercare_provider: d.aftercare_provider || null,
        });
        if (saveErr) throw saveErr;
      }
      onComplete();
    } catch (e) {
      setError(e.message ?? "We couldn't save your info. Please try again.");
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
          the same glance as the control it explains. */}
      {blockers.length > 0 && !saving && (
        <div className="mt-6 rounded-lg border-2 border-j2s-purple/15 bg-j2s-purple-soft/40 px-4 py-3 text-sm text-j2s-ink/80">
          <p className="font-semibold text-j2s-ink">Still needed before you continue:</p>
          <ul className="mt-1 grid gap-1">
            {blockers.map((b, i) => (
              <li key={i}>{students.length > 1 && b.name ? `${b.name}: ${b.msg}` : b.msg}</li>
            ))}
          </ul>
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
