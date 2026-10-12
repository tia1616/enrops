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
    .eq("organization_id", orgId)
    .order("expires_on", { ascending: true, nullsFirst: false });
  if (error) throw error;
  return data ?? [];
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
    await supabase.storage.from(DOCUMENT_BUCKET).remove([path]).catch(() => {});
    throw error;
  }
}

/**
 * Edit a document, optionally replacing its file. A new file is uploaded and the
 * row repointed before the old file is removed, so the row never points at
 * nothing. Removing the old file is best effort: if it fails, the leftover is
 * unreadable anyway (the bucket only signs files a row points at).
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
    if (newPath) await supabase.storage.from(DOCUMENT_BUCKET).remove([newPath]).catch(() => {});
    throw error;
  }
  if (newPath && row.storage_path !== newPath) {
    await supabase.storage.from(DOCUMENT_BUCKET).remove([row.storage_path]).catch(() => {});
  }
}

/**
 * Delete a document. The row goes first: once it is gone no one can open the
 * file (the bucket only signs files a row points at), so a failed file removal
 * leaves nothing readable behind.
 */
export async function deleteProviderDocument(row) {
  const { error } = await supabase.from("provider_documents").delete().eq("id", row.id);
  if (error) throw error;
  await supabase.storage.from(DOCUMENT_BUCKET).remove([row.storage_path]).catch(() => {});
}

/** A short-lived link to open the file. */
export async function signedDocumentUrl(storagePath) {
  const { data, error } = await supabase.storage.from(DOCUMENT_BUCKET).createSignedUrl(storagePath, SIGNED_URL_TTL);
  if (error) throw error;
  return data?.signedUrl ?? null;
}
