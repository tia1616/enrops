// InviteFamiliesModal — preview-then-send for parent-portal invites.
//
// Opens against one program. First loads a PREVIEW from invite-parents
// (preview:true) — the exact recipient list + the real rendered email, with
// nothing created or sent — so the operator sees who and what before committing.
// "Send" calls invite-parents for real. Shared by the Rosters list + the
// per-program roster page.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../lib/supabase";

const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const GREEN = "#166534";
const RED = "#b53737";

export default function InviteFamiliesModal({ orgId, orgSlug, programId, onClose, onSent }) {
  const [phase, setPhase] = useState("loading"); // loading | review | sending | sent | error
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke("invite-parents", {
          body: { organization_id: orgId, program_id: programId, preview: true, login_url: `${window.location.origin}/${orgSlug}/login` },
        });
        if (!alive) return;
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        setPreview(data);
        setPhase("review");
      } catch (e) {
        if (!alive) return;
        setErr(e.message ?? "Couldn't load the preview.");
        setPhase("error");
      }
    })();
    return () => { alive = false; };
  }, [orgId, programId]);

  async function send() {
    setPhase("sending");
    setErr("");
    try {
      const origin = window.location.origin;
      const { data, error } = await supabase.functions.invoke("invite-parents", {
        body: { organization_id: orgId, program_id: programId, redirect_to: `${origin}/${orgSlug}/dashboard`, login_url: `${origin}/${orgSlug}/login` },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setResult(data);
      setPhase("sent");
      if (onSent) onSent(data);
    } catch (e) {
      setErr(e.message ?? "Couldn't send invites.");
      setPhase("error");
    }
  }

  const recipients = preview?.recipients ?? [];
  const count = recipients.length;
  const busy = phase === "sending";

  return (
    <div
      onClick={busy ? undefined : onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(28,0,79,0.32)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px", zIndex: 200, fontFamily: "inherit" }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, maxWidth: 620, width: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 10px 40px rgba(0,0,0,0.25)" }}>
        <div style={{ padding: "18px 24px", borderBottom: `1px solid ${RULE}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: INK }}>Invite families to the portal</h2>
          <button onClick={onClose} disabled={busy} aria-label="Close" style={{ background: "none", border: "none", fontSize: 20, color: MUTED, cursor: busy ? "default" : "pointer", lineHeight: 1 }}>✕</button>
        </div>

        <div style={{ padding: 24 }}>
          {phase === "loading" && <div style={{ color: MUTED, fontSize: 14 }}>Checking who hasn't been invited yet…</div>}

          {phase === "error" && <div style={{ color: RED, fontSize: 14 }}>{err}</div>}

          {phase === "sent" && (
            <div>
              <div style={{ fontSize: 16, fontWeight: 600, color: (result?.invited ?? 0) > 0 ? GREEN : INK, marginBottom: 8 }}>
                {(result?.invited ?? 0) > 0 ? `Sent ${result.invited} invite${result.invited === 1 ? "" : "s"}.` : "No invites sent."}
              </div>
              <div style={{ fontSize: 14, color: INK, lineHeight: 1.6 }}>
                {result?.skipped_active ? `${result.skipped_active} already active (signed in before). ` : ""}
                {result?.skipped_no_email ? `${result.skipped_no_email} had no email on file. ` : ""}
                {result?.held_back ? `${result.held_back} held back (staging test guard). ` : ""}
                {result?.failed ? `${result.failed} couldn't be sent.` : ""}
                {(result?.invited ?? 0) === 0 && !result?.skipped_active && !result?.skipped_no_email && !result?.failed ? "Nothing to send." : ""}
              </div>
              {result?.failed_reasons?.length ? (
                <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
                  {result.failed_reasons.map((f, i) => (
                    <li key={f.email + i}><span style={{ color: INK }}>{f.email}</span> — {f.reason}</li>
                  ))}
                </ul>
              ) : null}
              <div style={{ marginTop: 18, textAlign: "right" }}>
                <button onClick={onClose} style={primaryBtn(false)}>Done</button>
              </div>
            </div>
          )}

          {(phase === "review" || phase === "sending") && (
            <div>
              {count === 0 ? (
                <div style={{ color: MUTED, fontSize: 14, lineHeight: 1.6 }}>
                  {preview?.held_back
                    ? `${preview.held_back} would-be recipient${preview.held_back === 1 ? " is" : "s are"} held back by the staging test guard — only your allowlisted inboxes receive on staging.`
                    : (preview?.message || "Everyone on this roster already has portal access or has no email on file — nothing to send.")}
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 14, color: INK, marginBottom: 4, lineHeight: 1.6 }}>
                    This will email <strong>{count} famil{count === 1 ? "y" : "ies"}</strong> who don't have portal access yet
                    {preview?.skipped_no_email ? <span style={{ color: MUTED }}> ({preview.skipped_no_email} skipped — no email on file)</span> : null}.
                  </div>
                  {preview?.held_back ? (
                    <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 8 }}>
                      {preview.held_back} more held back by the staging test guard — only your allowlisted inboxes receive on staging.
                    </div>
                  ) : null}
                  <div style={{ fontSize: 12, color: MUTED, marginBottom: 12 }}>From: {preview?.from} · Subject: {preview?.subject}</div>
                  <div style={{ fontSize: 12, color: MUTED, marginBottom: 12, lineHeight: 1.5 }}>
                    In the portal, families sign your required waivers before they see program details.{" "}
                    <Link to="/admin/waivers" style={{ color: BRIGHT, textDecoration: "none" }}>Manage waivers →</Link>
                  </div>

                  <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, maxHeight: 140, overflowY: "auto", marginBottom: 16 }}>
                    {recipients.map((r, i) => (
                      <div key={r.email + i} style={{ padding: "8px 12px", borderBottom: i < recipients.length - 1 ? `1px solid ${RULE}` : "none", fontSize: 13, color: INK, display: "flex", justifyContent: "space-between", gap: 12 }}>
                        <span>{r.name}</span>
                        <span style={{ color: MUTED }}>{r.email}</span>
                      </div>
                    ))}
                  </div>

                  <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Email preview</div>
                  <iframe title="Invite email preview" srcDoc={preview?.preview_html} style={{ width: "100%", height: 380, border: `1px solid ${RULE}`, borderRadius: 8, background: "#fff" }} />
                </>
              )}

              <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button onClick={onClose} disabled={busy} style={ghostBtn(busy)}>Cancel</button>
                {count > 0 && (
                  <button onClick={send} disabled={busy} style={primaryBtn(busy)}>
                    {busy ? "Sending…" : `Send ${count} invite${count === 1 ? "" : "s"}`}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function primaryBtn(busy) {
  return { padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, fontFamily: "inherit", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1 };
}
function ghostBtn(busy) {
  return { padding: "9px 16px", background: "#fff", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 8, fontSize: 14, fontWeight: 600, fontFamily: "inherit", cursor: busy ? "default" : "pointer" };
}
