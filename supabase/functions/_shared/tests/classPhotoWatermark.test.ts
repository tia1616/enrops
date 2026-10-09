// The watermark has to (1) leave the photo recognisably the same, (2) actually
// change the corner it claims to, and (3) refuse anything that is not a JPEG.
import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { Image } from 'https://deno.land/x/imagescript@1.3.0/mod.ts';
import { watermarkJpeg, isJpeg, markPlacement, jpegDimensions, MAX_DIM } from '../classPhotoWatermark.ts';

async function solidJpeg(w: number, h: number, rgba: number): Promise<Uint8Array> {
  const img = new Image(w, h);
  img.fill(rgba);
  return await img.encodeJPEG(90);
}

Deno.test('the corner changes and the rest of the photo does not', async () => {
  const src = await solidJpeg(1000, 700, 0x2e8b57ff);
  const out = await watermarkJpeg(src);
  assert(isJpeg(out));
  const before = (await Image.decode(src)) as Image;
  const after = (await Image.decode(out)) as Image;
  assertEquals([after.width, after.height], [1000, 700]);

  // top-left is untouched (allowing for one more JPEG generation)
  const [r0, g0, b0] = before.getRGBAAt(10, 10).slice(0, 3);
  const [r1, g1, b1] = after.getRGBAAt(10, 10).slice(0, 3);
  assert(Math.abs(r0 - r1) + Math.abs(g0 - g1) + Math.abs(b0 - b1) < 18, 'far corner moved');

  // somewhere inside the mark's box differs clearly from the plain green
  const { width, margin } = markPlacement(1000, 700);
  let maxDiff = 0;
  for (let x = 1000 - width - margin; x < 1000 - margin; x += 2) {
    for (let y = 700 - margin - 30; y < 700 - margin; y += 2) {
      const a = before.getRGBAAt(x, y), b = after.getRGBAAt(x, y);
      maxDiff = Math.max(maxDiff, Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]));
    }
  }
  assert(maxDiff > 120, `the mark is not visible (max diff ${maxDiff})`);
});

Deno.test('an oversized photo is shrunk to MAX_DIM on its long side', async () => {
  const out = await watermarkJpeg(await solidJpeg(2400, 1800, 0x336699ff));
  const img = (await Image.decode(out)) as Image;
  assertEquals(Math.max(img.width, img.height), MAX_DIM);
});

Deno.test('dimensions are read from the header without decoding', async () => {
  const src = await solidJpeg(321, 123, 0x112233ff);
  assertEquals(jpegDimensions(src), { width: 321, height: 123 });
  assertEquals(jpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), null);
});

Deno.test('a photo that DECLARES a huge size is refused before it is decoded', async () => {
  // Take a real small JPEG and rewrite its frame header to claim 30000x30000.
  // Nothing is decoded, so this is instant; if the guard were missing the decode
  // would try to allocate gigabytes.
  const src = await solidJpeg(64, 64, 0x445566ff);
  const bomb = new Uint8Array(src);
  let i = 2;
  while (i + 9 < bomb.length) {
    if (bomb[i] === 0xff && bomb[i + 1] >= 0xc0 && bomb[i + 1] <= 0xc2) {
      bomb[i + 5] = 30000 >> 8; bomb[i + 6] = 30000 & 0xff;
      bomb[i + 7] = 30000 >> 8; bomb[i + 8] = 30000 & 0xff;
      break;
    }
    i += 2 + ((bomb[i + 2] << 8) | bomb[i + 3]);
  }
  assertEquals(jpegDimensions(bomb), { width: 30000, height: 30000 });
  await assertRejects(() => watermarkJpeg(bomb), Error, 'image_too_large');
});

Deno.test('a non-JPEG is refused, not stamped', async () => {
  await assertRejects(() => watermarkJpeg(new TextEncoder().encode('hello')), Error, 'not_a_jpeg');
  const png = await new Image(20, 20).encode();
  await assertRejects(() => watermarkJpeg(png), Error, 'not_a_jpeg');
});
