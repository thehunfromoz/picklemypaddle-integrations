/**
 * Which library decodes and re-encodes paddle photos (SCRUM-66).
 *
 *  - "vips": the libvips command-line tools (vipsheader, vipsthumbnail) from the operating system.
 *    The service's image installs them from Alpine, which builds for the baseline x86-64 CPU, so
 *    they run on any 64-bit Intel or AMD processor. This is what staging and production use.
 *  - "sharp": the same libvips inside Node, through the sharp package. Handy on a Mac, but its
 *    prebuilt binaries need a newer CPU (x86-64-v2, SSE4.2) than home-server has: on 26 Oct 2026
 *    the service crashed there at start-up. So sharp is a development dependency only, never in
 *    the image.
 *  - "auto" (the default): vips when its tools are installed, otherwise sharp.
 *
 * Both do the same steps: read only the header first (to refuse decompression bombs before any
 * decoding), then shrink to fit 2560 px, turn the image upright, flatten transparency onto
 * white, and write a JPEG at quality 85 that keeps no metadata at all.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const IMAGE_ENGINES = ['auto', 'vips', 'sharp'] as const;
export type ImageEngineSetting = (typeof IMAGE_ENGINES)[number];

export interface ImageLimits {
  maxEdge: number;
  maxPixels: number;
  timeoutSeconds: number;
  quality: number;
}

export interface EncodedImage {
  data: Buffer;
  width: number;
  height: number;
}

/** Why an image couldn't be used. The caller turns it into the customer's field message. */
export class ImageRejected extends Error {
  constructor(public readonly reason: 'too_many_pixels' | 'wrong_format' | 'unreadable') {
    super(reason);
    this.name = 'ImageRejected';
  }
}

export interface ImageEngine {
  readonly name: 'vips' | 'sharp';
  /** Decodes, checks and re-encodes one photo whose type was already sniffed. */
  reencode(bytes: Uint8Array, type: 'jpeg' | 'png' | 'webp', limits: ImageLimits): Promise<EncodedImage>;
}

// ── libvips command-line tools ────────────────────────────────────────────────

/**
 * The upload is written to the temporary folder for the tools to read, and removed straight
 * after. In the stacks that folder is a tmpfs (memory), so the original never reaches a disk.
 */
export function vipsEngine(tmpRoot = tmpdir()): ImageEngine {
  return {
    name: 'vips',
    async reencode(bytes, type, limits) {
      const dir = await mkdtemp(path.join(tmpRoot, 'pmp-photo-'));
      const input = path.join(dir, `in-${randomBytes(8).toString('hex')}.${type === 'jpeg' ? 'jpg' : type}`);
      const output = path.join(dir, 'out.jpg');
      const opts = { timeout: limits.timeoutSeconds * 1000, killSignal: 'SIGKILL' as const, maxBuffer: 1024 * 1024 };
      try {
        await writeFile(input, bytes, { mode: 0o600 });
        // Header only: nothing is decoded until the size is known to be sane.
        let width: number;
        let height: number;
        let loader: string;
        try {
          const { stdout } = await run('vipsheader', ['-f', 'width', input], opts);
          width = Number(stdout.trim());
          height = Number((await run('vipsheader', ['-f', 'height', input], opts)).stdout.trim());
          loader = (await run('vipsheader', ['-f', 'vips-loader', input], opts)).stdout.trim();
        } catch {
          throw new ImageRejected('unreadable');
        }
        if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new ImageRejected('unreadable');
        if (width * height > limits.maxPixels) throw new ImageRejected('too_many_pixels');
        // libvips must agree with the sniffed type (jpegload, pngload/pngload_source, webpload...).
        if (!loader.startsWith(type === 'jpeg' ? 'jpegload' : `${type}load`)) throw new ImageRejected('wrong_format');
        const edge = limits.maxEdge;
        try {
          // ">" shrinks only; vipsthumbnail turns the image upright from its EXIF orientation.
          await run(
            'vipsthumbnail',
            [input, '--size', `${edge}x${edge}>`, '-o', `${output}[Q=${limits.quality},keep=none,background=255,optimize_coding]`],
            opts,
          );
          const data = await readFile(output);
          const w = Number((await run('vipsheader', ['-f', 'width', output], opts)).stdout.trim());
          const h = Number((await run('vipsheader', ['-f', 'height', output], opts)).stdout.trim());
          return { data, width: w, height: h };
        } catch {
          throw new ImageRejected('unreadable');
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

export async function vipsAvailable(): Promise<boolean> {
  try {
    await run('vipsheader', ['--version'], { timeout: 5000 });
    await run('vipsthumbnail', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ── sharp (development only) ──────────────────────────────────────────────────

export async function sharpEngine(): Promise<ImageEngine> {
  // A variable specifier keeps TypeScript from requiring sharp's types in production builds,
  // where sharp isn't installed at all.
  const specifier = 'sharp';
  const sharp = ((await import(specifier)) as { default: typeof import('sharp').default }).default;
  return {
    name: 'sharp',
    async reencode(bytes, type, limits) {
      try {
        const image = sharp(bytes, { limitInputPixels: limits.maxPixels, failOn: 'error', sequentialRead: true });
        const meta = await image.metadata();
        if (meta.format !== type) throw new ImageRejected('wrong_format');
        const { data, info } = await image
          .timeout({ seconds: limits.timeoutSeconds })
          .rotate()
          .resize({ width: limits.maxEdge, height: limits.maxEdge, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: limits.quality, mozjpeg: true })
          .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
      } catch (err) {
        if (err instanceof ImageRejected) throw err;
        throw new ImageRejected(/pixel limit/i.test((err as Error)?.message ?? '') ? 'too_many_pixels' : 'unreadable');
      }
    },
  };
}

// ── choosing one ──────────────────────────────────────────────────────────────

export async function selectImageEngine(setting: ImageEngineSetting): Promise<ImageEngine> {
  if (setting === 'vips' || (setting === 'auto' && (await vipsAvailable()))) {
    if (setting === 'vips' && !(await vipsAvailable())) {
      throw new Error('IMAGE_ENGINE is vips, but the libvips tools (vipsheader, vipsthumbnail) are not installed');
    }
    return vipsEngine();
  }
  try {
    return await sharpEngine();
  } catch (err) {
    throw new Error(
      `no image engine: the libvips tools aren't installed and sharp can't load (${(err as Error).message.split('\n')[0]})`,
    );
  }
}
