// The photo grid and full-size viewer shared by the instructor, family and admin
// surfaces. Presentation only: it is handed rows and signed URLs and reports
// clicks; it never decides who may see or do anything.

import { useEffect, useState } from "react";
import { saveClassPhoto } from "../lib/classPhotos.js";

const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const BRIGHT = "#5847C9";

export function PhotoGrid({ photos, urls, onOpen, badge }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))", gap: 6 }}>
      {photos.map((p) => {
        const url = urls[p.storage_path];
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onOpen(p)}
            aria-label="Open photo"
            style={{ position: "relative", padding: 0, border: `1px solid ${RULE}`, borderRadius: 8, overflow: "hidden", background: "#f1efe8", aspectRatio: "1 / 1", cursor: "pointer" }}
          >
            {url ? (
              <img src={url} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            ) : (
              <span style={{ fontSize: 11, color: MUTED }}>Loading...</span>
            )}
            {badge?.(p) && (
              <span style={{ position: "absolute", left: 4, top: 4, background: "#b0413e", color: "#fff", fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4 }}>
                {badge(p)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * actions: [{ label, onClick(photo), danger?, confirm? }]. `confirm` is a sentence
 * shown inline before the action runs, so a destructive tap is never one tap.
 */
export function PhotoLightbox({ photo, url, onClose, actions = [] }) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // an action awaiting its confirm
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!photo) return null;

  async function run(a) {
    setBusy(true);
    setMsg("");
    try {
      await a.onClick(photo);
      setPending(null);
    } catch (e) {
      console.error("[PhotoLightbox] action failed", e);
      setMsg("That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setMsg("");
    try {
      await saveClassPhoto(url, `class-photo-${photo.session_date}.jpg`);
    } catch {
      setMsg("Couldn't save the photo. Press and hold it to save instead.");
    } finally {
      setBusy(false);
    }
  }

  const btn = { padding: "9px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: busy ? "default" : "pointer", border: `1px solid ${RULE}`, background: "#fff", color: INK };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Class photo"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(10,6,24,.86)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16 }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: 960, width: "100%", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
        {url ? (
          <img src={url} alt="" style={{ maxWidth: "100%", maxHeight: "70vh", borderRadius: 8, background: "#000" }} />
        ) : (
          <div style={{ color: "#fff" }}>Loading...</div>
        )}
        {pending ? (
          <div style={{ background: "#fff", borderRadius: 8, padding: 12, maxWidth: 460, fontSize: 13, color: INK }}>
            <div style={{ marginBottom: 10, lineHeight: 1.5 }}>{pending.confirm}</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" disabled={busy} onClick={() => setPending(null)} style={btn}>Cancel</button>
              <button type="button" disabled={busy} onClick={() => run(pending)} style={{ ...btn, background: pending.danger ? "#b0413e" : BRIGHT, color: "#fff", border: "none" }}>
                {busy ? "Working..." : pending.label}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            {url && <button type="button" disabled={busy} onClick={save} style={{ ...btn, background: BRIGHT, color: "#fff", border: "none" }}>Save photo</button>}
            {actions.map((a) => (
              <button key={a.label} type="button" disabled={busy} onClick={() => (a.confirm ? setPending(a) : run(a))} style={{ ...btn, color: a.danger ? "#b0413e" : INK }}>
                {a.label}
              </button>
            ))}
            <button type="button" onClick={onClose} style={btn}>Close</button>
          </div>
        )}
        {msg && <div style={{ color: "#ffd9d6", fontSize: 13 }}>{msg}</div>}
      </div>
    </div>
  );
}
