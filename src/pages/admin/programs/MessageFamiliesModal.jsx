// Message the families of ONE class.
//
// The gap Jessica named: "there is no way to email just the families in one
// class - and it cost a real send today" (27 Aug, when the Art Rutkin FA26 class
// moved a week and nine confirmed families needed one sentence).
//
// PREVIEW FIRST, ALWAYS. The recipient list is fetched before a word is typed
// and re-fetched whenever the audience changes, because the standing rule is to
// count and inspect recipients before any send. Sawyer does the same thing -
// pick Booked and/or Waitlisted, then read the list - and it is the only way an
// operator can catch "14 when the class has 12" before families do.
//
// NO DEFAULT COPY. Subject and body start EMPTY with examples in the
// placeholders, deliberately: family-facing wording is Jessica's to approve, and
// a pre-filled sentence is one an operator can send without ever reading it.
// Sawyer auto-composes "A message from X about Y"; that can be added here once
// the wording is approved rather than invented in a modal.
//
// The families it CANNOT reach are shown, not hidden. A class whose roster came
// from a school that runs its own registration has placeholder addresses, and on
// prod one class has 13 of them - "13 recipients" with zero deliverable is the
// exact silent failure this panel exists to make visible.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const RED = "#b53737";
const AMBER = "#a16207";
const OK_GREEN = "#3a7c3a";

// Every placeholder the edge function fills, said in plain words. Not a jargon
// list: an operator reads "the parent's first name", not "{parent_first_name}
// interpolation".
const PLACEHOLDERS = [
  ["{parent_first_name}", "the parent's first name"],
  ["{student_first_name}", "their child - or all their children in this class"],
  ["{program_name}", "the class name"],
  ["{program_day}", "the weekday it runs"],
  ["{program_location}", "the school or site"],
  ["{org_name}", "your organisation's name"],
];

export default function MessageFamiliesModal({ program, orgId, onClose }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [includeWaitlist, setIncludeWaitlist] = useState(false);
  const [preview, setPreview] = useState(null);       // null = loading
  const [previewError, setPreviewError] = useState("");
  const [phase, setPhase] = useState("compose");       // compose | sending | done
  const [error, setError] = useState("");
  const [duplicate, setDuplicate] = useState(null);    // the 409 payload
  const [result, setResult] = useState(null);

  const call = useCallback(async (payload) => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error("Your sign-in expired. Refresh and try again.");
    const resp = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/notify-program-families`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          program_id: program?.id,
          organization_id: orgId,
          include_waitlist: includeWaitlist,
          ...payload,
        }),
      },
    );
    return { status: resp.status, json: await resp.json().catch(() => ({})) };
  }, [program?.id, orgId, includeWaitlist]);

  // Re-previewed whenever the audience changes, so the count on screen always
  // belongs to the toggle as it currently sits. A stale count is the thing that
  // makes an operator trust a number that is no longer true.
  useEffect(() => {
    let alive = true;
    setPreview(null);
    setPreviewError("");
    (async () => {
      try {
        const { status, json } = await call({ mode: "preview" });
        if (!alive) return;
        if (status !== 200) {
          setPreviewError(json?.error === "forbidden"
            ? "You don't have permission to message this class's families."
            : "Couldn't work out who would receive this. Refresh and try again.");
          setPreview({ recipients: [], unreachable: [], recipient_count: 0, unreachable_count: 0 });
          return;
        }
        setPreview(json);
      } catch (e) {
        if (alive) {
          setPreviewError(e.message ?? "Couldn't load the recipient list.");
          setPreview({ recipients: [], unreachable: [], recipient_count: 0, unreachable_count: 0 });
        }
      }
    })();
    return () => { alive = false; };
  }, [call]);

  async function send({ confirmDuplicate = false } = {}) {
    if (phase === "sending") return;
    setError("");
    setDuplicate(null);
    if (!subject.trim() || !body.trim()) {
      setError("Add a subject and a message before sending.");
      return;
    }
    if ((preview?.recipient_count ?? 0) === 0) {
      setError("Nobody in this class has an email address we can send to.");
      return;
    }
    setPhase("sending");
    try {
      const { status, json } = await call({
        mode: "send",
        subject: subject.trim(),
        body_text: body.trim(),
        confirm_duplicate: confirmDuplicate,
      });
      if (status === 409 && json?.error === "duplicate_send") {
        setDuplicate(json);
        setPhase("compose");
        return;
      }
      if (status !== 200) {
        setError(json?.message || json?.error || "Couldn't send. Nothing was sent.");
        setPhase("compose");
        return;
      }
      setResult(json);
      setPhase("done");
    } catch (e) {
      setError(e.message ?? "Couldn't send. Nothing was sent.");
      setPhase("compose");
    }
  }

  const count = preview?.recipient_count ?? 0;
  const unreachable = preview?.unreachable ?? [];
  const sending = phase === "sending";

  return (
    // textAlign RESET, and it is not cosmetic paranoia. This panel is opened
    // from the Class rosters row, whose action column is `textAlign: "right"`,
    // and a fixed-position child still INHERITS text alignment from its DOM
    // parent - so every label, the placeholder list and the footer note came out
    // right-aligned. A modal must not depend on where it happens to be mounted.
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 24, zIndex: 60, overflowY: "auto", textAlign: "left" }}>
      <div style={{ background: "#fff", borderRadius: 12, maxWidth: 640, width: "100%", padding: 20, boxShadow: "0 12px 40px rgba(0,0,0,0.2)", textAlign: "left" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 4 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: PURPLE }}>Message families</div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
              {program?.curriculum || "This class"}
              {preview?.program?.summary ? ` · ${preview.program.summary}` : ""}
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={sending} aria-label="Close"
            style={{ background: "transparent", border: "none", color: MUTED, fontSize: 18, cursor: sending ? "not-allowed" : "pointer" }}>
            ✕
          </button>
        </div>

        {phase === "done" ? (
          // THE RESULT WHERE THEY CLICKED. Counts first, then every failure by
          // name - a tally with no names is a result an operator cannot act on.
          <div style={{ marginTop: 14 }}>
            <div style={{ background: result?.failed ? "#fdf6e3" : "#eef7ee", border: `1px solid ${result?.failed ? "#ecdca6" : "#cfe6cf"}`, borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: result?.failed ? AMBER : OK_GREEN }}>
                {result?.status === "no_recipients"
                  ? "Nothing was sent - nobody in this class had an email address."
                  : `Sent to ${result?.sent} ${result?.sent === 1 ? "family" : "families"}${result?.failed ? `, ${result.failed} failed` : ""}.`}
              </div>
              {!!result?.unreachable_count && (
                <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
                  {result.unreachable_count} {result.unreachable_count === 1 ? "family has" : "families have"} no email address on file, so they were not included.
                </div>
              )}
              {result?.audit_recorded === false && (
                <div style={{ fontSize: 12, color: AMBER, marginTop: 6 }}>
                  The emails went out, but recording them in the log failed. Don't send again - check the log later.
                </div>
              )}
            </div>
            {(result?.results ?? []).filter((r) => r.status === "failed").length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: RED, marginBottom: 4 }}>These did not go:</div>
                {(result.results).filter((r) => r.status === "failed").map((r) => (
                  <div key={r.email} style={{ fontSize: 12, color: INK }}>
                    {r.name || r.email} <span style={{ color: MUTED }}>({r.email})</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
              <button type="button" onClick={onClose} style={{ padding: "8px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* WHO, before what. */}
            <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: 12, marginTop: 14 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: INK }}>
                <input type="checkbox" checked={includeWaitlist} disabled={sending}
                  onChange={(e) => setIncludeWaitlist(e.target.checked)} />
                Also include families on the waiting list
              </label>

              <div style={{ marginTop: 10, fontSize: 13, color: INK }}>
                {preview === null ? (
                  <span style={{ color: MUTED }}>Working out who would receive this…</span>
                ) : previewError ? (
                  <span style={{ color: RED }}>{previewError}</span>
                ) : (
                  <strong>{count} {count === 1 ? "family" : "families"} will receive this</strong>
                )}
              </div>

              {!!preview?.recipients?.length && (
                <div style={{ marginTop: 8, maxHeight: 160, overflowY: "auto", border: `1px solid ${RULE}`, borderRadius: 6 }}>
                  {preview.recipients.map((r) => (
                    <div key={r.email} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "5px 8px", fontSize: 12, borderBottom: `1px solid ${RULE}` }}>
                      <span style={{ color: INK, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.name || r.email}
                        <span style={{ color: MUTED }}> · {r.children}</span>
                      </span>
                      {/* THREE STATES, THREE SENTENCES. A family can be BOTH -
                          one child enrolled and another waiting - and the first
                          version of this badge said only "WAITING LIST" for
                          them, which reads as "this family has no place" when
                          one of their children does. Seen live on staging:
                          Jessica Vorster has Priya enrolled and J dog waiting. */}
                      {r.audiences?.includes("waitlist") && (
                        <span style={{ color: AMBER, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
                          {r.audiences?.includes("enrolled") ? "ENROLLED + WAITING" : "WAITING LIST"}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* The half a send would hide. Named, so the operator can chase the
                  school that runs its own registration for real addresses. */}
              {unreachable.length > 0 && (
                <div style={{ marginTop: 10, background: "#fdf6e3", border: "1px solid #ecdca6", borderRadius: 6, padding: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: AMBER }}>
                    {unreachable.length} {unreachable.length === 1 ? "family has" : "families have"} no email address on file and will not be included
                  </div>
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
                    {unreachable.map((r) => r.children).join(", ")}
                  </div>
                  <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
                    These usually come from a school that runs its own registration. Ask them for parent emails to reach these families.
                  </div>
                </div>
              )}
            </div>

            {/* WHAT. */}
            <label style={{ display: "block", marginTop: 14 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: INK }}>Subject</span>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={sending}
                placeholder="e.g. A change to next week's class"
                style={{ width: "100%", marginTop: 4, padding: "7px 10px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", color: INK, boxSizing: "border-box" }} />
            </label>

            <label style={{ display: "block", marginTop: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: INK }}>Message</span>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={sending} rows={7}
                placeholder={"e.g. Hi {parent_first_name}, next week {student_first_name}'s class will start at 3pm instead of 2:30."}
                style={{ width: "100%", marginTop: 4, padding: "7px 10px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", color: INK, boxSizing: "border-box", resize: "vertical" }} />
            </label>

            <details style={{ marginTop: 8 }}>
              <summary style={{ fontSize: 12, color: BRIGHT, cursor: "pointer" }}>Words you can drop in</summary>
              <div style={{ marginTop: 6 }}>
                {PLACEHOLDERS.map(([token, what]) => (
                  <div key={token} style={{ fontSize: 12, color: MUTED }}>
                    <code style={{ color: INK }}>{token}</code> — {what}
                  </div>
                ))}
              </div>
            </details>

            {/* One email per family, said out loud - it is the question an
                operator asks before sending to a class. */}
            <div style={{ fontSize: 11, color: MUTED, marginTop: 10 }}>
              Each family gets their own email. Nobody sees anyone else's address, and a family
              with two children in this class gets one email naming both.
            </div>

            {duplicate && (
              <div style={{ marginTop: 12, background: "#fdf6e3", border: "1px solid #ecdca6", borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: AMBER }}>This looks like a repeat</div>
                <div style={{ fontSize: 12, color: INK, marginTop: 4 }}>{duplicate.message}</div>
                <button type="button" onClick={() => send({ confirmDuplicate: true })}
                  style={{ marginTop: 8, padding: "6px 12px", background: AMBER, color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
                  Send it again anyway
                </button>
              </div>
            )}

            {error && (
              <div style={{ marginTop: 12, background: `${RED}1A`, color: RED, padding: 8, borderRadius: 6, fontSize: 12 }}>{error}</div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button type="button" onClick={onClose} disabled={sending}
                style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: sending ? "not-allowed" : "pointer" }}>
                Cancel
              </button>
              {/* Disabled WHILE SENDING as well as when there is nothing to send:
                  a send is one request per family, so it takes seconds with
                  nothing visibly happening, and a second click would email the
                  whole class twice. The edge function guards this too. */}
              <button type="button" onClick={() => send()} disabled={sending || count === 0 || preview === null}
                style={{ padding: "8px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: (sending || count === 0) ? "not-allowed" : "pointer", opacity: (sending || count === 0 || preview === null) ? 0.5 : 1 }}>
                {sending ? `Sending to ${count}…` : `Send to ${count} ${count === 1 ? "family" : "families"}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
