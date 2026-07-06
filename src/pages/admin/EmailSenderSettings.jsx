// /admin/email-sender — set how this org's outgoing email identifies itself.
//
// The provider sets a sender display name + reply-to email. The actual FROM
// address is derived server-side (a per-tenant address on the verified platform
// domain), so providers never touch DNS and a misconfig can't silently break
// sending. The `tenant-sender` edge fn is the single source of truth for the
// resolved sender, so the preview always matches real emails. Owner/admin only.

import { useEffect, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";
import { htmlToEditable, editableToHtml } from "./marketing-v2/bodyEditorUtils.js";

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
  // Signature: friendly editable text (light markdown) + an optional image URL.
  // Stored as HTML in org_branding.email_signature; edited here as plain text.
  const [sigText, setSigText] = useState("");
  const [sigImageUrl, setSigImageUrl] = useState("");
  const [uploadingSig, setUploadingSig] = useState(false);
  const sigFileRef = useRef(null);
  const sigTextRef = useRef(null);
  // Inline "add link" mini-form state (so operators never type link syntax).
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const linkSel = useRef({ start: 0, end: 0 });
  // Snapshot of the last loaded/saved values so the Save button can grey out
  // when there's nothing to save, and light up when you change something.
  const [saved, setSaved] = useState({ fromName: "", replyTo: "", mailingAddress: "", sigText: "", sigImageUrl: "" });
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
        .select("email_from_name, email_reply_to, email_signature, email_signature_image_url")
        .eq("organization_id", org.id)
        .maybeSingle();
      // mailing_address lives on organizations (CAN-SPAM footer), not org_branding.
      const { data: orgRow } = await supabase
        .from("organizations")
        .select("mailing_address")
        .eq("id", org.id)
        .maybeSingle();
      if (!cancelled) {
        const sig = htmlToEditable(data?.email_signature ?? "");
        const sigImg = data?.email_signature_image_url ?? "";
        setFromName(data?.email_from_name ?? "");
        setReplyTo(data?.email_reply_to ?? "");
        setMailingAddress(orgRow?.mailing_address ?? "");
        setSigText(sig);
        setSigImageUrl(sigImg);
        setSaved({
          fromName: data?.email_from_name ?? "",
          replyTo: data?.email_reply_to ?? "",
          mailingAddress: orgRow?.mailing_address ?? "",
          sigText: sig,
          sigImageUrl: sigImg,
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
      const sigHtml = editableToHtml(sigText.trim());
      const fields = {
        organization_id: org.id,
        email_from_name: fromName.trim() || null,
        email_reply_to: replyTo.trim() || null,
        email_signature: sigHtml || null,
        email_signature_image_url: sigImageUrl.trim() || null,
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
      setSaved({ fromName, replyTo, mailingAddress, sigText, sigImageUrl });
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

  async function handleSigImage(e) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    setError("");
    // Raster formats only. SVG is an image type but can carry scripts, so it's
    // excluded — a signature never needs it, and it keeps the uploaded file from
    // being a script vector.
    const OK_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    if (!OK_IMAGE_TYPES.includes(file.type)) {
      setError("Please choose a PNG, JPG, GIF, or WebP image.");
      return;
    }
    // Signature images ride along in every email — keep them small so inboxes
    // load them fast and don't clip. 1 MB is generous for a logo/headshot.
    if (file.size > 1_000_000) {
      setError("That image is over 1 MB. Please use a smaller logo or headshot.");
      return;
    }
    setUploadingSig(true);
    try {
      const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
      // Path starts with the org id so the org-assets bucket RLS allows the write.
      const path = `${org.id}/signatures/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("org-assets")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from("org-assets").getPublicUrl(path);
      if (!pub?.publicUrl) throw new Error("Couldn't get the image URL.");
      setSigImageUrl(pub.publicUrl);
    } catch (err) {
      setError(err.message ?? "Couldn't upload that image.");
    } finally {
      setUploadingSig(false);
    }
  }

  function removeSigImage() {
    // Clears the reference; the file stays in storage (harmless, org-scoped).
    // Save to persist the removal.
    setSigImageUrl("");
  }

  // Formatting buttons wrap the highlighted text with the underlying markers so
  // the operator never types or sees syntax — they highlight and click, and the
  // preview shows the real result. Bold/italic wrap in place.
  function wrapSelection(marker) {
    const ta = sigTextRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? sigText.length;
    const end = ta.selectionEnd ?? sigText.length;
    const sel = sigText.slice(start, end) || "text";
    const next = sigText.slice(0, start) + marker + sel + marker + sigText.slice(end);
    setSigText(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + marker.length;
      ta.setSelectionRange(pos, pos + sel.length);
    });
  }

  // Link: capture the selection first (opening the mini-form drops focus), then
  // insert on confirm. The operator sees a "Text" + "Web address" form, never
  // the [text](url) markup.
  function openLink() {
    const ta = sigTextRef.current;
    linkSel.current = { start: ta?.selectionStart ?? sigText.length, end: ta?.selectionEnd ?? sigText.length };
    setLinkUrl("");
    setLinkOpen(true);
  }
  function addLink() {
    let url = linkUrl.trim();
    if (!url) { setLinkOpen(false); return; }
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    const { start, end } = linkSel.current;
    const label = sigText.slice(start, end) || url.replace(/^https?:\/\//i, "");
    const next = sigText.slice(0, start) + `[${label}](${url})` + sigText.slice(end);
    setSigText(next);
    setLinkOpen(false);
    setLinkUrl("");
  }

  // Live HTML of the signature exactly as the email will render it.
  const sigPreviewHtml = editableToHtml(sigText.trim());
  const hasSignature = !!(sigPreviewHtml || sigImageUrl);

  const dirty =
    fromName !== saved.fromName || replyTo !== saved.replyTo || mailingAddress !== saved.mailingAddress ||
    sigText !== saved.sigText || sigImageUrl !== saved.sigImageUrl;

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

        <div style={{ borderTop: `1px solid ${RULE}`, margin: "22px 0 0", paddingTop: 20 }}>
          <label style={lbl}>Email signature</label>
          <div style={hint}>
            Added to the bottom of every email you send — reminders, welcomes, and campaigns. Add an
            image (logo or headshot) and a few lines about you.
          </div>

          {/* Image */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
            {sigImageUrl ? (
              <img src={sigImageUrl} alt="Signature" style={{ maxHeight: 56, maxWidth: 180, height: "auto", borderRadius: 6, border: `1px solid ${RULE}` }} />
            ) : (
              <div style={{ width: 56, height: 56, borderRadius: 6, border: `1px dashed ${RULE}`, display: "flex", alignItems: "center", justifyContent: "center", color: MUTED, fontSize: 11 }}>No image</div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input ref={sigFileRef} type="file" accept="image/*" onChange={handleSigImage} style={{ display: "none" }} />
              <button type="button" onClick={() => sigFileRef.current?.click()} disabled={uploadingSig} style={ghostBtn(uploadingSig)}>
                {uploadingSig ? "Uploading…" : sigImageUrl ? "Replace image" : "Add image"}
              </button>
              {sigImageUrl && !uploadingSig && (
                <button type="button" onClick={removeSigImage} style={{ ...ghostBtn(false), color: MUTED, borderColor: RULE }}>Remove</button>
              )}
            </div>
          </div>
          <div style={hint}>PNG, JPG, or GIF, under 1 MB. A logo or headshot works best.</div>

          {/* Text with a simple formatting toolbar — highlight, then click. */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12, marginBottom: 6 }}>
            <button type="button" onClick={() => wrapSelection("**")} title="Bold" style={{ ...fmtBtn, fontWeight: 800 }}>B</button>
            <button type="button" onClick={() => wrapSelection("_")} title="Italic" style={{ ...fmtBtn, fontStyle: "italic" }}>i</button>
            <button type="button" onClick={openLink} title="Add a link" style={fmtBtn}>🔗 Link</button>
            <span style={{ fontSize: 12.5, color: MUTED, marginLeft: 4 }}>Highlight text, then click to format.</span>
          </div>
          {linkOpen && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 8px", padding: 10, background: "#faf9ff", border: `1px solid ${RULE}`, borderRadius: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, color: INK, fontWeight: 600 }}>Web address:</span>
              <input
                type="text"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }}
                placeholder="yourwebsite.com"
                autoFocus
                style={{ ...input, flex: 1, minWidth: 180, padding: "7px 10px" }}
              />
              <button type="button" onClick={addLink} style={{ ...ghostBtn(false), padding: "7px 12px" }}>Add link</button>
              <button type="button" onClick={() => setLinkOpen(false)} style={{ ...ghostBtn(false), padding: "7px 12px", color: MUTED, borderColor: RULE }}>Cancel</button>
            </div>
          )}
          <textarea
            ref={sigTextRef}
            value={sigText}
            onChange={(e) => setSigText(e.target.value)}
            placeholder={"Warm regards,\nJordan Rivera\nDirector, Bright Minds Academy\n(555) 123-4567"}
            rows={4}
            style={{ ...input, resize: "vertical", lineHeight: 1.5 }}
          />
          <div style={hint}>Type your sign-off. What you see in the preview below is exactly what families and staff will get.</div>

          {/* Live preview */}
          {hasSignature && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Preview</div>
              <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: 16 }}>
                <div style={{ marginTop: 4, paddingTop: 16, borderTop: "1px solid #eee", color: "#555", fontSize: 14, lineHeight: 1.5 }}>
                  {sigImageUrl && <img src={sigImageUrl} alt="Signature" style={{ maxHeight: 64, maxWidth: 220, height: "auto", display: "block", margin: "0 0 10px" }} />}
                  <div dangerouslySetInnerHTML={{ __html: sigPreviewHtml }} />
                </div>
              </div>
            </div>
          )}
        </div>

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
const fmtBtn = { minWidth: 32, padding: "5px 10px", background: "#fff", color: INK, border: `1.5px solid ${RULE}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", cursor: "pointer", lineHeight: 1 };
function primaryBtn(disabled) { return { padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
function ghostBtn(disabled) { return { padding: "9px 14px", background: "#fff", color: BRIGHT, border: `1.5px solid ${BRIGHT}`, borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
