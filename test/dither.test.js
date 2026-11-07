const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const file of ['png.js', 'strategies.js', 'gif.js', 'dither.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'webapp', file), 'utf8');
  vm.runInThisContext(src, { filename: file });
}

function lzwDecode(data, minCodeSize, pixelCount) {
  const clear = 1 << minCodeSize, end = clear + 1;
  const out = [];
  let dict, width, prev;
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = dict[end] = null;
    width = minCodeSize + 1;
    prev = null;
  };
  reset();
  let bits = 0, nbits = 0, i = 0;
  for (;;) {
    while (nbits < width && i < data.length) { bits |= data[i++] << nbits; nbits += 8; }
    if (nbits < width) throw new Error('ran out of data before the end code');
    const code = bits & ((1 << width) - 1);
    bits >>>= width; nbits -= width;
    if (code === clear) { reset(); continue; }
    if (code === end) break;
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (code === dict.length && prev) entry = [...prev, prev[0]];
    else throw new Error(`bad code ${code}`);
    out.push(...entry);
    if (prev && dict.length < 4096) dict.push([...prev, entry[0]]);
    if (dict.length === 1 << width && width < 12) width++;
    prev = entry;
  }
  assert.equal(out.length, pixelCount, 'decoded pixel count');
  return out;
}

function decodeSingleFrame(bytes) {
  const gif = parseGif(bytes);
  assert.equal(gif.frames.length, 1);
  const frame = gif.frames[0];
  const indices = lzwDecode(frame.data, frame.minCodeSize, frame.width * frame.height);
  const table = gif.colorTables[frame.table];
  return { gif, frame, indices, table: bytes.subarray(table.start, table.start + table.count * 3) };
}

function solid(width, height, rgba) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < out.length; i += 4) out.set(rgba, i);
  return out;
}

function gradient(width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[i] = Math.round(x * 255 / (width - 1));
      out[i + 1] = Math.round(y * 255 / (height - 1));
      out[i + 2] = 128;
      out[i + 3] = 255;
    }
  }
  return out;
}

const BASE = { dither: 'floyd-steinberg', strength: 100, serpentine: true, palette: 'adaptive', colors: 16, dark: '#000000', light: '#ffffff', dot: 1, brightness: 0, contrast: 0, seed: 1 };

test('encodeIndexedGif round-trips indices through an independent decoder', () => {
  for (const colors of [2, 3, 4, 16, 200, 256]) {
    const width = 97, height = 61;
    const random = mulberry32(colors);
    const indices = new Uint8Array(width * height).map(() => Math.floor(random() * colors));
    const palette = new Uint8Array(colors * 3).map((_, i) => i % 256);
    const bytes = encodeIndexedGif({ width, height, indices, palette });
    const decoded = decodeSingleFrame(bytes);
    assert.deepEqual(decoded.indices, Array.from(indices), `${colors} colors`);
    assert.equal(decoded.gif.version, '89a');
    assert.equal(bytes[bytes.length - 1], 0x3B);
  }
});

test('the LZW encoder sends a clear code when its table fills up', () => {
  const width = 300, height = 300;
  const random = mulberry32(7);
  const indices = new Uint8Array(width * height).map(() => Math.floor(random() * 256));
  const bytes = encodeIndexedGif({ width, height, indices, palette: new Uint8Array(768) });
  assert.deepEqual(decodeSingleFrame(bytes).indices, Array.from(indices));
});

test('the end code is written at the width a decoder reads it with, for every image length', () => {
  for (const colors of [4, 16]) {
    const random = mulberry32(colors);
    const all = new Uint8Array(1500).map(() => Math.floor(random() * colors));
    const palette = new Uint8Array(colors * 3);
    for (let n = 1; n <= all.length; n++) {
      const indices = all.subarray(0, n);
      const decoded = decodeSingleFrame(encodeIndexedGif({ width: n, height: 1, indices, palette }));
      assert.deepEqual(decoded.indices, Array.from(indices), `${colors} colors, length ${n}`);
    }
  }
});

test('a one-color image still gets a color table of 2 entries', () => {
  const bytes = encodeIndexedGif({ width: 3, height: 2, indices: new Uint8Array(6), palette: Uint8Array.of(10, 20, 30) });
  const { gif, table } = decodeSingleFrame(bytes);
  assert.equal(gif.colorTables[0].count, 2);
  assert.deepEqual(Array.from(table.subarray(0, 3)), [10, 20, 30]);
});

test('every dither method keeps indices inside the palette', () => {
  const rgba = gradient(40, 30);
  for (const dither of DITHER_METHODS) {
    for (const palette of PALETTE_KINDS) {
      const result = renderDither(rgba, 40, 30, { ...BASE, dither, palette, colors: 5 });
      const { indices, frame } = decodeSingleFrame(result.bytes);
      assert.ok(indices.every(i => i < result.colors), `${dither} / ${palette}`);
      assert.equal(frame.width, 40);
    }
  }
});

test('the same image and settings give the same bytes', () => {
  const rgba = gradient(32, 32);
  for (const dither of DITHER_METHODS) {
    const a = renderDither(rgba, 32, 32, { ...BASE, dither, seed: 5 }).bytes;
    const b = renderDither(rgba, 32, 32, { ...BASE, dither, seed: 5 }).bytes;
    assert.deepEqual(a, b, dither);
  }
});

test('noise dither changes with the seed; other methods ignore it', () => {
  const rgba = gradient(32, 32);
  const noise = s => renderDither(rgba, 32, 32, { ...BASE, dither: 'noise', seed: s }).bytes;
  assert.notDeepEqual(noise(1), noise(2));
  const fs1 = renderDither(rgba, 32, 32, { ...BASE, seed: 1 }).bytes;
  const fs2 = renderDither(rgba, 32, 32, { ...BASE, seed: 2 }).bytes;
  assert.deepEqual(fs1, fs2);
});

test('dot size shrinks the image and enlarging restores the original size', () => {
  const rgba = gradient(50, 35);
  const result = renderDither(rgba, 50, 35, { ...BASE, dot: 4 });
  assert.equal(result.width, 13);
  assert.equal(result.height, 9);

  const small = decodeSingleFrame(result.bytes);
  const big = decodeSingleFrame(result.encode(4));
  assert.equal(big.frame.width, 50);
  assert.equal(big.frame.height, 35);
  for (const [x, y] of [[0, 0], [3, 3], [4, 0], [49, 34], [21, 17]]) {
    assert.equal(big.indices[y * 50 + x], small.indices[Math.floor(y / 4) * 13 + Math.floor(x / 4)], `${x},${y}`);
  }
});

test('error diffusion on a mid gray with black and white gives about half white pixels', () => {
  const rgba = solid(64, 64, [128, 128, 128, 255]);
  for (const dither of Object.keys(DITHER_KERNELS).filter(k => k !== 'atkinson').concat('bayer-8')) {
    const { indices, table } = decodeSingleFrame(renderDither(rgba, 64, 64, { ...BASE, dither, palette: 'grayscale', colors: 2 }).bytes);
    const white = indices.filter(i => table[i * 3] === 255).length / indices.length;
    assert.ok(Math.abs(white - 128 / 255) < 0.03, `${dither}: ${white}`);
  }
});

test('without dithering a mid gray maps to one color', () => {
  const rgba = solid(16, 16, [100, 100, 100, 255]);
  const { indices } = decodeSingleFrame(renderDither(rgba, 16, 16, { ...BASE, dither: 'none', palette: 'grayscale', colors: 2 }).bytes);
  assert.equal(new Set(indices).size, 1);
});

test('strength 0 turns every method into plain nearest-color mapping', () => {
  const rgba = gradient(24, 24);
  const none = renderDither(rgba, 24, 24, { ...BASE, dither: 'none' }).bytes;
  for (const dither of DITHER_METHODS) {
    assert.deepEqual(renderDither(rgba, 24, 24, { ...BASE, dither, strength: 0 }).bytes, none, dither);
  }
});

test('duotone writes the chosen colors into the table', () => {
  const rgba = gradient(20, 20);
  const { table } = decodeSingleFrame(renderDither(rgba, 20, 20, { ...BASE, palette: 'duotone', colors: 2, dark: '#102030', light: '#f0e0d0' }).bytes);
  assert.deepEqual(Array.from(table.subarray(0, 6)), [0x10, 0x20, 0x30, 0xf0, 0xe0, 0xd0]);
});

test('transparent pixels get the transparent index from a graphic control extension', () => {
  const rgba = gradient(10, 10);
  for (let i = 0; i < 50; i++) rgba[i * 4 + 3] = 0;
  const result = renderDither(rgba, 10, 10, { ...BASE, palette: 'grayscale', colors: 256 });
  assert.equal(result.transparent, true);
  assert.equal(result.colors, 255);
  const { frame, indices } = decodeSingleFrame(result.bytes);
  assert.equal(frame.transparent, 255);
  assert.ok(indices.slice(0, 50).every(i => i === 255));
  assert.ok(indices.slice(50).every(i => i < 255));
});

test('median cut returns at most the requested colors and the exact colors of a small image', () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255]);
  const palette = medianCutPalette(rgba, 16);
  const colors = [];
  for (let i = 0; i < palette.length; i += 3) colors.push(Array.from(palette.subarray(i, i + 3)).join());
  assert.deepEqual(colors.sort(), ['0,0,255', '0,255,0', '255,0,0']);
  assert.equal(medianCutPalette(gradient(64, 64), 7).length / 3, 7);
});

test('palette spread equals the step of gray ramps and color cubes', () => {
  assert.equal(paletteSpread(grayPalette(2)), 255);
  assert.equal(paletteSpread(grayPalette(6)), 51);
  assert.equal(paletteSpread(cubePalette(6)), 51);
  assert.equal(paletteSpread(cubePalette(2)), 255);
});

test('Bayer matrices hold every threshold once', () => {
  for (const n of [2, 4, 8]) assert.deepEqual(bayerMatrix(n).slice().sort((a, b) => a - b), [...Array(n * n).keys()]);
  assert.deepEqual(bayerMatrix(2), [0, 2, 3, 1]);
});

test('nearestFinder gives the lowest index among the exactly nearest palette colors', () => {
  const random = mulberry32(3);
  for (const n of [1, 2, 7, 64, 256]) {
    const palette = new Uint8Array(n * 3).map(() => Math.floor(random() * 4) * 85);
    const find = nearestFinder(palette);
    for (let t = 0; t < 2000; t++) {
      const r = Math.floor(random() * 64) * 4, g = Math.floor(random() * 64) * 4, b = Math.floor(random() * 64) * 4;
      let best = 0, bestD = Infinity;
      for (let k = 0; k < n; k++) {
        const d = (r - palette[k * 3]) ** 2 + (g - palette[k * 3 + 1]) ** 2 + (b - palette[k * 3 + 2]) ** 2;
        if (d < bestD) { bestD = d; best = k; }
      }
      assert.equal(find(r, g, b), best, `${n} colors, ${r},${g},${b}`);
    }
  }
});
