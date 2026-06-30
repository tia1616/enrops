// FeedbackWidget — a persistent "Feedback" button (fixed, bottom-right) that
// opens a free-text modal. On submit it calls the submit-feedback edge fn,
// which saves the row (RLS-scoped) and emails the platform inbox.
//
// Always available (never dismissed) so the feedback path never disappears —
// distinct from the one-time AnnouncementBanner. Page/user/org context is
// attached automatically; the user only types a message.
//
// Enrops admin chrome only — mounted in AdminLayout. Tokens match the shell.

import { useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const LAVENDER = "#F2F0FF";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

export default function FeedbackWidget({ org }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | done | error
  const [errorMsg, setErrorMsg] = useState("");
  const textareaRef = useRef(null);
  const timersRef = useRef([]);

  // Don't render until we know which org the feedback belongs to.
  const orgId = org?.id ?? null;

  // Tracked setTimeout so we can clear pending close/reset timers if the
  // component unmounts (e.g. user navigates away within ~2s of submitting).
  function later(fn, ms) {
    const id = setTimeout(fn, ms);
    timersRef.current.push(id);
    return id;
  }

  useEffect(() => () => { timersRef.current.forEach(clearTimeout); }, []);

  useEffect(() => {
    if (open && textareaRef.current) textareaRef.current.focus();
  }, [open]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape" && open && status !== "sending") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, status]);

  function close() {
    setOpen(false);
    // reset after the modal is gone so the user doesn't see it flicker
    later(() => {
      setMessage("");
      setStatus("idle");
      setErrorMsg("");
    }, 200);
  }

  async function submit() {
    const text = message.trim();
    if (!text || status === "sending") return;
    setStatus("sending");
    setErrorMsg("");
    try {
      // Explicitly attach the user's access token — functions.invoke otherwise
      // sends the anon key, and the edge fn would see no signed-in user.
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — please refresh and sign in again.");
      const { data, error } = await supabase.functions.invoke("submit-feedback", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: {
          organization_id: orgId,
          message: text,
          page_url: window.location.href,
          page_path: window.location.pathname,
          user_agent: navigator.userAgent,
        },
      });
      if (error || !data?.ok) {
        // Try to surface the server's friendly message if present.
        let detail = "";
        try { detail = (await error?.context?.json?.())?.error || ""; } catch (_e) { /* noop */ }
        throw new Error(detail || "Something went wrong. Please try again.");
      }
      setStatus("done");
      later(close, 1800);
    } catch (e) {
      setStatus("error");
      setErrorMsg(e?.message || "Something went wrong. Please try again.");
    }
  }

  if (!orgId) return null;

  return (
    <>
      {/* Floating button — always visible, fixed bottom-right */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Send feedback"
        style={{
          position: "fixed",
          right: 20,
          bottom: 20,
          zIndex: 1000,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "11px 16px",
          background: BRIGHT,
          color: "#fff",
          border: "none",
          borderRadius: 999,
          fontSize: 14,
          fontWeight: 600,
          fontFamily: "'Poppins', system-ui, sans-serif",
          cursor: "pointer",
          boxShadow: "0 4px 14px rgba(28, 0, 79, 0.22)",
        }}
      >
        <span aria-hidden="true" style={{ fontSize: 15, lineHeight: 1 }}>💬</span>
        Feedback
      </button>

      {open && (
        <div
          onMouseDown={(e) => { if (e.target === e.currentTarget && status !== "sending") close(); }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1001,
            background: "rgba(28, 0, 79, 0.32)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            fontFamily: "'Poppins', system-ui, sans-serif",
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Share your feedback"
            style={{
              width: "100%",
              maxWidth: 460,
              background: "#fff",
              borderRadius: 16,
              border: `1px solid ${RULE}`,
              boxShadow: "0 20px 50px rgba(28, 0, 79, 0.25)",
              padding: 24,
            }}
          >
            {status === "done" ? (
              <div style={{ textAlign: "center", padding: "16px 8px" }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 999, margin: "0 auto 14px",
                  background: "#2e9e4f", color: "#fff", display: "flex",
                  alignItems: "center", justifyContent: "center", fontSize: 22, fontWeight: 700,
                }}>✓</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: PURPLE }}>Thank you!</div>
                <p style={{ color: MUTED, fontSize: 14, marginTop: 6, marginBottom: 0 }}>
                  We got your feedback — it comes straight to our team.
                </p>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 18, fontWeight: 700, color: PURPLE }}>
                  Share your feedback
                </div>
                <p style={{ color: MUTED, fontSize: 13.5, lineHeight: 1.5, marginTop: 6, marginBottom: 14 }}>
                  You're one of our first partners — tell us what's working, what's broken,
                  or what you wish existed. It comes straight to our team.
                </p>

                <textarea
                  ref={textareaRef}
                  value={message}
                  onChange={(e) => setMessage(e.target.value.slice(0, 5000))}
                  placeholder="Type your feedback…"
                  rows={5}
                  disabled={status === "sending"}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    resize: "vertical",
                    border: `1px solid ${RULE}`,
                    borderRadius: 10,
                    padding: "10px 12px",
                    fontSize: 14,
                    fontFamily: "inherit",
                    color: INK,
                    background: status === "sending" ? "#faf9f5" : "#fff",
                    outline: "none",
                  }}
                />

                {status === "error" && (
                  <div style={{ color: "#b3261e", fontSize: 13, marginTop: 8 }}>
                    {errorMsg}
                  </div>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
                  <button
                    type="button"
                    onClick={close}
                    disabled={status === "sending"}
                    style={{
                      padding: "9px 16px",
                      background: "transparent",
                      color: BRIGHT,
                      border: `1px solid ${BRIGHT}`,
                      borderRadius: 8,
                      fontSize: 14,
                      fontWeight: 600,
                      fontFamily: "inherit",
                      cursor: status === "sending" ? "default" : "pointer",
                      opacity: status === "sending" ? 0.5 : 1,
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={submit}
                    disabled={!message.trim() || status === "sending"}
                    style={{
                      padding: "9px 18px",
                      background: BRIGHT,
                      color: "#fff",
                      border: "none",
                      borderRadius: 8,
                      fontSize: 14,
                      fontWeight: 600,
                      fontFamily: "inherit",
                      cursor: (!message.trim() || status === "sending") ? "default" : "pointer",
                      opacity: (!message.trim() || status === "sending") ? 0.55 : 1,
                    }}
                  >
                    {status === "sending" ? "Sending…" : "Send feedback"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
