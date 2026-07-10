// AttachmentPicker — shared "attach a file" surface for the Comms composers
// (campaign TouchpointCard, AutomationEditor, saved-template editor).
//
// Model: the parent holds `emailAttachments` = [{ id, attach }]. A file added
// here appears as a branded **Download button at the bottom of the email**
// (rendered by the send/preview, never a token in the body). When allowAttach is
// on (automations), a per-file "Also attach the file itself" checkbox rides the
// raw file along too. No cursor games, no {{ }} tokens, no UUIDs shown.

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
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  // Map id -> {id, attach} for the files included in this email.
  const included = new Map((emailAttachments || []).map((e) => [e.id, e]));

  useEffect(() => {
    let alive = true;
    if (!orgId) return;
    setLoading(true);
    listCommsAttachments(orgId)
      .then((rows) => { if (alive) setFiles(rows); })
      .catch((e) => { if (alive) setError(e?.message ?? "Couldn't load your files."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [orgId]);

  function emit(next) {
    onChange?.(next);
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (inputRef.current) inputRef.current.value = "";
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const row = await uploadCommsAttachment({ file, orgId, userId });
      setFiles((prev) => [row, ...prev]);
      // Newly uploaded files are added to the email by default (that's why you uploaded them).
      emit([...(emailAttachments || []), { id: row.id, attach: false }]);
    } catch (err) {
      setError(err?.message ?? "Upload failed — try again.");
    } finally {
      setUploading(false);
    }
  }

  function toggleInclude(id) {
    if (included.has(id)) {
      emit((emailAttachments || []).filter((e) => e.id !== id));
    } else {
      emit([...(emailAttachments || []), { id, attach: false }]);
    }
  }

  function toggleAttach(id) {
    emit((emailAttachments || []).map((e) => (e.id === id ? { ...e, attach: !e.attach } : e)));
  }

  async function handleArchive(id, name) {
    if (!window.confirm(
      `Remove "${name}" from your files?\n\nAny email using it will lose its download button. Emails already sent are unaffected.`
    )) return;
    setError(null);
    try {
      await archiveCommsAttachment(id);
      setFiles((prev) => prev.filter((f) => f.id !== id));
      if (included.has(id)) emit((emailAttachments || []).filter((e) => e.id !== id));
    } catch (err) {
      setError(err?.message ?? "Couldn't remove that file.");
    }
  }

  const addedCount = (emailAttachments || []).length;

  return (
    <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px" }}>
        <div>
          <span style={{ fontSize: 12, fontWeight: 700, color: INK, textTransform: "uppercase", letterSpacing: 1 }}>
            Attachments
          </span>
          <span style={{ fontSize: 12, color: MUTED, fontWeight: 400, marginLeft: 8 }}>
            {addedCount === 0 ? "none on this email" : `${addedCount} on this email`}
          </span>
        </div>
        <label
          style={{
            fontSize: 13, fontWeight: 600, color: "#fff", background: primaryColor,
            padding: "6px 12px", borderRadius: 6, cursor: uploading ? "wait" : "pointer",
            opacity: uploading ? 0.7 : 1,
          }}
        >
          {uploading ? "Uploading…" : "＋ Upload a file"}
          <input ref={inputRef} type="file" onChange={handleUpload} disabled={uploading} style={{ display: "none" }} />
        </label>
      </div>

      {error && (
        <p style={{ margin: 0, padding: "0 12px 10px", fontSize: 12, color: WARN, lineHeight: 1.4 }}>{error}</p>
      )}

      <div style={{ borderTop: `1px solid ${RULE}`, padding: "8px 12px 12px" }}>
        {loading ? (
          <p style={{ margin: "6px 0", fontSize: 13, color: MUTED }}>Loading your files…</p>
        ) : files.length === 0 ? (
          <p style={{ margin: "6px 0", fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
            No files yet. Upload a PDF, flyer, or schedule to add it to this email.
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {files.map((f) => {
              const inEmail = included.has(f.id);
              const attached = !!included.get(f.id)?.attach;
              return (
                <li
                  key={f.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                    padding: "8px 10px", border: `1px solid ${inEmail ? primaryColor : RULE}`,
                    borderRadius: 6, background: inEmail ? "#faf9fc" : "#fff",
                  }}
                >
                  <label style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 200px", minWidth: 0, cursor: "pointer" }}>
                    <input type="checkbox" checked={inEmail} onChange={() => toggleInclude(f.id)} />
                    <span aria-hidden="true">📎</span>
                    <span style={{ minWidth: 0, fontSize: 13, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {f.title?.trim() || f.file_name}
                      <span style={{ color: MUTED, fontWeight: 400 }}> · {formatBytes(f.byte_size)}</span>
                    </span>
                  </label>
                  {inEmail && allowAttach && (
                    <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: MUTED, cursor: "pointer" }}>
                      <input type="checkbox" checked={attached} onChange={() => toggleAttach(f.id)} />
                      Also attach the file
                    </label>
                  )}
                  <button
                    type="button"
                    onClick={() => handleArchive(f.id, f.title?.trim() || f.file_name)}
                    style={{ fontSize: 12, color: MUTED, background: "transparent", border: "none", cursor: "pointer" }}
                    title="Remove from your library"
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p style={{ margin: "10px 0 0", fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
          Files you add show as a <strong>Download button at the bottom of your email</strong> — you'll see it in the preview.
          {allowAttach && <> Tick <strong>Also attach the file</strong> to send the file itself too (under 15 MB).</>}
        </p>
      </div>
    </div>
  );
}
