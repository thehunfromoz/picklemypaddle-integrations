/** Test photos, made at runtime so no binary fixtures live in the repo (SCRUM-66). */
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 69, g: 101, b: 166 } } });

/** A JPEG carrying camera EXIF with a GPS position (what an unshrunk phone photo might have). */
export const jpegWithGps = (width = 800, height = 600) =>
  solid(width, height)
    .withExif({
      IFD0: { Make: 'TestCam', Model: 'Paddle Phone', Software: 'pmp-tests' },
      IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 52/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '151/1 12/1 0/1' },
    })
    .jpeg()
    .toBuffer();

export const jpeg = (width = 400, height = 300) => solid(width, height).jpeg().toBuffer();
export const png = (width = 400, height = 300) => solid(width, height).png().toBuffer();
export const webp = (width = 400, height = 300) => solid(width, height).webp().toBuffer();

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * A decompression bomb: a small, valid-looking PNG whose header claims 30 000 × 30 000 pixels
 * (900 megapixels). Decoding it for real would need gigabytes of memory.
 */
export function pngBomb(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(30_000, 0);
  ihdr.writeUInt32BE(30_000, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const row = Buffer.alloc(30_001); // filter byte + one row of zeros
  const idat = deflateSync(Buffer.concat(Array.from({ length: 50 }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const svgPretendingToBeJpeg = () =>
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
export const htmlPretendingToBeJpeg = () => Buffer.from('<!doctype html><html><body>not a photo</body></html>');
export const exePretendingToBeJpeg = () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);
