import t from 'tap';

import { describeImage, pictureProblem, PICTURE_RULES } from '../../server/files/picture.js';
import { png, jpeg } from '../fixtures/images.js';

/**
 * Reading a picture's size out of its own header, and the rules applied to it.
 *
 * Worth testing directly: this is the only thing standing between "square PNG
 * or JPEG, not large" and whatever somebody actually uploads, and it is doing
 * it by parsing bytes rather than by trusting a filename.
 */

t.test('dimensions come out of the file itself', async (t) => {
  t.same(describeImage(png(64, 64)), { format: 'png', width: 64, height: 64 });
  t.same(describeImage(png(1024, 512)), { format: 'png', width: 1024, height: 512 });
  t.same(describeImage(jpeg(300, 200)), { format: 'jpg', width: 300, height: 200 });
});

t.test('anything that is not one of the two formats is not a picture', async (t) => {
  t.equal(describeImage(Buffer.from('GIF89a and then some')), null, 'a GIF');
  t.equal(describeImage(Buffer.from('%PDF-1.7')), null, 'a PDF');
  t.equal(describeImage(Buffer.from('hello')), null, 'plain text');
  t.equal(describeImage(Buffer.alloc(0)), null, 'nothing at all');
  t.equal(describeImage(null), null, 'no buffer');

  // A PNG signature with a truncated header: the shape of the thing matters,
  // not the first eight bytes.
  t.equal(describeImage(png(64, 64).subarray(0, 20)), null, 'a PNG cut short');
});

t.test('a name is not evidence', async (t) => {
  // The extension is checked, but the bytes decide: this is a JPEG called .png.
  t.equal(pictureProblem(jpeg(128, 128), 'lying.png'), null, 'the bytes are a picture, so it is');
  t.match(pictureProblem(Buffer.from('not an image at all'), 'honest.png'), /not a PNG or a JPEG/);
});

t.test('the rules', async (t) => {
  const { minPixels, maxPixels, maxBytes } = PICTURE_RULES;

  t.equal(pictureProblem(png(256, 256), 'ok.png'), null, 'a square PNG');
  t.equal(pictureProblem(jpeg(256, 256), 'ok.jpg'), null, 'a square JPEG');
  t.equal(pictureProblem(png(minPixels, minPixels), 'small.png'), null, 'the smallest allowed');
  t.equal(pictureProblem(png(maxPixels, maxPixels), 'big.png'), null, 'the largest allowed');

  t.match(pictureProblem(png(256, 200), 'wide.png'), /square/, 'a rectangle');
  t.match(pictureProblem(png(minPixels - 1, minPixels - 1), 'tiny.png'), /at least/);
  t.match(pictureProblem(png(maxPixels + 1, maxPixels + 1), 'huge.png'), /no more than/);
  t.match(pictureProblem(png(64, 64), 'me.webp'), /PNG or a JPEG/, 'a format we do not take');
  t.match(
    pictureProblem(png(256, 256, { padTo: maxBytes + 64 }), 'fat.png'),
    /under/,
    'more bytes than a picture needs'
  );
});

t.test('square is square enough', async (t) => {
  // A 512×515 export is square to anybody looking at it, and rejecting it
  // would be a rule about arithmetic rather than about pictures.
  t.equal(pictureProblem(png(512, 515), 'close.png'), null, 'a few pixels out');
  t.match(pictureProblem(png(512, 560), 'off.png'), /square/, 'visibly not square');
});
