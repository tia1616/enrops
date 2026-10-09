// Stamps the enrops wordmark on a class photo and returns a JPEG.
//
// WHY SERVER-SIDE. The mark is applied before the file is ever stored, so an
// unmarked original cannot exist in the bucket and an instructor's phone cannot
// skip it. There is deliberately no storage INSERT policy for this bucket; the
// only writer is upload-class-photo, which calls this first.
//
// WHAT THE MARK IS FOR. A watermark does not stop a determined person copying a
// photo, and an oversized one ruins it for the family. This is a small corner
// mark that says where the photo came from, nothing more.
//
// The wordmark is rasterised with resvg-wasm (the same dependency and wasm
// source regenerate-email-logo already uses) and composited with imagescript
// (pure Deno, no native build). The phone has already shrunk and re-encoded the
// photo to at most MAX_DIM, so memory stays small; we cap again here because the
// client is not the authority.

import { Image } from 'https://deno.land/x/imagescript@1.3.0/mod.ts';
import { Resvg, initWasm } from 'https://esm.sh/@resvg/resvg-wasm@2.6.2';
import { WORDMARK_SVG, WORDMARK_CREAM } from './classPhotoWordmark.ts';

export const MAX_DIM = 1600;
export const JPEG_QUALITY = 82;

// Wordmark width as a share of the photo width, with a floor so it stays legible
// on a small image, and the gap from the corner.
const MARK_WIDTH_SHARE = 0.16;
const MARK_MIN_WIDTH = 96;
const MARGIN_SHARE = 0.03;
const SHADOW_COLOUR = '#1C004F'; // deep violet, from the brand guide
const SHADOW_OFFSET = 2;

const WASM_URL = 'https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm';

let wasmReady: Promise<void> | null = null;
function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const res = await fetch(WASM_URL);
      if (!res.ok) throw new Error(`wasm fetch ${res.status}`);
      await initWasm(await res.arrayBuffer());
    })().catch((e) => {
      // A failed fetch must not poison every later call for the life of the isolate.
      wasmReady = null;
      throw e;
    });
  }
  return wasmReady;
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

async function renderWordmark(width: number, colour: string): Promise<Image> {
  // Named separately from a bad photo: the CDN being down is not the instructor's
  // photo being unreadable, and telling them to retake it would send them in circles.
  try {
    await ensureWasm();
  } catch (e) {
    console.error('[classPhotoWatermark] resvg wasm unavailable:', e);
    throw new Error('watermark_unavailable');
  }
  const svg = WORDMARK_SVG.replaceAll(`fill="${WORDMARK_CREAM}"`, `fill="${colour}"`);
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
  const img = await Image.decode(png);
  if (!(img instanceof Image)) throw new Error('wordmark did not decode to a still image');
  return img;
}

/** Where the mark goes: bottom-right, inset by a margin that scales with the photo. */
export function markPlacement(photoW: number, photoH: number) {
  const width = Math.max(MARK_MIN_WIDTH, Math.round(photoW * MARK_WIDTH_SHARE));
  const margin = Math.round(photoW * MARGIN_SHARE);
  return { width, margin };
}

// The decoded size, not the file size, is what costs memory: a few hundred KB of
// solid colour can declare 30000x30000 pixels and need ~3.6 GB as RGBA, and the
// 6 MB upload cap says nothing about that. A phone camera is ~12-48 MP, so 64 MP
// is generous and still only ~256 MB decoded.
export const MAX_PIXELS = 64_000_000;

/**
 * Width and height from the first Start-Of-Frame marker, read WITHOUT decoding.
 * Returns null when no frame header is found (corrupt or truncated file).
 */
export function jpegDimensions(b: Uint8Array): { width: number; height: number } | null {
  let i = 2; // past the SOI marker
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    // Standalone markers carry no length: TEM, RSTn, SOI, EOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

export async function watermarkJpeg(input: Uint8Array): Promise<Uint8Array> {
  if (!isJpeg(input)) throw new Error('not_a_jpeg');
  const dims = jpegDimensions(input);
  if (!dims || dims.width === 0 || dims.height === 0) throw new Error('image_unreadable');
  if (dims.width * dims.height > MAX_PIXELS) throw new Error('image_too_large');
  const decoded = await Image.decode(input);
  if (!(decoded instanceof Image)) throw new Error('not_a_still_image');
  let img: Image = decoded;

  const longest = Math.max(img.width, img.height);
  if (longest > MAX_DIM) {
    const scale = MAX_DIM / longest;
    img = img.resize(Math.round(img.width * scale), Math.round(img.height * scale));
  }

  const { width, margin } = markPlacement(img.width, img.height);
  const mark = await renderWordmark(width, WORDMARK_CREAM);
  const shadow = await renderWordmark(width, SHADOW_COLOUR);
  shadow.opacity(0.45);
  mark.opacity(0.88);

  const x = Math.max(0, img.width - mark.width - margin);
  const y = Math.max(0, img.height - mark.height - margin);
  img.composite(shadow, x + SHADOW_OFFSET, y + SHADOW_OFFSET);
  img.composite(mark, x, y);

  return await img.encodeJPEG(JPEG_QUALITY);
}
