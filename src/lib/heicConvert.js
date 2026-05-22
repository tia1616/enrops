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
