// Share affordance for a single program: a button that opens a small panel
// with the registration link (copyable), a QR code preview, a high-res PNG
// download for flyers, and a "preview the page" link.
//
// Reused in three spots so the logic lives in ONE place: the program list's
// expanded panel, the roster page header, and the wizard success screen.
//
// Guardrail: a program only has a working public link once it's published
// (status === "open"). Drafts show a "publish first" message instead of a
// dead URL — eat-the-cooking, the link we hand over actually resolves.

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { buildRegUrl } from "../lib/regLinks.js";

const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const OK_GREEN = "#3a7c3a";
const AMBER = "#a16207";

const QR_DARK = "#1a1a1a";
const QR_LIGHT = "#ffffff";

function fileSlug(name) {
  const s = (name || "program")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "program";
}

export default function ShareProgram({ slug, program, align = "right" }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const previewRef = useRef(null);

  const isPublished = program?.status === "open";
  const url = slug ? buildRegUrl(slug, program?.id) : "";

  // Render the preview QR each time the panel opens with a live URL.
  useEffect(() => {
    if (!open || !isPublished || !url || !previewRef.current) return;
    QRCode.toCanvas(previewRef.current, url, {
      width: 148,
      margin: 2, // quiet zone
      errorCorrectionLevel: "Q", // survives a logo overlay later
      color: { dark: QR_DARK, light: QR_LIGHT },
    }).catch(() => {});
  }, [open, isPublished, url]);

  function copyLink() {
    if (!url) return;
    navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => {
        /* clipboard blocked — leave the field for manual copy */
      },
    );
  }

  async function downloadQr() {
    if (!url) return;
    try {
      const dataUrl = await QRCode.toDataURL(url, {
        width: 1024, // high-res for print flyers
        margin: 4,
        errorCorrectionLevel: "Q",
        color: { dark: QR_DARK, light: QR_LIGHT },
      });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `register-${fileSlug(program?.curriculum)}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      /* generation failed — nothing to download */
    }
  }

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Get the registration link and QR code to share"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: open ? BRIGHT : "transparent",
          color: open ? "#fff" : BRIGHT,
          border: `1px solid ${BRIGHT}`,
          padding: "7px 14px",
          borderRadius: 6,
          fontSize: 12.5,
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: "pointer",
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.6" y1="10.5" x2="15.4" y2="6.6" />
          <line x1="8.6" y1="13.4" x2="15.4" y2="17.5" />
        </svg>
        Share
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            [align]: 0,
            zIndex: 40,
            width: 322,
            background: "#fff",
            border: `1px solid ${RULE}`,
            borderRadius: 10,
            boxShadow: "0 8px 28px rgba(0,0,0,0.12)",
            padding: 16,
            textAlign: "left",
          }}
        >
          {!isPublished ? (
            <div style={{ fontSize: 13, color: INK, lineHeight: 1.55 }}>
              <strong style={{ color: AMBER }}>Not live yet.</strong> Publish this
              program first and you'll get a shareable registration link and QR
              code here. Families can only sign up once it's open.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
                Registration link
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                <input
                  readOnly
                  value={url}
                  onFocus={(e) => e.target.select()}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: "7px 9px",
                    fontSize: 12,
                    color: INK,
                    border: `1px solid ${RULE}`,
                    borderRadius: 6,
                    fontFamily: "inherit",
                    background: "#faf9f6",
                  }}
                />
                <button
                  type="button"
                  onClick={copyLink}
                  style={{
                    flexShrink: 0,
                    background: copied ? OK_GREEN : BRIGHT,
                    color: "#fff",
                    border: "none",
                    padding: "0 13px",
                    borderRadius: 6,
                    fontSize: 12.5,
                    fontWeight: 700,
                    fontFamily: "inherit",
                    cursor: "pointer",
                  }}
                >
                  {copied ? "✓ Copied" : "Copy"}
                </button>
              </div>

              <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
                <canvas
                  ref={previewRef}
                  width={148}
                  height={148}
                  style={{ border: `1px solid ${RULE}`, borderRadius: 8, flexShrink: 0 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: INK, fontWeight: 600, marginBottom: 2 }}>QR code</div>
                  <div style={{ fontSize: 11.5, color: MUTED, lineHeight: 1.45, marginBottom: 8 }}>
                    Put it on a flyer, in an email, or in an ad — families scan to register.
                  </div>
                  <button
                    type="button"
                    onClick={downloadQr}
                    style={{
                      background: "transparent",
                      color: BRIGHT,
                      border: `1px solid ${BRIGHT}`,
                      padding: "6px 12px",
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 600,
                      fontFamily: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    Download PNG
                  </button>
                </div>
              </div>

              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                style={{ display: "inline-block", marginTop: 14, fontSize: 12, color: BRIGHT, textDecoration: "none", fontWeight: 600 }}
              >
                Preview the registration page ↗
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}
