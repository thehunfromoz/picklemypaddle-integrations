/**
 * Paddle photo pipeline, server side (SCRUM-66).
 *
 *  1. Decide the type from the file's first bytes (never its name or declared type).
 *  2. Decode with a pixel-count and time limit (decompression-bomb protection).
 *  3. Re-encode to JPEG, long edge at most 2560 px, upright, with ALL metadata dropped
 *     (EXIF incl. GPS, XMP, IPTC, ICC: sharp keeps none unless asked, and converts to sRGB).
 *  4. Only the re-encoded copy is ever written, under a random name on the private volume.
 *     Uploads are held in memory only; the original never touches the disk.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { MAX_PHOTO_BYTES, MAX_PHOTO_EDGE } from './rules.js';

export type SniffedType = 'jpeg' | 'png' | 'webp';

/** Recognises JPEG, PNG and WebP by their magic bytes; anything else is null. */
export function sniffImageType(bytes: Uint8Array): SniffedType | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return 'png';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // WEBP
  ) return 'webp';
  return null;
}

/**
 * Largest image we'll decode: 100 megapixels, about twice a 48 MP phone photo that skipped the
 * browser shrink. A small file claiming more (a decompression bomb) is refused before decoding.
 */
export const MAX_INPUT_PIXELS = 100_000_000;
/** Seconds one photo may take to process before it's refused. */
export const PROCESS_TIMEOUT_SECONDS = 20;

export interface ProcessedPhoto {
  data: Buffer;
  width: number;
  height: number;
}

/** Why a photo was refused, worded for the customer (the field error). */
export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoError';
  }
}

export async function processPhoto(bytes: Uint8Array, label: string): Promise<ProcessedPhoto> {
  if (bytes.length === 0) throw new PhotoError(`Add a photo of the ${label} of the paddle.`);
  if (bytes.length > MAX_PHOTO_BYTES) throw new PhotoError(`The ${label} photo must be 10 MB or smaller.`);
  const type = sniffImageType(bytes);
  if (!type) throw new PhotoError(`The ${label} photo must be a JPEG, PNG or WebP image.`);
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error', sequentialRead: true });
    const meta = await image.metadata();
    if (meta.format !== type) {
      throw new PhotoError(`The ${label} photo must be a JPEG, PNG or WebP image.`);
    }
    const { data, info } = await image
      .timeout({ seconds: PROCESS_TIMEOUT_SECONDS })
      .rotate() // apply the camera's orientation before its EXIF is dropped
      .resize({ width: MAX_PHOTO_EDGE, height: MAX_PHOTO_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }) // transparent PNG/WebP areas become white, not black
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch (err) {
    if (err instanceof PhotoError) throw err;
    // Corrupt, truncated, too many pixels or too slow: the customer gets a field error, not a 500.
    throw new PhotoError(`We couldn't read the ${label} photo. Please take or choose another one.`);
  }
}

/** Where processed photos are kept. Paths are relative to the store's folder. */
export interface PhotoStore {
  save(data: Buffer): Promise<string>;
  remove(relativePath: string): Promise<void>;
}

/**
 * Files on the private photo volume, under random 128-bit names in two-character folders, so no
 * name can be guessed and no folder gets huge. Nothing serves this folder; the admin (SCRUM-72)
 * reads files through its own authorised route.
 */
export function fsPhotoStore(root: string): PhotoStore {
  return {
    async save(data) {
      const name = randomBytes(16).toString('hex');
      const rel = path.join(name.slice(0, 2), `${name}.jpg`);
      await mkdir(path.join(root, name.slice(0, 2)), { recursive: true, mode: 0o700 });
      // wx: never overwrite an existing file (a name clash would be a bug, not a reason to lose a photo)
      await writeFile(path.join(root, rel), data, { flag: 'wx', mode: 0o600 });
      return rel;
    },
    async remove(rel) {
      // Refuse anything that would leave the folder (paths come from our own rows, but be strict).
      const full = path.resolve(root, rel);
      if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('photo path outside the store');
      await rm(full, { force: true });
    },
  };
}
