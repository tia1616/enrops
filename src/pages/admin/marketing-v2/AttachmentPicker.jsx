// AttachmentPicker — shared "attach a file" surface for the Comms composers
// (campaign TouchpointCard, AutomationEditor, saved-template editor).
//
// Manages the per-org file library inline: list, upload, archive. Per file it
// offers two independent actions, matching the two ways an email uses a file:
//   - "Insert download link" -> calls onInsertToken({{attachment:<id>}}) so the
//     composer drops the marker at the cursor; the send renders a Download button.
//   - "Attach to email" toggle -> adds/removes the id in attachmentIds (the raw
//     file rides in the email). Opt-in; hidden when allowTrueAttach is false.
//
// The default, recommended path is the download LINK (tracked, best deliverability,
// no size worry) — same as Mailchimp/HubSpot. True-attach is the opt-in.

import { useEffect, useRef, useState } from "react";
import {
  listCommsAttachments,
  uploadCommsAttachment,
  archiveCommsAttachment,
  attachmentToken,
  formatBytes,
} from "../../../lib/commsAttachments.js";

const INK = "#221C3A";
const MUTED = "#6b6880";
const RULE = "#e7e5ee";
const WARN = "#b3261e";

export default function AttachmentPicker({
  orgId,
  userId = null,
  attachmentIds = [],
  onChangeAttachmentIds,
  onInsertToken,
  allowTrueAttach = true,
  primaryColor = "#4f3ec8",
}) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef(null);

  const attachedSet = new Set(attachmentIds || []);

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

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (inputRef.current) inputRef.current.value = ""; // allow re-picking the same file
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const row = await uploadCommsAttachment({ file, orgId, userId });
      setFiles((prev) => [row, ...prev]);
      setExpanded(true);
    } catch (err) {
      setError(err?.message ?? "Upload failed — try again.");
    } finally {
      setUploading(false);
    }
  }

  function toggleAttach(id) {
    if (!onChangeAttachmentIds) return;
    const next = attachedSet.has(id)
      ? (attachmentIds || []).filter((x) => x !== id)
      : [...(attachmentIds || []), id];
    onChangeAttachmentIds(next);
  }

  async function handleArchive(id, name) {
    if (!window.confirm(
      `Remove "${name}" from your files?\n\nIf you added it as a download button in any campaign or automation, that button will stop working. Emails already sent are unaffected.`
    )) return;
    setError(null);
    try {
      await archiveCommsAttachment(id);
      setFiles((prev) => prev.filter((f) => f.id !== id));
      if (attachedSet.has(id) && onChangeAttachmentIds) {
        onChangeAttachmentIds((attachmentIds || []).filter((x) => x !== id));
      }
    } catch (err) {
      setError(err?.message ?? "Couldn't remove that file.");
    }
  }

  const count = files.length;

  return (
    <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px" }}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 8 }}
        >
          <span aria-hidden="true" style={{ color: MUTED, fontSize: 13 }}>{expanded ? "▾" : "▸"}</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: INK, textTransform: "uppercase", letterSpacing: 1 }}>
            Attachments
          </span>
          <span style={{ fontSize: 12, color: MUTED, fontWeight: 400 }}>
            {count === 0 ? "none yet" : `${count} file${count === 1 ? "" : "s"} in your library`}
            {attachmentIds?.length ? ` · ${attachmentIds.length} attached to this email` : ""}
          </span>
        </button>
        <label
          style={{
            fontSize: 13, fontWeight: 600, color: "#fff", background: primaryColor,
            padding: "6px 12px", borderRadius: 6, cursor: uploading ? "wait" : "pointer",
            opacity: uploading ? 0.7 : 1,
          }}
        >
          {uploading ? "Uploading…" : "＋ Upload a file"}
          <input
            ref={inputRef}
            type="file"
            onChange={handleUpload}
            disabled={uploading}
            style={{ display: "none" }}
          />
        </label>
      </div>

      {error && (
        <p style={{ margin: 0, padding: "0 12px 10px", fontSize: 12, color: WARN, lineHeight: 1.4 }}>{error}</p>
      )}

      {expanded && (
        <div style={{ borderTop: `1px solid ${RULE}`, padding: "8px 12px 12px" }}>
          {loading ? (
            <p style={{ margin: "6px 0", fontSize: 13, color: MUTED }}>Loading your files…</p>
          ) : count === 0 ? (
            <p style={{ margin: "6px 0", fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
              No files yet. Upload a PDF, flyer, or schedule, then add it as a download button in your message.
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              {files.map((f) => {
                const isAttached = attachedSet.has(f.id);
                return (
                  <li
                    key={f.id}
                    style={{
                      display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                      padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 6, background: "#faf9fc",
                    }}
                  >
                    <span aria-hidden="true">📎</span>
                    <span style={{ flex: "1 1 160px", minWidth: 0, fontSize: 13, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {f.title?.trim() || f.file_name}
                      <span style={{ color: MUTED, fontWeight: 400 }}> · {formatBytes(f.byte_size)}</span>
                    </span>
                    {onInsertToken && (
                      <button
                        type="button"
                        onClick={() => onInsertToken(attachmentToken(f.id))}
                        style={{
                          fontSize: 12, fontWeight: 600, color: primaryColor, background: "#fff",
                          border: `1px solid ${primaryColor}`, borderRadius: 6, padding: "4px 10px", cursor: "pointer",
                        }}
                        title="Insert a Download button for this file at your cursor"
                      >
                        Insert download link
                      </button>
                    )}
                    {allowTrueAttach && onChangeAttachmentIds && (
                      <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: MUTED, cursor: "pointer" }}>
                        <input type="checkbox" checked={isAttached} onChange={() => toggleAttach(f.id)} />
                        Attach to email
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
            <strong>Insert download link</strong> adds a tracked Download button in your message — best for flyers and schedules.
            {allowTrueAttach && <> <strong>Attach to email</strong> sends the file itself (under 15 MB).</>}
          </p>
        </div>
      )}
    </div>
  );
}
