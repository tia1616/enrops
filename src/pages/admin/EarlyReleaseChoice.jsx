// src/pages/admin/EarlyReleaseChoice.jsx
//
// Asked right after a district calendar is saved, when that district has
// OCCASIONAL early-release days that land on a class's weekday.
//
// THE PROBLEM IT SOLVES (Jessica, 14 Aug 2026): school lets out early, so the
// class starts early -- it is not cancelled. Until 20260814a there was no way
// to say that, and every occasional early-release date was skipped like a
// holiday. On Jeff's real data that was 20 of his 21 classes.
//
// NOT ASKED for a weekday that is early-release EVERY week all year. That was
// never skipped (the rule Jessica confirmed on 16 Jul) and needs no choice, so
// programs_needing_early_release_choice leaves those out. The operator is only
// ever asked about days where the answer actually changes something.
//
// THE FLOW IS JESSICA'S, 14 Aug: yes/no -> every school or only some -> a time
// -> then confirm. The last step is an EDITABLE LIST rather than a message,
// which is the one change I made to her flow and the reason is in her own data:
// his schools inside one district already start at different times (PPS runs
// 2:35, 2:45 and 3:20; LOSD 2:45 and 2:05), and Cascadia has two classes at one
// school. A single district-wide time would be wrong for some of them, and he
// would find out weeks later. Showing the list costs no extra question and is
// what Acuity and Calendly both do -- apply in bulk, then correct the odd one.
//
// LEAVING A TIME BLANK KEEPS TODAY'S BEHAVIOUR (that date is skipped). Blank is
// not a broken state, it is the "no" answer for one class.

import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { formatTimeText, formatTimeRange, to24h, to12hText, durationMinutes, addMinutes24h } from "../../lib/timeText";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const AMBER_INK = "#a16207";
const AMBER_BG = "#fefce8";

const btnPrimary = {
  padding: "10px 18px", borderRadius: 8, border: "none", background: BRIGHT,
  color: "#fff", fontSize: 14, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
};
const btnPlain = {
  padding: "10px 18px", borderRadius: 8, border: `1px solid ${RULE}`, background: "#fff",
  color: INK, fontSize: 14, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
};
const timeInput = {
  padding: "7px 9px", borderRadius: 7, border: `1px solid ${RULE}`,
  fontSize: 13.5, fontFamily: "inherit", color: INK, width: 130,
};

export default function EarlyReleaseChoice({ org, districtId, districtText, districtLabel, onDone }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [rows, setRows] = useState([]);          // from the RPC, untouched
  const [draft, setDraft] = useState({});        // { [program_id]: { start, end } } as 24h input values
  const [step, setStep] = useState("ask");       // ask | scope | time | list | clearConfirm | done
  const [bulk, setBulk] = useState({ start: "", end: "" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedCount, setSavedCount] = useState(0);
  const [clearedCount, setClearedCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError("");
      // One call. Whether a date is occasional or the location's normal
      // schedule is decided by the same SQL the date derivation uses, never
      // re-decided here -- two answers to that question would drift.
      const { data, error } = await supabase.rpc("programs_needing_early_release_choice", {
        p_org_id: org?.id,
        p_district_id: districtId ?? null,
        p_district_text: districtText ?? null,
      });
      if (cancelled) return;
      if (error) {
        console.error("[EarlyReleaseChoice] lookup failed", error);
        // Fail visibly. Silently rendering "no classes affected" would tell the
        // operator their schedule is fine when we simply could not check.
        setLoadError(error.message || "Couldn't check which classes this affects.");
        setLoading(false);
        return;
      }
      const list = data ?? [];
      setRows(list);
      setDraft(Object.fromEntries(list.map((r) => [r.program_id, {
        start: to24h(r.early_release_start_time ?? ""),
        end: to24h(r.early_release_end_time ?? ""),
      }])));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [org?.id, districtId, districtText]);

  // Nothing to ask -> hand control straight back, rather than rendering null
  // and leaving a blank space where the district's row should be. A calendar
  // can have early-release days that land on no class's weekday at all.
  useEffect(() => {
    if (!loading && !loadError && rows.length === 0) onDone?.({ changed: false });
    // onDone is intentionally out of the deps: a parent that recreates the
    // callback each render would turn this into a loop.
  }, [loading, loadError, rows.length]);

  const alreadySet = rows.filter((r) => (r.early_release_start_time ?? "").trim() !== "");
  const dateCount = rows.reduce((max, r) => Math.max(max, r.exception_count ?? 0), 0);

  // The end time this class WOULD have if it kept its usual length, starting at
  // `start24`. A parent needs the whole window, not the start, so an end is
  // filled in for them rather than left to be typed 13 times — and a class that
  // normally runs 2:35-3:35 starting at 12:45 ends at 1:45, which is almost
  // always right. Still editable; this only fills a BLANK.
  function derivedEnd(row, start24) {
    if (!start24) return "";
    const mins = durationMinutes(row.start_time, row.end_time);
    return mins ? addMinutes24h(start24, mins) : "";
  }

  function setRowField(id, field, value) {
    // Writes ONE field of ONE row onto what we already hold, rather than
    // rebuilding the map from the inputs on screen. Same reason the document
    // toggle does: rebuilding drops anything this render does not know about.
    setDraft((d) => {
      const cur = d[id] ?? { start: "", end: "" };
      const next = { ...cur, [field]: value };
      // Typing a start fills the end IF it is empty. Never overwrites an end the
      // operator typed, and clearing the start does not wipe their end either.
      if (field === "start" && value && !cur.end) {
        const row = rows.find((r) => r.program_id === id);
        if (row) next.end = derivedEnd(row, value);
      }
      return { ...d, [id]: next };
    });
  }

  function applyBulkAndContinue() {
    setDraft((d) => {
      const next = { ...d };
      for (const r of rows) {
        // Per row, not one shared end: two classes can start at the same time on
        // an early-release day and still run different lengths.
        next[r.program_id] = {
          start: bulk.start,
          end: bulk.end || derivedEnd(r, bulk.start),
        };
      }
      return next;
    });
    setStep("list");
  }

  async function persist(values, { clearing = false } = {}) {
    // values: { [program_id]: { start, end } } already in stored 12-hour text,
    // or nulls when clearing.
    setSaving(true);
    setSaveError("");
    try {
      // Group identical values so this is a handful of requests, not one per
      // class. Only the two early-release columns are written -- never the whole
      // row, which is the bug still open in six other editors.
      const groups = new Map();
      for (const [id, v] of Object.entries(values)) {
        const key = `${v.start ?? ""}|${v.end ?? ""}`;
        if (!groups.has(key)) groups.set(key, { start: v.start, end: v.end, ids: [] });
        groups.get(key).ids.push(id);
      }
      for (const g of groups.values()) {
        const { error } = await supabase
          .from("programs")
          .update({
            early_release_start_time: g.start || null,
            early_release_end_time: g.end || null,
          })
          .in("id", g.ids)
          // Belt and braces on top of RLS: this screen only ever edits this
          // org's classes.
          .eq("organization_id", org.id);
        if (error) throw error;
      }
      const setCount = Object.values(values).filter((v) => (v.start ?? "") !== "").length;
      setSavedCount(setCount);
      setClearedCount(clearing ? Object.keys(values).length : Object.values(values).filter((v) => (v.start ?? "") === "").length);
      setStep("done");
    } catch (e) {
      console.error("[EarlyReleaseChoice] save failed", e);
      // Stay on the list. A step that advances after a failed write would tell
      // the operator their classes changed when they did not.
      setSaveError(`Couldn't save: ${e.message ?? "unknown error"}. Nothing changed.`);
    } finally {
      setSaving(false);
    }
  }

  function saveList() {
    const values = {};
    for (const r of rows) {
      const d = draft[r.program_id] ?? { start: "", end: "" };
      values[r.program_id] = {
        start: d.start ? to12hText(d.start) : "",
        end: d.end ? to12hText(d.end) : "",
      };
    }
    persist(values);
  }

  function answerNo() {
    // "No" only has work to do if something is currently set. Clearing is
    // destructive -- it puts those dates back to being skipped and drops times
    // the operator typed -- so it is confirmed, never silent. With nothing set
    // there is nothing to confirm and nothing to write.
    if (alreadySet.length === 0) {
      onDone?.({ changed: false });
      return;
    }
    setStep("clearConfirm");
  }

  function confirmClear() {
    const values = Object.fromEntries(rows.map((r) => [r.program_id, { start: "", end: "" }]));
    persist(values, { clearing: true });
  }

  const shell = (children) => (
    <div style={{
      background: "#fff", border: `2px solid ${BRIGHT}`, borderRadius: 12,
      padding: "20px 22px", display: "flex", flexDirection: "column", gap: 14,
    }}>
      {children}
    </div>
  );

  if (loading) return shell(<div style={{ color: MUTED, fontSize: 14 }}>Checking which classes this affects…</div>);

  if (loadError) {
    return shell(
      <>
        <div style={{ fontSize: 17, fontWeight: 700, color: INK }}>Early release</div>
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 12px", color: "#991b1b", fontSize: 13 }}>
          {loadError} Your calendar was saved. You can set early-release times per class in Scheduled Programs.
        </div>
        <div><button type="button" style={btnPlain} onClick={() => onDone?.({ changed: false })}>Close</button></div>
      </>
    );
  }

  // Nothing to ask. The calendar may still have early-release days -- they just
  // do not land on any class's weekday, or they are that location's normal
  // schedule and were never skipped.
  if (rows.length === 0) return null;

  if (step === "done") {
    return shell(
      <>
        <div style={{ fontSize: 17, fontWeight: 700, color: INK }}>Saved</div>
        <div style={{ fontSize: 14, color: INK, lineHeight: 1.55 }}>
          {savedCount > 0 ? (
            <>
              <strong>{savedCount}</strong> {savedCount === 1 ? "class" : "classes"} now {savedCount === 1 ? "meets" : "meet"} on {districtLabel}&rsquo;s early-release days, at the {savedCount === 1 ? "time" : "times"} you set.
              {clearedCount > 0 && <> The other <strong>{clearedCount}</strong> stay off on those days.</>}
            </>
          ) : (
            <>Those days stay off your schedule, the same as before.</>
          )}
        </div>
        <div style={{ fontSize: 13, color: MUTED }}>
          You can change any of this any time in <strong>Scheduled Programs</strong>.
        </div>
        <div><button type="button" style={btnPrimary} onClick={() => onDone?.({ changed: true })}>Done</button></div>
      </>
    );
  }

  if (step === "clearConfirm") {
    return shell(
      <>
        <div style={{ fontSize: 17, fontWeight: 700, color: INK }}>Turn early-release classes off?</div>
        <div style={{ background: AMBER_BG, border: `1px solid ${AMBER_INK}33`, borderRadius: 8, padding: "11px 13px", fontSize: 13.5, color: INK, lineHeight: 1.55 }}>
          <strong>{alreadySet.length}</strong> {alreadySet.length === 1 ? "class has" : "classes have"} an early-release time set. Saying no clears {alreadySet.length === 1 ? "it" : "them"}, and {districtLabel}&rsquo;s early-release days go back to being skipped &mdash; which moves the last session of {alreadySet.length === 1 ? "that class" : "those classes"} later.
        </div>
        {saveError && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 12px", color: "#991b1b", fontSize: 13 }}>{saveError}</div>}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" style={btnPrimary} disabled={saving} onClick={confirmClear}>
            {saving ? "Clearing…" : "Yes, clear them"}
          </button>
          <button type="button" style={btnPlain} disabled={saving} onClick={() => setStep("ask")}>Cancel</button>
        </div>
      </>
    );
  }

  if (step === "ask") {
    return shell(
      <>
        <div style={{ fontSize: 17, fontWeight: 700, color: INK }}>
          {districtLabel} has {dateCount} early-release {dateCount === 1 ? "day" : "days"} that land on your class {rows.length === 1 ? "day" : "days"}
        </div>
        <div style={{ fontSize: 14, color: INK, lineHeight: 1.55 }}>
          School lets out early on {dateCount === 1 ? "that day" : "those days"}. Do you still teach?
        </div>
        <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
          Right now {rows.length === 1 ? "that class is" : `all ${rows.length} of these classes are`} skipped on {dateCount === 1 ? "it" : "them"}, and the last session moves later to make up the count.
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" style={btnPrimary} onClick={() => setStep("scope")}>Yes, I teach on early-release days</button>
          <button type="button" style={btnPlain} onClick={answerNo}>No, we skip those days</button>
        </div>
      </>
    );
  }

  if (step === "scope") {
    return shell(
      <>
        <div style={{ fontSize: 17, fontWeight: 700, color: INK }}>At every school in {districtLabel}?</div>
        <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
          {rows.length} {rows.length === 1 ? "class is" : "classes are"} affected across{" "}
          {new Set(rows.map((r) => r.school_name)).size}{" "}
          {new Set(rows.map((r) => r.school_name)).size === 1 ? "school" : "schools"}.
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" style={btnPrimary} onClick={() => setStep("time")}>Every school</button>
          <button type="button" style={btnPlain} onClick={() => setStep("list")}>Only some schools</button>
        </div>
        <button type="button" onClick={() => setStep("ask")} style={{ alignSelf: "flex-start", background: "none", border: "none", color: MUTED, fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>&larr; Back</button>
      </>
    );
  }

  if (step === "time") {
    return shell(
      <>
        <div style={{ fontSize: 17, fontWeight: 700, color: INK }}>What time do your classes start on those days?</div>
        <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
          {rows.length === 1
            ? "You can change it on the next screen."
            : `This fills in all ${rows.length}. You can change any of them on the next screen.`}
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12.5, fontWeight: 600, color: INK }}>
            Starts
            <input type="time" style={timeInput} value={bulk.start} onChange={(e) => setBulk((b) => ({ ...b, start: e.target.value }))} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12.5, fontWeight: 600, color: INK }}>
            Ends <span style={{ fontWeight: 400, color: MUTED }}>(we'll match your usual length)</span>
            <input type="time" style={timeInput} value={bulk.end} onChange={(e) => setBulk((b) => ({ ...b, end: e.target.value }))} />
          </label>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" style={{ ...btnPrimary, opacity: bulk.start ? 1 : 0.5 }} disabled={!bulk.start} onClick={applyBulkAndContinue}>Continue</button>
          <button type="button" style={btnPlain} onClick={() => setStep("scope")}>Back</button>
        </div>
      </>
    );
  }

  // step === "list"
  const bySchool = rows.reduce((acc, r) => {
    (acc[r.school_name] ??= []).push(r);
    return acc;
  }, {});

  return shell(
    <>
      <div style={{ fontSize: 17, fontWeight: 700, color: INK }}>Early release &mdash; {districtLabel}</div>
      <div style={{ fontSize: 13.5, color: INK, lineHeight: 1.55 }}>
        Set the time each class starts on {districtLabel}&rsquo;s early-release days.{" "}
        <span style={{ color: MUTED }}>Leave one blank to keep skipping that class on those days.</span>
      </div>
      {saveError && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 12px", color: "#991b1b", fontSize: 13 }}>{saveError}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {Object.entries(bySchool).map(([school, list]) => (
          <div key={school}>
            <div style={{ fontSize: 12, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{school}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {list.map((r) => (
                <div key={r.program_id} style={{
                  display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap",
                  border: `1px solid ${RULE}`, borderRadius: 9, padding: "10px 12px",
                }}>
                  <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: INK }}>{r.curriculum || "Class"}</div>
                    <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                      Normally {r.day_of_week ?? "weekly"} {formatTimeRange(r.start_time, r.end_time) || "—"}
                      {" · "}
                      {r.exception_count} early-release {r.exception_count === 1 ? "day" : "days"}
                    </div>
                  </div>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5, fontWeight: 600, color: MUTED }}>
                    Starts
                    <input
                      type="time"
                      style={timeInput}
                      value={draft[r.program_id]?.start ?? ""}
                      onChange={(e) => setRowField(r.program_id, "start", e.target.value)}
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5, fontWeight: 600, color: MUTED }}>
                    Ends
                    <input
                      type="time"
                      style={timeInput}
                      value={draft[r.program_id]?.end ?? ""}
                      onChange={(e) => setRowField(r.program_id, "end", e.target.value)}
                    />
                  </label>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button type="button" style={btnPrimary} disabled={saving} onClick={saveList}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" style={btnPlain} disabled={saving} onClick={() => onDone?.({ changed: false })}>Not now</button>
      </div>
    </>
  );
}
