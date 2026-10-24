const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

for (const file of ['png.js', 'strategies.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'webapp', file), 'utf8');
  vm.runInThisContext(src, { filename: file });
}

// ── Synthetic PNG builder ─────────────────────────────────────────────────────

const SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

function u32(n) {
  return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
}

function chunk(type, data = []) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  return [...Buffer.concat([Buffer.from(u32(data.length)), body, Buffer.from(u32(zlib.crc32(body)))])];
}

function ihdr(width, height, bitDepth, colorType, interlace = 0) {
  return chunk('IHDR', [...u32(width), ...u32(height), bitDepth, colorType, 0, 0, interlace]);
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24;
  };
}

// Builds a PNG whose raw stream has every row filtered with `filter` (or a
// rotating filter when `filter` is 'mixed'). Returns the file and its raw
// stream so tests can compare against what parsing and inflating produce.
function buildPng({
  width = 23, height = 17, bitDepth = 8, colorType = 2, interlace = 0,
  filter = 'mixed', seed = 3, idatSplit = 3, extraHead = [], extraTail = [], iend = true,
} = {}) {
  const info = { width, height, bitDepth, colorType, interlaced: interlace === 1, bitsPerPixel: bitDepth * PNG_CHANNELS[colorType] };
  const layout = layoutPng(info);
  const rand = lcg(seed);
  const raw = new Uint8Array(layout.rawLength);
  layout.filterPositions.forEach((pos, r) => {
    raw[pos] = filter === 'mixed' ? r % 5 : filter;
    for (let k = 1; k <= layout.rowLengths[r]; k++) raw[pos + k] = rand();
  });

  const compressed = zlib.deflateSync(raw);
  const parts = [SIGNATURE, ihdr(width, height, bitDepth, colorType, interlace), extraHead];
  if (colorType === 3) parts.push(chunk('PLTE', Array.from({ length: 256 * 3 }, (_, k) => k & 0xFF)));
  const step = Math.ceil(compressed.length / idatSplit);
  for (let k = 0; k < compressed.length; k += step) {
    parts.push(chunk('IDAT', compressed.subarray(k, k + step)));
  }
  parts.push(extraTail);
  if (iend) parts.push(chunk('IEND'));

  return { bytes: new Uint8Array(Buffer.concat(parts.map(p => Buffer.from(p)))), raw, layout };
}

// Splits a PNG into its chunks, verifying every CRC along the way.
function readChunks(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], SIGNATURE);
  const chunks = [];
  let i = 8;
  while (i < bytes.length) {
    const length = Buffer.from(bytes.subarray(i, i + 4)).readUInt32BE(0);
    const type = Buffer.from(bytes.subarray(i + 4, i + 8)).toString('latin1');
    const data = bytes.subarray(i + 8, i + 8 + length);
    const crc = Buffer.from(bytes.subarray(i + 8 + length, i + 12 + length)).readUInt32BE(0);
    assert.equal(crc, zlib.crc32(Buffer.from(bytes.subarray(i + 4, i + 8 + length))), `CRC of ${type}`);
    chunks.push({ type, data });
    i += 12 + length;
  }
  assert.equal(i, bytes.length);
  return chunks;
}

function inflateIdat(bytes) {
  const idat = readChunks(bytes).filter(c => c.type === 'IDAT').map(c => Buffer.from(c.data));
  return new Uint8Array(zlib.inflateSync(Buffer.concat(idat)));
}

// Counts how many pixels Adam7 assigns to each pass, by brute force.
function adam7PassSizes(width, height) {
  const pattern = [
    [1, 6, 4, 6, 2, 6, 4, 6],
    [7, 7, 7, 7, 7, 7, 7, 7],
    [5, 6, 5, 6, 5, 6, 5, 6],
    [7, 7, 7, 7, 7, 7, 7, 7],
    [3, 6, 4, 6, 3, 6, 4, 6],
    [7, 7, 7, 7, 7, 7, 7, 7],
    [5, 6, 5, 6, 5, 6, 5, 6],
    [7, 7, 7, 7, 7, 7, 7, 7],
  ];
  const cols = Array.from({ length: 8 }, () => new Set());
  const rows = Array.from({ length: 8 }, () => new Set());
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pass = pattern[y % 8][x % 8];
      cols[pass].add(x);
      rows[pass].add(y);
    }
  }
  return cols.slice(1).map((c, k) => ({ width: c.size, height: rows[k + 1].size }));
}

const COLOR_DEPTHS = Object.entries(PNG_BIT_DEPTHS).flatMap(([ct, depths]) => depths.map(d => [Number(ct), d]));

// ── parsePng ──────────────────────────────────────────────────────────────────

test('parses the header and joins split IDAT chunks', () => {
  const { bytes } = buildPng({ width: 31, height: 9, colorType: 6, idatSplit: 4 });
  const png = parsePng(bytes);
  assert.equal(png.width, 31);
  assert.equal(png.height, 9);
  assert.equal(png.bitDepth, 8);
  assert.equal(png.colorName, 'RGBA');
  assert.equal(png.bitsPerPixel, 32);
  assert.equal(png.interlaced, false);
  assert.equal(png.idatCount, 4);
  assert.equal(png.animated, false);
  const expected = Buffer.concat(readChunks(bytes).filter(c => c.type === 'IDAT').map(c => Buffer.from(c.data)));
  assert.deepEqual(Buffer.from(png.idat), expected);
});

test('keeps safe chunks and drops ones that depend on the IDAT layout', () => {
  const extraHead = [
    ...chunk('gAMA', u32(45455)),
    ...chunk('acTL', [...u32(2), ...u32(0)]),
    ...chunk('fcTL', Array(26).fill(0)),
    ...chunk('iDOT', Array(28).fill(0)),
    ...chunk('prVt', [1, 2, 3]),
  ];
  const extraTail = [...chunk('tEXt', [...Buffer.from('Comment\0hi')]), ...chunk('fdAT', [0, 0, 0, 1, 9])];
  const { bytes } = buildPng({ extraHead, extraTail });
  const png = parsePng(bytes);

  const headTypes = readChunks(Uint8Array.from([...SIGNATURE, ...png.head])).map(c => c.type);
  const tailTypes = readChunks(Uint8Array.from([...SIGNATURE, ...png.tail])).map(c => c.type);
  assert.deepEqual(headTypes, ['IHDR', 'gAMA', 'prVt']);
  assert.deepEqual(tailTypes, ['tEXt']);
  assert.equal(png.animated, true);
});

test('tolerates a missing IEND and a file cut off inside IDAT', () => {
  const { bytes } = buildPng({ iend: false, idatSplit: 1 });
  assert.equal(parsePng(bytes).idatCount, 1);

  const cut = bytes.subarray(0, bytes.length - 20);
  const png = parsePng(cut);
  assert.equal(png.idat.length, parsePng(bytes).idat.length - 16);
});

test('rejects malformed PNGs with specific messages', () => {
  const ok = buildPng().bytes;
  assert.throws(() => parsePng(Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0])), /signature/);
  assert.throws(() => parsePng(Uint8Array.from(SIGNATURE)), /missing IHDR/);
  assert.throws(() => parsePng(Uint8Array.from([...SIGNATURE, ...chunk('gAMA', u32(1))])), /IHDR must come first/);
  assert.throws(() => parsePng(Uint8Array.from([...SIGNATURE, ...ihdr(4, 4, 8, 2), ...chunk('IEND')])), /IDAT/);
  assert.throws(() => parsePng(Uint8Array.from([...SIGNATURE, ...ihdr(4, 4, 3, 2)])), /color type 2 with bit depth 3/);
  assert.throws(() => parsePng(Uint8Array.from([...SIGNATURE, ...ihdr(0, 4, 8, 2)])), /zero width/);
  assert.throws(() => parsePng(Uint8Array.from([...SIGNATURE, ...ihdr(4, 4, 8, 2, 2)])), /interlace/);

  const split = [...ok.subarray(0, ok.length - 12)];
  split.push(...chunk('tEXt', [65, 0, 66]), ...chunk('IDAT', [1, 2, 3]), ...chunk('IEND'));
  assert.throws(() => parsePng(Uint8Array.from(split)), /split by other chunks/);

  const noPalette = [...SIGNATURE, ...ihdr(4, 4, 8, 3), ...chunk('IDAT', [...zlib.deflateSync(Buffer.alloc(20))]), ...chunk('IEND')];
  assert.throws(() => parsePng(Uint8Array.from(noPalette)), /palette/);
});

// ── layoutPng ─────────────────────────────────────────────────────────────────

test('row layout matches the PNG spec for every color type and bit depth', () => {
  for (const [colorType, bitDepth] of COLOR_DEPTHS) {
    for (const [width, height] of [[1, 1], [7, 3], [33, 5]]) {
      const bpp = bitDepth * PNG_CHANNELS[colorType];
      const layout = layoutPng({ width, height, bitsPerPixel: bpp, interlaced: false });
      const rowLength = Math.ceil(width * bpp / 8);
      assert.equal(layout.rawLength, height * (rowLength + 1), `ct${colorType} d${bitDepth} ${width}x${height}`);
      assert.equal(layout.bytesPerPixel, Math.max(1, bpp / 8));
      assert.equal(layout.filterPositions.length, height);
      assert.equal(layout.priorRows[0], -1);
      for (let r = 1; r < height; r++) assert.equal(layout.priorRows[r], layout.filterPositions[r - 1]);
      assert.deepEqual(layout.scanRanges, [{ start: 0, end: layout.rawLength }]);
    }
  }
});

test('Adam7 layout matches a brute-force pass assignment, including empty passes', () => {
  for (const [width, height] of [[1, 1], [2, 3], [5, 5], [8, 8], [13, 9], [40, 21]]) {
    for (const bpp of [1, 4, 24, 64]) {
      const layout = layoutPng({ width, height, bitsPerPixel: bpp, interlaced: true });
      const passes = adam7PassSizes(width, height).filter(p => p.width > 0 && p.height > 0);
      const expectedRows = passes.reduce((n, p) => n + p.height, 0);
      const expectedLength = passes.reduce((n, p) => n + p.height * (Math.ceil(p.width * bpp / 8) + 1), 0);
      assert.equal(layout.filterPositions.length, expectedRows, `${width}x${height} bpp${bpp}`);
      assert.equal(layout.rawLength, expectedLength, `${width}x${height} bpp${bpp}`);
      assert.equal(layout.priorRows.filter(p => p === -1).length, passes.length);
    }
  }
});

// ── inflatePng ────────────────────────────────────────────────────────────────

test('inflates the image data to exactly the raw stream', async () => {
  for (const interlace of [0, 1]) {
    const { bytes, raw } = buildPng({ interlace, width: 41, height: 19, colorType: 0, bitDepth: 4 });
    const png = parsePng(bytes);
    const { raw: got, inflated } = await inflatePng(png, layoutPng(png));
    assert.deepEqual(got, raw);
    assert.equal(inflated, raw.length);
  }
});

test('a cut-off stream keeps what inflated and zero-fills the rest', async () => {
  const { bytes, raw } = buildPng({ width: 200, height: 50, idatSplit: 1, filter: 0 });
  const png = parsePng(bytes.subarray(0, bytes.length - 200));
  const { raw: got, inflated } = await inflatePng(png, layoutPng(png));
  assert.equal(got.length, raw.length);
  let same = 0;
  while (same < raw.length && got[same] === raw[same]) same++;
  assert.ok(same > raw.length / 2, `only ${same} of ${raw.length} bytes recovered`);
  assert.ok(inflated <= same && inflated < raw.length, `inflated ${inflated}, matching ${same}`);
  assert.ok(got.subarray(raw.length - 100).every(b => b === 0));
});

test('stops at the size the header promises', async () => {
  const { bytes, raw } = buildPng({ width: 10, height: 10 });
  const png = parsePng(bytes);
  png.idat = new Uint8Array(zlib.deflateSync(Buffer.concat([Buffer.from(raw), Buffer.alloc(1 << 20, 7)])));
  assert.deepEqual((await inflatePng(png, layoutPng(png))).raw, raw);
});

test('undecodable image data is rejected', async () => {
  const { bytes } = buildPng();
  const png = parsePng(bytes);
  png.idat = Uint8Array.from([0x12, 0x34, 0x56, 0x78]);
  await assert.rejects(inflatePng(png, layoutPng(png)), /decompress/);
});

// ── Filters ───────────────────────────────────────────────────────────────────

test('unfilter matches hand-computed rows for every filter type', () => {
  // 3 pixels of 1-byte grayscale per row, 2 rows; second row uses each filter in turn.
  const layout = layoutPng({ width: 3, height: 2, bitsPerPixel: 8, interlaced: false });
  const first = [10, 20, 30];
  const filtered = [5, 6, 250];
  const expected = {
    0: [5, 6, 250],
    1: [5, 11, 5],                               // 250 + 11 wraps to 5
    2: [15, 26, 24],                             // 250 + 30 wraps to 24
    3: [10, (6 + ((10 + 20) >> 1)) & 0xFF, (250 + ((((6 + 15) & 0xFF) + 30) >> 1)) & 0xFF],
    4: [15, 26, (250 + paethPredictor(26, 30, 20)) & 0xFF],
  };
  for (const [type, row] of Object.entries(expected)) {
    const raw = Uint8Array.from([0, ...first, Number(type), ...filtered]);
    const recon = unfilterPng(raw, layout);
    assert.deepEqual([...recon.subarray(5, 8)], row, `filter ${type}`);
  }
  assert.equal(paethPredictor(26, 30, 20), 30);
  assert.equal(paethPredictor(10, 10, 10), 10);
  assert.equal(paethPredictor(1, 9, 5), 5);
});

test('refilter then unfilter is lossless for every filter type and pixel size', () => {
  for (const [colorType, bitDepth] of COLOR_DEPTHS) {
    for (const interlace of [0, 1]) {
      const { raw, layout } = buildPng({ colorType, bitDepth, interlace, width: 19, height: 11, seed: colorType * 31 + bitDepth });
      const recon = unfilterPng(raw, layout);
      for (let type = 0; type < PNG_FILTER_TYPES.length; type++) {
        const refiltered = refilterPng(recon, layout, type);
        for (const pos of layout.filterPositions) assert.equal(refiltered[pos], type);
        assert.deepEqual(unfilterPng(refiltered, layout), recon, `ct${colorType} d${bitDepth} i${interlace} f${type}`);
      }
    }
  }
});

test('unfilter stops at a row with an invalid filter type and copies the rest verbatim', () => {
  const { raw, layout } = buildPng({ width: 9, height: 6 });
  const buf = new Uint8Array(raw);
  const bad = layout.filterPositions[3];
  buf[bad] = 7;
  const recon = unfilterPng(buf, layout);
  assert.deepEqual(recon.subarray(0, bad), unfilterPng(raw, layout).subarray(0, bad));
  assert.deepEqual(recon.subarray(bad), buf.subarray(bad));
});

test('protectFilters restores every filter byte and nothing else', () => {
  const { raw, layout } = buildPng({ interlace: 1 });
  const buf = new Uint8Array(raw).map(b => b ^ 0x5A);
  const before = new Uint8Array(buf);
  protectFilters(buf, raw, layout);

  const isFilter = new Set(layout.filterPositions);
  for (let i = 0; i < buf.length; i++) {
    assert.equal(buf[i], isFilter.has(i) ? raw[i] : before[i]);
  }
});

test('Prism leaves invalid filter bytes alone', () => {
  const { raw, layout } = buildPng({ width: 8, height: 300 });
  const buf = new Uint8Array(raw);
  for (const pos of layout.filterPositions) buf[pos] = 200;
  applyPrism(buf, layout, 100, 3);
  for (const pos of layout.filterPositions) assert.equal(buf[pos], 200);
});

test('Prism changes only filter bytes, always to a different valid type', () => {
  const { raw, layout } = buildPng({ width: 20, height: 400 });
  const buf = new Uint8Array(raw);
  applyPrism(buf, layout, 100, 12);

  const isFilter = new Set(layout.filterPositions);
  let changed = 0;
  for (let i = 0; i < buf.length; i++) {
    if (!isFilter.has(i)) assert.equal(buf[i], raw[i]);
    else if (buf[i] !== raw[i]) { changed++; assert.ok(buf[i] <= 4); }
  }
  assert.ok(changed > 30 && changed <= 40, `${changed} of 400 rows changed at full intensity (40 picks)`);

  const none = new Uint8Array(raw);
  applyPrism(none, layout, 0, 12);
  assert.deepEqual(none, raw);
});

test('restoreAlpha puts back alpha bytes only, for 8- and 16-bit images', () => {
  for (const [colorType, bitDepth] of [[6, 8], [6, 16], [4, 8], [4, 16]]) {
    const { raw, layout } = buildPng({ colorType, bitDepth, width: 13, height: 7, interlace: 1 });
    const png = { colorType, bitDepth };
    const original = unfilterPng(raw, layout);
    const damaged = new Uint8Array(original).map((b, k) => layout.filterPositions.includes(k) ? 0 : b ^ 0xFF);
    const before = new Uint8Array(damaged);
    restoreAlpha(damaged, original, layout, png);

    const alphaBytes = bitDepth / 8;
    layout.filterPositions.forEach((pos, r) => {
      for (let k = 0; k < layout.rowLengths[r]; k++) {
        const isAlpha = k % layout.bytesPerPixel >= layout.bytesPerPixel - alphaBytes;
        assert.equal(damaged[pos + 1 + k], isAlpha ? original[pos + 1 + k] : before[pos + 1 + k], `ct${colorType} d${bitDepth} row ${r} byte ${k}`);
      }
    });
  }
});

// ── Encode ────────────────────────────────────────────────────────────────────

test('crc32 and adler32 agree with zlib', () => {
  const data = new Uint8Array(200000).map((_, k) => (k * 7919) & 0xFF);
  assert.equal(crc32(data, 0, data.length), zlib.crc32(Buffer.from(data)));
  assert.equal(crc32(data, 100, 5000), zlib.crc32(Buffer.from(data.subarray(100, 5000))));
  let a = 1, b = 0;
  for (const byte of data) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  assert.equal(adler32(data), ((b << 16) | a) >>> 0);
});

test('encodePng writes one IDAT with valid CRCs, chunk order and a zlib stream that inflates to the raw data', () => {
  const extraHead = [...chunk('gAMA', u32(45455))];
  const extraTail = [...chunk('tEXt', [...Buffer.from('k\0v')])];
  const { bytes, raw } = buildPng({ width: 700, height: 500, colorType: 6, extraHead, extraTail });
  const png = parsePng(bytes);
  assert.ok(raw.length > IDAT_CHUNK_BYTES, 'fixture should need many stored blocks');

  const out = encodePng(png, raw);
  const types = readChunks(out).map(c => c.type);
  assert.equal(types[0], 'IHDR');
  assert.equal(types[1], 'gAMA');
  assert.equal(types.at(-2), 'tEXt');
  assert.equal(types.at(-1), 'IEND');
  assert.equal(types.filter(t => t === 'IDAT').length, 1);
  assert.deepEqual(inflateIdat(out), raw);

  const reparsed = parsePng(out);
  assert.deepEqual(reparsed.head, png.head);
  assert.deepEqual(reparsed.tail, png.tail);
});

test('encodePng handles a raw stream that fits in one stored block', () => {
  const { bytes, raw } = buildPng({ width: 4, height: 4, colorType: 3, bitDepth: 2 });
  const png = parsePng(bytes);
  const out = encodePng(png, raw);
  assert.deepEqual(readChunks(out).map(c => c.type), ['IHDR', 'PLTE', 'IDAT', 'IEND']);
  assert.deepEqual(inflateIdat(out), raw);
});

test('optimizeFilters keeps every decoded pixel and only picks valid filters', async () => {
  for (const interlace of [0, 1]) {
    const { raw, layout } = buildPng({ width: 64, height: 48, interlace, filter: 'mixed', seed: 21 });
    const recon = unfilterPng(raw, layout);
    const smooth = refilterPng(recon.map((_, k) => (k * 3) & 0xFF), layout, 0);
    for (const input of [raw, smooth]) {
      const out = await optimizeFilters(input, layout);
      assert.deepEqual(unfilterPng(out, layout), unfilterPng(input, layout));
      for (const pos of layout.filterPositions) assert.ok(out[pos] <= 4);
    }
    const smoothOut = await optimizeFilters(smooth, layout);
    assert.ok(layout.filterPositions.some(pos => smoothOut[pos] !== 0), 'a smooth ramp should move rows off filter None');
  }
});

test('optimizeFilters leaves rows from an invalid filter byte on untouched', async () => {
  const { raw, layout } = buildPng({ width: 20, height: 10 });
  const buf = new Uint8Array(raw);
  const cut = layout.filterPositions[6];
  buf[cut] = 9;
  const out = await optimizeFilters(buf, layout);
  assert.deepEqual(out.subarray(cut), buf.subarray(cut));
  assert.deepEqual(unfilterPng(out, layout).subarray(0, cut), unfilterPng(buf, layout).subarray(0, cut));
});

test('encodePngCompressed is smaller and decodes to the same pixels', async () => {
  const { bytes } = buildPng({ width: 300, height: 200, filter: 0 });
  const source = await loadPngSource(bytes);
  const recon = sourceRecon(source).map((_, k) => (k * 7) & 0xFF);
  const smooth = refilterPng(recon, source.layout, 0);
  const stored = encodePng(source.png, smooth);
  const packed = await encodePngCompressed(source, smooth);
  assert.ok(packed.length < stored.length / 10, `${packed.length} vs ${stored.length}`);
  assert.deepEqual(unfilterPng(inflateIdat(packed), source.layout), unfilterPng(smooth, source.layout));
});

test('encodePngCompressed splits large output into several IDAT chunks', async () => {
  const { bytes } = buildPng({ width: 700, height: 500, filter: 0, seed: 31 });
  const source = await loadPngSource(bytes);
  const packed = await encodePngCompressed(source, source.raw);
  assert.ok(readChunks(packed).filter(c => c.type === 'IDAT').length >= 2);
  assert.deepEqual(unfilterPng(inflateIdat(packed), source.layout), sourceRecon(source));
});

test('optimizeFilters gives up with null once cancelled', async () => {
  const { raw, layout } = buildPng({ width: 2000, height: 400, seed: 33 });
  let checks = 0;
  const out = await optimizeFilters(raw, layout, () => ++checks > 0);
  assert.equal(out, null);
  assert.ok(checks >= 1, 'a fixture this size should take more than one time slice');
});

// ── Source and pipeline ───────────────────────────────────────────────────────

const ALL_STRATEGIES = [...Object.keys(STRATEGY_FNS), ...Object.keys(PNG_STRATEGY_FNS)];

const PNG_FIXTURES = {
  rgb: buildPng({ width: 200, height: 120, seed: 5 }),
  rgba16: buildPng({ width: 80, height: 60, colorType: 6, bitDepth: 16, seed: 6 }),
  indexed2: buildPng({ width: 300, height: 200, colorType: 3, bitDepth: 2, seed: 7 }),
  interlaced: buildPng({ width: 150, height: 100, interlace: 1, colorType: 4, seed: 8 }),
};

function settings(overrides) {
  return { strategies: new Set(), intensity: 100, seed: 1, filter: 'keep', protect: true, keepAlpha: true, ...overrides };
}

test('loadPngSource inflates once and caches the base for the last filter only', async () => {
  const { bytes, raw } = PNG_FIXTURES.rgb;
  const source = await loadPngSource(bytes);
  assert.deepEqual(source.raw, raw);
  assert.equal(sourceBase(source, 'keep').bytes, source.raw);

  const paeth = sourceBase(source, 'paeth');
  assert.equal(sourceBase(source, 'paeth'), paeth);
  for (const pos of source.layout.filterPositions) assert.equal(paeth.bytes[pos], 4);
  assert.deepEqual(unfilterPng(paeth.bytes, source.layout), sourceRecon(source));
  assert.notEqual(sourceBase(source, 'sub'), paeth);
  assert.equal(sourceBase(source, 'keep').bytes, source.raw);
});

for (const [label, { bytes }] of Object.entries(PNG_FIXTURES)) {
  test(`every strategy on ${label} PNG yields a well-formed PNG with valid filters`, async () => {
    const source = await loadPngSource(bytes);
    for (const name of ALL_STRATEGIES) {
      for (const filter of ['keep', 'none', 'average']) {
        const out = glitchPng(source, settings({ strategies: new Set([name]), seed: 3, filter }));
        assert.equal(out.length, source.raw.length);
        assert.notDeepEqual(unfilterPng(out, source.layout), sourceRecon(source), `${name} ${filter} changed nothing`);
        for (const pos of source.layout.filterPositions) assert.ok(out[pos] <= 4, `${name} ${filter}`);
        assert.deepEqual(inflateIdat(encodePng(source.png, out)), out);
      }
    }
  });

  test(`glitchPng on ${label} PNG is deterministic and a no-op without strategies`, async () => {
    const source = await loadPngSource(bytes);
    const all = settings({ strategies: new Set(ALL_STRATEGIES), intensity: 70, seed: 4242 });
    assert.deepEqual(glitchPng(source, all), glitchPng(source, all));
    const idle = glitchPng(source, settings({ keepAlpha: false }));
    assert.deepEqual(idle, source.raw);
  });
}

test('with protection on, only Prism changes filter bytes', async () => {
  const source = await loadPngSource(PNG_FIXTURES.rgb.bytes);
  const { filterPositions } = source.layout;
  const byteOnly = glitchPng(source, settings({ strategies: new Set(Object.keys(STRATEGY_FNS)) }));
  for (const pos of filterPositions) assert.equal(byteOnly[pos], source.raw[pos]);

  const prism = glitchPng(source, settings({ strategies: new Set(['dropout', 'prism']) }));
  const swapped = [...filterPositions].filter(pos => prism[pos] !== source.raw[pos]);
  assert.ok(swapped.length > 0, 'prism should survive filter protection');
});

test('without protection, damaged filter bytes are kept as they are', async () => {
  const source = await loadPngSource(PNG_FIXTURES.rgb.bytes);
  const fx = new Set(['static', 'dropout']);
  const out = glitchPng(source, settings({ strategies: fx, protect: false }));
  const expected = new Uint8Array(source.raw);
  runPipeline(expected, { ...source.layout, densityScale: source.original.densityScale }, fx, 100, 1);
  assert.deepEqual(out, expected);
  assert.ok(source.layout.filterPositions.some(pos => out[pos] !== source.raw[pos]), 'fixture should damage filter bytes');
});

test('keepAlpha returns an unfiltered stream with the original alpha', async () => {
  const source = await loadPngSource(PNG_FIXTURES.rgba16.bytes);
  const opts = { strategies: new Set(['static', 'prism']), seed: 8 };
  const kept = glitchPng(source, settings(opts));
  const raw = glitchPng(source, settings({ ...opts, keepAlpha: false }));
  const expected = unfilterPng(raw, source.layout);
  restoreAlpha(expected, sourceRecon(source), source.layout, source.png);
  assert.deepEqual(kept, expected);
  for (const pos of source.layout.filterPositions) assert.equal(kept[pos], 0);
});

test('density scale averages the per-filter weights over all rows', () => {
  const { raw, layout } = buildPng({ width: 10, height: 40, filter: 'mixed' });
  const expected = PNG_DENSITY_WEIGHTS.reduce((n, w) => n + w, 0) / 5;
  assert.ok(Math.abs(pngDensityScale(raw, layout) - expected) < 1e-12);
  for (let type = 0; type < 5; type++) {
    assert.ok(Math.abs(pngDensityScale(refilterPng(raw, layout, type), layout) - PNG_DENSITY_WEIGHTS[type]) < 1e-12, `filter ${type}`);
  }
});

test('density scale thins out Static, Smear and Crumble on PNG data', async () => {
  const source = await loadPngSource(buildPng({ width: 400, height: 300, filter: 2, seed: 9 }).bytes);
  for (const filter of ['keep', 'none']) {
    const { densityScale } = sourceBase(source, filter);
    for (const name of ['static', 'smear', 'crumble']) {
      const out = glitchPng(source, settings({ strategies: new Set([name]), filter }));
      const base = sourceBase(source, filter).bytes;
      let touched = 0;
      for (let i = 0; i < out.length; i++) if (out[i] !== base[i]) touched++;
      const share = touched / out.length;
      assert.ok(share > 0 && share < densityScale * 1.5, `${name} ${filter} touched ${(share * 100).toFixed(3)}% of bytes`);
    }
  }
});

test('loadPngSource rejects image data above the raw size limit before inflating', async () => {
  const { bytes, layout } = buildPng({ width: 64, height: 64 });
  await assert.rejects(loadPngSource(bytes, { maxRawBytes: layout.rawLength - 1 }), /too large/);
  const source = await loadPngSource(bytes, { maxRawBytes: layout.rawLength });
  assert.equal(source.raw.length, layout.rawLength);
});

test('forEachSparse makes a fixed number of hits, at least one, inside the range', () => {
  const scanInfo = { scanRanges: [{ start: 0, end: 30000 }, { start: 40000, end: 100000 }], scanLength: 90000 };
  for (const density of [0.0000001, 0.0005, 0.01, 0.3]) {
    const seen = [];
    forEachSparse(scanInfo, 1000, 85000, density, makePrng(5), i => seen.push(i));
    assert.equal(seen.length, Math.max(1, Math.round(85000 * density)), `density ${density}`);
    for (const i of seen) assert.ok((i >= 1000 && i < 30000) || (i >= 40000 && i < 96000), `visit at ${i}`);
  }
  const first = [];
  const again = [];
  forEachSparse(scanInfo, 1000, 85000, 0.01, makePrng(5), i => first.push(i));
  forEachSparse(scanInfo, 1000, 85000, 0.01, makePrng(5), i => again.push(i));
  assert.deepEqual(again, first);
  forEachSparse(scanInfo, 0, 90000, 0, makePrng(5), () => assert.fail('density 0 visited a byte'));
  forEachSparse(scanInfo, 0, 0, 0.5, makePrng(5), () => assert.fail('empty range visited a byte'));
});

test('unfilter treats the missing row above the first row as zeros', () => {
  const layout = layoutPng({ width: 4, height: 1, bitsPerPixel: 8, interlaced: false });
  const filtered = [10, 20, 30, 250];
  const expected = {
    0: [10, 20, 30, 250],
    1: [10, 30, 60, 54],                       // 60 + 250 wraps to 54
    2: [10, 20, 30, 250],                      // Up with nothing above is None
    3: [10, 25, 42, (250 + (42 >> 1)) & 0xFF], // a >> 1 only
    4: [10, 30, 60, 54],                       // Paeth with nothing above is Sub
  };
  for (const [type, row] of Object.entries(expected)) {
    const recon = unfilterPng(Uint8Array.from([Number(type), ...filtered]), layout);
    assert.deepEqual([...recon.subarray(1)], row, `filter ${type}`);
    assert.deepEqual([...refilterPng(recon, layout, Number(type))], [Number(type), ...filtered], `refilter ${type}`);
  }
});

test('a cut-off PNG keeps strategies and the density scale on the rows that inflated', async () => {
  const { bytes } = buildPng({ width: 300, height: 100, idatSplit: 1, filter: 4, seed: 41 });
  const cut = bytes.subarray(0, Math.floor(bytes.length * 0.6));
  const source = await loadPngSource(cut);
  const { layout } = source;
  assert.ok(layout.completeRows > 0 && layout.completeRows < 100, `${layout.completeRows} complete rows`);
  assert.equal(layout.scanLength, layout.filterPositions[layout.completeRows]);
  assert.deepEqual(layout.scanRanges, [{ start: 0, end: layout.scanLength }]);
  assert.ok(Math.abs(source.original.densityScale - PNG_DENSITY_WEIGHTS[4]) < 1e-12, `density ${source.original.densityScale}`);

  const out = glitchPng(source, settings({ strategies: new Set(Object.keys(STRATEGY_FNS)) }));
  assert.deepEqual(out.subarray(layout.scanLength), source.raw.subarray(layout.scanLength));
});

test('loadPngSource checks the size limit before building the row layout', async () => {
  const huge = [...SIGNATURE, ...ihdr(1, 50_000_000, 8, 6), ...chunk('IDAT', [...zlib.deflateSync(Buffer.alloc(10))]), ...chunk('IEND')];
  await assert.rejects(loadPngSource(Uint8Array.from(huge), { maxRawBytes: 64 * 1024 * 1024 }), /too large/);
});

test('every PNG strategy changes the image at low intensity, even on a small image', async () => {
  const source = await loadPngSource(buildPng({ width: 64, height: 64, colorType: 2, filter: 4, seed: 51 }).bytes);
  for (const name of ALL_STRATEGIES) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const out = glitchPng(source, settings({ strategies: new Set([name]), intensity: 5, seed, protect: false }));
      assert.notDeepEqual(out, source.raw, `${name} s${seed}`);
    }
  }
});

// A literal transcription of the PNG specification's per-byte reconstruction,
// independent of the optimized row kernels, as a reference for every pixel size.
function referenceUnfilter(raw, layout) {
  const out = new Uint8Array(raw.length);
  const bpp = layout.bytesPerPixel;
  layout.filterPositions.forEach((pos, r) => {
    const type = raw[pos];
    const prior = layout.priorRows[r] < 0 ? -1 : layout.priorRows[r] + 1;
    for (let k = 0; k < layout.rowLengths[r]; k++) {
      const x = raw[pos + 1 + k];
      const a = k >= bpp ? out[pos + 1 + k - bpp] : 0;
      const b = prior >= 0 ? out[prior + k] : 0;
      const c = prior >= 0 && k >= bpp ? out[prior + k - bpp] : 0;
      let pred = 0;
      if (type === 1) pred = a;
      if (type === 2) pred = b;
      if (type === 3) pred = Math.floor((a + b) / 2);
      if (type === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[pos + 1 + k] = (x + pred) % 256;
    }
  });
  return out;
}

test('optimized unfilter matches a literal transcription of the spec for every pixel size', () => {
  for (const [colorType, bitDepth] of COLOR_DEPTHS) {
    for (const interlace of [0, 1]) {
      const { raw, layout } = buildPng({ colorType, bitDepth, interlace, width: 21, height: 13, filter: 'mixed', seed: colorType * 7 + bitDepth });
      const shuffled = new Uint8Array(raw);
      layout.filterPositions.forEach((pos, r) => { shuffled[pos] = (r * 3 + bitDepth) % 5; });
      assert.deepEqual(unfilterPng(shuffled, layout), referenceUnfilter(shuffled, layout), `ct${colorType} d${bitDepth} i${interlace}`);
    }
  }
});

// ── Pixels as PNG ─────────────────────────────────────────────────────────────

test('pngSourceFromPixels turns RGBA pixels into an RGB source with adaptive filters', async () => {
  const width = 50, height = 30;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let k = 0; k < width * height; k++) {
    const x = k % width, y = Math.floor(k / width);
    rgba.set([x * 5, y * 8, (x * y) & 0xFF, 255], k * 4);
  }
  const source = await pngSourceFromPixels(width, height, rgba);
  const { png, layout, raw } = source;
  assert.equal(png.colorType, 2);
  assert.equal(png.bitsPerPixel, 24);
  assert.equal(hasAlphaChannel(png), false);
  assert.deepEqual(readChunks(Uint8Array.from([...SIGNATURE, ...png.head])).map(c => c.type), ['IHDR']);

  const recon = unfilterPng(raw, layout);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = layout.filterPositions[y] + 1 + x * 3, i = (y * width + x) * 4;
      assert.deepEqual([...recon.subarray(o, o + 3)], [rgba[i], rgba[i + 1], rgba[i + 2]], `pixel ${x},${y}`);
    }
  }
  assert.deepEqual(sourceRecon(source), recon);
  assert.ok(layout.filterPositions.some(pos => raw[pos] !== 0), 'a gradient should pick filters other than None');

  const out = encodePng(png, glitchPng(source, settings({ strategies: new Set(['static', 'prism']), seed: 2 })));
  const parsed = parsePng(out);
  assert.equal(parsed.width, width);
  assert.equal(parsed.height, height);
  assert.equal(inflateIdat(out).length, layout.rawLength);
});

test('pngSourceFromPixels returns null once cancelled', async () => {
  const width = 2000, height = 400;
  const rgba = new Uint8ClampedArray(width * height * 4).map((_, k) => (k * 2654435761) >>> 24);
  assert.equal(await pngSourceFromPixels(width, height, rgba, () => true), null);
});
