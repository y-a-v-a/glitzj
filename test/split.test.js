const test = require('node:test');
const assert = require('node:assert/strict');
const { load, noisePicture, run } = require('./helpers/load.js');

load('pixels.js', 'split.js');

const split = (picture, settings) => run(splitSteps({ ...picture, cache: {} }, settings));

function maxDifference(a, b) {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

test('with nothing moved the picture comes back: exactly as RGB, within rounding as CMYK and YCbCr', () => {
  const picture = noisePicture(31, 17);
  assert.deepEqual(split(picture, { model: 'rgb' }).rgba, picture.rgba);
  assert.ok(maxDifference(split(picture, { model: 'cmyk' }).rgba, picture.rgba) <= 2);
  assert.ok(maxDifference(split(picture, { model: 'ycc' }).rgba, picture.rgba) <= 3);
});

test('CMYK planes are inks: white paper has none, black is all on the black plate', () => {
  const rgba = Uint8ClampedArray.from([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
  const [c, m, y, k] = splitPlanes(rgba, 3, 1, 'cmyk');
  assert.deepEqual([c[0], m[0], y[0], k[0]], [0, 0, 0, 0]);
  assert.deepEqual([c[1], m[1], y[1], k[1]], [0, 0, 0, 255]);
  assert.deepEqual([c[2], m[2], y[2], k[2]], [0, 255, 255, 0]);
});

test('an offset moves exactly one plane, and wraps around the edges', () => {
  const picture = noisePicture(20, 12);
  const { rgba, width, height } = picture;
  const out = split(picture, { offsets: [3, 2, 0, 0, -5, 0, 0, 0] }).rgba;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const red = (((y - 2 + height) % height) * width + (x - 3 + width) % width) * 4;
      const blue = (y * width + (x + 5) % width) * 4;
      assert.equal(out[o], rgba[red]);
      assert.equal(out[o + 1], rgba[o + 1]);
      assert.equal(out[o + 2], rgba[blue + 2]);
    }
  }
});

test('edges can smear the last pixel or be left blank', () => {
  const picture = noisePicture(16, 4);
  const { rgba, width } = picture;
  const smear = split(picture, { offsets: [5, 0, 0, 0, 0, 0, 0, 0], edge: 'smear' }).rgba;
  const blank = split(picture, { offsets: [5, 0, 0, 0, 0, 0, 0, 0], edge: 'blank' }).rgba;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const moved = rgba[(y * width + x - 5) * 4];
      assert.equal(smear[o], x < 5 ? rgba[y * width * 4] : moved);
      assert.equal(blank[o], x < 5 ? 0 : moved);
    }
  }
  const far = split(picture, { offsets: [-99, 0, 0, 0, 0, 0, 0, 0], edge: 'smear' }).rgba;
  for (let x = 0; x < width; x++) assert.equal(far[x * 4], rgba[(width - 1) * 4]);
});

test('a blank plane is no light in RGB, no ink in CMYK and no color in YCbCr', () => {
  const picture = noisePicture(8, 8);
  const gone = [99, 0, 99, 0, 99, 0, 99, 0];
  assert.ok(split(picture, { model: 'rgb', offsets: gone, edge: 'blank' }).rgba.every((v, i) => v === (i % 4 === 3 ? 255 : 0)));
  assert.ok(split(picture, { model: 'cmyk', offsets: gone, edge: 'blank' }).rgba.every(v => v === 255));
  const gray = split(picture, { model: 'ycc', offsets: [0, 0, 99, 0, 99, 0, 0, 0], edge: 'blank' }).rgba;
  for (let i = 0; i < gray.length; i += 4) assert.ok(gray[i] === gray[i + 1] && gray[i + 1] === gray[i + 2]);
});

test('wiring feeds each plane from another', () => {
  const picture = noisePicture(9, 5);
  const { rgba } = picture;
  const next = split(picture, { wiring: 'next' }).rgba;
  const mirror = split(picture, { wiring: 'mirror' }).rgba;
  for (let i = 0; i < rgba.length; i += 4) {
    assert.deepEqual([next[i], next[i + 1], next[i + 2]], [rgba[i + 1], rgba[i + 2], rgba[i]]);
    assert.deepEqual([mirror[i], mirror[i + 1], mirror[i + 2]], [rgba[i + 2], rgba[i + 1], rgba[i]]);
  }
  assert.deepEqual(splitWiring('previous', 4), [3, 0, 1, 2]);
});

test('zoom and twist move the outer planes in opposite directions and leave the middle one alone', () => {
  assert.deepEqual([0, 1, 2].map(p => splitSpread(p, 3)), [-1, 0, 1]);
  assert.deepEqual([0, 3].map(p => splitSpread(p, 4)), [-1, 1]);
  const picture = noisePicture(24, 24);
  const out = split(picture, { zoom: 80, twist: -60 }).rgba;
  let redMoved = 0, blueMoved = 0;
  for (let i = 0; i < out.length; i += 4) {
    assert.equal(out[i + 1], picture.rgba[i + 1]);
    if (out[i] !== picture.rgba[i]) redMoved++;
    if (out[i + 2] !== picture.rgba[i + 2]) blueMoved++;
  }
  assert.ok(redMoved > 200 && blueMoved > 200);
});

test('tear cuts all planes into the same bands, moves them apart, and follows the seed', () => {
  assert.equal(tearOffsets(100, 80, 3, { tear: 0, band: 30, seed: 1 }), null);
  const a = tearOffsets(400, 300, 3, { tear: 50, band: 20, seed: 4 });
  const b = tearOffsets(400, 300, 3, { tear: 50, band: 20, seed: 4 });
  const c = tearOffsets(400, 300, 3, { tear: 50, band: 20, seed: 5 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);

  const edges = plane => { const at = []; for (let y = 1; y < 300; y++) if (plane[y] !== plane[y - 1]) at.push(y); return at; };
  const all = new Set(a.flatMap(edges));
  assert.ok(all.size >= 3, 'several bands');
  assert.ok(a.some((plane, p) => p > 0 && plane.some((v, y) => v !== a[0][y])), 'planes move differently');
  assert.ok(a.every(plane => plane.every(v => Math.abs(v) <= 400 * SPLIT_MAX_TEAR)));
  assert.ok(a[0].some(v => v === 0) && a[0].some(v => v !== 0), 'some bands tear and some do not');
});

test('transparency stays where it was', () => {
  const picture = noisePicture(10, 6);
  for (let i = 3; i < picture.rgba.length; i += 4) picture.rgba[i] = (i * 7) % 256;
  const out = split(picture, { offsets: [4, 1, -2, 0, 0, 3, 0, 0], twist: 30 }).rgba;
  for (let i = 3; i < out.length; i += 4) assert.equal(out[i], picture.rgba[i]);
});

test('switching the model on the same picture does not reuse the old planes', () => {
  const source = { ...noisePicture(12, 12), cache: {} };
  const rgb = run(splitSteps(source, { model: 'rgb', offsets: [2, 0, 0, 0, 0, 0, 0, 0] })).rgba;
  run(splitSteps(source, { model: 'cmyk', offsets: [2, 0, 0, 0, 0, 0, 0, 0] }));
  assert.deepEqual(run(splitSteps(source, { model: 'rgb', offsets: [2, 0, 0, 0, 0, 0, 0, 0] })).rgba, rgb);
});
