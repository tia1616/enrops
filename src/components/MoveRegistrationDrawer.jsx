// src/components/MoveRegistrationDrawer.jsx
//
// Move a child from one class to another (Jessica, 2026-11-25). Until now every
// move was a hand-written database edit. The shape copies Sawyer's "Edit
// Enrollment" and Activity Messenger's "Switch": pick the new class from a list that
// shows spots left, read one sentence that says exactly what will happen, press.
//
// THE RULES, all hers:
//   * No money moves. The sentence says what they paid against what the new class
//     costs when the two differ, and the difference is settled separately.
//   * The family is emailed by default; untick to skip.
//   * A full class can be filled past capacity, after a warning.
//
// Everything is decided server-side by admin-move-registration; this panel only
// gathers the choice and shows what came back.
//
// Props:
//   registration: { id, studentName }
//   onClose():    dismiss without changes
//   onDone():     a move happened - caller should reload

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { formatCalendarDate } from "../lib/programSchedule";
import { moveConfirmSentence, seatLabel } from "../lib/rosterActions";

const PURPLE = "#1C004F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const OK = "#3a7c3a";
const RED = "#b53737";
const CREAM = "#FBFBFB";
const AMBER_BG = "#fff7ed";
const AMBER_LINE = "#fed7aa";
const AMBER_INK = "#7c2d12";

const fmtCents = (c) => `$${((Number(c) || 0) / 100).toFixed(2)}`;

export default function MoveRegistrationDrawer({ registration, onClose, onDone }) {
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");
  const [data, setData] = useState(null); // { registration, from, classes }
  const [query, setQuery] = useState("");
  const [pickedId, setPickedId] = useState(null);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: res, error } = await supabase.functions.invoke("admin-move-registration", {
        body: { mode: "options", registration_id: registration.id },
      });
      if (cancelled) return;
      if (error || res?.error) {
        console.error("[MoveRegistrationDrawer] options failed", error || res?.error);
        // A refusal is not a hiccup: "try again" would never work, so say why.
        setLoadErr(res?.message || (res?.error === "forbidden"
          ? "Only an owner or admin can move a child to another class."
          : "We couldn't load the classes. Close this and try again."));
      } else {
        setData(res);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [registration.id]);

  const classes = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = data?.classes ?? [];
    if (!q) return list;
    return list.filter((c) =>
      [c.label, c.summary, c.term].filter(Boolean).join(" ").toLowerCase().includes(q));
  }, [data, query]);

  const picked = (data?.classes ?? []).find((c) => c.id === pickedId) || null;
  const first = data?.registration?.student_first_name || registration.studentName || "this child";
  const isBundleLeg = /^vip/i.test(data?.registration?.discount_type || "");
  const movable = data?.registration?.movable !== false;
  const canSubmit = !busy && !!picked && !picked.already_in && movable;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr("");
    const { data: res, error } = await supabase.functions.invoke("admin-move-registration", {
      body: {
        mode: "move",
        registration_id: registration.id,
        target_program_id: picked.id,
        notify_family: notify,
        // The panel has already shown the full-class warning beside the button,
        // so pressing it IS the confirmation.
        confirm_over_capacity: !!picked.is_full,
      },
    });
    setBusy(false);
    if (error || res?.error) {
      // A seat can fill between loading the list and pressing. The server says so;
      // mark the class full here so the warning appears and the next press confirms.
      if (res?.error === "target_full") {
        setData((d) => ({
          ...d,
          classes: d.classes.map((c) => c.id === picked.id
            ? { ...c, is_full: true, seats_taken: res.seats_taken ?? c.seats_taken }
            : c),
        }));
      }
      setErr(res?.message || "Couldn't move them. Nothing changed.");
      return;
    }
    setResult(res);
  }

  const emailLine = (() => {
    const e = result?.email;
    if (!e || !e.requested) return "The family was not emailed.";
    if (e.sent > 0 && e.failed === 0) return `The family was emailed (${e.sent} ${e.sent === 1 ? "address" : "addresses"}).`;
    if (e.sent > 0) return `The email reached ${e.sent} of ${e.sent + e.failed} addresses.`;
    if (e.error === "no_address") return "We have no email address for this family, so nobody was emailed.";
    return "The move worked, but the email to the family did not send. Tell them yourself.";
  })();

  return (
    <div
      onClick={busy ? undefined : (result ? onDone : onClose)}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 16px", zIndex: 220 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "#fff", width: "100%", maxWidth: 520, border: `1px solid ${RULE}`, borderRadius: 10, padding: 22, boxShadow: "0 10px 40px rgba(0,0,0,0.2)", maxHeight: "85vh", overflowY: "auto" }}
      >
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: INK }}>
          Move {registration.studentName || "this child"} to another class
        </h3>

        {loading && <p style={{ color: MUTED, fontSize: 13, marginTop: 12 }}>Loading classes…</p>}
        {loadErr && (
          <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 12.5, marginTop: 12 }}>{loadErr}</div>
        )}

        {result && (
          <div role="status" style={{ marginTop: 14, background: `${OK}14`, border: `1px solid ${OK}55`, borderRadius: 8, padding: 12, fontSize: 13, color: INK, lineHeight: 1.55 }}>
            <strong>Moved.</strong> {first} is now in {picked?.label}.{" "}
            {result.over_capacity ? "That class is now over its capacity. " : ""}
            {emailLine}
          </div>
        )}

        {!loading && !loadErr && data && !result && (
          <>
            <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, padding: "10px 12px", marginTop: 12, fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
              Now in <strong style={{ color: INK }}>{data.from.label}</strong>
              {data.from.term ? ` · ${data.from.term}` : ""}
              {data.registration.amount_cents != null && (
                // The registration's price, not "paid": it can be unpaid, part-way
                // through a plan, or one leg of a bundle. See rosterActions.js.
                <> · <strong style={{ color: INK }}>{fmtCents(data.registration.amount_cents)}</strong></>
              )}
            </div>

            {!movable && (
              <div style={{ marginTop: 12, color: RED, fontSize: 12.5 }}>
                Only a child who has a place in the class can be moved.
              </div>
            )}

            <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: INK, marginTop: 16, marginBottom: 6 }}>
              Move to
            </label>
            <input
              type="search" value={query} onChange={(e) => setQuery(e.target.value)} disabled={busy}
              placeholder="Search by class, school or term"
              style={{ width: "100%", boxSizing: "border-box", padding: "8px 12px", fontSize: 13, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: "inherit" }}
            />
            <div style={{ marginTop: 8, maxHeight: 280, overflowY: "auto", border: `1px solid ${RULE}`, borderRadius: 8 }}>
              {classes.length === 0 && (
                <div style={{ padding: 12, fontSize: 12.5, color: MUTED }}>
                  {(data.classes ?? []).length === 0 ? "There are no other open classes to move them to." : "No class matches that search."}
                </div>
              )}
              {classes.map((c) => {
                const seats = seatLabel(c);
                const checked = c.id === pickedId;
                return (
                  <label key={c.id} style={{
                    display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 11px",
                    borderBottom: `1px solid ${RULE}`, cursor: c.already_in ? "not-allowed" : "pointer",
                    background: checked ? "rgba(28,0,79,0.05)" : "#fff", opacity: c.already_in ? 0.55 : 1,
                  }}>
                    <input type="radio" name="move-target" checked={checked} disabled={busy || c.already_in}
                      onChange={() => { setPickedId(c.id); setErr(""); }} style={{ marginTop: 3 }} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: INK }}>{c.label}</span>
                      <span style={{ display: "block", fontSize: 11.5, color: MUTED, marginTop: 2, lineHeight: 1.4 }}>
                        {[c.summary, c.term,
                          c.first_session_date ? `${c.started ? "started" : "starts"} ${formatCalendarDate(c.first_session_date, { month: "short", day: "numeric" }) || ""}` : null,
                          c.price_cents != null ? fmtCents(c.price_cents) : null,
                        ].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span style={{ fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap", color: c.already_in ? MUTED : c.is_full ? AMBER_INK : OK }}>
                      {c.already_in ? "Already in this class" : seats}
                    </span>
                  </label>
                );
              })}
            </div>

            {picked && (
              <>
                {picked.is_full && (
                  <div role="alert" style={{ marginTop: 12, background: AMBER_BG, border: `1px solid ${AMBER_LINE}`, borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: AMBER_INK, lineHeight: 1.5 }}>
                    <strong>This class is full</strong> ({picked.seats_taken} of {picked.max_capacity}). Moving {first} puts it at {Number(picked.seats_taken) + 1} of {picked.max_capacity}.
                  </div>
                )}
                {picked.started && (
                  <div style={{ marginTop: 10, fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
                    This class has already started, so {first} joins from the next session.
                  </div>
                )}
                {isBundleLeg && (
                  <div style={{ marginTop: 10, fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
                    This is one term of a year-long sign-up. Only this term moves; their other terms stay where they are.
                  </div>
                )}

                <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 14, cursor: busy ? "not-allowed" : "pointer" }}>
                  <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} disabled={busy} style={{ marginTop: 2 }} />
                  <span>
                    <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: INK }}>Email the family about the move</span>
                    <span style={{ display: "block", fontSize: 11.5, color: MUTED, marginTop: 2, lineHeight: 1.4 }}>
                      One short email from you naming the new class, where and when it meets, and the next date. Both parents on file get it.
                    </span>
                  </span>
                </label>

                {/* THE SENTENCE BESIDE THE BUTTON: who, from which class, to which,
                    and what happens to the money. See src/lib/rosterActions.js. */}
                <div style={{ marginTop: 14, background: "rgba(28,0,79,0.05)", border: `1px solid ${PURPLE}33`, borderRadius: 8, padding: "10px 12px", fontSize: 13, color: INK, lineHeight: 1.5 }}>
                  {moveConfirmSentence({
                    studentName: registration.studentName,
                    fromLabel: data.from.label,
                    toLabel: picked.label,
                    paidCents: data.registration.amount_cents,
                    toPriceCents: picked.price_cents,
                  })}
                </div>
              </>
            )}

            {err && (
              <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 12.5, marginTop: 12, lineHeight: 1.5 }}>{err}</div>
            )}
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          {result ? (
            <button type="button" onClick={onDone}
              style={{ padding: "8px 16px", background: PURPLE, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
              Done
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose} disabled={busy}
                style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: busy ? "not-allowed" : "pointer" }}>
                Cancel
              </button>
              {!loading && !loadErr && (
                <button type="button" onClick={submit} disabled={!canSubmit}
                  style={{ padding: "8px 16px", background: canSubmit ? PURPLE : "#bbb", color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: canSubmit ? "pointer" : "not-allowed" }}>
                  {busy ? "Moving…" : picked?.is_full ? `Move ${first} anyway` : `Move ${first}`}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
