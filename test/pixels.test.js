const test = require('node:test');
const assert = require('node:assert/strict');
const { load, noisePicture } = require('./helpers/load.js');

load('pixels.js');

test('prng gives the same series for the same seed and another for another', () => {
  const a = prng(7), b = prng(7), c = prng(8);
  const as = Array.from({ length: 20 }, a), bs = Array.from({ length: 20 }, b), cs = Array.from({ length: 20 }, c);
  assert.deepEqual(as, bs);
  assert.notDeepEqual(as, cs);
  assert.ok(as.every(v => v >= 0 && v < 1));
});

test('hashRandom depends only on its arguments and spreads evenly', () => {
  assert.equal(hashRandom(12, 34), hashRandom(12, 34));
  assert.notEqual(hashRandom(12, 34), hashRandom(34, 12));
  let sum = 0;
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 20000; i++) {
    const v = hashRandom(i, 3);
    assert.ok(v >= 0 && v < 1);
    sum += v;
    buckets[Math.floor(v * 10)]++;
  }
  assert.ok(Math.abs(sum / 20000 - 0.5) < 0.01);
  assert.ok(buckets.every(n => n > 1700 && n < 2300), buckets.join(' '));
});

test('gaussian has mean 0 and deviation 1', () => {
  const next = gaussian(prng(3));
  let sum = 0, squares = 0;
  const n = 50000;
  for (let i = 0; i < n; i++) {
    const v = next();
    sum += v;
    squares += v * v;
  }
  assert.ok(Math.abs(sum / n) < 0.02);
  assert.ok(Math.abs(Math.sqrt(squares / n) - 1) < 0.02);
});

test('flattenOnWhite returns opaque pixels untouched and lays the rest over white', () => {
  const { rgba } = noisePicture(4, 4);
  assert.equal(flattenOnWhite(rgba), rgba);
  const clear = Uint8ClampedArray.from([10, 20, 30, 0, 100, 0, 200, 255, 0, 0, 0, 128]);
  const flat = flattenOnWhite(clear);
  assert.deepEqual(Array.from(flat.subarray(0, 8)), [255, 255, 255, 255, 100, 0, 200, 255]);
  assert.ok(Math.abs(flat[8] - 127) <= 1);
  assert.equal(flat[11], 255);
});

test('resizePixels keeps the size it has, averages when shrinking, interpolates when enlarging', () => {
  const { rgba, width, height } = noisePicture(8, 6);
  assert.equal(resizePixels(rgba, width, height, 8, 6), rgba);

  const half = resizePixels(rgba, width, height, 4, 3);
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++) {
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) sum += rgba[((y * 2 + dy) * 8 + x * 2 + dx) * 4 + ch];
        assert.ok(Math.abs(half[(y * 4 + x) * 4 + ch] - sum / 4) <= 1);
      }
    }
  }

  const flat = new Uint8ClampedArray(5 * 5 * 4).fill(77);
  assert.ok(resizePixels(flat, 5, 5, 13, 9).every(v => v === 77));
  assert.ok(resizePixels(flat, 5, 5, 2, 3).every(v => v === 77));

  const ramp = Uint8ClampedArray.from([0, 0, 0, 255, 100, 100, 100, 255]);
  const wide = resizePixels(ramp, 2, 1, 4, 1);
  assert.deepEqual([wide[0], wide[4], wide[8], wide[12]], [0, 25, 75, 100]);
});
