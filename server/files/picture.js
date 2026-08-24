/**
 * What may be used as somebody's picture, and how to tell from the bytes.
 *
 * The rules are Google's, near enough: a square PNG or JPEG that is not large.
 * They are checked here rather than in the browser because a browser check is a
 * courtesy — it tells somebody their photograph is the wrong shape before they
 * wait for the upload — while this is the one that decides.
 *
 * Dimensions come from parsing the file's own header. That is deliberate: it
 * needs no image library, and it doubles as proof that the bytes really are the
 * format the filename claims. A .png that no PNG parser can read is not a
 * picture, whatever it is called.
 */

/** Square, small, and one of two formats. */
export const PICTURE_RULES = Object.freeze({
  formats: Object.freeze(['png', 'jpg', 'jpeg']),
  maxBytes: 1024 * 1024,
  minPixels: 64,
  maxPixels: 1024,
  /**
   * How far from square is still square. Exactly 1:1 would reject a 512×515
   * export for no reason a person could see; a fifth of a percent per side is
   * invisible and still refuses anything with a shape.
   */
  squareTolerance: 0.02,
});

/** The extension, lower-cased and without its dot. */
function extensionOf(filename) {
  const match = /\.([a-zA-Z0-9]+)$/.exec(String(filename || ''));
  return match ? match[1].toLowerCase() : '';
}

/** PNG: the IHDR chunk is first, and its width and height are at fixed offsets. */
function readPng(buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length < 24) return null;
  if (!signature.every((byte, i) => buffer[i] === byte)) return null;
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null;

  return {
    format: 'png',
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

/**
 * JPEG: no fixed offset — the size lives in whichever start-of-frame segment
 * this file happens to use, so the segments are walked until one turns up.
 */
function readJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null; // not where a marker should be

    const marker = buffer[offset + 1];
    // Padding between segments, and the markers that carry no payload.
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }

    const length = buffer.readUInt16BE(offset + 2);
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);

    if (isStartOfFrame) {
      return {
        format: 'jpg',
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + length;
  }

  return null;
}

/**
 * `{ format, width, height }` for a PNG or JPEG, or null for anything else —
 * including a file whose header does not parse as the format it claims.
 */
export function describeImage(buffer) {
  if (!buffer || buffer.length === 0) return null;
  return readPng(buffer) || readJpeg(buffer);
}

/**
 * The complaint about using these bytes as a picture, or null when there is
 * none. A message rather than a thrown error, so the caller decides the status
 * code and the browser and the route can share one set of rules.
 */
export function pictureProblem(buffer, filename) {
  const { formats, maxBytes, minPixels, maxPixels, squareTolerance } = PICTURE_RULES;

  const extension = extensionOf(filename);
  if (extension && !formats.includes(extension)) {
    return 'A picture has to be a PNG or a JPEG.';
  }

  if (buffer.length > maxBytes) {
    return `A picture has to be under ${Math.round(maxBytes / 1024)}KB.`;
  }

  const image = describeImage(buffer);
  if (!image) return 'That file is not a PNG or a JPEG.';

  const { width, height } = image;
  if (width < minPixels || height < minPixels) {
    return `A picture has to be at least ${minPixels}×${minPixels}.`;
  }
  if (width > maxPixels || height > maxPixels) {
    return `A picture has to be no more than ${maxPixels}×${maxPixels}.`;
  }

  const longest = Math.max(width, height);
  if (Math.abs(width - height) / longest > squareTolerance) {
    return `A picture has to be square; this one is ${width}×${height}.`;
  }

  return null;
}
