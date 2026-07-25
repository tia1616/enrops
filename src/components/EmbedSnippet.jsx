// EmbedSnippet — hands the operator a copy-paste block that puts their
// registration ON THEIR OWN WEBSITE instead of sending families off to a
// third-party page. This is the piece competitors do badly (dated widgets,
// site-slowing scripts, or an off-site redirect), so it's worth being clean:
// one <iframe> plus a tiny listener that keeps it exactly as tall as its
// content (no inner scrollbar, no guessing a fixed height).
//
// The URL is built from the CURRENT origin, so the snippet an operator copies
// on staging points at staging and the one they copy on prod points at prod —
// nothing hardcoded to swap at release time.

import { useState } from "react";

const INK = "#1C004F";
const MUTED = "#6b6b6b";
const RULE = "#E7E4F5";
const RULE_STRONG = "#C9C3EC";  // visible dashed edge — RULE alone reads as no border
const BRIGHT = "#5847C9";

export function buildEmbedSnippet(slug, orgName) {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "https://enrops.com";
  const src = `${origin}/${slug}/embed`;
  // We are writing code that runs on the OPERATOR'S site, so the listener is
  // defensive: it checks the message origin and range-clamps the height. Without
  // that, any other frame on their page (an ad tag, a chat widget) could post a
  // matching message and blow the registration iframe up to 200,000px, wrecking
  // their layout. Their site's stability is our responsibility here.
  // Comment carries the org name so an operator pasting into a page full of
  // other embeds can tell at a glance which block this is.
  return `<!-- ${orgName || "Registration"} — powered by enrops -->
<iframe
  src="${src}"
  title="Register"
  style="width:100%;border:0;min-height:600px"
  loading="lazy"
></iframe>
<script>
  window.addEventListener("message", function (e) {
    if (e.origin !== "${origin}") return;
    if (!e.data || e.data.type !== "enrops:height") return;
    var h = Number(e.data.height);
    if (!(h > 0 && h < 20000)) return;
    var f = document.querySelector('iframe[src="${src}"]');
    if (f) f.style.height = h + "px";
  });
</script>`;
}

export default function EmbedSnippet({ slug, orgName }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!slug) return null;
  const snippet = buildEmbedSnippet(slug, orgName);

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
    } catch (_) {
      // Clipboard can be blocked (permissions, http). The textarea below is
      // selectable, so the operator is never stuck — just tell the truth.
      setCopied(false);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div style={{ position: "relative" }}>
      {/* Visually distinct from "Share registration page" next to it. That one
          hands out a LINK (an action you take once, outward); this one hands out
          CODE for their own site. Same-looking outline buttons read as two
          flavours of the same thing, so this is a quieter tertiary control with
          a code glyph — different weight, different shape, different meaning. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Put your registration on your own website"
        style={{
          display: "inline-flex", alignItems: "center", gap: 7,
          padding: "9px 14px", borderRadius: 8,
          border: `1px dashed ${RULE_STRONG}`,
          background: "#FBFAFF", color: INK, fontSize: 14, fontWeight: 600,
          fontFamily: "inherit", cursor: "pointer", whiteSpace: "nowrap",
        }}
      >
        <span aria-hidden="true" style={{ fontFamily: "ui-monospace, Menlo, Consolas, monospace", color: BRIGHT, fontWeight: 700 }}>
          &lt;/&gt;
        </span>
        Add to your website
      </button>

      {open && (
        <div
          style={{
            position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: 40,
            width: "min(520px, 90vw)", background: "#fff", border: `1px solid ${RULE}`,
            borderRadius: 12, padding: 16, boxShadow: "0 12px 30px rgba(28,0,79,0.14)",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginBottom: 4 }}>
            Put registration on your own site
          </div>
          <p style={{ fontSize: 13, color: MUTED, lineHeight: 1.55, margin: "0 0 10px" }}>
            Paste this where you want your classes to appear. Families sign up
            without ever leaving your website, and it resizes itself to fit.
          </p>
          <textarea
            readOnly
            value={snippet}
            onFocus={(e) => e.target.select()}
            rows={9}
            style={{
              width: "100%", boxSizing: "border-box", fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              fontSize: 12, lineHeight: 1.5, color: INK, background: "#FBFBFB",
              border: `1px solid ${RULE}`, borderRadius: 8, padding: 10, resize: "vertical",
            }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
            <button
              type="button"
              onClick={copy}
              style={{
                padding: "8px 14px", borderRadius: 8, border: "none", background: BRIGHT,
                color: "#fff", fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
              }}
            >
              {copied ? "Copied" : "Copy code"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{
                padding: "8px 12px", borderRadius: 8, border: `1px solid ${RULE}`,
                background: "#fff", color: MUTED, fontSize: 13, fontWeight: 600,
                fontFamily: "inherit", cursor: "pointer",
              }}
            >
              Close
            </button>
            <span style={{ fontSize: 12, color: MUTED }}>
              Works with Squarespace, Wix, WordPress and most site builders.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
