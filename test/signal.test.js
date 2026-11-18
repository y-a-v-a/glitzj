const test = require('node:test');
const assert = require('node:assert/strict');
const { load, noisePicture, smoothPicture, run } = require('./helpers/load.js');

load('pixels.js', 'signal.js');

// A perfect cable: nothing added, nothing smeared.
const clean = { noise: 0, ghost: 0, jitter: 0, wobble: 0, hhold: 0, vhold: 0, tracking: 0, dropouts: 0, hue: 0, bleed: 0, soft: 0 };
const receive = (picture, settings, frame = 0) => run(signalSteps({ ...picture, cache: {} }, { ...clean, ...settings }, frame));

function meanDifference(a, b) {
  assert.equal(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

test('the raster follows the number of lines and the shape of the picture', () => {
  assert.deepEqual(signalRaster(768, 512, '480'), { rows: 480, columns: 720, samples: 848 });
  assert.deepEqual(signalRaster(768, 512, '240'), { rows: 240, columns: 360, samples: 424 });
  assert.equal(signalRaster(768, 512, 'source').rows, 512);
  assert.equal(signalRaster(300, 200, '480').rows, 200, 'a small picture keeps its own lines');
  assert.equal(signalRaster(4000, 100, '480').columns, 4000);
});

test('a gray picture has no color wave; a colored one has, at four samples per wave', () => {
  const gray = new Uint8ClampedArray(64 * 16 * 4).fill(120);
  const encodedGray = signalEncode(gray, 64, 16, signalRaster(64, 16, 'source'));
  assert.ok(encodedGray.chroma.every(v => Math.abs(v) < 1e-6));
  assert.ok(encodedGray.luma.every(v => Math.abs(v - 120 / 255) < 1e-3));

  const red = new Uint8ClampedArray(64 * 16 * 4);
  for (let i = 0; i < red.length; i += 4) { red[i] = 255; red[i + 3] = 255; }
  const { chroma, samples } = signalEncode(red, 64, 16, signalRaster(64, 16, 'source'));
  for (let x = 8; x < samples - 8; x++) {
    assert.ok(Math.abs(chroma[x] + chroma[x + 2]) < 1e-6, 'half a wave later the wave is upside down');
    assert.ok(Math.abs(chroma[x] - chroma[x + 4]) < 1e-6, 'a whole wave later it is back');
  }
  assert.ok(Math.max(...chroma) > 0.3);
});

test('over a perfect cable a soft picture arrives almost as it was sent, with either color receiver', () => {
  const picture = smoothPicture(160, 120);
  for (const decoder of ['notch', 'comb']) {
    const out = receive(picture, { lines: 'source', decoder });
    assert.equal(out.width, 160);
    assert.equal(out.height, 120);
    const error = meanDifference(out.rgba, picture.rgba);
    assert.ok(error < 5, `${decoder}: mean error ${error.toFixed(2)}`);
  }
});

test('fine detail turns into false color with a notch filter, and a black and white set shows the wave as dots', () => {
  // Vertical stripes two samples wide are exactly what the color wave looks like.
  const picture = { width: 400, height: 40, rgba: new Uint8ClampedArray(400 * 40 * 4) };
  for (let i = 0; i < picture.rgba.length; i += 4) picture.rgba[i + 3] = 255;
  const samples = signalRaster(400, 40, 'source').samples;
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 400; x++) {
      const v = Math.floor(x * samples / 400 / 2) % 2 ? 230 : 25;
      picture.rgba.fill(v, (y * 400 + x) * 4, (y * 400 + x) * 4 + 3);
    }
  }
  const colorful = data => { let n = 0; for (let i = 0; i < data.length; i += 4) if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 40) n++; return n / (data.length / 4); };
  assert.equal(colorful(picture.rgba), 0);
  assert.ok(colorful(receive(picture, { lines: 'source', decoder: 'notch' }).rgba) > 0.5, 'rainbows');

  const flatRed = { width: 200, height: 20, rgba: new Uint8ClampedArray(200 * 20 * 4) };
  for (let i = 0; i < flatRed.rgba.length; i += 4) { flatRed.rgba[i] = 220; flatRed.rgba[i + 3] = 255; }
  const mono = receive(flatRed, { lines: 'source', decoder: 'mono' }).rgba;
  let lo = 255, hi = 0;
  for (let i = 40 * 4; i < 160 * 4; i += 4) {
    assert.ok(mono[i] === mono[i + 1] && mono[i] === mono[i + 2], 'gray');
    lo = Math.min(lo, mono[i]);
    hi = Math.max(hi, mono[i]);
  }
  assert.ok(hi - lo > 60, 'a flat red field shows up as a pattern of dots');
});

test('the color and tint knobs do what they say', () => {
  const picture = smoothPicture(120, 60);
  const gray = receive(picture, { lines: 'source', color: 0 }).rgba;
  for (let i = 0; i < gray.length; i += 4) assert.ok(Math.abs(gray[i] - gray[i + 1]) <= 1 && Math.abs(gray[i] - gray[i + 2]) <= 1);

  const normal = receive(picture, { lines: 'source' }).rgba;
  const turned = receive(picture, { lines: 'source', tint: 180 }).rgba;
  const full = receive(picture, { lines: 'source', tint: 360 }).rgba;
  assert.ok(meanDifference(normal, turned) > 10);
  assert.ok(meanDifference(normal, full) < 0.5, 'all the way round is back where it started');
});

test('vertical hold slips the picture and shows the gap between frames as a black bar', () => {
  const picture = smoothPicture(100, 100);
  const steady = receive(picture, { lines: 'source', decoder: 'mono' });
  const slipped = receive(picture, { lines: 'source', decoder: 'mono', vhold: 50 });
  const frameRows = 100 + Math.round(100 * SIGNAL_VBLANK);
  const roll = Math.round(0.5 * frameRows);
  const row = (result, y) => Array.from(result.rgba.subarray(y * 100 * 4, (y + 1) * 100 * 4));
  let black = 0;
  for (let y = 0; y < 100; y++) {
    const from = (y + roll) % frameRows;
    if (from >= 100) { assert.ok(row(slipped, y).every((v, i) => i % 4 === 3 || v === 0)); black++; }
    else assert.deepEqual(row(slipped, y), row(steady, from));
  }
  assert.equal(black, frameRows - 100);
});

test('horizontal hold leans the picture over and shows the gap between lines', () => {
  const white = { width: 200, height: 100, rgba: new Uint8ClampedArray(200 * 100 * 4).fill(255) };
  const out = receive(white, { lines: 'source', decoder: 'mono', hhold: 60 }).rgba;
  const firstDark = y => { for (let x = 0; x < 200; x++) if (out[(y * 200 + x) * 4] < 40) return x; return -1; };
  assert.equal(firstDark(0), -1, 'the first line starts on time');
  const positions = [20, 30, 40, 50].map(firstDark);
  assert.ok(positions.every(x => x >= 0), 'further down the dark gap is in the picture');
  assert.ok(positions[1] > positions[0] && positions[2] > positions[1] && positions[3] > positions[2], `the gap leans: ${positions}`);
});

test('snow, jumps and tape trouble follow the seed; a moving picture changes from frame to frame', () => {
  const picture = smoothPicture(120, 80);
  const worn = { lines: 'source', noise: 40, ghost: 30, jitter: 60, wobble: 40, tracking: 50, dropouts: 60, hue: 40, bleed: 50, soft: 40 };
  const a = receive(picture, { ...worn, seed: 3 }).rgba;
  assert.deepEqual(receive(picture, { ...worn, seed: 3 }).rgba, a);
  assert.notDeepEqual(receive(picture, { ...worn, seed: 4 }).rgba, a);
  const f1 = receive(picture, { ...worn, seed: 3 }, 1).rgba, f2 = receive(picture, { ...worn, seed: 3 }, 2).rgba;
  assert.notDeepEqual(f1, a);
  assert.notDeepEqual(f2, f1);
  assert.deepEqual(receive(picture, { ...worn, seed: 3 }, 2).rgba, f2);
  assert.ok(a.every((v, i) => i % 4 !== 3 || v === 255));
});

test('every kind of damage changes the picture, and none of them breaks it', () => {
  const picture = noisePicture(90, 60);
  const base = receive(picture, { lines: 'source' }).rgba;
  for (const key of ['noise', 'ghost', 'jitter', 'wobble', 'hhold', 'vhold', 'tracking', 'dropouts', 'hue', 'bleed', 'soft']) {
    const out = receive(picture, { lines: 'source', [key]: 70 });
    assert.equal(out.rgba.length, base.length);
    assert.ok(meanDifference(out.rgba, base) > 0.3, `${key} does something`);
  }
});

test('a result has as many rows as lines were asked for', () => {
  const picture = smoothPicture(300, 600);
  const out = receive(picture, { lines: '240' });
  assert.equal(out.height, 240);
  assert.equal(out.width, 120);
  assert.equal(out.rgba.length, 240 * 120 * 4);
});
