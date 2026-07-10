// AttachmentPicker — shared "attach a file" surface for the Comms composers
// (campaign TouchpointCard, AutomationEditor, saved-template editor).
//
// Shows ONLY the files on THIS email (parent holds `emailAttachments` =
// [{ id, attach }]). "Add a file" opens a small picker to reuse a library file
// or upload a new one — so a file is never shown as "attached" on an email it
// isn't on (the library is not dumped into every composer). Each file on the
// email renders as a Download button at the bottom of the sent email; with
// allowAttach on (automations), "Also attach the file" rides the raw file along.

import { useEffect, useRef, useState } from "react";
import {
  listCommsAttachments,
  uploadCommsAttachment,
  archiveCommsAttachment,
  formatBytes,
} from "../../../lib/commsAttachments.js";

const INK = "#221C3A";
const MUTED = "#6b6880";
const RULE = "#e7e5ee";
const WARN = "#b3261e";

export default function AttachmentPicker({
  orgId,
  userId = null,
  emailAttachments = [],
  onChange,
  allowAttach = false,
  primaryColor = "#4f3ec8",
}) {
  const [library, setLibrary] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [picking, setPicking] = useState(false); // "Add a file" panel open?
  const inputRef = useRef(null);

  const byId = new Map(library.map((f) => [f.id, f]));
  const onEmail = (emailAttachments || []); // [{id, attach}]
  const onEmailIds = new Set(onEmail.map((e) => e.id));
  const libraryNotOnEmail = library.filter((f) => !onEmailIds.has(f.id));

  useEffect(() => {
    let alive = true;
    if (!orgId) return;
    setLoading(true);
    listCommsAttachments(orgId)
      .then((rows) => { if (alive) setLibrary(rows); })
      .catch((e) => { if (alive) setError(e?.message ?? "Couldn't load your files."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [orgId]);

  function addToEmail(id) {
    if (onEmailIds.has(id)) return;
    onChange?.([...onEmail, { id, attach: false }]);
    setPicking(false);
  }
  function removeFromEmail(id) {
    onChange?.(onEmail.filter((e) => e.id !== id));
  }
  function toggleAttach(id) {
    onChange?.(onEmail.map((e) => (e.id === id ? { ...e, attach: !e.attach } : e)));
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (inputRef.current) inputRef.current.value = "";
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const row = await uploadCommsAttachment({ file, orgId, userId });
      setLibrary((prev) => [row, ...prev]);
      onChange?.([...onEmail, { id: row.id, attach: false }]); // a just-uploaded file goes on this email
      setPicking(false);
    } catch (err) {
      setError(err?.message ?? "Upload failed — try again.");
    } finally {
      setUploading(false);
    }
  }

  async function handleArchive(id, name) {
    if (!window.confirm(`Delete "${name}" from your files for good? Any email using it loses its download button.`)) return;
    setError(null);
    try {
      await archiveCommsAttachment(id);
      setLibrary((prev) => prev.filter((f) => f.id !== id));
      if (onEmailIds.has(id)) removeFromEmail(id);
    } catch (err) {
      setError(err?.message ?? "Couldn't delete that file.");
    }
  }

  const btn = { fontSize: 13, fontWeight: 600, borderRadius: 6, padding: "6px 12px", cursor: "pointer" };

  return (
    <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, background: "#fff", padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: onEmail.length || picking ? 8 : 0 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: INK, textTransform: "uppercase", letterSpacing: 1 }}>
          Attachments
        </span>
        {!picking && (
          <button type="button" onClick={() => setPicking(true)} style={{ ...btn, color: "#fff", background: primaryColor, border: "none" }}>
            ＋ Add a file
          </button>
        )}
      </div>

      {error && <p style={{ margin: "0 0 8px", fontSize: 12, color: WARN, lineHeight: 1.4 }}>{error}</p>}

      {/* Files ON this email */}
      {onEmail.length === 0 && !picking ? (
        <p style={{ margin: 0, fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
          No files on this email. Add a PDF, flyer, or schedule — it shows as a Download button at the bottom.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {onEmail.map((e) => {
            const f = byId.get(e.id);
            return (
              <li key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 10px", border: `1px solid ${primaryColor}`, borderRadius: 6, background: "#faf9fc" }}>
                <span aria-hidden="true">📎</span>
                <span style={{ flex: "1 1 160px", minWidth: 0, fontSize: 13, color: f || loading ? INK : WARN, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {loading ? "…" : f ? (f.title?.trim() || f.file_name) : "This file was deleted — remove it"}
                  {f && <span style={{ color: MUTED, fontWeight: 400 }}> · {formatBytes(f.byte_size)}</span>}
                </span>
                {allowAttach && (
                  <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: MUTED, cursor: "pointer" }}>
                    <input type="checkbox" checked={!!e.attach} onChange={() => toggleAttach(e.id)} />
                    Also attach the file
                  </label>
                )}
                <button type="button" onClick={() => removeFromEmail(e.id)} style={{ fontSize: 12, color: MUTED, background: "transparent", border: "none", cursor: "pointer" }}>
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Add-a-file panel: reuse a library file or upload a new one */}
      {picking && (
        <div style={{ marginTop: 10, border: `1px dashed ${RULE}`, borderRadius: 6, padding: "10px 12px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6 }}>Add a file</span>
            <div style={{ display: "flex", gap: 8 }}>
              <label style={{ ...btn, color: "#fff", background: primaryColor, opacity: uploading ? 0.7 : 1 }}>
                {uploading ? "Uploading…" : "Upload new"}
                <input ref={inputRef} type="file" onChange={handleUpload} disabled={uploading} style={{ display: "none" }} />
              </label>
              <button type="button" onClick={() => setPicking(false)} style={{ ...btn, color: INK, background: "#fff", border: `1px solid ${RULE}` }}>Done</button>
            </div>
          </div>
          {loading ? (
            <p style={{ margin: 0, fontSize: 13, color: MUTED }}>Loading your files…</p>
          ) : libraryNotOnEmail.length === 0 ? (
            <p style={{ margin: 0, fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
              {library.length === 0 ? "No files in your library yet — upload one." : "All your files are already on this email."}
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {libraryNotOnEmail.map((f) => (
                <li key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6 }}>
                  <span aria-hidden="true">📎</span>
                  <span style={{ flex: "1 1 auto", minWidth: 0, fontSize: 13, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {f.title?.trim() || f.file_name}<span style={{ color: MUTED, fontWeight: 400 }}> · {formatBytes(f.byte_size)}</span>
                  </span>
                  <button type="button" onClick={() => addToEmail(f.id)} style={{ ...btn, color: primaryColor, background: "#fff", border: `1px solid ${primaryColor}`, padding: "3px 10px" }}>Add</button>
                  <button type="button" onClick={() => handleArchive(f.id, f.title?.trim() || f.file_name)} title="Delete from your files" style={{ fontSize: 14, color: MUTED, background: "transparent", border: "none", cursor: "pointer" }}>×</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(onEmail.length > 0 || picking) && (
        <p style={{ margin: "10px 0 0", fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
          Files on this email show as a <strong>Download button at the bottom</strong> — you'll see it in the preview.
          {allowAttach && <> Tick <strong>Also attach the file</strong> to send the file itself too (under 15 MB).</>}
        </p>
      )}
    </div>
  );
}
