// /admin/branding — one home for the org's visual identity: logo + colors.
//
// Logo: a single upload is canonical. update-org-logo sets organizations.logo_url
// (SVG or raster, shown on the registration/public page) and derives an
// email-safe PNG (logo_email_url) via regenerate-email-logo. One upload → web
// AND email; operators never manage two files.
//
// Colors: the four brand colors live on org_branding and already feed both the
// public page and email templates (via _shared/orgBrand.ts). This is just the
// self-serve editor for them.

import { useEffect, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";
import RichBodyEditor from "../../components/RichBodyEditor.jsx";
import { sanitizeAuthoredHtml } from "../../lib/sanitizeAuthoredHtml.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const GREEN_BG = "#f0fdf4";
const GREEN_INK = "#166534";

// Shown in the pickers when an org hasn't set a color yet (Enrops defaults).
const DEFAULTS = { primary: "#1C004F", secondary: "#8C88FF", accent: "#F8A638", pageBg: "#FBFBFB" };
const COLOR_FIELDS = [
  { key: "primary", col: "primary_color", label: "Primary", help: "Buttons, links, headings." },
  { key: "accent", col: "accent_color", label: "Accent", help: "Highlights and call-to-action bits." },
  { key: "secondary", col: "secondary_color", label: "Secondary", help: "Supporting elements." },
  { key: "pageBg", col: "page_bg_color", label: "Page background", help: "Behind your registration page." },
];

function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("").toUpperCase();
}

// Pull a small brand palette from an uploaded logo — draw it to a tiny canvas,
// keep the saturated non-background pixels, return the most common distinct
// colors. Runs entirely client-side; returns null on any failure (extraction is
// a nicety, never a blocker). The file is a same-origin blob so getImageData
// isn't tainted; SVGs rasterize to the canvas the same way.
async function extractLogoPalette(file) {
  try {
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const S = 64;
    const canvas = document.createElement("canvas");
    canvas.width = S; canvas.height = S;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, S, S);
    URL.revokeObjectURL(url);
    const { data } = ctx.getImageData(0, 0, S, S);
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128) continue;                          // transparent
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (sat < 0.18) continue;                        // near-grey (bg/black/white)
      if (lum > 244 || lum < 12) continue;             // too light/dark
      const key = `${r >> 4}|${g >> 4}|${b >> 4}`;     // quantize into buckets
      const cur = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      cur.n++; cur.r += r; cur.g += g; cur.b += b;
      buckets.set(key, cur);
    }
    const sorted = [...buckets.values()]
      .map((c) => ({ n: c.n, r: Math.round(c.r / c.n), g: Math.round(c.g / c.n), b: Math.round(c.b / c.n) }))
      .sort((a, b) => b.n - a.n);
    if (!sorted.length) return null;
    const dist = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
    const picked = [];
    for (const c of sorted) {
      if (picked.every((p) => dist(p, c) > 60)) picked.push(c);
      if (picked.length >= 3) break;
    }
    return {
      primary: picked[0] ? rgbToHex(picked[0].r, picked[0].g, picked[0].b) : null,
      secondary: picked[1] ? rgbToHex(picked[1].r, picked[1].g, picked[1].b) : null,
      accent: picked[2] ? rgbToHex(picked[2].r, picked[2].g, picked[2].b) : null,
    };
  } catch { return null; }
}

export default function BrandLogoSettings() {
  const { org } = useOutletContext();
  const [logoUrl, setLogoUrl] = useState("");
  const [savedLogo, setSavedLogo] = useState("");
  const [colors, setColors] = useState(DEFAULTS);
  const [savedColors, setSavedColors] = useState(DEFAULTS);
  const [suggested, setSuggested] = useState(null); // palette found in the logo, offered (not auto-applied)
  const [bannerUrl, setBannerUrl] = useState("");
  const [savedBanner, setSavedBanner] = useState("");
  // Registration-page hero copy. Both columns already existed on org_branding and
  // the public page already renders them with fallbacks — nothing in the admin
  // ever let an operator EDIT them, so every provider got the default wording.
  const [heroHeadline, setHeroHeadline] = useState("");
  const [savedHeroHeadline, setSavedHeroHeadline] = useState("");
  const [heroSubtext, setHeroSubtext] = useState("");
  const [savedHeroSubtext, setSavedHeroSubtext] = useState("");
  // Confirmation-page block. Same rationale as the hero copy above — public page
  // wording that belongs to the operator — but this one holds a LINK, which is
  // why it gets the rich editor rather than a plain input: Jeff's whole ask was
  // sending families to his ukulele shop after they pay, and a text input can't
  // carry a link.
  const [confirmationHtml, setConfirmationHtml] = useState("");
  const [savedConfirmationHtml, setSavedConfirmationHtml] = useState("");
  // The button under that note. A label/url PAIR, not a link inside the note, so it
  // renders as a real button and the wording is a field rather than markup.
  const [ctaLabel, setCtaLabel] = useState("");
  const [savedCtaLabel, setSavedCtaLabel] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");
  const [savedCtaUrl, setSavedCtaUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const fileRef = useRef(null);
  const bannerRef = useRef(null);

  function flash(msg) { setToast(msg); setTimeout(() => setToast(""), 3000); }

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: o } = await supabase
        .from("organizations").select("logo_url, logo_email_url").eq("id", org.id).maybeSingle();
      const { data: b } = await supabase
        .from("org_branding").select("primary_color, secondary_color, accent_color, page_bg_color, banner_image_url, hero_headline, hero_subtext, confirmation_page_html, confirmation_cta_label, confirmation_cta_url")
        .eq("organization_id", org.id).maybeSingle();
      if (!cancelled) {
        const url = o?.logo_url || o?.logo_email_url || "";
        const c = {
          primary: b?.primary_color || DEFAULTS.primary,
          secondary: b?.secondary_color || DEFAULTS.secondary,
          accent: b?.accent_color || DEFAULTS.accent,
          pageBg: b?.page_bg_color || DEFAULTS.pageBg,
        };
        const banner = b?.banner_image_url || "";
        setLogoUrl(url); setSavedLogo(url);
        setColors(c); setSavedColors(c);
        setBannerUrl(banner); setSavedBanner(banner);
        // Empty string means "not set, using the default" — mirrored into the
        // saved-* copy so an untouched field is never written back (same reason
        // the colors are dirty-tracked: writing a blank would pin it).
        const hh = b?.hero_headline ?? "";
        const hs = b?.hero_subtext ?? "";
        setHeroHeadline(hh); setSavedHeroHeadline(hh);
        setHeroSubtext(hs); setSavedHeroSubtext(hs);
        const cp = b?.confirmation_page_html ?? "";
        setConfirmationHtml(cp); setSavedConfirmationHtml(cp);
        const cl = b?.confirmation_cta_label ?? "";
        const cu = b?.confirmation_cta_url ?? "";
        setCtaLabel(cl); setSavedCtaLabel(cl);
        setCtaUrl(cu); setSavedCtaUrl(cu);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = "";
    if (!file) return;
    setError("");
    // SVG allowed for the web logo; we auto-generate an email-safe PNG on save.
    const OK = ["image/svg+xml", "image/png", "image/jpeg", "image/webp"];
    if (!OK.includes(file.type)) { setError("Please choose an SVG, PNG, JPG, or WebP image."); return; }
    if (file.size > 2_000_000) { setError("That image is over 2 MB. Please use a smaller file."); return; }
    setUploading(true);
    try {
      const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
      const path = `${org.id}/logo/${Date.now()}.${ext}`; // org-id prefix satisfies bucket RLS
      const { error: upErr } = await supabase.storage
        .from("org-assets").upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from("org-assets").getPublicUrl(path);
      if (!pub?.publicUrl) throw new Error("Couldn't get the image URL.");
      setLogoUrl(pub.publicUrl);
      // Offer colors found in the logo as a SUGGESTION — never auto-apply. Logo
      // pixel-frequency is an unreliable guess (a colorful icon outweighs the
      // brand-color text), so the operator decides whether to use them.
      const palette = await extractLogoPalette(file);
      setSuggested(palette && (palette.primary || palette.secondary || palette.accent) ? palette : null);
    } catch (err) {
      setError(err.message ?? "Couldn't upload that image.");
    } finally {
      setUploading(false);
    }
  }

  async function handleBanner(e) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = "";
    if (!file) return;
    setError("");
    // Banner is a photo shown on the public page (not in email) — raster only.
    const OK = ["image/png", "image/jpeg", "image/webp"];
    if (!OK.includes(file.type)) { setError("Please choose a PNG, JPG, or WebP for the banner."); return; }
    if (file.size > 3_000_000) { setError("That banner is over 3 MB. Please use a smaller file."); return; }
    setUploadingBanner(true);
    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
      const path = `${org.id}/banner/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("org-assets").upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from("org-assets").getPublicUrl(path);
      if (!pub?.publicUrl) throw new Error("Couldn't get the image URL.");
      setBannerUrl(pub.publicUrl);
    } catch (err) {
      setError(err.message ?? "Couldn't upload that banner.");
    } finally {
      setUploadingBanner(false);
    }
  }

  const logoDirty = logoUrl !== savedLogo;
  const colorsDirty = COLOR_FIELDS.some((f) => colors[f.key] !== savedColors[f.key]);
  const bannerDirty = bannerUrl !== savedBanner;
  const heroDirty = heroHeadline !== savedHeroHeadline || heroSubtext !== savedHeroSubtext;
  const confirmationDirty = confirmationHtml !== savedConfirmationHtml;
  const ctaDirty = ctaLabel !== savedCtaLabel || ctaUrl !== savedCtaUrl;
  const dirty = logoDirty || colorsDirty || bannerDirty || heroDirty || confirmationDirty || ctaDirty;

  // Accept what an operator actually types ("yoursite.com/shop") and turn it
  // into something safe to put in an href. Anything that will not parse as http/https
  // is REFUSED at save time with a plain message rather than quietly stored - the
  // public page would then simply not render a button and the operator would be left
  // wondering why. RegisterSuccess re-checks on render regardless.
  function normalizeCtaUrl(raw) {
    const v = (raw || "").trim();
    if (!v) return { url: null, error: null };
    const candidate = /^https?:\/\//i.test(v) ? v : `https://${v}`;
    let parsed;
    try { parsed = new URL(candidate); } catch { return { url: null, error: true }; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { url: null, error: true };
    if (!parsed.hostname.includes(".")) return { url: null, error: true };
    // REJECT userinfo. Everything before an "@" is swallowed as user:pass, so the real
    // host is whatever follows it — which silently sends families somewhere else:
    //   "mailto:hello@gmail.com"     -> https://mailto:hello@gmail.com/  -> gmail.com
    //   "hello@myshop.com"           -> https://hello@myshop.com/        -> myshop.com
    //   "https://user:pass@evil.com" -> evil.com
    // Both the hostname-has-a-dot check and the render-side /^https?:/ test pass on all
    // three, so nothing downstream catches it. Typing an email address into a field
    // labelled "Button link" is an ordinary thing for an operator to do.
    if (parsed.username !== "" || parsed.password !== "") return { url: null, error: true };
    return { url: parsed.toString(), error: null };
  }
  const ctaCheck = normalizeCtaUrl(ctaUrl);
  // Don't shout at someone mid-word. Without this, typing the "y" of "yoursite.com"
  // turns the field red and prints an error before they have finished the first
  // token. The check itself still gates the save; this only governs when the inline
  // message is allowed to appear.
  const [ctaUrlBlurred, setCtaUrlBlurred] = useState(false);
  const showCtaError = ctaCheck.error && ctaUrlBlurred;
  // Built from the CURRENT origin so the link is right on staging and on prod,
  // and from the org's own slug — never a hardcoded tenant.
  const publicUrl = org?.slug
    ? `${typeof window !== "undefined" ? window.location.origin : "https://enrops.com"}/${org.slug}`
    : "";

  // Apply the logo-suggested colors into the pickers (operator's explicit click).
  function applySuggested() {
    if (!suggested) return;
    setColors((prev) => ({
      ...prev,
      primary: suggested.primary || prev.primary,
      secondary: suggested.secondary || prev.secondary,
      accent: suggested.accent || prev.accent,
    }));
    setSuggested(null);
  }

  async function save() {
    // Refuse rather than store something the public page would then decline to
    // render - the operator would see "Saved" and no button, with nothing to explain
    // it. Checked before setSaving so the button does not flicker into a spinner.
    if (ctaCheck.error) {
      // Reveal the field-level message too, so the explanation sits next to the field
      // that is wrong and not only in the banner and beside the button.
      setCtaUrlBlurred(true);
      setError("That button link doesn't look like a web address. Try something like yoursite.com/shop");
      return;
    }
    setSaving(true); setError("");
    try {
      // Logo goes through the edge fn (sets logo_url + derives the email PNG).
      if (logoDirty) {
        const url = logoUrl.trim() || null;
        // Edge functions can return a transient 5xx on a cold-start. Retry ONCE
        // on a transient failure; for a real error (e.g. 403) surface the
        // function's own message and don't retry.
        let lastErr = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          const { data, error: e } = await supabase.functions.invoke("update-org-logo", {
            body: { organization_id: org.id, logo_url: url },
          });
          if (!e && !data?.error) { lastErr = null; break; }
          const status = e?.context?.status;
          // invoke() gives a generic "non-2xx" message; read the real error body.
          let msg = data?.error || "";
          if (!msg && e?.context?.clone) { try { msg = (await e.context.clone().json())?.error || ""; } catch { /* body not JSON */ } }
          // Transient only when there's a real error object with a missing/5xx
          // status (cold-start 5xx or network/relay). A 200-with-error-body is a
          // real app error → surface its message, don't retry.
          const transient = !!e && (!status || status >= 500);
          lastErr = { message: msg, transient };
          if (attempt === 0 && transient) { await new Promise((r) => setTimeout(r, 800)); continue; }
          break; // real error → don't retry
        }
        if (lastErr) throw lastErr;
      }
      // Colors + banner go straight to org_branding. Build the payload from only
      // what changed so untouched fields (e.g. default colors) are never written.
      if (colorsDirty || bannerDirty || heroDirty || confirmationDirty || ctaDirty) {
        const payload = { organization_id: org.id, updated_at: new Date().toISOString() };
        // Only write colors the operator ACTUALLY changed. Writing all four would
        // pin untouched fields (still showing the platform default in the picker)
        // to that default value in the DB, detaching them from the fallback.
        COLOR_FIELDS.forEach((f) => { if (colors[f.key] !== savedColors[f.key]) payload[f.col] = colors[f.key]; });
        if (bannerDirty) payload.banner_image_url = bannerUrl.trim() || null;
        // NULL when cleared, not "" — the public page falls back on a falsy value,
        // and an empty string would read as "the operator chose blank wording".
        if (heroHeadline !== savedHeroHeadline) payload.hero_headline = heroHeadline.trim() || null;
        if (heroSubtext !== savedHeroSubtext) payload.hero_subtext = heroSubtext.trim() || null;
        // Same NULL-not-"" rule: the confirmation page renders the block only when
        // this is truthy, so clearing the editor must detach it, not store a blank
        // that would render an empty card.
        if (confirmationDirty) payload.confirmation_page_html = confirmationHtml.trim() || null;
        if (ctaDirty) {
          // Store the NORMALIZED url, so the page never has to guess about a missing
          // scheme, and NULL when cleared so the button disappears rather than
          // rendering with a dead destination.
          payload.confirmation_cta_url = ctaCheck.url;
          payload.confirmation_cta_label = ctaLabel.trim() || null;
        }
        const { error: e } = await supabase.from("org_branding").upsert(payload, { onConflict: "organization_id" });
        if (e) throw e;
      }
      flash("Branding saved.");
      setSavedLogo(logoUrl); setSavedColors(colors); setSavedBanner(bannerUrl);
      // Re-baseline the hero copy too, or the form stays permanently "dirty" and
      // the next save rewrites fields the operator never touched again.
      setSavedHeroHeadline(heroHeadline); setSavedHeroSubtext(heroSubtext);
      setSavedConfirmationHtml(confirmationHtml);
      // Re-baseline the normalized url, not the raw text, or the form stays dirty
      // forever after we rewrite "site.com" to "https://site.com/".
      setSavedCtaLabel(ctaLabel);
      const normalized = ctaCheck.url ?? "";
      setCtaUrl(normalized); setSavedCtaUrl(normalized);
    } catch (e) {
      const raw = e?.message ?? "";
      const jargon = /non-2xx|edge function|failed to fetch|network|fetcherror/i.test(raw);
      // Transient failure or opaque jargon → ask to retry; a real error with a
      // clean message → show it. Never surface runtime jargon to the operator.
      const friendly = e?.transient || jargon
        ? "Couldn't save just now — please click Save again."
        : (raw || "Couldn't save your branding — please try again.");
      setError(friendly);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "8px 0 40px" }}>
      <Link to="/admin/settings" style={{ fontSize: 13, color: MUTED, textDecoration: "none" }}>← Settings</Link>
      <h1 style={{ margin: "8px 0 4px", color: PURPLE, fontSize: 24, fontWeight: 700 }}>Branding</h1>
      <p style={{ color: MUTED, fontSize: 14, marginTop: 0, lineHeight: 1.5, maxWidth: 560 }}>
        Set these once. Your <strong>logo</strong> appears on your registration pages and your emails. Your <strong>colors</strong> style your emails. Your <strong>banner</strong> sits at the top of your class list.
      </p>

      {error && <div style={{ marginTop: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}
      {toast && <div style={{ marginTop: 16, padding: "10px 12px", background: GREEN_BG, border: "1px solid #bbf7d0", borderRadius: 8, color: GREEN_INK, fontSize: 13 }}>{toast}</div>}

      {/* Logo */}
      <div style={{ marginTop: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginBottom: 14 }}>Logo</div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ width: 160, height: 90, borderRadius: 8, border: `1px ${logoUrl ? "solid" : "dashed"} ${RULE}`, display: "flex", alignItems: "center", justifyContent: "center", background: "#faf9ff", overflow: "hidden" }}>
            {logoUrl
              ? <img src={logoUrl} alt="Your logo" style={{ maxWidth: "88%", maxHeight: "80%", objectFit: "contain" }} />
              : <span style={{ color: MUTED, fontSize: 12 }}>No logo yet</span>}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input ref={fileRef} type="file" accept="image/svg+xml,image/png,image/jpeg,image/webp" onChange={handleFile} style={{ display: "none" }} />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} style={ghostBtn(uploading)}>
              {uploading ? "Uploading…" : logoUrl ? "Replace logo" : "Upload logo"}
            </button>
            {logoUrl && !uploading && (
              <button type="button" onClick={() => { setLogoUrl(""); setSuggested(null); }} style={{ ...ghostBtn(false), color: MUTED, borderColor: RULE }}>Remove</button>
            )}
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: MUTED, marginTop: 12, lineHeight: 1.5 }}>
          SVG, PNG, JPG, or WebP, under 2 MB. A transparent PNG or SVG looks best — we'll make an
          email-friendly version automatically.
        </div>
      </div>

      {/* Colors */}
      <div style={{ marginTop: 16, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginBottom: 4 }}>Colors</div>
        <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 14, lineHeight: 1.5 }}>Pick your brand colors, or upload a logo above for suggestions.</div>
        {suggested && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "#faf9ff", border: `1px solid ${RULE}`, borderRadius: 8, padding: "10px 12px", marginBottom: 14 }}>
            <span style={{ fontSize: 12.5, color: INK, fontWeight: 600 }}>Found in your logo:</span>
            {[suggested.primary, suggested.secondary, suggested.accent].filter(Boolean).map((hex) => (
              <span key={hex} title={hex} style={{ width: 22, height: 22, borderRadius: 5, background: hex, border: `1px solid ${RULE}` }} />
            ))}
            <button type="button" onClick={applySuggested} style={{ ...ghostBtn(false), padding: "6px 12px", marginLeft: 4 }}>Use these</button>
            <button type="button" onClick={() => setSuggested(null)} style={{ ...ghostBtn(false), padding: "6px 12px", color: MUTED, borderColor: RULE }}>Dismiss</button>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 14 }}>
          {COLOR_FIELDS.map((f) => (
            <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
              <input
                type="color"
                value={colors[f.key]}
                onChange={(e) => setColors((c) => ({ ...c, [f.key]: e.target.value }))}
                style={{ width: 38, height: 38, border: `1px solid ${RULE}`, borderRadius: 8, padding: 0, background: "none", cursor: "pointer", flexShrink: 0 }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>{f.label}</div>
                <div style={{ fontSize: 11.5, color: MUTED, lineHeight: 1.4 }}>{f.help}</div>
              </div>
            </label>
          ))}
        </div>

        {/* Live preview using the chosen colors */}
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Preview</div>
          <div style={{ background: colors.pageBg, border: `1px solid ${RULE}`, borderRadius: 8, padding: 20, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ color: colors.primary, fontWeight: 700, fontSize: 16 }}>Your heading</span>
            <button type="button" style={{ background: colors.primary, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "default" }}>Register</button>
            <span style={{ background: colors.accent, color: "#fff", borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 600 }}>Accent</span>
            <a href="#" onClick={(e) => e.preventDefault()} style={{ color: colors.secondary, fontSize: 13, fontWeight: 600 }}>a link</a>
          </div>
        </div>
      </div>

      {/* Banner */}
      <div style={{ marginTop: 16, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginBottom: 4 }}>Banner</div>
        <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 14, lineHeight: 1.5 }}>A wide photo across the top of your <strong>registration page</strong> — not used in emails (those lead with your logo). Optional; leave it empty for a clean page.</div>
        <div style={{ width: "100%", maxWidth: 480, aspectRatio: "16 / 5", borderRadius: 8, border: `1px ${bannerUrl ? "solid" : "dashed"} ${RULE}`, display: "flex", alignItems: "center", justifyContent: "center", background: "#faf9ff", overflow: "hidden" }}>
          {bannerUrl
            ? <img src={bannerUrl} alt="Your banner" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : <span style={{ color: MUTED, fontSize: 12 }}>No banner yet</span>}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          <input ref={bannerRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleBanner} style={{ display: "none" }} />
          <button type="button" onClick={() => bannerRef.current?.click()} disabled={uploadingBanner} style={ghostBtn(uploadingBanner)}>
            {uploadingBanner ? "Uploading…" : bannerUrl ? "Replace banner" : "Upload banner"}
          </button>
          {bannerUrl && !uploadingBanner && (
            <button type="button" onClick={() => setBannerUrl("")} style={{ ...ghostBtn(false), color: MUTED, borderColor: RULE }}>Remove</button>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: MUTED, marginTop: 12, lineHeight: 1.5 }}>PNG, JPG, or WebP, under 3 MB. A wide image (about 3:1) works best.</div>
      </div>

      {/* Registration page wording. hero_headline + hero_subtext already existed
          on org_branding and the public page already renders them, but no admin
          screen edited them — so every provider shipped with the default copy and
          no way to change it. Placed under Banner because these three things sit
          together at the top of the registration page. */}
      <div style={{ marginTop: 16, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginBottom: 4 }}>Registration page wording</div>
        {/* ONE sentence, true for BOTH layouts. This briefly branched on
            instructor_pay_model, because the legacy layout used these fields for
            its class-picker heading while its real hero was hardcoded. That is no
            longer so: both layouts now take their opening headline from these two
            columns, and the picker carries its own platform label. A branch kept
            here would describe a product that no longer exists. */}
        <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 14, lineHeight: 1.5 }}>
          The headline and the line under it, at the top of the page families land on from your
          registration link. Leave either blank to use the default wording.
          {publicUrl && (
            <>
              {" "}
              <a href={publicUrl} target="_blank" rel="noreferrer" style={{ color: BRIGHT, fontWeight: 600 }}>
                Open that page →
              </a>
            </>
          )}
        </div>

        <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: INK }}>
          Headline
          <input
            type="text"
            value={heroHeadline}
            onChange={(e) => setHeroHeadline(e.target.value)}
            /* An EXAMPLE of what to write, not the default wording: the public
               page's fallback differs by catalog layout, so naming one here
               would be wrong on the other. */
            /* Tenant-neutral. This said "After-school ukulele classes in Portland" -
               one real provider's business, shown to every other one as the example. */
            placeholder="e.g. After-school art classes in your city"
            maxLength={120}
            style={{ width: "100%", boxSizing: "border-box", marginTop: 4, padding: "9px 12px", fontSize: 13, border: `1px solid ${RULE}`, borderRadius: 8, fontFamily: "inherit", fontWeight: 400 }}
          />
        </label>

        <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: INK, marginTop: 12 }}>
          Line underneath
          <textarea
            value={heroSubtext}
            onChange={(e) => setHeroSubtext(e.target.value)}
            placeholder="e.g. After-school art classes across the city. Pick a school and sign up in a couple of minutes."
            maxLength={300}
            style={{ width: "100%", boxSizing: "border-box", marginTop: 4, padding: "9px 12px", fontSize: 13, border: `1px solid ${RULE}`, borderRadius: 8, fontFamily: "inherit", fontWeight: 400, minHeight: 66, resize: "vertical" }}
          />
        </label>
      </div>

      {/* Confirmation page wording. Sits with the hero copy because both are
          operator-authored words on a page families see, and org_branding was
          already their home. This one is the LAST page of the flow rather than the
          first: the screen a family lands on straight after paying.

          Why a rich editor and not two inputs like the hero above: the entire ask
          was Jeff sending families to his ukulele shop once they've paid, and that
          needs a link. The editor is the same one used for email bodies, so an
          operator learns one control, and its Link button means nobody has to be
          told to type bracket-parenthesis notation. */}
      <div style={{ marginTop: 16, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginBottom: 4 }}>Confirmation page wording</div>
        <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 14, lineHeight: 1.5 }}>
          A note and a button on the page families see right after they pay — the place to send them
          to your own shop or website. Their class details, calendar links and sign-in instructions
          are always shown above it. Leave both blank and nothing extra appears.
          {publicUrl && (
            <>
              {" "}
              {/* The preview below shows the BOX. This shows the WHOLE page it sits on,
                  which is what you actually want to judge before families see it.
                  Opened directly it has no real registration behind it, so the class
                  details and calendar buttons are absent - said plainly, because a
                  preview that quietly omits things is worse than no preview. */}
              <a href={`${publicUrl}/register/success`} target="_blank" rel="noreferrer" style={{ color: BRIGHT, fontWeight: 600 }}>
                See the whole page &rarr;
              </a>{" "}
              <span style={{ color: MUTED }}>
                (opens without a real registration, so the class details and calendar buttons
                won&rsquo;t be there)
              </span>
            </>
          )}
        </div>
        <RichBodyEditor
          value={confirmationHtml}
          onChange={setConfirmationHtml}
          rows={5}
          /* Tenant-NEUTRAL example. A real provider's wording or web address must never
             be the platform's placeholder - every other operator sees it. */
          placeholder={"Need supplies before the first class? We keep everything you need in stock."}
          helpText={<>Leave a blank line to start a new paragraph. For your main link, use the button below rather than a link in the text.</>}
          /* No Link button here: the button fields below own the link, and two ways to
             make one link is one too many. Email bodies keep theirs. */
          allowLink={false}
          /* The editor's own preview is off here: the true preview is the combined one
             below, which shows the note AND the button together in the box families
             actually see. Two previews would be two answers to one question. */
          showPreview={false}
        />

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
          <label style={{ flex: "1 1 190px", fontSize: 12, fontWeight: 600, color: INK }}>
            Button wording
            <input
              type="text"
              value={ctaLabel}
              onChange={(e) => setCtaLabel(e.target.value)}
              placeholder="Visit our shop"
              maxLength={40}
              style={{ width: "100%", boxSizing: "border-box", marginTop: 4, padding: "9px 12px", fontSize: 13, border: `1px solid ${RULE}`, borderRadius: 8, fontFamily: "inherit", fontWeight: 400 }}
            />
          </label>
          <label style={{ flex: "1 1 190px", fontSize: 12, fontWeight: 600, color: INK }}>
            Button link
            <input
              type="text"
              value={ctaUrl}
              onChange={(e) => setCtaUrl(e.target.value)}
              onBlur={() => setCtaUrlBlurred(true)}
              placeholder="yoursite.com/shop"
              style={{ width: "100%", boxSizing: "border-box", marginTop: 4, padding: "9px 12px", fontSize: 13, border: `1px solid ${showCtaError ? "#dc2626" : RULE}`, borderRadius: 8, fontFamily: "inherit", fontWeight: 400 }}
            />
          </label>
        </div>
        <div style={{ fontSize: 11.5, color: showCtaError ? "#dc2626" : MUTED, marginTop: 6, lineHeight: 1.5 }}>
          {showCtaError
            ? "That doesn't look like a web address yet. Something like yoursite.com/shop."
            : "No need to type https:// - we add it. Leave the link blank and no button appears."}
        </div>

        {/* True preview: the box as families see it, in THIS provider's colour.
            Built with their saved primary rather than the public stylesheet's tokens
            because this admin page is not inside the public brand wrapper, so those
            tokens would resolve to the J2S palette and show them the wrong colour. */}
        {(confirmationHtml.trim() !== "" || (ctaUrl.trim() !== "" && !ctaCheck.error)) && (
          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
              What families will see
            </div>
            <div style={{
              border: `2px solid ${colors.primary}40`, background: `${colors.primary}0F`,
              borderRadius: 16, padding: "20px 18px", textAlign: "center",
            }}>
              {confirmationHtml.trim() !== "" && (
                <div
                  style={{ fontSize: 14.5, lineHeight: 1.6, color: INK }}
                  /* Sanitized here too. The preview must render what the live page
                     renders, and an admin viewing a value another admin injected over
                     the API is a real reader of this string. */
                  dangerouslySetInnerHTML={{ __html: sanitizeAuthoredHtml(confirmationHtml) }}
                />
              )}
              {ctaUrl.trim() !== "" && !ctaCheck.error && (
                <div style={{
                  display: "inline-block", marginTop: confirmationHtml.trim() !== "" ? 16 : 0,
                  background: colors.primary, color: "#fff", borderRadius: 12,
                  padding: "12px 24px", fontSize: 14, fontWeight: 700,
                }}>
                  {ctaLabel.trim() || "Visit our website"}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* The refusal has to be readable FROM HERE. The page's error banner is at the
          very top and this button is at the bottom of a long form, so a save blocked
          by a bad button link looked like a dead button - clicked, nothing happened.
          Not gated on the blur flag: by the time someone presses Save they are
          entitled to know why it did not. */}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12, marginTop: 18 }}>
        {ctaCheck.error && (
          <span style={{ color: "#dc2626", fontSize: 12.5, textAlign: "right", lineHeight: 1.4 }}>
            Check the button link before saving.
          </span>
        )}
        <button type="button" onClick={save} disabled={saving || !dirty} style={primaryBtn(saving || !dirty)}>{saving ? "Saving…" : dirty ? "Save" : "Saved ✓"}</button>
      </div>
    </div>
  );
}

function primaryBtn(disabled) { return { padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
function ghostBtn(disabled) { return { padding: "9px 14px", background: "#fff", color: BRIGHT, border: `1.5px solid ${BRIGHT}`, borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
