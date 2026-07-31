// Generic "share a link" affordance: a button that opens a small panel with a
// copyable link, a QR preview, a high-res PNG download for flyers, and a page
// preview. Used for BOTH a single program's registration deep link and the
// tenant's whole registration catalog — the copy/QR/download logic lives here
// once.
//
// Pass disabled + disabledNode to show a guidance message instead of a dead
// link (e.g. an unpublished program has no working link yet).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import QRCode from "qrcode";

const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const OK_GREEN = "#3a7c3a";

const QR_DARK = "#1a1a1a";
const QR_LIGHT = "#ffffff";

// Breathing room between the share panel and the edge of the screen.
const GUTTER = 8;

export default function ShareLink({
  url,
  buttonLabel = "Share",
  panelTitle = "Registration link",
  description = "Put it on a flyer, in an email, or in an ad — families scan to register.",
  qrFileBase = "registration",
  align = "right",
  disabled = false,
  disabledNode = null,
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const previewRef = useRef(null);
  const containerRef = useRef(null);
  const panelRef = useRef(null);
  // Horizontal correction applied to keep the panel on screen. See the layout
  // effect below.
  const [shiftX, setShiftX] = useState(0);

  const active = !disabled && !!url;

  // Close the panel on an outside click or Escape — otherwise it stays pinned
  // open when the operator clicks elsewhere (e.g. switches the term dropdown).
  useEffect(() => {
    if (!open) return;
    function onDocPointer(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Render the preview QR each time the panel opens with a live URL.
  useEffect(() => {
    if (!open || !active || !previewRef.current) return;
    QRCode.toCanvas(previewRef.current, url, {
      width: 148,
      margin: 2, // quiet zone
      errorCorrectionLevel: "Q", // survives a logo overlay later
      color: { dark: QR_DARK, light: QR_LIGHT },
    }).catch(() => {});
  }, [open, active, url]);

  // Keep the panel inside the viewport.
  //
  // The panel is absolutely positioned against the trigger button and is a
  // fixed 322px wide, so on a phone it runs off whichever edge it is anchored
  // toward: align="right" overflows to the left, align="left" overflows to the
  // right. BOTH are in use — ProgramsCalendar passes "right" for the page-level
  // share and "left" for the per-program one — which is why the QR was getting
  // cut off in admin on a phone. A CSS-only fix can't do this: the element has
  // no idea where it sits in the viewport. So measure after paint and nudge.
  useLayoutEffect(() => {
    if (!open) {
      setShiftX(0);
      return;
    }
    function clamp() {
      const el = panelRef.current;
      if (!el) return;
      // Measure the panel's NATURAL position by clearing any correction first.
      // An earlier version instead subtracted the previous shift inside a
      // functional setState, which is wrong under rapid resize: two clamp()
      // calls can both measure the same painted box (React has not re-rendered
      // between them) while the second updater receives the FIRST one's result
      // as `prev` — so it subtracts a shift the DOM never applied and the panel
      // jumps sideways. This runs in useLayoutEffect, before paint, so the
      // reset is never visible.
      el.style.transform = "none";
      const rect = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      let next = 0;
      if (rect.right > vw - GUTTER) next = vw - GUTTER - rect.right;
      // Pulling it off the right edge can push it off the left. Left wins: a
      // panel whose start is off-screen is unreadable, and the QR sits at the
      // start.
      if (rect.left + next < GUTTER) next = GUTTER - rect.left;
      // Apply immediately so the corrected position is what paints, then keep
      // React's style prop in sync so an unrelated re-render (the Copy button
      // flipping to "Copied") cannot drop the correction.
      el.style.transform = next ? `translateX(${next}px)` : "";
      setShiftX(next);
    }
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [open, active]);

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
      a.download = `${qrFileBase}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      /* generation failed — nothing to download */
    }
  }

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Get the link and QR code to share"
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
          whiteSpace: "nowrap",
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.6" y1="10.5" x2="15.4" y2="6.6" />
          <line x1="8.6" y1="13.4" x2="15.4" y2="17.5" />
        </svg>
        {buttonLabel}
      </button>

      {open && (
        <div
          ref={panelRef}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            [align]: 0,
            zIndex: 40,
            // Never wider than the screen it has to fit on. The shift below
            // handles WHERE it sits; this handles a phone narrower than the
            // panel itself.
            width: `min(322px, calc(100vw - ${GUTTER * 2}px))`,
            transform: shiftX ? `translateX(${shiftX}px)` : undefined,
            background: "#fff",
            border: `1px solid ${RULE}`,
            borderRadius: 10,
            boxShadow: "0 8px 28px rgba(0,0,0,0.12)",
            padding: 16,
            textAlign: "left",
          }}
        >
          {!active ? (
            disabledNode ?? (
              <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.55 }}>No link to share yet.</div>
            )
          ) : (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
                {panelTitle}
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
                    {description}
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
