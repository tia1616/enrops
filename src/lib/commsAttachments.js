// commsAttachments — per-org file library for email attachments.
//
// Files live in the PUBLIC `comms-attachments` bucket under {org.id}/attachments/,
// each path carrying the row's random uuid so the public URL is unguessable
// (matches how Mailchimp/HubSpot host download links). A comms_attachments row
// holds the metadata. Two ways an email uses a file:
//   - LINK:   drop the {{attachment:<id>}} token in the body -> Download button
//             (rendered by the send edge fn via _shared/attachments.ts).
//   - ATTACH: put the id in the row's attachment_ids[] -> the raw file rides in
//             the email (base64). Opt-in; 15 MB cap for deliverability.
//
// Writes go direct from the client (RLS: can_admin_org gates the table; the
// {org.id}/ storage-folder policy gates the bucket), mirroring the curriculum-doc
// and logo upload patterns.

import { supabase } from "./supabase.js";

export const COMMS_ATTACHMENTS_BUCKET = "comms-attachments";

// Keep in lockstep with MAX_ATTACH_TOTAL_BYTES in _shared/attachments.ts. A file
// bigger than this can be uploaded to the library but would be skipped from a
// true-attach send, so we block it at upload to avoid a silent surprise.
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

const SELECT_COLS = "id, file_name, storage_path, byte_size, content_type, title, created_at";

/** The body marker that renders to a Download button for this file. */
export function attachmentToken(id) {
  return `{{attachment:${id}}}`;
}

/** Permanent public URL for a library file (public bucket). */
export function attachmentPublicUrl(storagePath) {
  return supabase.storage.from(COMMS_ATTACHMENTS_BUCKET).getPublicUrl(storagePath).data.publicUrl;
}

/** Active (non-archived) library files for an org, newest first. */
export async function listCommsAttachments(orgId) {
  if (!orgId) return [];
  const { data, error } = await supabase
    .from("comms_attachments")
    .select(SELECT_COLS)
    .eq("organization_id", orgId)
    .is("archived_at", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** Upload a file to the library. Rolls back the storage object if the row insert fails. */
export async function uploadCommsAttachment({ file, orgId, userId, title }) {
  if (!file) throw new Error("No file selected.");
  if (!orgId) throw new Error("Missing organization.");
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB. Email attachments must be under ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB — for a bigger file, share a link instead.`,
    );
  }
  const id = crypto.randomUUID();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${orgId}/attachments/${id}-${safeName}`;
  const { error: upErr } = await supabase.storage
    .from(COMMS_ATTACHMENTS_BUCKET)
    .upload(path, file, { upsert: false, contentType: file.type || undefined });
  if (upErr) throw new Error(`Couldn't upload ${file.name}: ${upErr.message}`);
  const { data: row, error: insErr } = await supabase
    .from("comms_attachments")
    .insert({
      id,
      organization_id: orgId,
      file_name: file.name,
      storage_path: path,
      byte_size: file.size,
      content_type: file.type || "application/octet-stream",
      title: title?.trim() || null,
      uploaded_by: userId ?? null,
    })
    .select(SELECT_COLS)
    .single();
  if (insErr || !row) {
    // Don't orphan the storage object when the DB insert fails.
    await supabase.storage.from(COMMS_ATTACHMENTS_BUCKET).remove([path]).catch(() => {});
    throw new Error(`Couldn't save ${file.name}: ${insErr?.message ?? "no row returned"}`);
  }
  return row;
}

/** Soft-archive a library file (hidden from the picker; send history stays intact). */
export async function archiveCommsAttachment(id) {
  const { error } = await supabase
    .from("comms_attachments")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/** Human-friendly size label. */
export function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
