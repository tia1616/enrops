// /admin/email-sender — set how this org's outgoing email identifies itself.
//
// The provider sets a sender display name + reply-to email. The actual FROM
// address is derived server-side (a per-tenant address on the verified platform
// domain), so providers never touch DNS and a misconfig can't silently break
// sending. The `tenant-sender` edge fn is the single source of truth for the
// resolved sender, so the preview always matches real emails. Owner/admin only.

import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const GREEN_BG = "#f0fdf4";
const GREEN_INK = "#166534";

export default function EmailSenderSettings() {
  const { org, user } = useOutletContext();
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [mailingAddress, setMailingAddress] = useState("");
  // Snapshot of the last loaded/saved values so the Save button can grey out
  // when there's nothing to save, and light up when you change something.
  const [saved, setSaved] = useState({ fromName: "", replyTo: "", mailingAddress: "" });
  const [preview, setPreview] = useState(null); // { from, reply_to }
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  function flash(msg) { setToast(msg); setTimeout(() => setToast(""), 3000); }

  async function loadPreview() {
    const { data, error: e } = await supabase.functions.invoke("tenant-sender", {
      body: { organization_id: org.id, action: "preview" },
    });
    if (!e && data) setPreview(data);
  }

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from("org_branding")
        .select("email_from_name, email_reply_to")
        .eq("organization_id", org.id)
        .maybeSingle();
      // mailing_address lives on organizations (CAN-SPAM footer), not org_branding.
      const { data: orgRow } = await supabase
        .from("organizations")
        .select("mailing_address")
        .eq("id", org.id)
        .maybeSingle();
      if (!cancelled) {
        setFromName(data?.email_from_name ?? "");
        setReplyTo(data?.email_reply_to ?? "");
        setMailingAddress(orgRow?.mailing_address ?? "");
        setSaved({
          fromName: data?.email_from_name ?? "",
          replyTo: data?.email_reply_to ?? "",
          mailingAddress: orgRow?.mailing_address ?? "",
        });
        setTestTo(user?.email ?? "");
        await loadPreview();
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  async function save() {
    setSaving(true); setError("");
    try {
      const fields = {
        organization_id: org.id,
        email_from_name: fromName.trim() || null,
        email_reply_to: replyTo.trim() || null,
        updated_at: new Date().toISOString(),
      };
      // org_branding is keyed on organization_id (its PK) — upsert so it inserts
      // the row the first time and updates it thereafter.
      const { error: e } = await supabase
        .from("org_branding").upsert(fields, { onConflict: "organization_id" });
      if (e) throw e;
      // mailing_address lives on organizations (its own row already exists).
      const { error: addrErr } = await supabase
        .from("organizations")
        .update({ mailing_address: mailingAddress.trim() || null })
        .eq("id", org.id);
      if (addrErr) throw addrErr;
      flash("Sender saved.");
      setSaved({ fromName, replyTo, mailingAddress });
      await loadPreview();
    } catch (e) {
      setError(e.message ?? "Couldn't save your sender settings.");
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    if (!testTo.trim()) { setError("Enter an email to send the test to."); return; }
    setTesting(true); setError("");
    try {
      const { data, error: e } = await supabase.functions.invoke("tenant-sender", {
        body: { organization_id: org.id, action: "test", to: testTo.trim() },
      });
      if (e) throw e;
      if (data?.held_back) flash(`On staging, ${testTo.trim()} isn't on the test allow-list — nothing sent.`);
      else if (data?.sent) flash(`Test sent to ${data.to}. Check that inbox.`);
      else setError(data?.error ? `Couldn't send: ${data.error}` : "Couldn't send the test.");
    } catch (e) {
      setError(e.message ?? "Couldn't send the test email.");
    } finally {
      setTesting(false);
    }
  }

  const dirty =
    fromName !== saved.fromName || replyTo !== saved.replyTo || mailingAddress !== saved.mailingAddress;

  if (loading) {
    return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>;
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "8px 0 40px" }}>
      <Link to="/admin/settings" style={{ fontSize: 13, color: MUTED, textDecoration: "none" }}>← Settings</Link>
      <h1 style={{ margin: "8px 0 4px", color: PURPLE, fontSize: 24, fontWeight: 700 }}>Email sender</h1>
      <p style={{ color: MUTED, fontSize: 14, marginTop: 0, lineHeight: 1.5, maxWidth: 560 }}>
        How your emails — invites, waivers, reminders — show up in families' inboxes. We handle the sending
        domain for you, so there's nothing to set up with your web host.
      </p>

      {error && <div style={{ marginTop: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}
      {toast && <div style={{ marginTop: 16, padding: "10px 12px", background: GREEN_BG, border: "1px solid #bbf7d0", borderRadius: 8, color: GREEN_INK, fontSize: 13 }}>{toast}</div>}

      {/* Live preview of the resolved sender */}
      {preview && (
        <div style={{ marginTop: 20, background: "#faf9ff", border: `1px solid ${RULE}`, borderRadius: 10, padding: "14px 16px" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5 }}>Families will see</div>
          <div style={{ fontSize: 15, color: INK, marginTop: 6 }}><strong>From:</strong> {preview.from}</div>
          <div style={{ fontSize: 14, color: MUTED, marginTop: 2 }}><strong>Replies go to:</strong> {preview.reply_to}</div>
        </div>
      )}

      <div style={{ marginTop: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 20 }}>
        <label style={lbl}>Sender name</label>
        <input type="text" value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="e.g. Cascade Enrichment Co." style={input} />
        <div style={hint}>The name families see in their inbox. Defaults to your organization's name.</div>

        <label style={{ ...lbl, marginTop: 18 }}>Reply-to email</label>
        <input type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="e.g. hello@yourprogram.com" style={input} />
        <div style={hint}>Where replies land when a family hits "reply." Use an inbox you actually check.</div>

        <label style={{ ...lbl, marginTop: 18 }}>Mailing address</label>
        <textarea value={mailingAddress} onChange={(e) => setMailingAddress(e.target.value)} placeholder="e.g. 123 Main St, Portland, OR 97201" rows={2} style={{ ...input, resize: "vertical", lineHeight: 1.5 }} />
        <div style={hint}>Required on marketing emails by law (CAN-SPAM). Shown in the footer.</div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
          <button type="button" onClick={save} disabled={saving || !dirty} style={primaryBtn(saving || !dirty)}>{saving ? "Saving…" : dirty ? "Save" : "Saved ✓"}</button>
        </div>
      </div>

      <div style={{ marginTop: 16, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>Send a test email</div>
        <div style={hint}>Send yourself a sample so you can see exactly how it arrives.</div>
        <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
          <input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" style={{ ...input, flex: 1, minWidth: 220 }} />
          <button type="button" onClick={sendTest} disabled={testing} style={ghostBtn(testing)}>{testing ? "Sending…" : "Send test"}</button>
        </div>
      </div>
    </div>
  );
}

const lbl = { display: "block", fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 };
const hint = { fontSize: 12.5, color: MUTED, marginTop: 6, lineHeight: 1.5 };
const input = { width: "100%", padding: "10px 12px", border: `1.5px solid ${RULE}`, borderRadius: 8, fontSize: 14, color: INK, background: "#fff", fontFamily: "inherit", boxSizing: "border-box" };
function primaryBtn(disabled) { return { padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
function ghostBtn(disabled) { return { padding: "9px 14px", background: "#fff", color: BRIGHT, border: `1.5px solid ${BRIGHT}`, borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
