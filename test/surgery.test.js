const test = require('node:test');
const assert = require('node:assert/strict');
const { load, run } = require('./helpers/load.js');
const { naiveZigzag, decodeBaseline, photo } = require('./helpers/jpeg-decoder.js');

load('pixels.js', 'crush.js', 'surgery.js');

// No cuts and no lies: what the JPEG crush page would make.
const honest = {
  quality: 50, subsampling: '420', low: 0, high: 63, transpose: false, negate: false, shift: 0, transplant: 0, drift: 0,
  swapColors: false, seed: 1, lie: false, declared: 25, swapTables: false, widen: 0, sampling: 'honest',
};

const W = 72, H = 56;
const picture = () => ({ rgba: photo(W, H), width: W, height: H, cache: {} });
const operate = (settings, source = picture()) => run(surgerySteps(source, { ...honest, ...settings }));
const ZZ = naiveZigzag();

// The numbers of every block of a component, in zigzag order, as an
// independent decoder reads them from the file.
function blocks(bytes, component, options) {
  const { comps } = decodeBaseline(bytes, options);
  const c = comps[component];
  return Array.from({ length: c.bw * c.bh }, (_, b) => ZZ.map(k => c.coefs[b * 64 + k]));
}

test('without cuts or lies the file is byte for byte the one JPEG crush makes', () => {
  for (const subsampling of Object.keys(SUBSAMPLING)) {
    const source = picture();
    const result = operate({ subsampling }, source);
    assert.deepEqual(result.bytes, crushJpeg(source.rgba, W, H, { quality: 50, subsampling }).bytes, subsampling);
    assert.equal(result.honest, true);
    assert.deepEqual([result.width, result.height, result.type, result.ext], [W, H, 'image/jpeg', 'jpg']);
  }
});

test('the mirrored zigzag swaps rows and columns of the pattern grid', () => {
  assert.equal(ZIGZAG_TRANSPOSED[0], 0);
  assert.equal(ZIGZAG_TRANSPOSED[1], 2);
  assert.equal(ZIGZAG_TRANSPOSED[2], 1);
  for (let z = 0; z < 64; z++) {
    const k = ZZ[z], mirrored = ZZ[ZIGZAG_TRANSPOSED[z]];
    assert.equal(mirrored, (k & 7) * 8 + (k >> 3));
    assert.equal(ZIGZAG_TRANSPOSED[ZIGZAG_TRANSPOSED[z]], z);
  }
});

test('each cut does to the stored numbers what it says', () => {
  const before = [0, 1, 2].map(c => blocks(operate({}).bytes, c));

  const band = blocks(operate({ low: 2, high: 9 }).bytes, 0);
  band.forEach((block, b) => block.forEach((v, k) => assert.equal(v, k >= 2 && k <= 9 ? before[0][b][k] : 0)));
  assert.deepEqual(blocks(operate({ low: 9, high: 2 }).bytes, 0), band, 'the two ends may be given either way round');

  const mirrored = blocks(operate({ transpose: true }).bytes, 1);
  mirrored.forEach((block, b) => block.forEach((v, z) => assert.equal(v, before[1][b][ZIGZAG_TRANSPOSED[z]])));

  const negated = blocks(operate({ negate: true }).bytes, 2);
  negated.forEach((block, b) => block.forEach((v, k) => assert.equal(v, k === 0 ? before[2][b][0] : -before[2][b][k] + 0)));

  const shifted = blocks(operate({ shift: 5 }).bytes, 0);
  shifted.forEach((block, b) => {
    assert.equal(block[0], before[0][b][0]);
    for (let j = 1; j < 64; j++) assert.equal(block[1 + ((j - 1 + 5) % 63)], before[0][b][j]);
  });

  const swapped = operate({ swapColors: true }).bytes;
  assert.deepEqual(blocks(swapped, 1), before[2]);
  assert.deepEqual(blocks(swapped, 2), before[1]);
  assert.deepEqual(blocks(swapped, 0), before[0]);
});

test('transplant gives blocks the patterns of other blocks and leaves every average alone', () => {
  const before = blocks(operate({}).bytes, 0);
  const after = blocks(operate({ transplant: 60, seed: 4 }).bytes, 0);
  const known = new Set(before.map(block => block.slice(1).join()));
  let changed = 0;
  after.forEach((block, b) => {
    assert.equal(block[0], before[b][0]);
    assert.ok(known.has(block.slice(1).join()), 'patterns come from some block of the same picture');
    if (block.slice(1).join() !== before[b].slice(1).join()) changed++;
  });
  assert.ok(changed > after.length * 0.3 && changed < after.length * 0.8, `${changed} of ${after.length} blocks`);
  assert.deepEqual(blocks(operate({ transplant: 60, seed: 4 }).bytes, 0), after);
  assert.notDeepEqual(blocks(operate({ transplant: 60, seed: 5 }).bytes, 0), after);
});

test('drift changes averages only, in runs along the scan', () => {
  const before = blocks(operate({ subsampling: '444' }).bytes, 0);
  const after = blocks(operate({ subsampling: '444', drift: 60, seed: 2 }).bytes, 0);
  const offsets = after.map((block, b) => {
    assert.deepEqual(block.slice(1), before[b].slice(1));
    return block[0] - before[b][0];
  });
  assert.ok(offsets.some(v => v !== 0));
  const changes = offsets.filter((v, i) => i > 0 && v !== offsets[i - 1]).length;
  assert.ok(changes < offsets.length / 2, `the average stays wrong for a while: ${changes} changes in ${offsets.length} blocks`);
});

test('lying about the quality changes the tables in the header and nothing else', () => {
  const truth = operate({});
  const lie = operate({ lie: true, declared: 10 });
  const a = decodeBaseline(truth.bytes), b = decodeBaseline(lie.bytes);
  assert.deepEqual(Array.from(a.quant[0]), ZZ.map(k => scaleQuant(LUMA_QUANT, 50)[k]));
  assert.deepEqual(Array.from(b.quant[0]), ZZ.map(k => scaleQuant(LUMA_QUANT, 10)[k]));
  assert.deepEqual(Array.from(b.quant[1]), ZZ.map(k => scaleQuant(CHROMA_QUANT, 10)[k]));
  for (let c = 0; c < 3; c++) assert.deepEqual(blocks(lie.bytes, c), blocks(truth.bytes, c));
  assert.equal(lie.honest, false);
  assert.equal(lie.bytes.length, truth.bytes.length);

  const swapped = decodeBaseline(operate({ swapTables: true }).bytes);
  assert.deepEqual(Array.from(swapped.quant[0]), Array.from(a.quant[1]));
  assert.deepEqual(Array.from(swapped.quant[1]), Array.from(a.quant[0]));
});

test('lying about the width keeps the stream and makes the decoder break the rows elsewhere', () => {
  const truth = blocks(operate({ subsampling: '444' }).bytes, 0);       // 9 × 7 blocks
  for (const widen of [1, -2, 5]) {
    const result = operate({ subsampling: '444', widen });
    const cols = 9 + widen, rows = Math.floor(63 / cols);
    assert.deepEqual([result.width, result.height], [cols * 8, rows * 8]);
    assert.equal(result.honest, false);
    const { frame } = decodeBaseline(result.bytes, { trailing: true });
    assert.deepEqual([frame.width, frame.height], [cols * 8, rows * 8]);
    assert.deepEqual(blocks(result.bytes, 0, { trailing: true }), truth.slice(0, cols * rows), `the blocks in the order they were stored, ${cols} to a row`);
  }
});

test('the claimed size never asks for more than the file holds', () => {
  for (const subsampling of Object.keys(SUBSAMPLING)) {
    for (const sampling of SURGERY_SAMPLINGS) {
      for (const widen of [-16, -1, 0, 3, 16]) {
        const layout = crushLayout(W, H, subsampling);
        const header = surgeryHeader(layout, W, H, { subsampling, sampling, widen });
        const stored = layout.mcuCols * layout.mcuRows * (layout.h * layout.v + 2);
        const asked = Math.ceil(header.width / (8 * header.h)) * Math.ceil(header.height / (8 * header.v)) * (header.h * header.v + 2);
        assert.ok(Number.isInteger(asked) && asked >= header.h * header.v + 2 && asked <= stored, `${subsampling} as ${sampling} ${widen}: ${asked} of ${stored}`);
        assert.ok(header.width >= 8 && header.height >= 8 && header.width < 65536 && header.height < 65536);
        if (sampling === 'honest' && widen === 0) assert.deepEqual([header.width, header.height, header.honest], [W, H, true]);
      }
    }
  }
});

test('lying about the color layout still gives a file a decoder reads to the end', () => {
  for (const subsampling of Object.keys(SUBSAMPLING)) {
    for (const sampling of Object.keys(SUBSAMPLING)) {
      const result = operate({ subsampling, sampling, widen: 1, drift: 30, transplant: 20 });
      const decoded = decodeBaseline(result.bytes, { trailing: true });
      const [h, v] = SUBSAMPLING[sampling];
      assert.deepEqual([decoded.frame.comps[0].h, decoded.frame.comps[0].v], [h, v], `${subsampling} as ${sampling}`);
      assert.deepEqual([decoded.frame.width, decoded.frame.height], [result.width, result.height]);
      if (sampling !== subsampling) {
        assert.deepEqual(Object.keys(decoded.huff).map(Number).sort((a, b) => a - b), [0x00, 0x10], 'one pair of Huffman tables for every component');
        assert.ok(decoded.scan.every(c => c.td === 0 && c.ta === 0));
      } else {
        assert.equal(Object.keys(decoded.huff).length, 4);
      }
    }
  }
});

test('the same seed gives the same file, and the source picture is never changed', () => {
  const source = picture();
  const original = Uint8ClampedArray.from(source.rgba);
  const settings = { transplant: 40, drift: 40, transpose: true, shift: 3, lie: true, sampling: '444' };
  const a = operate(settings, source).bytes;
  assert.deepEqual(operate(settings, source).bytes, a, 'also when the encoded numbers are reused');
  assert.deepEqual(operate(settings).bytes, a);
  assert.deepEqual(source.rgba, original);
  assert.deepEqual(operate({}, source).bytes, operate({}).bytes, 'cuts never reach the numbers kept for the next run');
});
