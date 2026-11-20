const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const file of ['jpeg.js', 'crush.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'webapp', file), 'utf8');
  vm.runInThisContext(src, { filename: file });
}

const { naiveZigzag, naiveDct, naiveIdct, decodeBaseline, decodePixels, photo, maxError } = require('./helpers/jpeg-decoder.js');


test('zigzag order matches the diagonal scan', () => {
  assert.deepEqual(Array.from(ZIGZAG), naiveZigzag());
});

test('quality scaling follows IJG; 0 behaves like 1', () => {
  assert.deepEqual(scaleQuant(LUMA_QUANT, 50), LUMA_QUANT);
  assert.ok(scaleQuant(LUMA_QUANT, 100).every(v => v === 1));
  assert.ok(scaleQuant(LUMA_QUANT, 0).every(v => v === 255));
  assert.ok(scaleQuant(CHROMA_QUANT, 0).every(v => v === 255));
  assert.deepEqual(scaleQuant(LUMA_QUANT, 0), scaleQuant(LUMA_QUANT, 1));
  assert.equal(scaleQuant(LUMA_QUANT, 75)[0], 8);
  assert.equal(scaleQuant(LUMA_QUANT, 10)[0], 80);
});

test('AAN forward and inverse DCT match the textbook formulas', () => {
  const samples = Array.from({ length: 64 }, (_, i) => ((i * 37) % 255) - 128);
  const block = Float64Array.from(samples);
  fdct(block);
  const expected = naiveDct(samples);
  for (let k = 0; k < 64; k++) {
    const scale = AAN_SCALE[k >> 3] * AAN_SCALE[k & 7] * 8;
    assert.ok(Math.abs(block[k] / scale - expected[k]) < 1e-5, `coefficient ${k}`);
  }

  const back = new Float64Array(64);
  for (let k = 0; k < 64; k++) back[k] = expected[k] * AAN_SCALE[k >> 3] * AAN_SCALE[k & 7];
  idct(back);
  const reference = naiveIdct(expected);
  for (let k = 0; k < 64; k++) assert.ok(Math.abs(back[k] / 8 - reference[k]) < 1e-5, `sample ${k}`);
});

test('optimal Huffman tables stay within 16 bits and never use the all-ones code', () => {
  const counts = new Float64Array(257);
  let a = 1, b = 1;
  for (let i = 0; i < 40; i++) { counts[i] = a; [a, b] = [b, a + b]; }
  const spec = optimalTable(counts);
  assert.equal(spec.bits.length, 16);
  assert.equal(spec.values.length, 40);
  const kraft = spec.bits.reduce((sum, n, i) => sum + n * 2 ** -(i + 1), 0);
  assert.ok(kraft < 1, `Kraft sum ${kraft}`);

  const single = new Float64Array(257);
  single[7] = 100;
  assert.deepEqual(optimalTable(single).values, [7]);
});

test('output decodes with an independent baseline decoder, close to the source at quality 100', () => {
  const width = 37, height = 23;
  const rgba = photo(width, height);
  const { bytes } = crushJpeg(rgba, width, height, { quality: 100, subsampling: '444' });
  assert.equal(parseJpeg(bytes).frameType, 'baseline sequential DCT');
  const out = decodePixels(bytes);
  assert.equal(out.width, width);
  assert.equal(out.height, height);
  assert.ok(maxError(rgba, out.rgb) <= 4, `max error ${maxError(rgba, out.rgb)}`);
});

test('every subsampling decodes to the right size and sampling factors', () => {
  const width = 50, height = 29;
  const rgba = photo(width, height, 3);
  for (const [name, [h, v]] of Object.entries(SUBSAMPLING)) {
    for (const quality of [0, 30, 90]) {
      const { bytes } = crushJpeg(rgba, width, height, { quality, subsampling: name });
      const out = decodePixels(bytes);
      assert.equal(out.width, width);
      assert.equal(out.height, height);
      assert.deepEqual(out.frame.comps.map(c => [c.h, c.v]), [[h, v], [1, 1], [1, 1]], name);
    }
  }
});

test('the decoded coefficients are the ones the encoder quantized', () => {
  const width = 24, height = 16;
  const rgba = photo(width, height, 9);
  const layout = crushLayout(width, height, '420');
  const quant = [scaleQuant(LUMA_QUANT, 40), scaleQuant(CHROMA_QUANT, 40)];
  const planes = toPlanes(flattenRgba(rgba, width, height), width, height, layout);
  const coefs = planes.map((p, i) => quantizeComponent(p, layout.comps[i], quant[layout.comps[i].table], true));
  const bytes = encodeJpeg({ width, height, layout, quant, coefs });
  const { comps } = decodeBaseline(bytes);
  const zz = naiveZigzag();
  comps.forEach((c, i) => {
    for (let b = 0; b < c.bw * c.bh; b++) {
      for (let z = 0; z < 64; z++) assert.equal(c.coefs[b * 64 + zz[z]], coefs[i][b * 64 + z]);
    }
  });
});

test('quality 0 crushes the file and still decodes', () => {
  const width = 64, height = 48;
  const rgba = photo(width, height, 5);
  const best = crushJpeg(rgba, width, height, { quality: 100 }).bytes;
  const worst = crushJpeg(rgba, width, height, { quality: 0 }).bytes;
  assert.ok(worst.length < best.length / 4, `${worst.length} vs ${best.length}`);
  decodePixels(worst);
});

test('separate color quality only changes the chroma table', () => {
  const rgba = photo(16, 16);
  const { quant } = crushJpeg(rgba, 16, 16, { quality: 90, split: true, chroma: 0 });
  assert.deepEqual(quant[0], scaleQuant(LUMA_QUANT, 90));
  assert.deepEqual(quant[1], scaleQuant(CHROMA_QUANT, 0));
  const linked = crushJpeg(rgba, 16, 16, { quality: 90, split: false, chroma: 0 }).quant;
  assert.deepEqual(linked[1], scaleQuant(CHROMA_QUANT, 90));
});

test('the same image and settings give the same bytes', () => {
  const rgba = photo(40, 30);
  const settings = { quality: 12, subsampling: '411', generations: 4, shift: 3 };
  assert.deepEqual(crushJpeg(rgba, 40, 30, settings).bytes, crushJpeg(rgba, 40, 30, settings).bytes);
});

test('generations with a shift add loss but end up in place', () => {
  const width = 48, height = 40;
  const rgba = photo(width, height, 2);
  const one = decodePixels(crushJpeg(rgba, width, height, { quality: 60 }).bytes).rgb;
  const many = decodePixels(crushJpeg(rgba, width, height, { quality: 60, generations: 8, shift: 3 }).bytes).rgb;
  const error = rgb => {
    let sum = 0;
    for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) for (let c = 0; c < 3; c++) sum += Math.abs(rgba[i + c] - rgb[j + c]);
    return sum / rgb.length;
  };
  assert.ok(error(many) > error(one), `${error(many)} vs ${error(one)}`);
  assert.ok(error(many) < 40, 'still registered with the source');
});

test('rolling by a distance and back is lossless', () => {
  const rgb = Uint8ClampedArray.from({ length: 7 * 5 * 3 }, (_, i) => i);
  const there = rollRgb(rgb, 7, 5, 3, 2);
  assert.notDeepEqual(there, rgb);
  assert.deepEqual(rollRgb(there, 7, 5, -3, -2), rgb);
});

test('transparent pixels are composited over white', () => {
  const rgba = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 128]);
  assert.deepEqual(Array.from(flattenRgba(rgba, 3, 1)), [255, 255, 255, 0, 0, 0, 255, 127, 127]);
});
