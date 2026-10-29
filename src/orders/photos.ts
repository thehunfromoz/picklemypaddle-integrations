/**
 * Paddle photo pipeline, server side (SCRUM-66).
 *
 *  1. Decide the type from the file's first bytes (never its name or declared type).
 *  2. Decode with a pixel-count and time limit (decompression-bomb protection).
 *  3. Re-encode to JPEG, long edge at most 2560 px, upright, with ALL metadata dropped
 *     (EXIF incl. GPS, XMP, IPTC, ICC), using the image engine chosen at start-up
 *     (./image-engine.ts: the libvips tools in the image, sharp on a developer's Mac).
 *  4. Only the re-encoded copy is ever written, under a random name on the private volume.
 *     Uploads are held in memory only; the original never touches the disk.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageRejected, selectImageEngine, type ImageEngine, type ImageEngineSetting } from './image-engine.js';
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

let engine: Promise<ImageEngine> | undefined;

/**
 * Chooses the image engine once, at start-up (server.ts), so a missing library stops the service
 * before it takes orders. Tests and scripts that skip this get IMAGE_ENGINE from the environment,
 * or "auto".
 */
export function useImageEngine(setting: ImageEngineSetting): Promise<ImageEngine> {
  engine = selectImageEngine(setting);
  return engine;
}

export function currentImageEngine(): Promise<ImageEngine> {
  engine ??= selectImageEngine((process.env.IMAGE_ENGINE as ImageEngineSetting | undefined) ?? 'auto');
  return engine;
}

export async function processPhoto(bytes: Uint8Array, label: string, using?: ImageEngine): Promise<ProcessedPhoto> {
  if (bytes.length === 0) throw new PhotoError(`Add a photo of the ${label} of the paddle.`);
  if (bytes.length > MAX_PHOTO_BYTES) throw new PhotoError(`The ${label} photo must be 10 MB or smaller.`);
  const type = sniffImageType(bytes);
  if (!type) throw new PhotoError(`The ${label} photo must be a JPEG, PNG or WebP image.`);
  try {
    return await (using ?? (await currentImageEngine())).reencode(bytes, type, {
      maxEdge: MAX_PHOTO_EDGE,
      maxPixels: MAX_INPUT_PIXELS,
      timeoutSeconds: PROCESS_TIMEOUT_SECONDS,
      quality: 85,
    });
  } catch (err) {
    if (err instanceof ImageRejected && err.reason === 'wrong_format') {
      throw new PhotoError(`The ${label} photo must be a JPEG, PNG or WebP image.`);
    }
    // Corrupt, truncated, too many pixels or too slow: the customer gets a field error, not a 500.
    throw new PhotoError(`We couldn't read the ${label} photo. Please take or choose another one.`);
  }
}

/** Where processed photos are kept. Paths are relative to the store's folder. */
export interface PhotoStore {
  save(data: Buffer): Promise<string>;
  remove(relativePath: string): Promise<void>;
  /** The file's bytes, for the admin's authorised photo route (SCRUM-72); null if it's gone. */
  read(relativePath: string): Promise<Buffer | null>;
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
      await rm(inside(rel), { force: true });
    },
    async read(rel) {
      try {
        return await readFile(inside(rel));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
  };

  // Refuse anything that would leave the folder (paths come from our own rows, but be strict).
  function inside(rel: string): string {
    const full = path.resolve(root, rel);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('photo path outside the store');
    return full;
  }
}
