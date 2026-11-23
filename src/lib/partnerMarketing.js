// Marketing on the partner portal (20261123r): reads and writes for the
// partner's asks, its logo and each class's flyer / social graphic. Authority
// is the database (set_partner_marketing_ask, set_partner_logo,
// set_class_media, remove_class_media and the tables' row rules); nothing here
// decides access.

import { supabase } from "./supabase";
import { storedExtension } from "./providerDocumentLogic.js";

export const MARKETING_BUCKET = "partner-marketing";
const LINK_DAYS = 7;

/** The partner's asks (rows only for items it has ever set). */
export async function listMarketingAsks(partnerId) {
  const { data, error } = await supabase
    .from("partner_marketing_asks")
    .select("item_key, wanted, file_types, needs_logo, needs_accessible, note, updated_at")
    .eq("partner_id", partnerId);
  if (error) throw error;
  return data ?? [];
}

export async function setMarketingAsk(partnerId, ask) {
  const { error } = await supabase.rpc("set_partner_marketing_ask", {
    p_partner_id: partnerId,
    p_item_key: ask.item_key,
    p_wanted: !!ask.wanted,
    p_file_types: ask.file_types,
    p_needs_logo: !!ask.needs_logo,
    p_needs_accessible: !!ask.needs_accessible,
    p_note: ask.note ?? null,
  });
  if (error) throw error;
}

export async function getPartnerLogo(partnerId) {
  const { data, error } = await supabase
    .from("partner_logos")
    .select("storage_path, original_filename, uploaded_at")
    .eq("partner_id", partnerId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/** Remove a file and log (never throw) when it doesn't go. */
async function removeFile(path) {
  if (!path) return;
  const { data, error } = await supabase.storage.from(MARKETING_BUCKET).remove([path]);
  if (error || !data?.length) console.error("[partnerMarketing] file not removed", path, error?.message ?? "nothing matched");
}

async function uploadInto(folder, file) {
  const path = `${folder}/${crypto.randomUUID()}.${storedExtension(file) || "pdf"}`;
  const { error } = await supabase.storage
    .from(MARKETING_BUCKET)
    .upload(path, file, { upsert: false, contentType: file.type || undefined });
  if (error) throw error;
  return path;
}

/** Upload the partner's logo (the partner's every-site admin). */
export async function uploadPartnerLogo(partnerId, file) {
  const path = await uploadInto(partnerId, file);
  const { data: old, error } = await supabase.rpc("set_partner_logo", {
    p_partner_id: partnerId, p_storage_path: path, p_filename: file.name || null,
  });
  if (error) {
    await removeFile(path);
    throw error;
  }
  await removeFile(old);
}

/** This provider's flyers and social graphics the caller may see. */
export async function listClassMedia(orgId) {
  const { data, error } = await supabase
    .from("class_media")
    .select("id, program_id, camp_session_id, item_key, storage_path, original_filename, created_at")
    .eq("organization_id", orgId);
  if (error) throw error;
  return data ?? [];
}

/** Put a flyer / social graphic on a class, replacing any. */
export async function uploadClassMedia(orgId, c, itemKey, file) {
  const path = await uploadInto(orgId, file);
  const { data: old, error } = await supabase.rpc("set_class_media", {
    p_kind: c.kind, p_class_id: c.class_id, p_item_key: itemKey, p_storage_path: path, p_filename: file.name || null,
  });
  if (error) {
    await removeFile(path);
    throw error;
  }
  await removeFile(old);
}

export async function removeClassMedia(c, itemKey) {
  const { data: old, error } = await supabase.rpc("remove_class_media", {
    p_kind: c.kind, p_class_id: c.class_id, p_item_key: itemKey,
  });
  if (error) throw error;
  await removeFile(old);
}

/**
 * A link to the file. `download` names the saved file; `days` is how long it
 * works (Copy link: 7 days, for whoever it's pasted to, no sign-in).
 */
export async function marketingFileUrl(path, { download, days = 0 } = {}) {
  const ttl = days ? days * 24 * 3600 : 300;
  const { data, error } = await supabase.storage
    .from(MARKETING_BUCKET)
    .createSignedUrl(path, ttl, download ? { download } : undefined);
  if (error) throw error;
  if (!data?.signedUrl) throw new Error("no link");
  return data.signedUrl;
}

export const COPY_LINK_DAYS = LINK_DAYS;

/**
 * Share the file itself through the device's share sheet (Mail, Messages,
 * Teams...). Resolves "shared", "cancelled", or "unsupported" when this
 * browser can't share files (the caller then offers Copy link).
 */
export async function shareMarketingFile(path, name) {
  if (typeof navigator === "undefined" || !navigator.share || !navigator.canShare) return "unsupported";
  const url = await marketingFileUrl(path);
  const blob = await (await fetch(url)).blob();
  const file = new File([blob], name, { type: blob.type || undefined });
  if (!navigator.canShare({ files: [file] })) return "unsupported";
  try {
    await navigator.share({ files: [file], title: name });
    return "shared";
  } catch (err) {
    if (err?.name === "AbortError") return "cancelled";
    // The tap's permission ran out while the file downloaded (a slow
    // connection): offer Copy link rather than an error.
    if (err?.name === "NotAllowedError") return "unsupported";
    throw err;
  }
}
