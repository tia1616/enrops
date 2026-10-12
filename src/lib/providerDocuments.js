// Supabase calls for provider documents. The rules (validation, grouping, the
// columns to write) are in providerDocumentLogic.js; authority is the
// provider_documents RLS and the private provider-documents bucket.

import { supabase } from "./supabase";
import { storagePathFor, rowFromDraft } from "./providerDocumentLogic.js";

export const DOCUMENT_BUCKET = "provider-documents";
const SIGNED_URL_TTL = 60 * 10;

const LIST_COLUMNS =
  "id, organization_id, partner_id, doc_type, title, received_on, effective_on, expires_on, storage_path, original_filename, insurer, policy_number, abuse_coverage, coverage_notes, updated_at, expiry_status";

/** Every document this provider has on file, with its expiry status. */
export async function listProviderDocuments(orgId) {
  const { data, error } = await supabase
    .from("provider_documents_with_status")
    .select(LIST_COLUMNS)
    .eq("organization_id", orgId);
  if (error) throw error;
  return data ?? []; // ordered for display by groupByAudience
}

/**
 * All of the provider's partners, archived ones included: a document filed for a
 * partner that was later archived must still show that partner's name. The
 * "Shown to" picker offers only the active ones.
 */
export async function listPartners(orgId) {
  const { data, error } = await supabase
    .from("partners")
    .select("id, partner_name, inactive")
    .eq("organization_id", orgId)
    .order("partner_name", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/**
 * Remove one file and say whether it went. Storage's remove() never rejects: a
 * refusal, or a path it could not find, resolves with an error or an empty list.
 * Both are logged rather than swallowed, so a leftover file is at least visible
 * in the console. Only the provider's own owners/admins can read a file no row
 * points at, so a leftover is never exposed to anyone else.
 */
async function removeFile(path) {
  const { data, error } = await supabase.storage.from(DOCUMENT_BUCKET).remove([path]);
  const removed = !error && Array.isArray(data) && data.length > 0;
  if (!removed) console.error("[providerDocuments] file not removed", path, error?.message ?? "nothing matched");
  return removed;
}

async function uploadFile(orgId, file) {
  const path = storagePathFor(orgId, file, crypto.randomUUID());
  const { error } = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .upload(path, file, { upsert: false, contentType: file.type || undefined });
  if (error) throw error;
  return path;
}

/**
 * Add a document. The file goes up first (the row must point at a real object);
 * if the row is then refused, the orphaned file is removed again.
 */
export async function createProviderDocument(orgId, draft, file) {
  const path = await uploadFile(orgId, file);
  const { error } = await supabase.from("provider_documents").insert({
    organization_id: orgId,
    ...rowFromDraft(draft),
    storage_path: path,
    original_filename: file.name || null,
  });
  if (error) {
    await removeFile(path);
    throw error;
  }
}

/**
 * Edit a document, optionally replacing its file. A new file is uploaded and the
 * row repointed before the old file is removed, so the row never points at
 * nothing. Removing the old file is best effort (see removeFile).
 */
export async function updateProviderDocument(row, draft, file) {
  const patch = rowFromDraft(draft);
  let newPath = null;
  if (file) {
    newPath = await uploadFile(row.organization_id, file);
    patch.storage_path = newPath;
    patch.original_filename = file.name || null;
  }
  const { error } = await supabase.from("provider_documents").update(patch).eq("id", row.id);
  if (error) {
    if (newPath) await removeFile(newPath);
    throw error;
  }
  if (newPath && row.storage_path !== newPath) await removeFile(row.storage_path);
}

/**
 * Delete a document. The row goes first: once it is gone, partners and the rest
 * of the team can no longer open the file, so a failed file removal leaves it
 * readable only to the provider's own owners/admins (see removeFile).
 */
export async function deleteProviderDocument(row) {
  const { error } = await supabase.from("provider_documents").delete().eq("id", row.id);
  if (error) throw error;
  await removeFile(row.storage_path);
}

/**
 * Open a document in a new tab, from a click handler. The tab is opened
 * synchronously (so the browser doesn't treat it as a popup) and cut off from
 * this page before anything loads. Resolves null on success, or a sentence for
 * the person when it couldn't open. Shared by the admin screen and the partner
 * portal.
 */
export async function openDocumentInNewTab(storagePath) {
  const tab = window.open("", "_blank");
  if (!tab) return "Your browser blocked the new tab. Allow pop-ups for this site, then click Open again.";
  tab.opener = null;
  try {
    const url = await signedDocumentUrl(storagePath);
    if (!url) throw new Error("no link");
    tab.location.href = url;
    return null;
  } catch (err) {
    tab.close();
    return `Couldn't open that file: ${err?.message ?? "unknown error"}`;
  }
}

/** A short-lived link to open the file. */
export async function signedDocumentUrl(storagePath) {
  const { data, error } = await supabase.storage.from(DOCUMENT_BUCKET).createSignedUrl(storagePath, SIGNED_URL_TTL);
  if (error) throw error;
  return data?.signedUrl ?? null;
}
