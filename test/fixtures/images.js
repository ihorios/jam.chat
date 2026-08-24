import zlib from 'node:zlib';

/**
 * Real PNGs and JPEGs, built here rather than checked in.
 *
 * The picture rules are decided from a file's own header (server/files/
 * picture.js), so a test needs bytes that genuinely parse — and needs them at
 * whatever size the case is about, which a fixture file cannot be.
 */

/** length + type + data + CRC, which is every PNG chunk. */
function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([head, body, crc]);
}

/** A real 8-bit RGB PNG of the given size, one flat colour. */
export function png(width, height, { padTo = 0 } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;  // bit depth
  header[9] = 2;  // colour type: RGB
  // compression, filter and interlace are all 0.

  // Each row is a filter byte followed by its pixels.
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x38)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));

  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
  ];

  // For the size rule: a chunk of bytes no decoder reads, to push the file past
  // a byte ceiling without generating a megapixel image to get there.
  if (padTo) {
    const grown = Buffer.concat(parts).length + 12;
    if (padTo > grown) parts.push(chunk('teXt', Buffer.alloc(padTo - grown, 0x20)));
  }

  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/**
 * A JPEG as far as its dimensions go: the start of image, a baseline
 * start-of-frame carrying the size, and the end of image.
 */
export function jpeg(width, height) {
  const sof = Buffer.alloc(10);
  sof.writeUInt16BE(0xffc0, 0);  // baseline SOF0
  sof.writeUInt16BE(8, 2);       // segment length
  sof[4] = 8;                    // sample precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 1;                    // one component

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}
