// HEIC/HEIF → JPEG conversion helper. iPhone defaults to HEIC; Chrome/Firefox/
// Edge can't render it, so we convert client-side before upload. heic2any is
// lazy-imported so it (and its WASM payload) only loads when a HEIC file
// actually shows up.

const HEIC_TYPES = new Set(['image/heic', 'image/heif']);

export function isHeic(file) {
  if (!file) return false;
  const mime = (file.type || '').toLowerCase();
  if (HEIC_TYPES.has(mime)) return true;
  // Some browsers don't tag .heic with a MIME type — fall back to extension.
  const name = (file.name || '').toLowerCase();
  return name.endsWith('.heic') || name.endsWith('.heif');
}

export async function ensureBrowserSafeImage(file) {
  if (!isHeic(file)) return file;

  const { default: heic2any } = await import('heic2any');
  const converted = await heic2any({
    blob: file,
    toType: 'image/jpeg',
    quality: 0.85,
  });
  // heic2any may return a Blob[] for multi-image HEIC containers — take the first.
  const blob = Array.isArray(converted) ? converted[0] : converted;
  const baseName = (file.name || 'photo').replace(/\.(heic|heif)$/i, '');
  return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
}

// Shrink a photo before upload.
//
// A phone photo is routinely 3-5 MB and 4000px wide. The bucket cap is 2 MB, so
// most of a camera roll was being rejected with "that photo is over 2 MB" -
// asking an operator to go and resize an image by hand, at the exact moment the
// product is trying to feel effortless. The photo is displayed at 56px on the
// class card and never wider than the page, so the full-resolution original was
// never useful to anyone; it just made the upload fail.
//
// Downscales the long edge and re-encodes as JPEG. A typical 4 MB phone photo
// lands around 200-400 KB, indistinguishable at the sizes we render.
//
// Falls back to the original file on any failure (canvas blocked, decode error,
// exotic format). The caller's size check still applies, so the worst case is
// exactly today's behaviour rather than a broken upload.
export async function downscaleImage(file, { maxDim = 1600, quality = 0.82 } = {}) {
  if (!file || !file.type?.startsWith('image/')) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const longEdge = Math.max(width, height);

    // Already small enough in both dimensions AND bytes - leave it alone.
    if (longEdge <= maxDim && file.size <= 1_500_000) {
      bitmap.close?.();
      return file;
    }

    const scale = Math.min(1, maxDim / longEdge);
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close?.(); return file; }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    if (!blob) return file;
    // If re-encoding somehow made it bigger (already-optimised small JPEG),
    // keep the original.
    if (blob.size >= file.size) return file;

    const baseName = (file.name || 'photo').replace(/\.[^.]+$/, '');
    return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

export function extensionFor(file) {
  const mime = (file.type || '').toLowerCase();
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/heic') return 'heic';
  if (mime === 'image/heif') return 'heif';
  if (mime === 'application/pdf') return 'pdf';
  const name = (file.name || '').toLowerCase();
  const m = name.match(/\.([a-z0-9]+)$/);
  return m ? m[1] : 'bin';
}
