const test = require('node:test');
const assert = require('node:assert/strict');
const { load, lcg, noisePicture, run } = require('./helpers/load.js');

load('pixels.js', 'sort.js');

const LO = 3;   // every line is tested in the middle of a longer array, to catch writes outside the span

function packedLine(keys) {
  const a = new Float64Array(keys.length + 2 * LO);
  keys.forEach((key, i) => { a[LO + i] = key * SORT_POS + LO + i; });
  return a;
}

function runAlgorithm(name, keys, t, seed = 1) {
  const a = packedLine(keys);
  SORT_FNS[name](a, LO, LO + keys.length, t, new Float64Array(keys.length * 2 + 16), SORT_KEY_BITS, prng(seed));
  assert.ok(a.subarray(0, LO).every(v => v === 0) && a.subarray(LO + keys.length).every(v => v === 0), `${name} wrote outside its span`);
  return Array.from(a.subarray(LO, LO + keys.length));
}

const sortedLine = keys => Array.from(packedLine(keys).subarray(LO, LO + keys.length)).sort((x, y) => x - y);
const keyOf = v => Math.floor(v / SORT_POS);

function randomLines(count, seed = 9) {
  const rand = lcg(seed);
  return Array.from({ length: count }, () => {
    const n = 2 + Math.floor(rand() * 60);
    return { keys: Array.from({ length: n }, () => Math.floor(rand() * 24)), t: rand() };
  });
}

test('every algorithm only rearranges, does nothing at 0 and finishes at 1', () => {
  for (const { keys, t } of randomLines(150)) {
    const start = Array.from(packedLine(keys).subarray(LO, LO + keys.length));
    const done = sortedLine(keys);
    for (const name of SORT_ALGORITHMS) {
      assert.deepEqual(runAlgorithm(name, keys, 0), start, `${name} at 0`);
      assert.deepEqual(runAlgorithm(name, keys, 1), done, `${name} at 1`);
      assert.deepEqual(runAlgorithm(name, keys, t).sort((x, y) => x - y), done, `${name} keeps every pixel`);
    }
  }
});

test('bubble sort equals that many passes of a literal bubble sort', () => {
  for (const { keys, t } of randomLines(300, 2)) {
    const n = keys.length;
    const passes = Math.round(t * t * (n - 1));
    const naive = Array.from(packedLine(keys).subarray(LO, LO + n));
    for (let p = 0; p < passes; p++) {
      for (let i = 0; i + 1 < n; i++) if (naive[i] > naive[i + 1]) [naive[i], naive[i + 1]] = [naive[i + 1], naive[i]];
    }
    assert.deepEqual(runAlgorithm('bubble', keys, t), naive);
  }
});

test('selection sort equals that many rounds of a literal selection sort', () => {
  for (const { keys, t } of randomLines(300, 3)) {
    const n = keys.length;
    const rounds = Math.min(n, Math.round(t * n));
    const naive = Array.from(packedLine(keys).subarray(LO, LO + n));
    for (let i = 0; i < rounds; i++) {
      let best = i;
      for (let j = i + 1; j < n; j++) if (naive[j] < naive[best]) best = j;
      [naive[i], naive[best]] = [naive[best], naive[i]];
    }
    assert.deepEqual(runAlgorithm('selection', keys, t), naive);
  }
});

test('insertion sort has sorted the first part and not touched the rest', () => {
  for (const { keys, t } of randomLines(100, 4)) {
    const n = keys.length, m = Math.round(t * n);
    const start = Array.from(packedLine(keys).subarray(LO, LO + n));
    const out = runAlgorithm('insertion', keys, t);
    assert.deepEqual(out.slice(0, m), start.slice(0, m).sort((x, y) => x - y));
    assert.deepEqual(out.slice(m), start.slice(m));
  }
});

test('merge sort leaves sorted runs of a power of two', () => {
  const rand = lcg(5);
  const keys = Array.from({ length: 64 }, () => Math.floor(rand() * 100));
  const out = runAlgorithm('merge', keys, 0.5);       // 3 of 6 rounds: runs of 8
  for (let s = 0; s < 64; s += 8) {
    for (let i = s + 1; i < s + 8; i++) assert.ok(out[i - 1] < out[i]);
    assert.deepEqual(out.slice(s, s + 8).map(v => v % SORT_POS).sort((x, y) => x - y), Array.from({ length: 8 }, (_, i) => LO + s + i), 'pixels stay inside their run');
  }
  assert.ok(out.some((v, i) => i > 0 && out[i - 1] > v), 'not sorted as a whole');
});

test('shell sort has sorted every gap-th pixel among themselves', () => {
  const rand = lcg(6);
  const keys = Array.from({ length: 64 }, () => Math.floor(rand() * 100));
  const gaps = [32, 16, 8, 4, 2, 1];
  for (let done = 1; done < gaps.length; done++) {
    const out = runAlgorithm('shell', keys, done / gaps.length);
    const gap = gaps[done - 1];
    for (let i = gap; i < 64; i++) assert.ok(out[i - gap] < out[i], `gap ${gap}`);
  }
});

test('heap sort has built a heap after a quarter, then moves the largest to the end', () => {
  const rand = lcg(7);
  const keys = Array.from({ length: 50 }, () => Math.floor(rand() * 100));
  const heap = runAlgorithm('heap', keys, 0.25);
  for (let i = 1; i < 50; i++) assert.ok(heap[(i - 1) >> 1] > heap[i], 'parent larger than child');

  const later = runAlgorithm('heap', keys, 0.625);       // half of the 49 removals
  const taken = Math.round(0.5 * 49);
  assert.deepEqual(later.slice(50 - taken), sortedLine(keys).slice(50 - taken));
  for (let i = 1; i < 50 - taken; i++) assert.ok(later[(i - 1) >> 1] > later[i]);
});

test('quicksort has split each part around a pivot, one level per step', () => {
  const rand = lcg(8);
  const keys = Array.from({ length: 200 }, () => Math.floor(rand() * 1000));
  const maxDepth = Math.ceil(Math.log2(200)) + 2;
  const out = runAlgorithm('quick', keys, 1 / maxDepth);
  let split = -1;
  for (let cut = 1; cut < 200 && split < 0; cut++) {
    if (Math.max(...out.slice(0, cut)) < Math.min(...out.slice(cut))) split = cut;
  }
  assert.ok(split > 0, 'a point with everything smaller before it');
  assert.ok(out.some((v, i) => i > 0 && out[i - 1] > v), 'the parts are not sorted yet');
});

test('radix sort is in stable order of the lowest bits only', () => {
  const rand = lcg(10);
  const keys = Array.from({ length: 80 }, () => Math.floor(rand() * 1024));
  for (const bits of [1, 3, 7]) {
    const out = runAlgorithm('radix', keys, bits / SORT_KEY_BITS);
    const mask = (1 << bits) - 1;
    for (let i = 1; i < out.length; i++) {
      const a = keyOf(out[i - 1]) & mask, b = keyOf(out[i]) & mask;
      assert.ok(a < b || (a === b && out[i - 1] % SORT_POS < out[i] % SORT_POS), `bits ${bits}`);
    }
  }
});

test('bogo follows the seed', () => {
  const keys = Array.from({ length: 40 }, (_, i) => i);
  assert.deepEqual(runAlgorithm('bogo', keys, 0.5, 3), runAlgorithm('bogo', keys, 0.5, 3));
  assert.notDeepEqual(runAlgorithm('bogo', keys, 0.5, 3), runAlgorithm('bogo', keys, 0.5, 4));
});

test('sort keys stay within their bits', () => {
  const rand = lcg(11);
  for (let i = 0; i < 2000; i++) {
    const r = Math.floor(rand() * 256), g = Math.floor(rand() * 256), b = Math.floor(rand() * 256);
    for (const key of SORT_KEYS) {
      const v = SORT_KEY_FNS[key](r, g, b);
      assert.ok(Number.isInteger(v) && v >= 0 && v < 2 ** sortKeyBits(key), `${key}(${r},${g},${b}) = ${v}`);
    }
  }
  assert.equal(SORT_KEY_FNS.brightness(255, 255, 255), 1020);
  assert.equal(SORT_KEY_FNS.number(1, 2, 3), 0x010203);
  assert.equal(SORT_KEY_FNS.hue(255, 0, 0), 0);
  assert.equal(SORT_KEY_FNS.saturation(128, 128, 128), 0);
});

// ── The whole pipeline ────────────────────────────────────────────────────────

const sortPicture = (picture, settings) => run(sortSteps(picture, settings));
const brightness = (rgba, i) => SORT_KEY_FNS.brightness(rgba[i], rgba[i + 1], rgba[i + 2]);

test('finished, every algorithm gives the same picture and every line is in order', () => {
  const picture = noisePicture(40, 12);
  const { width, height } = picture;
  const first = sortPicture(picture, { algorithm: 'bubble', progress: 100, span: 'all' });
  for (const algorithm of SORT_ALGORITHMS) {
    assert.deepEqual(sortPicture(picture, { algorithm, progress: 100, span: 'all' }).rgba, first.rgba, algorithm);
  }
  assert.equal(first.sorted, width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width; x++) {
      assert.ok(brightness(first.rgba, (y * width + x - 1) * 4) <= brightness(first.rgba, (y * width + x) * 4));
    }
  }
});

test('the direction sets the axis and which end the bright pixels go to', () => {
  const picture = noisePicture(16, 14);
  const { width, height } = picture;
  const at = (rgba, x, y) => brightness(rgba, (y * width + x) * 4);
  const left = sortPicture(picture, { progress: 100, span: 'all', direction: 'left' }).rgba;
  const down = sortPicture(picture, { progress: 100, span: 'all', direction: 'down' }).rgba;
  const up = sortPicture(picture, { progress: 100, span: 'all', direction: 'up' }).rgba;
  for (let y = 0; y < height; y++) for (let x = 1; x < width; x++) assert.ok(at(left, x - 1, y) >= at(left, x, y));
  for (let x = 0; x < width; x++) {
    for (let y = 1; y < height; y++) {
      assert.ok(at(down, x, y - 1) <= at(down, x, y));
      assert.ok(at(up, x, y - 1) >= at(up, x, y));
    }
  }
});

test('pixels only move within their own line, and at 0 nothing moves', () => {
  const picture = noisePicture(30, 10);
  const { rgba, width, height } = picture;
  assert.deepEqual(sortPicture(picture, { progress: 0, span: 'all' }).rgba, rgba);
  const pixelsOfRow = (data, y) => Array.from({ length: width }, (_, x) => Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)).join()).sort();
  for (const algorithm of SORT_ALGORITHMS) {
    const out = sortPicture(picture, { algorithm, progress: 40, span: 'chunks', size: 60, seed: 5 }).rgba;
    for (let y = 0; y < height; y++) assert.deepEqual(pixelsOfRow(out, y), pixelsOfRow(rgba, y), algorithm);
  }
});

test('with a brightness range, pixels outside it stay where they are and end the spans', () => {
  const picture = noisePicture(60, 20, 4);
  const { rgba, width, height } = picture;
  const low = 30, high = 70;
  const result = sortPicture(picture, { progress: 100, span: 'threshold', low, high });
  const inRange = i => { const v = brightness(rgba, i) >> 2; return v >= low * 2.55 && v <= high * 2.55; };
  let moved = 0, counted = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const same = [0, 1, 2].every(ch => result.rgba[i + ch] === rgba[i + ch]);
      if (!inRange(i)) assert.ok(same, 'a pixel outside the range moved');
      else if (!same) moved++;
      // inside a span, order holds between neighbors that are both in range
      if (x > 0 && inRange(i) && inRange(i - 4)) {
        assert.ok(brightness(result.rgba, i - 4) <= brightness(result.rgba, i));
        counted++;
      }
    }
  }
  assert.ok(moved > 50 && counted > 50);
  assert.ok(result.sorted > 0 && result.sorted < width * height);
});

test('chunks, uneven stops and bogo follow the seed; the source is never changed', () => {
  const picture = noisePicture(50, 8);
  const original = Uint8ClampedArray.from(picture.rgba);
  for (const settings of [{ span: 'chunks' }, { span: 'all', jitter: 80 }, { span: 'all', algorithm: 'bogo' }]) {
    const a = sortPicture(picture, { ...settings, seed: 2 }).rgba;
    assert.deepEqual(sortPicture(picture, { ...settings, seed: 2 }).rgba, a);
    assert.notDeepEqual(sortPicture(picture, { ...settings, seed: 3 }).rgba, a);
  }
  assert.deepEqual(picture.rgba, original);
});

test('a brightness range up to 100 includes pure white', () => {
  const rgba = new Uint8ClampedArray(8 * 4).fill(255);
  const result = run(sortSteps({ rgba, width: 8, height: 1 }, { span: 'threshold', low: 0, high: 100, progress: 100 }));
  assert.equal(result.sorted, 8);
});

