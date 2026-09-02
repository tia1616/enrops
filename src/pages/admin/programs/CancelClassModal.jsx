// Cancel a class that has families in it.
//
// WHY THIS EXISTS. You could not. `deleteProgram` refused with "refund or cancel
// those places first, or unpublish the class instead", and cancelProgram was
// only reachable down one narrow path: a class with ZERO active registrations,
// ZERO waiting families, and SOME cancelled history. So the normal reason to
// cancel - low enrolment, or not enough kit to run it - had no route at all.
//
// JESSICA'S THREE ANSWERS, 2026-09-01, and each one is a decision this screen
// implements rather than re-litigates:
//   1. NAME the affected families, do not just count them. Then let the operator
//      go and tell them, which is what Message families is for.
//   2. Follow what other platforms do. Sawyer's "Cancel Instance" does NOT
//      notify families; Jumbula-run programs notify and offer transfer or a
//      refund. So cancelling here is a STATUS CHANGE and nothing else.
//   3. Keep the word "cancelled", and keep it off the instructor schedule and
//      the instructor portal (shipped separately, live on prod).
//
// NO MONEY AND NO EMAIL, and the panel says so out loud. A refund is
// irreversible and has to reconcile against the Squarespace export by SKU, so it
// stays a separate deliberate act. An automatic email would be a message nobody
// wrote and nobody approved.
//
// WAITING FAMILIES ARE NOT HISTORY. Delete refuses outright when anyone is
// queued, because nothing on that screen could tell them. Cancel ALLOWS it - low
// enrolment is exactly when a queue also exists - but it must not strand them
// silently, so they are counted, named, and left on screen afterwards as the
// thing still to do.
import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const RED = "#b53737";
const AMBER = "#a16207";
const OK_GREEN = "#3a7c3a";

// WHICH FAMILIES, grouped by FAMILY - not by inbox. The send path groups by
// address because it is deciding who gets an email; this panel is answering "who
// is affected", and the unit of that is a household. Same rows, different
// question, so this is not a second spelling of the send grouping.
function groupFamilies(rows) {
  const byParent = new Map();
  for (const r of rows ?? []) {
    const key = r.parent_id;
    if (!key) continue;
    let g = byParent.get(key);
    if (!g) {
      g = { parent_id: key, name: "", children: [], childIds: new Set(), audiences: new Set() };
      byParent.set(key, g);
    }
    // The account holder names the family; a guardian's name is the fallback.
    if (r.recipient_kind === "parent" && (r.recipient_name ?? "").trim()) g.name = r.recipient_name.trim();
    else if (!g.name && (r.recipient_name ?? "").trim()) g.name = r.recipient_name.trim();
    if (r.audience) g.audiences.add(r.audience);
    if (r.student_id && !g.childIds.has(r.student_id)) {
      g.childIds.add(r.student_id);
      if ((r.student_first_name ?? "").trim()) g.children.push(r.student_first_name.trim());
    }
  }
  return [...byParent.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// onConfirm(programId) -> {ok, message}. The WRITE lives in the parent's
// cancelProgram, which already owns the status update, the zero-rows-means-RLS-
// refused check and the local row refresh. This panel decides and reports; it
// does not keep a second copy of the write.
export default function CancelClassModal({ program, orgId, onConfirm, onTellFamilies, onClose }) {
  const [rows, setRows] = useState(null);       // null = loading
  const [loadError, setLoadError] = useState("");
  const [phase, setPhase] = useState("confirm"); // confirm | cancelling | done
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      // include_waitlist so BOTH groups come back in one call - the queue is
      // half of what an operator needs to see before cancelling.
      // Called with the operator's own JWT, so the function's own
      // owner/admin/staff check applies rather than being bypassed.
      const { data, error } = await supabase.rpc("program_message_recipients", {
        p_program_id: program?.id,
        p_org_id: orgId,
        p_include_waitlist: true,
      });
      if (!alive) return;
      if (error) {
        // FAIL CLOSED on the read. Not being able to see who is affected is not
        // the same as nobody being affected, and cancelling is the branch that
        // must not run on a wrong zero.
        setLoadError("Couldn't check who's in this class, so it can't be cancelled right now. Refresh and try again.");
        setRows([]);
        return;
      }
      setRows(data ?? []);
    })();
    return () => { alive = false; };
  }, [program?.id, orgId]);

  const families = groupFamilies(rows);
  const enrolled = families.filter((f) => f.audiences.has("enrolled"));
  const waiting = families.filter((f) => f.audiences.has("waitlist") && !f.audiences.has("enrolled"));

  async function doCancel() {
    if (phase === "cancelling") return;
    setError("");
    setPhase("cancelling");
    let res;
    try {
      res = await onConfirm?.(program.id);
    } catch (e) {
      res = { ok: false, message: e?.message ?? String(e) };
    }
    // A MISSING RESULT IS NOT SUCCESS. If the caller returned nothing, this panel
    // does not know whether the class was cancelled, and claiming it was is the
    // silent-save lie in a new place - so it reports rather than celebrating.
    if (!res?.ok) {
      setError(res?.message || "Nothing was cancelled. Refresh and check the class before trying again.");
      setPhase("confirm");
      return;
    }
    setPhase("done");
  }

  const names = (list) => list.map((f) => `${f.name || "A family"}${f.children.length ? ` (${f.children.join(", ")})` : ""}`);
  const busy = phase === "cancelling";

  return (
    // textAlign reset for the same reason as MessageFamiliesModal: a fixed-position
    // child still inherits text alignment from whatever it is mounted inside, and
    // these panels are opened from row action columns that are right-aligned.
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 24, zIndex: 60, overflowY: "auto", textAlign: "left" }}>
      <div style={{ background: "#fff", borderRadius: 12, maxWidth: 600, width: "100%", padding: 20, boxShadow: "0 12px 40px rgba(0,0,0,0.2)", textAlign: "left" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: PURPLE }}>
              {phase === "done" ? "Class cancelled" : "Cancel this class?"}
            </div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{program?.curriculum || "This class"}</div>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close"
            style={{ background: "transparent", border: "none", color: MUTED, fontSize: 18, cursor: busy ? "not-allowed" : "pointer" }}>✕</button>
        </div>

        {phase === "done" ? (
          <div style={{ marginTop: 14 }}>
            <div style={{ background: "#eef7ee", border: "1px solid #cfe6cf", borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: OK_GREEN }}>
                Cancelled. It's off your schedule board and any instructor's portal.
              </div>
              <div style={{ fontSize: 12, color: INK, marginTop: 6 }}>
                Nobody has been emailed and no money has moved. It still shows in Programs with a
                Cancelled badge, and you can reopen it as a draft.
              </div>
            </div>
            {/* THE FOLLOW-THROUGH, which is the whole reason this is a panel and
                not a confirm(): cancelling without telling anyone is the failure
                mode, so the next step is offered right where the decision was
                made rather than left for the operator to remember. */}
            {(enrolled.length > 0 || waiting.length > 0) && (
              <div style={{ marginTop: 12, border: `1px solid ${RULE}`, borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>
                  Now do these two, in this order
                </div>
                <div style={{ fontSize: 12.5, color: INK, marginTop: 8, lineHeight: 1.6 }}>
                  <strong>1. Tell the {enrolled.length + waiting.length} {enrolled.length + waiting.length === 1 ? "family" : "families"}.</strong> Nothing has gone out yet.
                </div>
                <button type="button" onClick={() => { onTellFamilies?.(); }}
                  style={{ marginTop: 8, padding: "8px 14px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
                  Message families
                </button>
                {waiting.length > 0 && (
                  <div style={{ fontSize: 12, color: AMBER, marginTop: 8, lineHeight: 1.6 }}>
                    {waiting.length} of them {waiting.length === 1 ? "is" : "are"} on the waiting list. Tick
                    "also include families on the waiting list" so they hear too.
                  </div>
                )}
                <div style={{ fontSize: 12.5, color: INK, marginTop: 12, lineHeight: 1.6 }}>
                  <strong>2. Refund them</strong> in Class rosters: open this class, then <em>Refund</em> on each child.
                </div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 6, lineHeight: 1.6 }}>
                  If you refund before messaging, tick <em>“families who have left or been refunded”</em> so
                  they still hear from you.
                </div>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
              <button type="button" onClick={onClose}
                style={{ padding: "8px 16px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ marginTop: 14, fontSize: 13, color: INK }}>
              {rows === null ? (
                <span style={{ color: MUTED }}>Checking who's in this class…</span>
              ) : loadError ? (
                <span style={{ color: RED }}>{loadError}</span>
              ) : enrolled.length === 0 && waiting.length === 0 ? (
                <span>Nobody holds a place in this class and nobody is waiting.</span>
              ) : (
                <>
                  {enrolled.length > 0 && (
                    <div>
                      <strong>{enrolled.length} {enrolled.length === 1 ? "family holds" : "families hold"} a place:</strong>
                      <div style={{ fontSize: 12, color: MUTED, marginTop: 4, lineHeight: 1.6 }}>
                        {names(enrolled).join(" · ")}
                      </div>
                    </div>
                  )}
                  {waiting.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <strong>{waiting.length} {waiting.length === 1 ? "family is" : "families are"} on the waiting list:</strong>
                      <div style={{ fontSize: 12, color: MUTED, marginTop: 4, lineHeight: 1.6 }}>
                        {names(waiting).join(" · ")}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* WHAT TO DO NEXT, IN ORDER - and the order is a real constraint,
                not advice. A refund sets registrations.status='cancelled' AND
                cancelled_at (all 11 refunded rows on prod are that shape), and
                the message recipient rule excludes both. So refunding FIRST
                removes the family from the recipient list and they can never be
                told. Jessica worked this out herself; it is stated here because
                the product is the only thing that knows it. */}
            <div style={{ marginTop: 14, background: "#fdf6e3", border: "1px solid #ecdca6", borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 12.5, color: INK, lineHeight: 1.6 }}>
                <strong>Cancelling doesn't refund anyone or send any emails.</strong> Two things to do
                afterwards:
              </div>
              <ol style={{ margin: "8px 0 0", paddingLeft: 20, fontSize: 12.5, color: INK, lineHeight: 1.9 }}>
                <li><strong>Message the families</strong> — offered here as soon as you cancel, or from
                  Class rosters &rsaquo; <em>Message families</em>.</li>
                <li><strong>Refund them</strong> — Class rosters, open the class, then <em>Refund</em> on
                  each child.</li>
              </ol>
              {/* THE ORDER USED TO BE A TRAP and this panel warned about it: a
                  refund sets the registration to cancelled, which took the family
                  off the roster and out of the recipient list for good. Jessica's
                  fix was better than the warning - the message panel now has a
                  "families who have left or been refunded" group, so either order
                  works. The note stays because refunding first still means an
                  extra tick box to remember. */}
              <div style={{ fontSize: 12, color: MUTED, marginTop: 8, lineHeight: 1.6 }}>
                Either order works. If you refund first, tick <em>“families who have left or been
                refunded”</em> in the message panel so they still hear from you.
              </div>
            </div>

            {error && (
              <div style={{ marginTop: 12, background: `${RED}1A`, color: RED, padding: 8, borderRadius: 6, fontSize: 12 }}>{error}</div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button type="button" onClick={onClose} disabled={busy}
                style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: busy ? "not-allowed" : "pointer" }}>
                Keep the class
              </button>
              {/* Disabled until the affected list has actually loaded: cancelling
                  a class while still "checking who's in this class" is deciding
                  without the information the panel exists to show. */}
              <button type="button" onClick={doCancel} disabled={busy || rows === null || !!loadError}
                style={{ padding: "8px 16px", background: RED, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: (busy || rows === null) ? "not-allowed" : "pointer", opacity: (busy || rows === null || !!loadError) ? 0.5 : 1 }}>
                {busy ? "Cancelling…" : "Cancel the class"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
