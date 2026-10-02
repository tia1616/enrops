// src/pages/admin/ClosureScopeChoice.jsx
//
// Asked right after a district calendar is saved, when that calendar carries
// closures whose own label names ONLY middle or high school.
//
// THE PROBLEM IT SOLVES. A district calendar lists closures for the whole
// district. "No School: MS Grade Prep" is a middle-school day; an elementary
// after-school class is unaffected. Nothing in the product knew that, so on
// 30 Sept 2026 a wrong cancellation reached 8 families and an instructor.
//
// WHY THE OPERATOR DECIDES AND NOT US. We can read the band out of the label,
// but only the provider knows which bands they actually teach. A provider
// running a middle-school chess club wants exactly the dates an elementary
// provider wants gone. So this never decides: it SUGGESTS, pre-ticked, and the
// operator confirms. Same shape as EarlyReleaseChoice next door, which asks the
// one question the calendar cannot answer either.
//
// WHAT CONFIRMING DOES. A ticked date is REMOVED from the calendar, so every
// surface that reads it - the reminder email, the schedule screens, the session
// maths - is correct with no further change anywhere. An unticked date stays
// and is marked `applies: true`, which is only ever used to stop this screen
// asking about it again. Re-reading a calendar from its PDF legitimately
// re-asks, because that is a new set of dates.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import { unansweredSecondaryOnlyDates, classifyBands } from "../../lib/schoolBands";

const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

const btnPrimary = {
  padding: "10px 18px", borderRadius: 8, border: "none", background: BRIGHT,
  color: "#fff", fontSize: 14, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
};
const btnPlain = {
  padding: "10px 18px", borderRadius: 8, border: `1px solid ${RULE}`, background: "#fff",
  color: INK, fontSize: 14, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
};

function shell(children) {
  return (
    <div style={{
      background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8,
      padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12,
    }}>
      {children}
    </div>
  );
}

function formatDay(iso) {
  // Parsed as UTC parts, never new Date(iso) - that reads an ISO date as
  // midnight UTC and renders the day before west of Greenwich, which is every
  // tenant this product has.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString(undefined, {
    weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

// Loads its OWN calendar row rather than taking one as a prop, the same way
// EarlyReleaseChoice fetches its own rows. This screen opens the instant a
// calendar is saved, when the list behind it still holds the pre-save copy -
// reading that prop would show "nothing to check" for the very dates just
// uploaded. Matching mirrors calendarForRow: structured district_id first, the
// legacy free-text key second.
export default function ClosureScopeChoice({
  org, districtId, districtText, districtLabel, schoolYear, explicit = false, onDone,
}) {
  const [cal, setCal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError("");
      try {
        const { data, error } = await supabase
          .from("district_calendars")
          .select("id, district, district_id, no_school_dates, early_release_dates")
          .eq("organization_id", org.id)
          .eq("school_year", schoolYear);
        if (error) throw error;
        const rows = data ?? [];
        const match = districtId
          ? rows.find((c) => c.district_id === districtId
              || (districtText && !c.district_id && c.district === districtText))
          : rows.find((c) => !c.district_id && c.district === districtText);
        if (!cancelled) setCal(match ?? null);
      } catch (e) {
        console.error("Closure scope load failed:", e);
        // Fail CLOSED: with no calendar read we cannot know which dates are
        // only secondary, and guessing would remove a real closure.
        if (!cancelled) setLoadError(e.message ?? "unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [org?.id, districtId, districtText, schoolYear]);

  const noSchool = useMemo(() => unansweredSecondaryOnlyDates(cal?.no_school_dates), [cal]);
  const earlyRelease = useMemo(() => unansweredSecondaryOnlyDates(cal?.early_release_dates), [cal]);
  const candidates = useMemo(
    () => [...noSchool.map((r) => ({ ...r, list: "no_school_dates" })),
           ...earlyRelease.map((r) => ({ ...r, list: "early_release_dates" }))]
      .sort((a, b) => a.date.localeCompare(b.date)),
    [noSchool, earlyRelease],
  );

  // Pre-ticked = "doesn't apply to my classes", because that is the answer for
  // the provider this screen exists for. Unticking is the exception.
  //
  // Seeded by an effect, NOT by a useState initializer: the calendar is still
  // loading on first render, so an initializer would capture an empty list and
  // every box would come up unticked. Keyed on the candidate identities so it
  // seeds once when they arrive and never again - re-seeding on each render
  // would undo the operator's unticks as they made them.
  const candidateKey = candidates.map((c) => `${c.list}|${c.date}`).join(",");
  const [drop, setDrop] = useState(() => new Set());
  useEffect(() => {
    setDrop(new Set(candidateKey ? candidateKey.split(",") : []));
  }, [candidateKey]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [done, setDone] = useState(null); // { removed, kept }

  // Nothing to ask and nobody clicked: hand control straight back, so a save
  // never leaves an empty panel sitting where the calendar row was.
  // Must not fire while the calendar is still loading, or the panel hands
  // control back before it has read anything and the question is never asked.
  useEffect(() => {
    if (loading || loadError) return;
    if (candidates.length === 0 && !explicit && !done) onDone?.({ changed: false });
  }, [loading, loadError, candidates.length, explicit, done, onDone]);

  async function confirm() {
    setSaving(true);
    setSaveError("");
    try {
      const patch = {};
      for (const listName of ["no_school_dates", "early_release_dates"]) {
        const current = Array.isArray(cal?.[listName]) ? cal[listName] : [];
        const dropping = new Set(
          candidates.filter((c) => c.list === listName && drop.has(`${c.list}|${c.date}`)).map((c) => c.date),
        );
        const asked = new Set(candidates.filter((c) => c.list === listName).map((c) => c.date));
        const next = current
          .filter((r) => !dropping.has(r?.date))
          // Only the rows actually ASKED about get the marker. Everything else
          // is written back byte-identical, so this cannot quietly rewrite a
          // date nobody was shown.
          .map((r) => (asked.has(r?.date) ? { ...r, applies: true } : r));
        if (next.length !== current.length || asked.size > 0) patch[listName] = next;
      }
      // Only the two date columns move. A whole-row write here would revert
      // whatever another screen changed on this calendar in the meantime.
      patch.updated_at = new Date().toISOString();
      const { error } = await supabase.from("district_calendars").update(patch).eq("id", cal.id);
      if (error) throw error;
      setDone({ removed: drop.size, kept: candidates.length - drop.size });
    } catch (e) {
      console.error("Closure scope save failed:", e);
      setSaveError(`Couldn't save: ${e.message ?? "unknown error"}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return shell(<div style={{ color: MUTED, fontSize: 14 }}>Checking this calendar&rsquo;s closures…</div>);

  if (loadError) {
    return shell(
      <>
        <div style={{ fontSize: 17, fontWeight: 700, color: INK }}>Could not check {districtLabel}</div>
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 12px", color: "#991b1b", fontSize: 13 }}>
          {loadError} Your calendar was saved and every date on it is still in force. Open this again from the calendar row to check.
        </div>
        <div><button type="button" style={btnPlain} onClick={() => onDone?.({ changed: false })}>Close</button></div>
      </>
    );
  }

  if (done) {
    return shell(
      <>
        <div style={{ fontSize: 17, fontWeight: 700, color: INK }}>Saved</div>
        <div style={{ fontSize: 14, color: INK, lineHeight: 1.55 }}>
          {done.removed > 0 ? (
            <><strong>{done.removed}</strong> {done.removed === 1 ? "day is" : "days are"} off this calendar, so {done.removed === 1 ? "it" : "they"} will not cancel a class or email a family.</>
          ) : (
            <>Nothing changed. Those days stay on the calendar.</>
          )}
          {done.kept > 0 && <> The other <strong>{done.kept}</strong> stay, and you will not be asked about {done.kept === 1 ? "it" : "them"} again.</>}
        </div>
        <div><button type="button" style={btnPrimary} onClick={() => onDone?.({ changed: done.removed > 0 })}>Done</button></div>
      </>
    );
  }

  if (candidates.length === 0) {
    if (!explicit) return null;
    return shell(
      <>
        <div style={{ fontSize: 17, fontWeight: 700, color: INK }}>Nothing to check for {districtLabel}</div>
        <div style={{ fontSize: 14, color: INK, lineHeight: 1.55 }}>
          None of this calendar&rsquo;s closures are marked as middle or high school only, so every one of them applies to your classes.
        </div>
        <div><button type="button" style={btnPlain} onClick={() => onDone?.({ changed: false })}>Close</button></div>
      </>
    );
  }

  return shell(
    <>
      <div style={{ fontSize: 17, fontWeight: 700, color: INK }}>
        {candidates.length} {candidates.length === 1 ? "day on this calendar looks" : "days on this calendar look"} like {candidates.length === 1 ? "it is" : "they are"} middle or high school only
      </div>
      <div style={{ fontSize: 14, color: INK, lineHeight: 1.55 }}>
        {districtLabel} wrote {candidates.length === 1 ? "this one" : "these"} down for part of the district. Untick anything that <em>does</em> affect your classes.
      </div>
      <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
        A ticked day comes off this calendar, so it stops cancelling classes and stops families being emailed about it.
      </div>

      <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, overflow: "hidden" }}>
        {candidates.map((c) => {
          const key = `${c.list}|${c.date}`;
          const bands = classifyBands(c.reason).secondary.join(", ");
          return (
            <label
              key={key}
              style={{
                display: "flex", alignItems: "flex-start", gap: 10, padding: "11px 13px",
                borderBottom: `1px solid ${RULE}`, cursor: "pointer", background: "#fff",
              }}
            >
              <input
                type="checkbox"
                checked={drop.has(key)}
                onChange={(e) => {
                  const next = new Set(drop);
                  if (e.target.checked) next.add(key); else next.delete(key);
                  setDrop(next);
                }}
                style={{ marginTop: 3, width: 17, height: 17, flexShrink: 0, cursor: "pointer" }}
              />
              <span style={{ minWidth: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: INK }}>{formatDay(c.date)}</span>
                <span style={{ fontSize: 13, color: MUTED, display: "block", marginTop: 2 }}>
                  {c.reason || "No reason given"}
                  {bands && <> &middot; names {bands}</>}
                  {c.list === "early_release_dates" && <> &middot; early release</>}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {saveError && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 12px", color: "#991b1b", fontSize: 13 }}>
          {saveError}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" style={btnPrimary} disabled={saving} onClick={confirm}>
          {saving ? "Saving…" : drop.size > 0 ? `Remove ${drop.size} ${drop.size === 1 ? "day" : "days"}` : "Keep all of them"}
        </button>
        <button type="button" style={btnPlain} disabled={saving} onClick={() => onDone?.({ changed: false })}>
          Decide later
        </button>
      </div>
    </>,
  );
}
