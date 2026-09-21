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
//
// ── 2026-09-21: formatting, a test, a copy, and a record ────────────────────
//
// Jeff: "Since there's no way to test or add a CC to Message families, I've just
// been hitting send and giving a slight prayer... all the copied bold text shows
// up regular with **before and after**."
//
// He was right three times over, and the numbers are from prod, not from the
// report: of his 33 sends in eight days, 17 carried `**bold**` and 15 carried
// `[words](url)`, so 230 of 405 emails went out with the markers visible - one
// of them giving 29 families the portal sign-in link as `[enrops.com/...](...)`.
//
// The cause was not that we failed to understand his notation. `bodyEditorUtils`
// has understood exactly `**bold**`, `_italic_` and `[words](url)` since June,
// and every other body editor in the product is built on it. THIS was the one
// send surface that never got wired to it - a raw textarea whose contents went
// straight into a plain-text email. So the fix is adoption, not invention:
// the shared RichBodyEditor, and an HTML half on the send.
//
// The other two are the same complaint in different clothes - he could not see
// what he was about to send, and could not see what he had sent. Hence "Send a
// test to", "email me a copy", and the Sent tab, which reads the audit rows this
// panel has been writing since day one and that nothing on this screen showed.
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../../../lib/supabase.js";
import RichBodyEditor from "../../../components/RichBodyEditor.jsx";
import { stripHtml } from "../marketing-v2/bodyEditorUtils.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const RED = "#b53737";
const AMBER = "#a16207";
const OK_GREEN = "#3a7c3a";

// Every placeholder the edge function fills, said in plain words and grouped the
// way an operator thinks about them. Not a jargon list: the palette shows
// "The parent's first name", never "{parent_first_name} interpolation".
//
// The keys are inserted as {{double braces}}, which is the spelling every other
// editor in the product uses. The edge function still honours the single-brace
// form this panel used to teach, so the 64 sends already written that way, and
// anyone who learned it here, keep working.
const FIELDS = [
  {
    group: "The family",
    tokens: [
      { key: "parent_first_name", label: "Parent's first name", tip: "The parent's first name" },
      { key: "student_first_name", label: "Their child", tip: "Their child - or all their children in this class" },
    ],
  },
  {
    group: "The class",
    tokens: [
      { key: "program_name", label: "Class name", tip: "The name of this class" },
      { key: "program_day", label: "Day it runs", tip: "The weekday this class meets" },
      { key: "program_location", label: "School or site", tip: "Where this class meets" },
    ],
  },
  {
    group: "You",
    tokens: [
      { key: "org_name", label: "Your business name", tip: "Your organisation's name" },
    ],
  },
];

function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export default function MessageFamiliesModal({ program, orgId, onClose }) {
  const [tab, setTab] = useState("write");          // write | sent
  const [subject, setSubject] = useState("");
  // HTML is the canonical form, the same as every other body editor. The
  // operator never sees it; RichBodyEditor shows them words and a toolbar.
  const [bodyHtml, setBodyHtml] = useState("");
  const [includeWaitlist, setIncludeWaitlist] = useState(false);
  // THE THIRD GROUP, and it exists because of a dead end Jessica spotted: a
  // refund sets the registration to cancelled, which takes the family off the
  // roster - so after refunding, there was no way left to email them at all. One
  // cancelled class on prod has 2 refunded families and returned ZERO reachable
  // people. Sawyer solves it the same way, with a separate "canceled" tab you
  // can still message from.
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [preview, setPreview] = useState(null);       // null = loading
  const [previewError, setPreviewError] = useState("");
  const [phase, setPhase] = useState("compose");       // compose | sending | done
  const [error, setError] = useState("");
  const [duplicate, setDuplicate] = useState(null);    // the 409 payload
  const [result, setResult] = useState(null);

  // ONE ADDRESS, TWO USES - the test goes to it, and the copy goes to it. Two
  // separate address fields in one panel is two chances to typo the same fact.
  const [myEmail, setMyEmail] = useState("");
  const [copyToMe, setCopyToMe] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);  // { ok, message }

  // The body as words, used ONLY to decide whether anything has been written.
  // An "empty" RichBodyEditor still holds markup, so a trim() on the HTML would
  // call an empty message written and let a blank email go to a class.
  const bodyIsEmpty = useMemo(() => !stripHtml(bodyHtml || "").trim(), [bodyHtml]);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (alive) setMyEmail(data?.session?.user?.email ?? "");
    });
    return () => { alive = false; };
  }, []);

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
          include_cancelled: includeCancelled,
          ...payload,
        }),
      },
    );
    return { status: resp.status, json: await resp.json().catch(() => ({})) };
    // includeCancelled is a dependency for the same reason includeWaitlist is:
    // `call` is what the preview effect watches, so leaving it out would show a
    // count that no longer matches the boxes as they sit.
  }, [program?.id, orgId, includeWaitlist, includeCancelled]);

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

  // A TEST IS NOT A SEND, and the difference is enforced on the server: it
  // writes no audit row, does not arm the duplicate guard, and goes to exactly
  // one address that must already belong to this org.
  async function sendTest() {
    if (testing) return;
    setTestResult(null);
    if (!subject.trim() || bodyIsEmpty) {
      setTestResult({ ok: false, message: "Write a subject and a message first." });
      return;
    }
    if (!myEmail.trim()) {
      setTestResult({ ok: false, message: "Add an address to send the test to." });
      return;
    }
    setTesting(true);
    try {
      const { status, json } = await call({
        mode: "test",
        subject: subject.trim(),
        body_html: bodyHtml,
        test_email: myEmail.trim(),
      });
      if (status !== 200 || json?.status !== "sent") {
        setTestResult({
          ok: false,
          message: json?.message || json?.failure_reason || "The test didn't go. Nothing was sent to families.",
        });
      } else {
        setTestResult({ ok: true, message: `Test sent to ${json.to}. Check how it looks before sending to families.` });
      }
    } catch (e) {
      setTestResult({ ok: false, message: e.message ?? "The test didn't go." });
    } finally {
      setTesting(false);
    }
  }

  async function send({ confirmDuplicate = false } = {}) {
    if (phase === "sending") return;
    setError("");
    setDuplicate(null);
    if (!subject.trim() || bodyIsEmpty) {
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
        body_html: bodyHtml,
        copy_to: copyToMe && myEmail.trim() ? myEmail.trim() : undefined,
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

        {/* ONE PANEL, TWO QUESTIONS: what am I about to send, and what have I
            already sent. Kept in this modal rather than on a screen of its own
            so there is ONE place a class's messages live, reachable identically
            from Rosters and from the calendar. */}
        {phase !== "done" && (
          <div style={{ display: "flex", gap: 4, marginTop: 12, borderBottom: `1px solid ${RULE}` }}>
            {[["write", "Write a message"], ["sent", "Sent"]].map(([key, label]) => (
              <button key={key} type="button" onClick={() => setTab(key)} disabled={sending}
                style={{
                  background: "transparent", border: "none", borderBottom: `2px solid ${tab === key ? BRIGHT : "transparent"}`,
                  color: tab === key ? PURPLE : MUTED, fontWeight: tab === key ? 700 : 500,
                  fontSize: 13, fontFamily: "inherit", padding: "6px 10px", marginBottom: -1,
                  cursor: sending ? "not-allowed" : "pointer",
                }}>
                {label}
              </button>
            ))}
          </div>
        )}

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
              {/* The copy is reported separately and never as a failed send: the
                  families already have their email either way. */}
              {result?.copy && (
                <div style={{ fontSize: 12, color: result.copy.status === "sent" ? MUTED : AMBER, marginTop: 6 }}>
                  {result.copy.status === "sent"
                    ? `A copy was sent to you at ${result.copy.to}.`
                    : `The families were emailed, but your copy to ${result.copy.to} did not go.`}
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
        ) : tab === "sent" ? (
          <SentMessages programId={program?.id} orgId={orgId} />
        ) : (
          <>
            {/* WHO, before what. */}
            <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: 12, marginTop: 14 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: INK }}>
                <input type="checkbox" checked={includeWaitlist} disabled={sending}
                  onChange={(e) => setIncludeWaitlist(e.target.checked)} />
                Also include families on the waiting list
              </label>
              {/* Worded as "left or been refunded" rather than "cancelled",
                  because the operator is thinking about the family, not the
                  registration's status value. Off by default: most messages are
                  for the people currently in the class. */}
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: INK, marginTop: 6 }}>
                <input type="checkbox" checked={includeCancelled} disabled={sending}
                  onChange={(e) => setIncludeCancelled(e.target.checked)} />
                Also include families who have left or been refunded
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
                      {/* FOUR STATES, FOUR LABELS. A family can be in more than
                          one group at once - one child enrolled, another waiting
                          or refunded - and a single-word badge for that reads as
                          the wrong fact about them. Seen live: Jessica Vorster
                          has Priya enrolled and J dog waiting on the same class. */}
                      {(r.audiences?.includes("waitlist") || r.audiences?.includes("cancelled")) && (
                        <span style={{ color: AMBER, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
                          {r.audiences?.includes("enrolled")
                            ? "ENROLLED + OTHER"
                            : r.audiences?.includes("waitlist") && r.audiences?.includes("cancelled")
                              ? "WAITING + LEFT"
                              : r.audiences?.includes("waitlist") ? "WAITING LIST" : "LEFT / REFUNDED"}
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

            <div style={{ marginTop: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: INK, display: "block", marginBottom: 4 }}>Message</span>
              {/* THE FIX. Select your words and press B, or press Link and fill
                  in a box - the same control Mailchimp, HubSpot and every other
                  comms tool gives you, and the same one the rest of Enrops
                  already uses. Nothing here shows an operator a markup marker. */}
              <RichBodyEditor
                value={bodyHtml}
                onChange={setBodyHtml}
                rows={7}
                fields={FIELDS}
                showPreview={false}
                placeholder={"e.g. Hi {{parent_first_name}}, next week {{student_first_name}}'s class will start at 3pm instead of 2:30."}
              />
            </div>

            {/* SEE IT BEFORE THEY DO. Jeff's words: "I've just been hitting send
                and giving a slight prayer." */}
            <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: 12, marginTop: 12, background: "#fcfbf7" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: INK }}>Check it first</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 6 }}>
                <label style={{ flex: "1 1 220px", fontSize: 11, color: MUTED }}>
                  Send a test to
                  <input value={myEmail} onChange={(e) => setMyEmail(e.target.value)} disabled={sending || testing}
                    placeholder="you@yourbusiness.com"
                    style={{ width: "100%", marginTop: 3, padding: "7px 10px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", color: INK, boxSizing: "border-box" }} />
                </label>
                <button type="button" onClick={sendTest} disabled={sending || testing}
                  style={{ padding: "8px 14px", background: "#fff", color: PURPLE, border: `1px solid ${BRIGHT}`, borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: (sending || testing) ? "not-allowed" : "pointer" }}>
                  {testing ? "Sending test…" : "Send test"}
                </button>
              </div>
              <div style={{ fontSize: 11, color: MUTED, marginTop: 5 }}>
                A test goes to one person on your team and reaches no families. It is not recorded as a send.
              </div>
              {testResult && (
                <div style={{ fontSize: 12, marginTop: 7, color: testResult.ok ? OK_GREEN : RED }}>
                  {testResult.message}
                </div>
              )}
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: INK, marginTop: 9 }}>
                <input type="checkbox" checked={copyToMe} disabled={sending}
                  onChange={(e) => setCopyToMe(e.target.checked)} />
                Email me a copy when this goes
              </label>
            </div>

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

// What this class has already been sent, read from the rows this panel has been
// writing since it was built - and which, until today, only appeared on ONE
// contact's timeline over in Comms. An operator who sent from here had no way to
// see it from here.
//
// Every row states its own outcome, including the families that were never
// attempted, because "sent to 29" with no failures listed is the number that
// makes an operator stop looking.
function SentMessages({ programId, orgId }) {
  const [rows, setRows] = useState(null);   // null = loading
  const [loadError, setLoadError] = useState("");
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase
        .from("program_family_messages")
        .select("id, sent_at, subject, body_text, body_html, status, recipient_count, sent_count, failed_count, include_waitlist, include_cancelled, recipients")
        .eq("program_id", programId)
        .eq("organization_id", orgId)
        .order("sent_at", { ascending: false })
        .limit(25);
      if (!alive) return;
      if (error) {
        setLoadError("Couldn't load what has been sent to this class.");
        setRows([]);
        return;
      }
      setRows(data ?? []);
    })();
    return () => { alive = false; };
  }, [programId, orgId]);

  if (rows === null) {
    return <div style={{ fontSize: 13, color: MUTED, padding: "20px 2px" }}>Loading…</div>;
  }
  if (loadError) {
    return <div style={{ fontSize: 13, color: RED, padding: "20px 2px" }}>{loadError}</div>;
  }
  if (!rows.length) {
    return (
      <div style={{ fontSize: 13, color: MUTED, padding: "24px 2px" }}>
        Nothing has been sent to this class's families yet. Anything you send from here will be listed, with who received it.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      {rows.map((m) => {
        const open = openId === m.id;
        const failed = (m.recipients ?? []).filter((r) => r.status === "failed");
        const notAttempted = (m.recipients ?? []).filter((r) => r.status === "not_attempted");
        return (
          <div key={m.id} style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: 10, marginBottom: 8 }}>
            <button type="button" onClick={() => setOpenId(open ? null : m.id)}
              style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>{m.subject}</div>
              <div style={{ fontSize: 11.5, color: MUTED, marginTop: 3 }}>
                {fmtWhen(m.sent_at)}
                {" · "}
                {m.status === "no_recipients"
                  ? "nobody could be reached"
                  : `${m.sent_count} of ${m.recipient_count} ${m.recipient_count === 1 ? "family" : "families"}`}
                {m.failed_count ? ` · ${m.failed_count} failed` : ""}
                {m.include_waitlist ? " · incl. waiting list" : ""}
                {m.include_cancelled ? " · incl. left/refunded" : ""}
              </div>
            </button>

            {open && (
              <div style={{ marginTop: 10, borderTop: `1px solid ${RULE}`, paddingTop: 10 }}>
                {/* The message as it was written. `body_html` is only ever
                    produced by our own editor, which sanitises link targets;
                    older rows have none and fall back to the plain half. */}
                {m.body_html
                  ? <div style={{ fontSize: 12.5, color: INK, lineHeight: 1.5 }} dangerouslySetInnerHTML={{ __html: m.body_html }} />
                  : <div style={{ fontSize: 12.5, color: INK, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{m.body_text}</div>}

                {failed.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: RED }}>Did not arrive:</div>
                    {failed.map((r) => (
                      <div key={r.email} style={{ fontSize: 11.5, color: INK }}>
                        {r.name || r.email} <span style={{ color: MUTED }}>({r.email})</span>
                      </div>
                    ))}
                  </div>
                )}
                {notAttempted.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: AMBER }}>Not included - no email address on file:</div>
                    {notAttempted.map((r) => (
                      <div key={r.email || r.name} style={{ fontSize: 11.5, color: MUTED }}>{r.name || r.email}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
