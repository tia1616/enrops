// A partner's decision on a provider's record (spec v3 H2 section 7 and the
// History list; partner_acceptances, 20261102b). Rendered on the partner's
// provider page AND on the provider's admin page for that partner, like the
// rest of ProviderRecord: the provider sees the same decisions the partner
// recorded, read-only.
//
// Who may record is decided by the database (record_partner_decision: a
// host_admin login of this partner only). `can_decide` from partner_decisions()
// only chooses whether the form is drawn. Each decision is a new row; nothing
// here edits or removes one.

import { useEffect, useRef, useState } from "react";
import { getPartnerDecisions, recordPartnerDecision } from "../../lib/partnerPortal.js";
import { DECISIONS, DECISION_CHOICES, decisionProblem, decisionRecordedLine } from "../../lib/partnerPortalLogic.js";
import DocumentStatusBadge from "../../components/DocumentStatusBadge.jsx";

function DecisionLabel({ d }) {
  return <DocumentStatusBadge badge={DECISIONS[d.decision] ?? DECISIONS.withdrawn} />;
}

/** `partnerName` set = the provider is looking (wording names the partner). */
export default function PartnerDecision({ partnerId, partnerName = null }) {
  const provider = Boolean(partnerName);
  // undefined = loading, null = not available to this login.
  const [panel, setPanel] = useState(undefined);
  const [loadError, setLoadError] = useState("");
  const [decision, setDecision] = useState("");
  const [note, setNote] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  // The form is open only when there is nothing decided yet, or the host
  // chose "Change decision". Recording closes it (Jessica 2026-11-02: an
  // always-open form looked like nothing happened).
  const [changing, setChanging] = useState(false);
  const busy = useRef(false);

  // The component is keyed on the partner by its parents, so partnerId never
  // changes under a mounted panel and no cancellation is needed.
  async function load() {
    const p = await getPartnerDecisions(partnerId);
    setPanel(p);
    return p;
  }

  useEffect(() => {
    load()
      .then((p) => setTitle(p?.last_title ?? ""))
      .catch((err) => { setPanel(null); setLoadError(`Couldn't load decisions: ${err?.message ?? "unknown error"}`); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerId]);

  async function submit(e) {
    e.preventDefault();
    // A second click while the first is saving would record two decisions.
    if (busy.current) return;
    const problem = decisionProblem({ decision, note, title });
    if (problem) { setError(problem); return; }
    busy.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await recordPartnerDecision(partnerId, { decision, note: note.trim(), title: title.trim() });
      setDecision("");
      setNote("");
      setChanging(false);
      // Recorded either way; a failed reload must not read as a failed save
      // (red would invite recording it twice).
      await load()
        .then(() => setNotice("Decision recorded."))
        .catch(() => setNotice("Decision recorded. Refresh the page to see it."));
    } catch (err) {
      setError(err?.message || "Couldn't record the decision. Please try again.");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  if (panel === undefined) return null;
  if (panel === null) {
    return loadError ? <p className="error-text mt-5">{loadError}</p> : null;
  }

  const version = panel.requirements_version;
  const decisions = panel.decisions ?? [];
  const latest = decisions[0] ?? null;
  const formOpen = !provider && panel.can_decide && (!latest || changing);

  function cancel() {
    setChanging(false);
    setDecision("");
    setNote("");
    setError("");
  }

  return (
    <section className="mt-5 rounded-2xl bg-white p-4 shadow-card">
      <h2 className="text-base font-bold text-j2s-ink">{provider ? `${partnerName}'s decision` : "Your decision"}</h2>
      {notice && (
        <p role="status" className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">{notice}</p>
      )}

      {latest ? (
        <div className="mt-2">
          <DecisionLabel d={latest} />
          <p className="mt-1 text-sm text-j2s-ink/70">{decisionRecordedLine(latest, partnerName)}</p>
          {latest.note && <p className="mt-1 whitespace-pre-line text-sm text-j2s-ink/80">{latest.note}</p>}
          {latest.requirements_version < version && (
            <p className="mt-1 text-xs text-amber-900">
              {provider ? `${partnerName}'s` : "Your"} requirements are now version {version}.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-2 text-sm text-j2s-ink/60">{provider ? `${partnerName} hasn't recorded a decision yet.` : "No decision recorded yet."}</p>
      )}

      {!provider && panel.can_decide && latest && !changing && (
        <button
          type="button" className="btn-j2s-secondary mt-3"
          onClick={() => { setChanging(true); setNotice(""); }}
        >
          Change decision
        </button>
      )}

      {formOpen && (
        <form onSubmit={submit} className="mt-4 space-y-3 border-t border-j2s-ink/10 pt-4">
          <fieldset className="space-y-2">
            <legend className="sr-only">Decision</legend>
            {DECISION_CHOICES.map((key) => (
              <label key={key} className="flex items-start gap-2 text-sm text-j2s-ink">
                <input
                  type="radio" name={`decision-${partnerId}`} value={key} className="mt-1"
                  checked={decision === key} onChange={() => { setDecision(key); setError(""); }}
                />
                <span>{DECISIONS[key].choice.replace("{N}", String(version))}</span>
              </label>
            ))}
          </fieldset>
          <label className="block text-sm text-j2s-ink">
            <span className="font-semibold">{decision === "not_accepted" ? "What is missing" : "Note (optional)"}</span>
            <textarea className="input-field mt-1" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <label className="block text-sm text-j2s-ink">
            <span className="font-semibold">Your title</span>
            <input className="input-field mt-1" maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          {error && <p className="error-text">{error}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={saving} className="btn-j2s-primary">{saving ? "Saving…" : "Record decision"}</button>
            {latest && <button type="button" onClick={cancel} disabled={saving} className="text-sm font-semibold text-j2s-ink/60 hover:underline">Cancel</button>}
          </div>
          <p className="text-xs text-j2s-ink/50">Your decision is saved with today's status. It is not shared with other hosts.</p>
        </form>
      )}
      {!provider && !panel.can_decide && (
        <p className="mt-3 text-sm text-j2s-ink/60">Only a host admin can record a decision.</p>
      )}

      {decisions.length > 1 && (
        <div className="mt-4 border-t border-j2s-ink/10 pt-3">
          <h3 className="text-sm font-semibold text-j2s-ink/70">History</h3>
          <ul className="mt-2 space-y-2">
            {decisions.slice(1).map((d) => (
              <li key={d.id} className="text-sm">
                <DecisionLabel d={d} />
                <span className="ml-2 text-j2s-ink/60">{decisionRecordedLine(d, partnerName)}</span>
                {d.note && <div className="mt-0.5 whitespace-pre-line text-j2s-ink/70">{d.note}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
