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
          supabase.from("students").select("id, dismissal_method").in("id", ids),
        ]);
        if (cancelled) return;
        const parsed = parseRegFields(fields || []);
        setStd(parsed.std);
        setGuardianCfg(parsed.std.guardian_secondary || null);

        const init = {};
        for (const s of students) {
          const cs = (contacts || []).filter((c) => c.student_id === s.student_id);
          const dm = (studs || []).find((x) => x.id === s.student_id)?.dismissal_method || "";
          init[s.student_id] = {
            dismissal_method: dm,
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
    if (d.dismissal_method === "released_to_authorized_adult" && nonEmpty(d.pickup).length === 0) {
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
                dismissalMethod={d.dismissal_method}
                onDismissalChange={(v) => update(s.student_id, { dismissal_method: v })}
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
