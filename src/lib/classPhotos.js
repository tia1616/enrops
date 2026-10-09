// Everything the three class-photo surfaces (instructor upload, parent gallery,
// admin review) share, so no screen has its own spelling of a rule.
//
// Authority lives in the database (class_photos RLS + the private class-photos
// bucket). Nothing here decides who may see or write a photo; it only calls the
// paths that do and words their refusals for a person.

import { supabase } from "./supabase";
import { prepareClassPhoto } from "./classPhotoPrep.js";

export const PHOTO_BUCKET = "class-photos";
const SIGNED_URL_TTL = 60 * 60;

// The pure rules (consent list, error wording, day grouping) live in
// classPhotoLogic.js so they can be tested without the Supabase client.
import { uploadErrorMessage } from "./classPhotoLogic.js";
export { todayLocalISO, childrenWithoutPhotoPermission, uploadErrorMessage, groupByDay } from "./classPhotoLogic.js";

/** Upload one photo. Resolves { ok:true } or { ok:false, message } - never throws. */
export async function uploadClassPhoto({ programId, sessionDate, file }) {
  let prepared;
  try {
    prepared = await prepareClassPhoto(file);
  } catch {
    return { ok: false, message: uploadErrorMessage("image_unreadable") };
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return { ok: false, message: "You've been signed out. Sign in again to upload." };

  const form = new FormData();
  form.append("program_id", programId);
  form.append("session_date", sessionDate);
  form.append("file", prepared);

  const { data, error } = await supabase.functions.invoke("upload-class-photo", {
    body: form,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (error) {
    let code = null;
    try { code = (await error.context?.json?.())?.error ?? null; } catch { /* body not JSON */ }
    return { ok: false, message: uploadErrorMessage(code) };
  }
  if (!data?.ok) return { ok: false, message: uploadErrorMessage(data?.error) };
  return { ok: true, id: data.id };
}

/** Photos for a class (optionally one day), newest day first. RLS decides what the caller sees. */
export async function listClassPhotos({ programId, sessionDate = null }) {
  let q = supabase
    .from("class_photos")
    .select("id, program_id, session_date, storage_path, created_at, flagged_at, uploaded_by_instructor_id")
    .eq("program_id", programId)
    .order("session_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (sessionDate) q = q.eq("session_date", sessionDate);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

/** { [storage_path]: signedUrl } for the given rows. A path that fails to sign is simply absent. */
export async function signPhotoUrls(rows) {
  const paths = (rows || []).map((r) => r.storage_path).filter(Boolean);
  if (!paths.length) return {};
  const { data, error } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL);
  if (error) throw error;
  const out = {};
  for (const d of data || []) if (d?.signedUrl && d.path) out[d.path] = d.signedUrl;
  return out;
}

/**
 * Remove a photo. The file goes first: the storage policy reads the class_photos
 * row to authorize the delete, so deleting the row first would leave a file nobody
 * is allowed to remove.
 */
export async function deleteClassPhoto(row) {
  const { error: rmErr } = await supabase.storage.from(PHOTO_BUCKET).remove([row.storage_path]);
  if (rmErr) throw rmErr;
  // Read the deleted row back: a DELETE the policy refuses affects ZERO rows and
  // returns no error (the photo may have been reported since the screen loaded),
  // which used to read as success while the photo sat there.
  const { data, error } = await supabase.from("class_photos").delete().eq("id", row.id).select("id");
  if (error) throw error;
  if (!data || data.length === 0) throw new Error("photo was not deleted");
}

/** A family reports a photo; it disappears for every family at once. */
export async function flagClassPhoto(photoId) {
  const { error } = await supabase.rpc("flag_class_photo", { p_photo_id: photoId });
  if (error) throw error;
}

/** Save a photo to the device. Fetches the bytes so the browser downloads instead of navigating. */
export async function saveClassPhoto(url, name = "class-photo.jpg") {
  const res = await fetch(url);
  if (!res.ok) throw new Error("download failed");
  const blob = await res.blob();
  const a = document.createElement("a");
  const href = URL.createObjectURL(blob);
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 5000);
}
