const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers/load.js');

load('export.js');

const E = Exporter;
const png = { width: 800, height: 600, ext: 'png' };
const jpg = { width: 800, height: 600, ext: 'jpg' };
const gif = { width: 800, height: 600, ext: 'gif' };

test('out of the box, export saves the result itself', () => {
  for (const result of [png, jpg, gif]) {
    const planned = E.plan(result, E.defaults());
    assert.deepEqual([planned.width, planned.height, planned.render, planned.resized, planned.ext], [800, 600, false, false, result.ext]);
    assert.equal(E.fileName('photo_sort_bubble.png', planned), `photo_sort_bubble.${result.ext}`);
  }
  assert.equal(E.summary(E.defaults()), '');
});

test('a size is a share of the result or a width in pixels, and keeps the shape', () => {
  assert.deepEqual([E.plan(png, { size: '25' }).width, E.plan(png, { size: '25' }).height], [200, 150]);
  assert.deepEqual([E.plan(png, { size: '400' }).width, E.plan(png, { size: '400' }).height], [3200, 2400]);
  assert.deepEqual([E.plan(png, { size: 'custom', width: 1000 }).width, E.plan(png, { size: 'custom', width: 1000 }).height], [1000, 750]);
  const thin = E.plan({ width: 1000, height: 3, ext: 'png' }, { size: '25' });
  assert.deepEqual([thin.width, thin.height], [250, 1], 'never less than a pixel high');
  const same = E.plan(png, { size: 'custom', width: 800 });
  assert.ok(!same.resized && !same.render, 'asking for the width it has changes nothing');
});

test('another size or another format takes a rendered copy, in a format a picture can be drawn in', () => {
  const bigger = E.plan(png, { size: '200' });
  assert.deepEqual([bigger.render, bigger.type, bigger.ext], [true, 'image/png', 'png']);
  const biggerJpeg = E.plan(jpg, { size: '200' });
  assert.deepEqual([biggerJpeg.type, biggerJpeg.ext], ['image/jpeg', 'jpg'], 'a resized JPEG stays a JPEG');
  const biggerGif = E.plan(gif, { size: '200' });
  assert.deepEqual([biggerGif.type, biggerGif.ext], ['image/png', 'png'], 'a browser cannot write a GIF, so a resized GIF is a PNG');

  const asWebp = E.plan(png, { format: 'webp' });
  assert.deepEqual([asWebp.render, asWebp.resized, asWebp.type, asWebp.ext], [true, false, 'image/webp', 'webp']);
  const jpegAsJpeg = E.plan(jpg, { format: 'jpeg' });
  assert.ok(!jpegAsJpeg.render, 'a glitched JPEG asked for as JPEG is not redrawn: it would lose what makes it one');
  const gifAsPng = E.plan(gif, { format: 'png', size: '50' });
  assert.deepEqual([gifAsPng.width, gifAsPng.type], [400, 'image/png']);
});

test('a copy is never larger than a browser can make', () => {
  const huge = E.plan({ width: 4000, height: 4000, ext: 'png' }, { size: '400' });
  assert.ok(huge.limited);
  assert.ok(huge.width <= E.MAX_SIDE && huge.height <= E.MAX_SIDE && huge.width * huge.height <= E.MAX_AREA);
  assert.equal(huge.width, huge.height);
  assert.ok(huge.width > 10000, 'but as large as it can be');
  const wide = E.plan({ width: 4000, height: 10, ext: 'png' }, { size: 'custom', width: 16384 });
  assert.ok(!wide.limited);
  assert.ok(!E.plan(png, { size: '400' }).limited);
});

test('a result without a size still gets a plan of at least one pixel', () => {
  const planned = E.plan({ width: 0, height: 0, ext: 'png' }, { size: '200' });
  assert.deepEqual([planned.width, planned.height], [1, 1]);
});

test('a resized copy carries its size in its name, and every copy the right extension', () => {
  assert.equal(E.fileName('cat_split_rgb.png', E.plan(png, { size: '200' })), 'cat_split_rgb_1600x1200.png');
  assert.equal(E.fileName('cat_crush_q0_420.jpg', E.plan(jpg, { format: 'png' })), 'cat_crush_q0_420.png');
  assert.equal(E.fileName('cat.tar.gif', E.plan(gif, { size: '50', format: 'webp' })), 'cat.tar_400x300.webp');
  assert.equal(E.fileName('', E.plan(png, {})), 'image.png');
  assert.equal(E.fileName('noextension', E.plan(png, {})), 'noextension.png');
});

test('remembered options are checked before they are used', () => {
  assert.deepEqual(E.sanitize(null), E.defaults());
  assert.deepEqual(E.sanitize('junk'), E.defaults());
  assert.deepEqual(E.sanitize({ size: '999', width: -5, sharp: 'yes', format: 'bmp', quality: 500 }), { size: '100', width: 1, sharp: true, format: 'made', quality: 100 });
  assert.deepEqual(E.sanitize({ size: 200, width: '1024.4', sharp: false, format: 'jpeg', quality: '80' }), { size: '200', width: 1024, sharp: false, format: 'jpeg', quality: 80 });
  assert.equal(E.sanitize({ width: 1e9 }).width, E.MAX_SIDE);
});

test('the note on the button says what differs from the default', () => {
  assert.equal(E.summary({ size: '200' }), '2×');
  assert.equal(E.summary({ size: '50', format: 'jpeg' }), '50% · JPEG');
  assert.equal(E.summary({ size: 'custom', width: 1920, format: 'webp' }), '1920 px · WebP');
  assert.equal(E.summary({ format: 'png' }), 'PNG');
});
