/** Server-side photo pipeline (SCRUM-66). */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { sharpEngine, vipsAvailable, vipsEngine, type ImageEngine } from '../src/orders/image-engine.js';
import { PhotoError, processPhoto as process_, sniffImageType } from '../src/orders/photos.js';
import * as img from './helpers/images.js';

describe('sniffImageType: by content, never by name', () => {
  it('recognises JPEG, PNG and WebP', async () => {
    expect(sniffImageType(await img.jpeg())).toBe('jpeg');
    expect(sniffImageType(await img.png())).toBe('png');
    expect(sniffImageType(await img.webp())).toBe('webp');
  });
  it('rejects SVG, HTML and executables', () => {
    for (const b of [img.svgPretendingToBeJpeg(), img.htmlPretendingToBeJpeg(), img.exePretendingToBeJpeg(), Buffer.alloc(0)]) {
      expect(sniffImageType(b)).toBeNull();
    }
  });
});

// Every engine that can run here gets the same tests. CI's container test installs the libvips
// tools and sets REQUIRE_VIPS=1, so the engine the image uses is always covered.
const engines: { name: string; get: () => Promise<ImageEngine> }[] = [];
const haveVips = await vipsAvailable();
if (haveVips) engines.push({ name: 'vips', get: async () => vipsEngine() });
else if (process.env.REQUIRE_VIPS === '1') throw new Error('REQUIRE_VIPS=1 but the libvips tools are not installed');
let sharpOk = true;
try {
  await sharpEngine();
} catch {
  sharpOk = false;
}
if (sharpOk) engines.push({ name: 'sharp', get: sharpEngine });

it('has at least one image engine to test', () => expect(engines.length).toBeGreaterThan(0));

describe.each(engines)('processPhoto ($name engine)', ({ get }) => {
  let engine: ImageEngine;
  const processPhoto = async (bytes: Uint8Array, label: string) => process_(bytes, label, (engine ??= await get()));

  it('turns a sideways camera photo upright (EXIF orientation applied before it is dropped)', async () => {
    const input = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#4565A6' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const out = await processPhoto(input, 'front');
    expect([out.width, out.height]).toEqual([1920, 2560]);
    expect((await sharp(out.data).metadata()).orientation).toBeUndefined();
  });

  it('turns transparent areas white, not black', async () => {
    const input = await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const stats = await sharp((await processPhoto(input, 'front')).data).stats();
    for (const c of stats.channels.slice(0, 3)) expect(c.mean).toBeGreaterThan(250);
  });

  it('drops every bit of metadata, GPS included', async () => {
    const input = await img.jpegWithGps();
    expect((await sharp(input).metadata()).exif).toBeDefined(); // the fixture really has EXIF
    const out = await processPhoto(input, 'front');
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(out.data.includes(Buffer.from('Paddle Phone'))).toBe(false);
  });

  it('turns PNG and WebP into JPEG', async () => {
    for (const input of [await img.png(), await img.webp()]) {
      const out = await processPhoto(input, 'back');
      expect((await sharp(out.data).metadata()).format).toBe('jpeg');
    }
  });

  it('shrinks an 8000 px photo to 2560 px on the long edge', async () => {
    const out = await processPhoto(await img.jpeg(8000, 6000), 'front');
    expect([out.width, out.height]).toEqual([2560, 1920]);
  });

  it('never enlarges a small photo', async () => {
    const out = await processPhoto(await img.jpeg(400, 300), 'front');
    expect([out.width, out.height]).toEqual([400, 300]);
  });

  it('refuses SVG, HTML and executables named like photos, with a field message', async () => {
    for (const b of [img.svgPretendingToBeJpeg(), img.htmlPretendingToBeJpeg(), img.exePretendingToBeJpeg()]) {
      await expect(processPhoto(b, 'front')).rejects.toThrow(new PhotoError('The front photo must be a JPEG, PNG or WebP image.'));
    }
  });

  it('refuses a decompression bomb quickly, without decoding it', async () => {
    const started = Date.now();
    await expect(processPhoto(img.pngBomb(), 'back')).rejects.toBeInstanceOf(PhotoError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('refuses a corrupt photo with a field message, not a crash', async () => {
    const truncated = (await img.jpeg()).subarray(0, 200);
    await expect(processPhoto(truncated, 'front')).rejects.toThrow(/couldn't read the front photo/);
  });

  it('refuses a photo over 10 MB', async () => {
    const big = Buffer.concat([await img.jpeg(), Buffer.alloc(10 * 1024 * 1024)]);
    await expect(processPhoto(big, 'front')).rejects.toThrow(/10 MB or smaller/);
  });
});
