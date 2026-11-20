const test = require('node:test');
const assert = require('node:assert/strict');
const { load, noisePicture, smoothPicture, run } = require('./helpers/load.js');

load('pixels.js', 'mosh.js');

const mosh = (picture, settings, donor) => run(moshSteps({ ...picture, cache: {} }, { size: 'source', ...settings }, donor));

test('the frame size limits the longest side and never enlarges', () => {
  assert.deepEqual(moshSize(4000, 2000, '1280'), { width: 1280, height: 640 });
  assert.deepEqual(moshSize(600, 1200, '640'), { width: 320, height: 640 });
  assert.deepEqual(moshSize(300, 200, '1280'), { width: 300, height: 200 });
  assert.deepEqual(moshSize(3000, 2000, 'source'), { width: 3000, height: 2000 });
});

test('the next frame is the picture moved: not at all at strength 0, by whole pixels in a pan', () => {
  const { rgba, width, height } = noisePicture(60, 40);
  for (const motion of ['zoom', 'pan', 'spin']) {
    assert.deepEqual(moshNextFrame(rgba, width, height, motion, 0, 30), rgba, motion);
  }
  const next = moshNextFrame(rgba, width, height, 'pan', 100, 0);       // 3% of 60 px, to the right
  for (let y = 0; y < height; y++) {
    for (let x = 2; x < width; x++) assert.equal(next[(y * width + x) * 4], rgba[(y * width + x - 2) * 4]);
  }
  const zoomed = moshNextFrame(rgba, width, height, 'zoom', 100, 0);
  assert.notDeepEqual(zoomed, rgba);
});

test('the search finds where the blocks of a panned frame came from', () => {
  const { rgba, width, height } = smoothPicture(128, 96);
  // Soft texture: a step-by-step search needs a slope to walk down.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rgba[(y * width + x) * 4 + 1] = 128 + 60 * Math.sin(x / 9) + 60 * Math.cos(y / 7);
  }
  const next = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(width - 1, Math.max(0, x - 5)), sy = Math.min(height - 1, Math.max(0, y + 3));
      next.set(rgba.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * width + x) * 4);
    }
  }
  const { vx, vy, cols, rows } = moshSearch(moshLuma(rgba, width * height), moshLuma(next, width * height), width, height, 16);
  assert.deepEqual([cols, rows], [8, 6]);
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) assert.deepEqual([vx[r * cols + c], vy[r * cols + c]], [-5, 3]);
  }
});

test('in a flat picture nothing is found to move', () => {
  const flat = new Uint8Array(64 * 64).fill(90);
  const { vx, vy } = moshSearch(flat, flat, 64, 64, 16);
  assert.ok(vx.every(v => v === 0) && vy.every(v => v === 0));
});

test('no frames is the picture itself; with the full correction, one frame is exactly the next frame', () => {
  const picture = noisePicture(96, 64, 3);
  assert.deepEqual(mosh(picture, { frames: 0 }).rgba, picture.rgba);

  const settings = { motion: 'spin', strength: 70, block: '16' };
  const next = moshNextFrame(picture.rgba, 96, 64, 'spin', 70, 0);
  assert.deepEqual(mosh(picture, { ...settings, frames: 1, correction: 100 }).rgba, next, 'a codec that keeps its correction decodes the frame it encoded');
  assert.notDeepEqual(mosh(picture, { ...settings, frames: 1, correction: 0 }).rgba, next, 'without it only what the vectors explain arrives');
});

test('without a correction a frame only ever holds pixels of the picture, moved', () => {
  const picture = noisePicture(64, 48, 5);
  const colors = new Set();
  for (let i = 0; i < picture.rgba.length; i += 4) colors.add(`${picture.rgba[i]},${picture.rgba[i + 1]},${picture.rgba[i + 2]}`);
  const out = mosh(picture, { motion: 'zoom', strength: 80, frames: 12 }).rgba;
  let moved = 0;
  for (let i = 0; i < out.length; i += 4) {
    assert.ok(colors.has(`${out[i]},${out[i + 1]},${out[i + 2]}`));
    assert.equal(out[i + 3], 255);
    if (out[i] !== picture.rgba[i]) moved++;
  }
  assert.ok(moved > 500);
});

test('a run that is continued gives the same frames as one started from the beginning', () => {
  const picture = smoothPicture(80, 60);
  const settings = { motion: 'zoom', strength: 60, correction: 20, size: 'source' };
  const source = { ...picture, cache: {} };
  const five = run(moshSteps(source, { ...settings, frames: 5 })).rgba;
  const nine = run(moshSteps(source, { ...settings, frames: 9 })).rgba;
  const three = run(moshSteps(source, { ...settings, frames: 3 })).rgba;
  assert.deepEqual(five, mosh(picture, { ...settings, frames: 5 }).rgba);
  assert.deepEqual(nine, mosh(picture, { ...settings, frames: 9 }).rgba);
  assert.deepEqual(three, mosh(picture, { ...settings, frames: 3 }).rgba, 'going back starts over');
  assert.notDeepEqual(five, nine);
  const other = run(moshSteps(source, { ...settings, motion: 'spin', frames: 9 })).rgba;
  assert.deepEqual(other, mosh(picture, { ...settings, motion: 'spin', frames: 9 }).rgba, 'other instructions start over too');
});

test('fall moves bright blocks further than dark ones; scatter follows the seed', () => {
  const luma = new Uint8Array(64 * 32);
  luma.fill(255, 0, 64 * 16);                       // bright top half, black bottom half
  const fall = moshInvent(luma, 64, 32, 16, 'fall', 100, 90, 1);
  assert.deepEqual(Array.from(fall.vy), [-24, -24, -24, -24, 0, 0, 0, 0]);
  assert.ok(fall.vx.every(v => Math.abs(v) === 0));
  const sideways = moshInvent(luma, 64, 32, 16, 'fall', 100, 0, 1);
  assert.deepEqual(Array.from(sideways.vx.subarray(0, 4)), [-24, -24, -24, -24]);

  const a = moshInvent(luma, 64, 32, 8, 'scatter', 50, 0, 7), b = moshInvent(luma, 64, 32, 8, 'scatter', 50, 0, 7), c = moshInvent(luma, 64, 32, 8, 'scatter', 50, 0, 8);
  assert.deepEqual(a.vx, b.vx);
  assert.notDeepEqual(a.vx, c.vx);
  assert.ok(a.vx.every(v => Math.abs(v) <= 6) && a.vy.every(v => Math.abs(v) <= 6));
});

test('another picture as the next frame: fully corrected it arrives whole, uncorrected it is built from this picture', () => {
  const picture = noisePicture(64, 48, 2);
  const other = { ...smoothPicture(32, 24), id: 1 };
  const arrived = mosh(picture, { motion: 'donor', frames: 1, correction: 100 }, other).rgba;
  assert.deepEqual(arrived, resizePixels(other.rgba, 32, 24, 64, 48));

  const built = mosh(picture, { motion: 'donor', frames: 1 }, other).rgba;
  const colors = new Set();
  for (let i = 0; i < picture.rgba.length; i += 4) colors.add(`${picture.rgba[i]},${picture.rgba[i + 1]},${picture.rgba[i + 2]}`);
  for (let i = 0; i < built.length; i += 4) assert.ok(colors.has(`${built[i]},${built[i + 1]},${built[i + 2]}`));

  assert.deepEqual(mosh(picture, { motion: 'donor', frames: 4 }, null).rgba, mosh(picture, { motion: 'zoom', frames: 4 }).rgba, 'with no other picture it zooms');
});

test('odd sizes, tiny pictures and every block size work, and the source is never changed', () => {
  for (const [w, h] of [[1, 1], [5, 3], [17, 33], [100, 7]]) {
    const picture = noisePicture(w, h);
    const original = Uint8ClampedArray.from(picture.rgba);
    for (const block of MOSH_BLOCKS) {
      for (const motion of ['zoom', 'pan', 'spin', 'fall', 'scatter']) {
        const out = mosh(picture, { motion, block, frames: 3, correction: 30, strength: -100 });
        assert.deepEqual([out.width, out.height, out.rgba.length], [w, h, w * h * 4], `${w}×${h} ${motion} ${block}`);
      }
    }
    assert.deepEqual(picture.rgba, original);
  }
});
