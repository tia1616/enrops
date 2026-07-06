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

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const GREEN_BG = "#f0fdf4";
const GREEN_INK = "#166534";

// The signature is authored in a WYSIWYG box and injected raw into outgoing
// email HTML, so we sanitize before storing: keep only a tiny formatting tag
// set, drop every attribute except a safe href on links. Combined with
// paste-as-plain-text, an operator can't smuggle scripts/styles into an email.
const SIG_ALLOWED_TAGS = new Set(["B", "STRONG", "I", "EM", "U", "A", "BR", "P", "DIV", "SPAN"]);
const SIG_DROP_WITH_CONTENT = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED"]);
function sanitizeSignatureHtml(html) {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstChild;
  const walk = (node) => {
    let mutated = false;
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === 3) return; // text — keep
      if (child.nodeType !== 1) { child.remove(); mutated = true; return; } // comments etc
      if (SIG_DROP_WITH_CONTENT.has(child.tagName)) { child.remove(); mutated = true; return; } // never keep code
      if (!SIG_ALLOWED_TAGS.has(child.tagName)) {
        while (child.firstChild) node.insertBefore(child.firstChild, child); // unwrap, keep text
        child.remove();
        mutated = true;
        return;
      }
      [...child.attributes].forEach((a) => {
        if (child.tagName === "A" && a.name.toLowerCase() === "href") {
          if (!/^(https?:\/\/|mailto:)/i.test(a.value)) child.removeAttribute("href");
        } else {
          child.removeAttribute(a.name); // strip style/class/on*/everything else
        }
      });
      walk(child);
    });
    if (mutated) walk(node); // re-process after unwrapping nested disallowed tags
  };
  walk(root);
  return root.innerHTML;
}
function htmlHasText(html) {
  if (!html) return false;
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent || "").trim().length > 0;
}
function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export default function EmailSenderSettings() {
  const { org, user } = useOutletContext();
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [mailingAddress, setMailingAddress] = useState("");
  // Signature: rich HTML (from the WYSIWYG box) + an optional image URL. Stored
  // as sanitized HTML in org_branding.email_signature.
  const [sigHtml, setSigHtml] = useState("");
  const [sigImageUrl, setSigImageUrl] = useState("");
  const [orgLogo, setOrgLogo] = useState(""); // canonical org logo (Settings → Logo)
  const [sigImgMode, setSigImgMode] = useState("none"); // 'logo' | 'custom' | 'none'
  const [uploadingSig, setUploadingSig] = useState(false);
  const sigFileRef = useRef(null);
  const sigEditorRef = useRef(null);
  const sigHydrated = useRef(false); // set the editor's innerHTML exactly once
  const initialSig = useRef("");
  const savedRange = useRef(null); // caret/selection saved before the link form steals focus
  // Inline "add link" mini-form state (so operators never type link syntax).
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  // Snapshot of the last loaded/saved values so the Save button can grey out
  // when there's nothing to save, and light up when you change something.
  const [saved, setSaved] = useState({ fromName: "", replyTo: "", mailingAddress: "", sigHtml: "", sigImageUrl: "" });
  const [preview, setPreview] = useState(null); // { from, reply_to }
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  // Inline result shown right at the Send-test button (the page-top toast is
  // off-screen once you've scrolled down to this section).
  const [testMsg, setTestMsg] = useState(null); // { kind: 'ok'|'warn'|'err', text }
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
        .select("mailing_address, logo_url")
        .eq("id", org.id)
        .maybeSingle();
      if (!cancelled) {
        const sig = sanitizeSignatureHtml(data?.email_signature ?? "");
        const sigImg = data?.email_signature_image_url ?? "";
        const logo = orgRow?.logo_url ?? "";
        // Mode is stored explicitly now. Legacy rows (null mode) fall back to the
        // old URL-equality guess so their signatures keep rendering the same way.
        const mode = data?.email_signature_image_mode
          ?? (!sigImg ? "none" : (logo && sigImg === logo) ? "logo" : "custom");
        const customImg = mode === "custom" ? sigImg : "";
        initialSig.current = sig;
        sigHydrated.current = false; // re-hydrate the editor for this org
        setFromName(data?.email_from_name ?? "");
        setReplyTo(data?.email_reply_to ?? "");
        setMailingAddress(orgRow?.mailing_address ?? "");
        setSigHtml(sig);
        setSigImageUrl(customImg);
        setOrgLogo(logo);
        setSigImgMode(mode);
        setSaved({
          fromName: data?.email_from_name ?? "",
          replyTo: data?.email_reply_to ?? "",
          mailingAddress: orgRow?.mailing_address ?? "",
          sigHtml: sig,
          sigImageUrl: customImg,
          sigImgMode: mode,
        });
        setTestTo(user?.email ?? "");
        await loadPreview();
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  // Seed the contentEditable's HTML once after load — React must not re-write it
  // on every keystroke (that would fight the cursor). We read innerHTML back into
  // state on input instead.
  useEffect(() => {
    if (!loading && sigEditorRef.current && !sigHydrated.current) {
      sigEditorRef.current.innerHTML = initialSig.current;
      sigHydrated.current = true;
    }
  }, [loading]);

  async function save() {
    setSaving(true); setError("");
    try {
      const cleanSig = sanitizeSignatureHtml(sigHtml);
      const fields = {
        organization_id: org.id,
        email_from_name: fromName.trim() || null,
        email_reply_to: replyTo.trim() || null,
        email_signature: htmlHasText(cleanSig) ? cleanSig : null,
        email_signature_image_mode: sigImgMode,
        // Only 'custom' stores a URL; 'logo' resolves to the live org logo at
        // send time, 'none' stores nothing.
        email_signature_image_url: sigImgMode === "custom" ? (sigImageUrl.trim() || null) : null,
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
      setSaved({ fromName, replyTo, mailingAddress, sigHtml, sigImageUrl, sigImgMode });
      await loadPreview();
    } catch (e) {
      setError(e.message ?? "Couldn't save your sender settings.");
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTestMsg(null);
    if (!testTo.trim()) { setTestMsg({ kind: "err", text: "Enter an email to send the test to." }); return; }
    setTesting(true); setError("");
    try {
      const { data, error: e } = await supabase.functions.invoke("tenant-sender", {
        body: { organization_id: org.id, action: "test", to: testTo.trim() },
      });
      if (e) throw e;
      if (data?.held_back) setTestMsg({ kind: "warn", text: `On staging, ${testTo.trim()} isn't on the test allow-list — nothing sent.` });
      else if (data?.sent) setTestMsg({ kind: "ok", text: `✓ Test sent to ${data.to}. Check that inbox.` });
      else setTestMsg({ kind: "err", text: data?.error ? `Couldn't send: ${data.error}` : "Couldn't send the test." });
    } catch (e) {
      setTestMsg({ kind: "err", text: e.message ?? "Couldn't send the test email." });
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

  // Signature image mode. "Use my logo" tracks the org logo live (resolved at
  // send time — no snapshot); "different image" keeps the uploaded custom image;
  // "none" shows nothing. We keep sigImageUrl untouched across switches so a
  // custom upload survives toggling to logo/none and back.
  function chooseLogoImg() { setSigImgMode("logo"); }
  function chooseCustomImg() { setSigImgMode("custom"); }
  function chooseNoImg() { setSigImgMode("none"); }

  // Read the editor's current HTML into state (sanitized) — drives preview,
  // dirty-check, and save. We never write back to the DOM here, so the cursor
  // stays put while typing.
  function syncSig() {
    const raw = sigEditorRef.current?.innerHTML ?? "";
    setSigHtml(htmlHasText(raw) || /<img|<a\b/i.test(raw) ? sanitizeSignatureHtml(raw) : "");
  }

  // Toolbar formatting. execCommand is deprecated but universally supported and
  // is the lightest way to get true WYSIWYG bold/italic/link without a heavy
  // editor dependency. Buttons use onMouseDown+preventDefault so clicking them
  // doesn't blur the editor and drop the selection.
  function exec(cmd) {
    sigEditorRef.current?.focus();
    document.execCommand(cmd, false, null);
    syncSig();
  }

  function openLink() {
    const sel = window.getSelection();
    savedRange.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    setLinkUrl("");
    setLinkOpen(true);
  }
  function addLink() {
    let url = linkUrl.trim();
    if (!url) { setLinkOpen(false); return; }
    if (!/^(https?:\/\/|mailto:)/i.test(url)) url = `https://${url}`;
    const ed = sigEditorRef.current;
    ed?.focus();
    const sel = window.getSelection();
    if (savedRange.current && sel) { sel.removeAllRanges(); sel.addRange(savedRange.current); }
    if (sel && sel.isCollapsed) {
      const label = url.replace(/^https?:\/\//i, "").replace(/^mailto:/i, "");
      document.execCommand("insertHTML", false, `<a href="${escapeAttr(url)}">${escapeAttr(label)}</a>`);
    } else {
      document.execCommand("createLink", false, url);
    }
    syncSig();
    setLinkOpen(false);
    setLinkUrl("");
  }

  // Paste as plain text — strips pasted fonts/colors/scripts so the signature
  // stays clean and safe; the operator re-formats with the toolbar.
  function onSigPaste(e) {
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    document.execCommand("insertText", false, text);
    syncSig();
  }

  const sigPreviewHtml = sanitizeSignatureHtml(sigHtml);
  // The image shown in the preview/email depends on the chosen mode.
  const sigPreviewImg = sigImgMode === "logo" ? orgLogo : sigImgMode === "custom" ? sigImageUrl : "";
  const hasSignature = htmlHasText(sigPreviewHtml) || !!sigPreviewImg;

  const dirty =
    fromName !== saved.fromName || replyTo !== saved.replyTo || mailingAddress !== saved.mailingAddress ||
    sigHtml !== saved.sigHtml || sigImageUrl !== saved.sigImageUrl || sigImgMode !== saved.sigImgMode;

  if (loading) {
    return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>;
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "8px 0 40px" }}>
      <style>{`.sig-editor:empty:before{content:attr(data-ph);color:#9ca3af;}
.sig-editor a{color:${BRIGHT};}
.sig-editor:focus{outline:none;border-color:${BRIGHT};}`}</style>
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

          {/* Image choice — reuse the org logo, a different image, or none. */}
          <div style={{ ...lbl, marginTop: 4 }}>Image</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" onClick={chooseLogoImg} style={segBtn(sigImgMode === "logo")}>Use my logo</button>
            <button type="button" onClick={chooseCustomImg} style={segBtn(sigImgMode === "custom")}>Use a different image</button>
            <button type="button" onClick={chooseNoImg} style={segBtn(sigImgMode === "none")}>No image</button>
          </div>

          {sigImgMode === "logo" && (
            orgLogo
              ? <div style={{ marginTop: 12 }}><img src={orgLogo} alt="Your logo" style={{ maxHeight: 56, maxWidth: 180, height: "auto", borderRadius: 6, border: `1px solid ${RULE}` }} /></div>
              : <div style={{ ...hint, marginTop: 10 }}>You haven't added a logo yet. <Link to="/admin/branding" style={{ color: BRIGHT, fontWeight: 600, textDecoration: "none" }}>Add your logo →</Link></div>
          )}

          {sigImgMode === "custom" && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
                {sigImageUrl ? (
                  <img src={sigImageUrl} alt="Signature image" style={{ maxHeight: 56, maxWidth: 180, height: "auto", borderRadius: 6, border: `1px solid ${RULE}` }} />
                ) : (
                  <div style={{ width: 56, height: 56, borderRadius: 6, border: `1px dashed ${RULE}`, display: "flex", alignItems: "center", justifyContent: "center", color: MUTED, fontSize: 11 }}>No image</div>
                )}
                <input ref={sigFileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={handleSigImage} style={{ display: "none" }} />
                <button type="button" onClick={() => sigFileRef.current?.click()} disabled={uploadingSig} style={ghostBtn(uploadingSig)}>
                  {uploadingSig ? "Uploading…" : sigImageUrl ? "Replace image" : "Upload image"}
                </button>
              </div>
              <div style={hint}>A badge or headshot. PNG, JPG, or GIF, under 1 MB.</div>
            </>
          )}

          {/* WYSIWYG editor — bold shows bold, links show as links. No syntax. */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 14, marginBottom: 6 }}>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec("bold")} title="Bold" style={{ ...fmtBtn, fontWeight: 800 }}>B</button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec("italic")} title="Italic" style={{ ...fmtBtn, fontStyle: "italic" }}>i</button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={openLink} title="Add a link" style={fmtBtn}>🔗 Link</button>
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
          <div
            ref={sigEditorRef}
            className="sig-editor"
            contentEditable
            suppressContentEditableWarning
            data-ph="Highlight text to make it bold, italic, or a link."
            onInput={syncSig}
            onBlur={syncSig}
            onPaste={onSigPaste}
            style={{ ...input, minHeight: 96, lineHeight: 1.5, cursor: "text" }}
          />
          <div style={hint}>Type your sign-off — highlight any text and use the buttons above to format it. The preview below is exactly what families and staff will get.</div>

          {/* Live preview */}
          {hasSignature && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Preview</div>
              <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: 16 }}>
                <div style={{ marginTop: 4, paddingTop: 16, borderTop: "1px solid #eee", color: "#555", fontSize: 14, lineHeight: 1.5 }}>
                  <div dangerouslySetInnerHTML={{ __html: sigPreviewHtml }} />
                  {sigPreviewImg && <img src={sigPreviewImg} alt="Signature" style={{ maxHeight: 64, maxWidth: 220, height: "auto", display: "block", margin: htmlHasText(sigPreviewHtml) ? "12px 0 0" : "0" }} />}
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
        {testMsg && (
          <div style={{
            marginTop: 12, padding: "10px 12px", borderRadius: 8, fontSize: 13,
            background: testMsg.kind === "ok" ? GREEN_BG : testMsg.kind === "warn" ? "#fffbeb" : "#fef2f2",
            border: `1px solid ${testMsg.kind === "ok" ? "#bbf7d0" : testMsg.kind === "warn" ? "#fde68a" : "#fecaca"}`,
            color: testMsg.kind === "ok" ? GREEN_INK : testMsg.kind === "warn" ? "#92400e" : "#991b1b",
          }}>{testMsg.text}</div>
        )}
      </div>
    </div>
  );
}

const lbl = { display: "block", fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 };
const hint = { fontSize: 12.5, color: MUTED, marginTop: 6, lineHeight: 1.5 };
const input = { width: "100%", padding: "10px 12px", border: `1.5px solid ${RULE}`, borderRadius: 8, fontSize: 14, color: INK, background: "#fff", fontFamily: "inherit", boxSizing: "border-box" };
const fmtBtn = { minWidth: 32, padding: "5px 10px", background: "#fff", color: INK, border: `1.5px solid ${RULE}`, borderRadius: 7, fontSize: 13, fontFamily: "inherit", cursor: "pointer", lineHeight: 1 };
function segBtn(active) { return { padding: "7px 12px", background: active ? "#f0e3e8" : "#fff", color: active ? PURPLE : INK, border: `1.5px solid ${active ? BRIGHT : RULE}`, borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }; }
function primaryBtn(disabled) { return { padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
function ghostBtn(disabled) { return { padding: "9px 14px", background: "#fff", color: BRIGHT, border: `1.5px solid ${BRIGHT}`, borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
