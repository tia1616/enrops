// Turns whatever the phone produced into the one thing upload-class-photo
// accepts: an upright JPEG, at most MAX_DIM on its long side.
//
// WHY THIS DOES NOT REUSE downscaleImage. That helper returns the ORIGINAL file
// untouched when it is already small, which is right for an avatar and wrong
// here: a small photo can still carry an EXIF "rotate me" flag instead of
// upright pixels. The server decodes pixels only and drops EXIF when it stamps
// the watermark, so a flag the browser honoured on the phone would be lost and
// the photo would arrive on its side. Drawing through a canvas with
// imageOrientation 'from-image' bakes the rotation into the pixels, always.
//
// HEIC first (an iPhone's default), exactly as the other upload paths do.

import { ensureBrowserSafeImage } from "./heicConvert.js";

export const CLASS_PHOTO_MAX_DIM = 1600;
export const CLASS_PHOTO_QUALITY = 0.85;

/** Long side scaled to at most maxDim, never enlarged. Pure, so it is testable. */
export function fitWithin(width, height, maxDim = CLASS_PHOTO_MAX_DIM) {
  const longest = Math.max(width, height);
  if (!longest || longest <= maxDim) return { width, height };
  const scale = maxDim / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export async function prepareClassPhoto(file) {
  const safe = await ensureBrowserSafeImage(file);
  const bitmap = await createImageBitmap(safe, { imageOrientation: "from-image" });
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot prepare photos.");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", CLASS_PHOTO_QUALITY));
    if (!blob) throw new Error("That photo could not be read.");
    return new File([blob], "class-photo.jpg", { type: "image/jpeg" });
  } finally {
    bitmap.close?.();
  }
}
