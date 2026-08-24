/**
 * What may be used as a picture, checked in the browser.
 *
 * The server decides — server/files/picture.js holds the same numbers and is
 * the one that refuses an upload. This is here so somebody who picks a 4000px
 * photograph is told immediately, rather than after sending a megabyte of it.
 * Keep the two in step; the messages are deliberately the same.
 */
export const PICTURE_RULES = Object.freeze({
  formats: Object.freeze(['png', 'jpg', 'jpeg']),
  accept: 'image/png,image/jpeg',
  maxBytes: 1024 * 1024,
  minPixels: 64,
  maxPixels: 1024,
  squareTolerance: 0.02,
});

/** `{ width, height }` for a chosen file, or null if the browser cannot read it. */
export async function measure(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('not an image'));
      image.src = url;
    });
    return { width: image.naturalWidth, height: image.naturalHeight };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The complaint about a chosen file, or null when there is none. Mirrors
 * pictureProblem() on the server, in the same order, so the answer a person
 * gets here is the answer they would have got from the upload.
 */
export async function pictureProblem(file) {
  const { formats, maxBytes, minPixels, maxPixels, squareTolerance } = PICTURE_RULES;

  const extension = /\.([a-zA-Z0-9]+)$/.exec(file.name || '')?.[1]?.toLowerCase();
  if (extension && !formats.includes(extension)) return 'A picture has to be a PNG or a JPEG.';
  if (file.size > maxBytes) return `A picture has to be under ${Math.round(maxBytes / 1024)}KB.`;

  const size = await measure(file);
  if (!size) return 'That file is not a PNG or a JPEG.';

  const { width, height } = size;
  if (width < minPixels || height < minPixels) {
    return `A picture has to be at least ${minPixels}×${minPixels}.`;
  }
  if (width > maxPixels || height > maxPixels) {
    return `A picture has to be no more than ${maxPixels}×${maxPixels}.`;
  }
  if (Math.abs(width - height) / Math.max(width, height) > squareTolerance) {
    return `A picture has to be square; this one is ${width}×${height}.`;
  }

  return null;
}
