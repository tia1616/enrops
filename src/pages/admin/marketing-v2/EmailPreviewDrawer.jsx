// EmailPreviewDrawer — right-side slide-in that shows the SERVER-rendered email
// (subject + full HTML body, exactly what a parent at the picked school/area
// receives). Lives here instead of inline in TouchpointCard so the tall email
// gets dedicated space while the operator keeps the campaign + editor in view.
//
// Pure presentation: the parent (TouchpointCard) owns the preview fetch and
// passes the rendered result down. Closes on Esc, backdrop click, or the X.

import { useEffect } from "react";
import { PURPLE, RULE, INK, MUTED } from "../marketing/tokens.jsx";

export default function EmailPreviewDrawer({
  open,
  onClose,
  schoolName,
  previewLabel,
  previewKind,
  subject,
  bodyHtml,
  loading = false,
  error = null,
  badges = [],
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Prefer the operator's picked audience entry (area or school) over the
  // server's representative school name, so an area preview reads "in Portland"
  // not "at Overlook House". Area → "in", school → "at".
  const headerName = previewLabel ?? schoolName;
  const previewHeader = headerName
    ? `As a parent ${previewKind === "area" ? "in" : "at"} ${headerName}`
    : "Rendered email";

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 80,
        background: "rgba(28,0,79,0.28)",
        display: "flex", justifyContent: "flex-end",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 560, height: "100%",
          background: "#fff",
          boxShadow: "-12px 0 40px rgba(0,0,0,0.18)",
          display: "flex", flexDirection: "column",
          borderTopLeftRadius: 12, borderBottomLeftRadius: 12,
        }}
      >
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 12, padding: "16px 18px", borderBottom: `1px solid ${RULE}`, flexShrink: 0,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>
              Email preview
            </div>
            <div style={{
              fontSize: 15, fontWeight: 700, color: PURPLE, lineHeight: 1.3, marginTop: 2,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {previewHeader}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close preview"
            style={{
              background: "transparent", border: "none", color: MUTED,
              fontSize: 24, lineHeight: 1, cursor: "pointer", fontFamily: "inherit", flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        <div style={{
          flex: 1, overflowY: "auto", padding: 18,
          display: "flex", flexDirection: "column", gap: 12, background: "#FBFBFB",
        }}>
          {badges.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {badges.map((b, i) => (
                <span key={i} style={{
                  fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5,
                  color: b.color, background: b.bg, padding: "2px 8px", borderRadius: 999,
                }}>
                  {b.label}
                </span>
              ))}
            </div>
          )}

          {error ? (
            <div style={{
              padding: "10px 12px", border: "1px solid #b3261e", borderRadius: 8,
              background: "#fce4ec", color: "#b3261e", fontSize: 13,
            }}>
              Preview failed: {error}
            </div>
          ) : loading ? (
            <div style={{ color: MUTED, fontSize: 13, padding: 12 }}>Rendering…</div>
          ) : (
            <>
              {subject && (
                <div style={{
                  padding: "10px 12px", border: `1px solid ${RULE}`, borderRadius: 8,
                  background: "#fff", fontSize: 13.5, color: INK,
                }}>
                  <span style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700, marginRight: 6 }}>
                    Subject
                  </span>
                  {subject}
                </div>
              )}
              {/* Server-rendered send-time output, isolated in an iframe so the
                  email's own styles don't collide with the admin app. */}
              <iframe
                title="email preview"
                srcDoc={bodyHtml}
                sandbox="allow-popups allow-popups-to-escape-sandbox"
                style={{
                  width: "100%", flex: 1, minHeight: 520,
                  border: `1px solid ${RULE}`, borderRadius: 8, background: "#fff",
                }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
