// WaiverGate — blocking parent-portal step: the parent must read + agree to
// every required, active waiver before they can see program details.
//
// A signature is per-REGISTRATION (matching create-registration), so on submit
// we write one waiver_signatures row per (waiver, still-unsigned registration).
// RLS (parents_create_own_sigs) permits a parent to insert signatures only for
// registrations that belong to them. onComplete re-fetches the dashboard, which
// recomputes the gate (now empty) and lets them through.

import { useState } from "react";
import { supabase } from "../../lib/supabase.js";

export default function WaiverGate({ waivers, parent, orgId, onComplete }) {
  const parentName = `${parent?.first_name ?? ""} ${parent?.last_name ?? ""}`.trim();
  const [agreed, setAgreed] = useState({}); // waiverId -> bool
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const allAgreed = waivers.length > 0 && waivers.every((w) => agreed[w.id]);

  async function submit() {
    if (!allAgreed || saving) return;
    setSaving(true);
    setError("");
    try {
      const rows = [];
      for (const w of waivers) {
        for (const rid of w.missingRegIds) {
          rows.push({
            registration_id: rid,
            waiver_id: w.id,
            parent_id: parent.id,
            organization_id: orgId,
            signature_text: `I agree — ${parentName}`,
            waiver_text_snapshot: w.content,
            waiver_version: w.version || 1,
          });
        }
      }
      if (rows.length > 0) {
        const { error: insErr } = await supabase.from("waiver_signatures").insert(rows);
        if (insErr) throw insErr;
      }
      onComplete();
    } catch (e) {
      setError(e.message ?? "We couldn't save your agreement. Please try again.");
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="font-titan text-2xl text-j2s-ink sm:text-3xl">One quick step before you're in</h1>
      <p className="mt-2 text-j2s-ink/70">
        Please read and agree to the form{waivers.length === 1 ? "" : "s"} below to see your child's program details.
      </p>

      <div className="mt-8 space-y-6">
        {waivers.map((w) => {
          const isAgreed = !!agreed[w.id];
          return (
            <div key={w.id} className={`rounded-2xl border-2 p-6 transition ${isAgreed ? "border-j2s-purple bg-j2s-purple-soft/40" : "border-j2s-purple/10 bg-white"}`}>
              <div className="flex items-start justify-between gap-4">
                <h2 className="font-titan text-xl text-j2s-ink">{w.name}</h2>
                <span className="flex-shrink-0 rounded-full bg-j2s-orange/15 px-3 py-1 text-xs font-bold uppercase tracking-wider text-j2s-orange-dark">Required</span>
              </div>
              <div className="mt-4 max-h-72 overflow-y-auto rounded-xl border border-j2s-purple/10 bg-white p-4 text-sm leading-relaxed text-j2s-ink/80 whitespace-pre-wrap">
                {w.content}
              </div>
              <label className="mt-5 flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5 rounded border-2 border-j2s-purple/30 text-j2s-purple focus:ring-j2s-purple"
                  checked={isAgreed}
                  onChange={(e) => setAgreed((a) => ({ ...a, [w.id]: e.target.checked }))}
                />
                <span className="font-semibold text-j2s-ink">
                  I, <span className="text-j2s-purple">{parentName || "your name"}</span>, have read and agree to this {w.name.toLowerCase()}.
                </span>
              </label>
            </div>
          );
        })}
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <button
        onClick={submit}
        disabled={!allAgreed || saving}
        className={`mt-8 w-full rounded-xl px-6 py-3.5 font-bold text-white transition ${allAgreed && !saving ? "bg-j2s-purple hover:bg-j2s-purple-dark" : "cursor-not-allowed bg-j2s-purple/40"}`}
      >
        {saving ? "Saving…" : "Agree & continue"}
      </button>
    </div>
  );
}
