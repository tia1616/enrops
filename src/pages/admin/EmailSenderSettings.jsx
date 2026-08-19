// /admin/email-sender — set how this org's outgoing email identifies itself,
// and where the alerts meant for the operator land.
//
// The provider sets a sender display name + reply-to email. The actual FROM
// address is derived server-side (a per-tenant address on the verified platform
// domain), so providers never touch DNS and a misconfig can't silently break
// sending. The `tenant-sender` edge fn is the single source of truth for the
// resolved sender, so the preview always matches real emails. Owner/admin only.
//
// The alert address (organizations.alert_email) is the OTHER direction: mail we
// send TO the operator about their own business. It used to be set only at
// signup by two DB triggers (20260731f) with no way to change it, which was a
// real dead end once d7dbe6d made tenant-data alerts refuse to send rather than
// fall back to the Enrops inbox. This page is where an owner/admin fixes it.
// See migration 20260801d.

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

// Deliberately the SAME shape as the organizations_alert_email_format CHECK
// constraint (migration 20260801d) and isPlausibleEmail() in
// supabase/functions/_shared/orgBrand.ts: one non-whitespace address, one @, a
// dot in the domain. Not an RFC 5322 validator — Resend still gates delivery.
// The DB constraint is the real backstop (a direct PostgREST PATCH never runs
// this); this exists so the operator gets a sentence instead of a 23514.
const PLAUSIBLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function EmailSenderSettings() {
  const { org, user } = useOutletContext();
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [mailingAddress, setMailingAddress] = useState("");
  // organizations.alert_email — where OUR alerts to the operator go.
  //
  // THIS FIELD NEVER WRITES NULL, and that is load-bearing. loadOrgBrand's
  // tenant_alert_email coalesces alert_email -> email, so null looks harmless
  // from here — but several functions read the RAW column with no fallback, and
  // simply go quiet when it is null: respond-to-sub-offer drops the "your sub
  // declined" notice to a console.warn, and stripe-webhook skips its Connect
  // account-status alerts. Until those coalesce, "clear it" would mean "stop
  // telling me some things, silently". So an empty box means "use my sign-up
  // email", and we persist THAT address rather than a null.
  //
  // storedAlert is the column as it actually is in the DB (empty string when
  // null); alertEmail is the textbox, pre-filled with whichever address is
  // really in force. Keeping them separate is what lets the page say where the
  // current value came from.
  const [alertEmail, setAlertEmail] = useState("");
  const [storedAlert, setStoredAlert] = useState("");
  const [orgEmail, setOrgEmail] = useState("");
  const [alertErr, setAlertErr] = useState("");
  const alertInputRef = useRef(null);
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
  const [saved, setSaved] = useState({ fromName: "", replyTo: "", mailingAddress: "", alertEmail: "", sigHtml: "", sigImageUrl: "" });
  const [preview, setPreview] = useState(null); // { from, reply_to, reply_to_source, sender_source, ... }
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  // Inline result shown right at the Send-test button (the page-top toast is
  // off-screen once you've scrolled down to this section).
  const [testMsg, setTestMsg] = useState(null); // { kind: 'ok'|'warn'|'err', text }
  const [error, setError] = useState("");
  // Save failures render beside the Save button; `error` stays for the signature
  // image upload, whose control sits higher up the panel.
  const [saveErr, setSaveErr] = useState("");
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
        .select("email_from_name, email_reply_to, email_signature, email_signature_image_url, email_signature_image_mode")
        .eq("organization_id", org.id)
        .maybeSingle();
      // mailing_address + alert_email live on organizations, not org_branding.
      // `email` is read (never written here) purely to show which address is in
      // force when alert_email is empty.
      const { data: orgRow } = await supabase
        .from("organizations")
        .select("mailing_address, logo_url, alert_email, email")
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
        // Pre-fill with the address actually in force, so the box is never
        // mysteriously blank for an org that IS receiving alerts today.
        const storedA = orgRow?.alert_email ?? "";
        const orgE = orgRow?.email ?? "";
        setStoredAlert(storedA);
        setOrgEmail(orgE);
        setAlertEmail(storedA || orgE);
        setAlertErr("");
        setSaveErr("");
        setSigHtml(sig);
        setSigImageUrl(customImg);
        setOrgLogo(logo);
        setSigImgMode(mode);
        setSaved({
          fromName: data?.email_from_name ?? "",
          replyTo: data?.email_reply_to ?? "",
          mailingAddress: orgRow?.mailing_address ?? "",
          // The pre-filled value, not the raw column — otherwise an org whose
          // alert_email is null loads permanently "dirty".
          alertEmail: storedA || orgE,
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

  // Refuse the save and put the operator's cursor on the offending field. The
  // panel's Save button sits below the alert field, so setting an error alone
  // could leave the explanation off-screen above the click — scroll it into
  // view rather than trusting where the page happens to be.
  function blockOnAlert(msg) {
    setAlertErr(msg);
    setSaving(false);
    alertInputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    alertInputRef.current?.focus({ preventScroll: true });
  }

  async function save() {
    setSaving(true); setError(""); setSaveErr("");
    // Only touch alert_email when the operator actually changed THIS field.
    //
    // The box is pre-filled with whichever address is in force, so writing it on
    // every save meant an org whose column was still null had it quietly filled
    // in by, say, editing their signature — adopting a value they never chose,
    // and destroying the page's ability to tell them it came from signup rather
    // than from them. Nothing else on this panel gets to write this column.
    const alertTyped = alertEmail.trim();
    const alertDirty = alertEmail !== saved.alertEmail;
    // Emptying the box means "go back to my sign-up email" — resolved to that
    // concrete address rather than written as null, because several functions
    // read the raw column with no fallback (see the state comment above).
    const alertToSave = alertTyped || orgEmail.trim();
    if (alertDirty) {
      // Three distinct bad states, three distinct sentences — each true only in
      // the state that selects it. The typo message quotes what THEY typed; the
      // nothing-at-all message fires only when there is genuinely no fallback;
      // the third fires only for an unusable inherited address, which is
      // reachable only when the box was left empty.
      if (alertTyped && !PLAUSIBLE_EMAIL.test(alertTyped)) {
        blockOnAlert(`"${alertTyped}" doesn't look like an email address. Check for a typo — it needs an @ and a domain, like you@yourprogram.com.`);
        return;
      }
      if (!alertToSave) {
        blockOnAlert("Your alerts need somewhere to go. Add an address here — without one we can't tell you about a background check that needs review or a payment that failed.");
        return;
      }
      // The fallback can itself be junk: organizations.email is written from the
      // signup JWT and has never been format-checked, so don't hand it to the DB
      // constraint unexamined and turn a 23514 into the operator's problem.
      if (!PLAUSIBLE_EMAIL.test(alertToSave)) {
        blockOnAlert(`We were going to send alerts to "${alertToSave}", the email your account was created with, but that isn't a valid address. Type the one you want instead.`);
        return;
      }
    }
    setAlertErr("");
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
      // mailing_address + alert_email live on organizations (its own row already
      // exists). Read the row back in the same call rather than assuming the
      // write took: RLS could refuse it (members_update_own_org is owner/admin
      // only) and a 0-row update returns no error, which would otherwise show
      // "Saved" for a save that changed nothing.
      const { data: savedOrg, error: addrErr } = await supabase
        .from("organizations")
        .update({
          mailing_address: mailingAddress.trim() || null,
          // Omitted entirely unless this field changed, so an untouched null
          // column stays null. When present it is never null — see above.
          ...(alertDirty ? { alert_email: alertToSave } : {}),
        })
        .eq("id", org.id)
        .select("mailing_address, alert_email, email")
        .maybeSingle();
      if (addrErr) throw addrErr;
      if (!savedOrg) throw new Error("That didn't save. Your role may not have permission to change organization settings — ask an owner or admin.");
      flash("Sender saved.");
      // Reflect what the DATABASE now holds, not what we hoped it would hold.
      const storedBack = savedOrg.alert_email ?? "";
      const orgEmailBack = savedOrg.email ?? "";
      setStoredAlert(storedBack);
      setOrgEmail(orgEmailBack);
      setAlertEmail(storedBack || orgEmailBack);
      setMailingAddress(savedOrg.mailing_address ?? "");
      setSaved({
        fromName, replyTo,
        mailingAddress: savedOrg.mailing_address ?? "",
        alertEmail: storedBack || orgEmailBack,
        sigHtml, sigImageUrl, sigImgMode,
      });
      await loadPreview();
    } catch (e) {
      // Next to the Save button, NOT in the page-top box: this panel is now long
      // enough that the top of the page is well off-screen by the time you reach
      // Save, and an error you cannot see reads as a button that did nothing.
      // The page-top box stays for the signature image upload, whose control
      // lives further up.
      setSaveErr(e.message ?? "Couldn't save your sender settings.");
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
    alertEmail !== saved.alertEmail ||
    sigHtml !== saved.sigHtml || sigImageUrl !== saved.sigImageUrl || sigImgMode !== saved.sigImgMode;

  // What is in force RIGHT NOW, read off the STORED column and never off the
  // textbox — "right now" has to describe the database, not what someone is
  // half-way through typing. Three states, three sentences:
  //   explicit  — alert_email is set; that is the answer.
  //   inherited — alert_email is null, so loadOrgBrand falls through to
  //               organizations.email. The box is pre-filled with it, but the
  //               column is still empty, and the operator deserves to know the
  //               value came from signup rather than from them.
  //   none      — neither exists. Alerts carrying tenant data are refused.
  const storedAlertTrimmed = storedAlert.trim();
  const savedOrgEmail = orgEmail.trim();
  const effectiveAlert = storedAlertTrimmed || savedOrgEmail;
  const alertSource = storedAlertTrimmed ? "explicit" : savedOrgEmail ? "inherited" : "none";

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
        How your emails — invites, waivers, reminders — show up in families' inboxes, and where the alerts
        meant for you land. We handle the sending domain for you, so there's nothing to set up with your
        web host.
      </p>

      {error && <div style={{ marginTop: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}
      {toast && <div style={{ marginTop: 16, padding: "10px 12px", background: GREEN_BG, border: "1px solid #bbf7d0", borderRadius: 8, color: GREEN_INK, fontSize: 13 }}>{toast}</div>}

      {/* Live preview of the resolved sender */}
      {preview && (
        <div style={{ marginTop: 20, background: "#faf9ff", border: `1px solid ${RULE}`, borderRadius: 10, padding: "14px 16px" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5 }}>Families will see</div>
          <div style={{ fontSize: 15, color: INK, marginTop: 6 }}><strong>From:</strong> {preview.from}</div>
          <div style={{ fontSize: 14, color: MUTED, marginTop: 2 }}><strong>Replies go to:</strong> {preview.reply_to}</div>
          {/* The line above used to be the whole story, and it read as success in
              two states where it is not. An address the operator did not choose
              must not be shown in the same voice as one they did.

              THREE states, because a two-way tenant/platform split reports the
              middle one as fine and that is the one that actually bit us: The
              Ukulele Project had no reply-to set but did have an account email, so
              the resolved address was its own — nothing here would have warned —
              while SenderSetupNotice on the Comms tabs was calling that same org
              unconfigured. An operator following that nudge landed here, saw no
              warning and a blank Reply-to field, and had every reason to think the
              nudge was wrong. Both surfaces now tell the same story. */}
          {preview.reply_to_source === "platform" && (
            <div style={{ marginTop: 10, padding: "10px 12px", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, color: "#7c2d12", fontSize: 13 }} role="alert">
              <strong>That's an Enrops address, not yours.</strong> You haven't set a reply-to email, so a family who hits "reply" reaches us instead of you. Add yours below and save.
            </div>
          )}
          {preview.reply_to_source === "org_email" && (
            <div style={{ marginTop: 10, padding: "10px 12px", background: "#f5f3ff", border: `1px solid ${RULE}`, borderRadius: 8, color: INK, fontSize: 13 }}>
              That's your account email, used because you haven't set a reply-to for families. Replies do reach you. Set one below if they should go somewhere else.
            </div>
          )}
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

        {/* Alerts to the OPERATOR — the other direction from everything above.
            Own divider so it doesn't read as another family-facing field. */}
        <div style={{ borderTop: `1px solid ${RULE}`, margin: "22px 0 0", paddingTop: 20 }}>
          <label style={lbl} htmlFor="alert-email">Where should we send your alerts?</label>
          <div style={{ ...hint, marginTop: 0, marginBottom: 8 }}>
            This one isn't for families — it's us telling you about your own business. A contractor's
            background check that needs your review, a card declining on a payment plan, a bank transfer
            that didn't go through. Use an inbox a person actually reads.
          </div>
          {/* The box is pre-filled whenever either address exists, so the
              placeholder is only ever seen in the "none" state. */}
          <input
            id="alert-email"
            ref={alertInputRef}
            type="email"
            value={alertEmail}
            onChange={(e) => { setAlertEmail(e.target.value); if (alertErr) setAlertErr(""); }}
            placeholder="you@yourprogram.com"
            aria-invalid={alertErr ? "true" : undefined}
            aria-describedby={alertErr ? "alert-email-error alert-email-state" : "alert-email-state"}
            style={{ ...input, borderColor: alertErr ? "#fecaca" : RULE }}
          />
          {alertErr && (
            <div id="alert-email-error" role="alert" style={{ marginTop: 8, padding: "9px 11px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 12.5, lineHeight: 1.5 }}>
              {alertErr}
            </div>
          )}
          {/* What is true today, straight off the saved row. An operator who has
              never touched this has no way to know the value came from signup,
              so say which address is in force and where it came from. */}
          <div id="alert-email-state" style={alertSource === "none"
            ? { marginTop: 8, padding: "9px 11px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, color: "#92400e", fontSize: 12.5, lineHeight: 1.5 }
            : hint}>
            {alertSource === "explicit" && (
              <>
                Right now alerts go to <strong>{effectiveAlert}</strong>.
                {effectiveAlert.toLowerCase() === savedOrgEmail.toLowerCase() && " That's the email your account was created with."}
              </>
            )}
            {alertSource === "inherited" && (
              <>
                Right now alerts go to <strong>{savedOrgEmail}</strong>, the email your account was created
                with — you haven't chosen one yourself yet. Change it above if they should go somewhere else.
              </>
            )}
            {alertSource === "none" && (
              <>
                Right now your alerts have nowhere to go. Anything that names your staff or your families
                is held back rather than sent to Enrops, so you aren't hearing about it at all. Add an
                address to turn those back on.
              </>
            )}
          </div>
        </div>

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

        {saveErr && (
          <div role="alert" style={{ marginTop: 18, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13, lineHeight: 1.5 }}>
            {saveErr}
          </div>
        )}
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
