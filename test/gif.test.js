const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const file of ['png.js', 'strategies.js', 'gif.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'webapp', file), 'utf8');
  vm.runInThisContext(src, { filename: file });
}

// ── Reference LZW codec ───────────────────────────────────────────────────────
// Written independently of gif.js. In testing, the decoder gave the same
// pixels as Chrome, Firefox and macOS ImageIO for every file they decoded in
// full, and the encoder's files decoded identically in all three, except at
// minimum code size 1, which only Chrome and ImageIO decoded.

function lzwEncode(indices, minCodeSize, { clearWhenFull = true } = {}) {
  const clear = 1 << minCodeSize;
  const out = [];
  let bits = 0, nbits = 0, width = minCodeSize + 1;
  const emit = code => {
    bits |= code << nbits;
    nbits += width;
    while (nbits >= 8) { out.push(bits & 0xFF); bits >>>= 8; nbits -= 8; }
  };

  let dict = new Map(), next = clear + 2;
  emit(clear);
  let w = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i];
    const hit = dict.get(w * 256 + c);
    if (hit !== undefined) { w = hit; continue; }
    emit(w);
    if (next < 4096) {
      dict.set(w * 256 + c, next++);
      if (next > (1 << width) && width < 12) width++;
    } else if (clearWhenFull) {
      emit(clear);
      dict = new Map();
      next = clear + 2;
      width = minCodeSize + 1;
    }
    w = c;
  }
  emit(w);
  emit(clear + 1);
  if (nbits) out.push(bits & 0xFF);
  return Uint8Array.from(out);
}

// Returns the pixels, how many arrived and why decoding stopped: 'full',
// 'eoi' (early end code), 'invalid' (code past the table) or 'data'.
function lzwDecode(data, minCodeSize, pixels) {
  const clear = 1 << minCodeSize;
  const prefix = new Int32Array(4096), suffix = new Uint16Array(4096), length = new Int32Array(4096);
  const out = new Uint8Array(pixels);
  for (let c = 0; c < clear; c++) { suffix[c] = c; length[c] = 1; }
  let next = clear + 2, width = minCodeSize + 1, prev = -1, filled = 0, bits = 0, nbits = 0, i = 0, stop = 'data';

  outer: while (filled < pixels) {
    while (nbits < width) {
      if (i >= data.length) break outer;
      bits |= data[i++] << nbits;
      nbits += 8;
    }
    const code = bits & ((1 << width) - 1);
    bits >>>= width;
    nbits -= width;
    if (code === clear) { next = clear + 2; width = minCodeSize + 1; prev = -1; continue; }
    if (code === clear + 1) { stop = 'eoi'; break; }
    if (prev < 0 ? code > clear : code > next) { stop = 'invalid'; break; }

    const kwk = code === next;
    let c = kwk ? prev : code;
    const len = length[c] + (kwk ? 1 : 0);
    let k = filled + length[c] - 1;
    while (c >= clear) { if (k < pixels) out[k] = suffix[c]; c = prefix[c]; k--; }
    if (k < pixels) out[k] = c;
    if (kwk && filled + len - 1 < pixels) out[filled + len - 1] = c;
    if (prev >= 0 && next < 4096) {
      prefix[next] = prev; suffix[next] = c; length[next] = length[prev] + 1;
      next++;
    }
    if (next === 1 << width && width < 12) width++;
    filled += len;
    prev = code;
  }
  return { indices: out, filled: Math.min(filled, pixels), stop: filled >= pixels ? 'full' : stop };
}

// ── Synthetic GIF builder ─────────────────────────────────────────────────────

function le16(n) {
  return [n & 0xFF, (n >> 8) & 0xFF];
}

function subBlocks(data) {
  const out = [];
  for (let i = 0; i < data.length; i += 255) {
    const n = Math.min(255, data.length - i);
    out.push(n, ...data.subarray(i, i + n));
  }
  out.push(0);
  return out;
}

function tableBits(colors) {
  return Math.max(1, Math.ceil(Math.log2(colors)));
}

function palette(colors, seed = 1) {
  const rand = makePrng(seed);
  return Array.from({ length: colors * 3 }, () => Math.floor(rand() * 256));
}

// A textured test picture: smooth bands plus noise, so LZW makes a mix of
// short and long codes and, on larger frames, fills its table.
function picture(width, height, colors, seed = 1) {
  const rand = makePrng(seed);
  const out = new Uint8Array(width * height);
  for (let p = 0; p < out.length; p++) {
    const x = p % width, y = Math.floor(p / width);
    out[p] = (Math.floor((x + y * 3) / 7) + (rand() < 0.1 ? Math.floor(rand() * colors) : 0)) % colors;
  }
  return out;
}

// frames: [{ indices, width, height, left, top, delay, transparent, interlaced,
// lct (flat RGB array), minCodeSize, data (LZW bytes instead of indices) }]
function buildGif({ width = 40, height = 30, gct = palette(16), frames, loops = -1, comment = null, trailer = true }) {
  const bytes = [...Buffer.from('GIF89a', 'latin1'), ...le16(width), ...le16(height)];
  if (gct) {
    const bits = tableBits(gct.length / 3);
    bytes.push(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0, ...gct, ...Array((1 << bits) * 3 - gct.length).fill(0));
  } else {
    bytes.push(0, 0, 0);
  }
  if (loops >= 0) bytes.push(0x21, 0xFF, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, ...le16(loops), 0);
  if (comment) bytes.push(0x21, 0xFE, ...subBlocks(Buffer.from(comment)));

  for (const f of frames) {
    const fw = f.width ?? width, fh = f.height ?? height;
    const transparent = f.transparent ?? -1;
    if (f.delay || transparent >= 0) {
      bytes.push(0x21, 0xF9, 4, transparent >= 0 ? 1 : 0, ...le16(f.delay || 0), Math.max(0, transparent), 0);
    }
    let flags = f.interlaced ? 0x40 : 0;
    const lct = f.lct || [];
    if (f.lct) flags |= 0x80 | (tableBits(lct.length / 3) - 1);
    bytes.push(0x2C, ...le16(f.left || 0), ...le16(f.top || 0), ...le16(fw), ...le16(fh), flags);
    if (f.lct) bytes.push(...lct, ...Array((1 << tableBits(lct.length / 3)) * 3 - lct.length).fill(0));
    const colors = (f.lct || gct || []).length / 3;
    const m = f.minCodeSize ?? Math.max(2, tableBits(colors));
    bytes.push(m, ...subBlocks(f.data ?? lzwEncode(f.indices, m)));
  }
  if (trailer) bytes.push(0x3B);
  return Uint8Array.from(bytes);
}

function stillGif({ width = 40, height = 30, colors = 16, seed = 1, ...rest } = {}) {
  return buildGif({ width, height, gct: palette(colors, seed), frames: [{ indices: picture(width, height, colors, seed) }], ...rest });
}

function animatedGif({ width = 24, height = 16, frames = 4, colors = 16 } = {}) {
  return buildGif({
    width, height, gct: palette(colors), loops: 0,
    frames: Array.from({ length: frames }, (_, k) => ({ indices: picture(width, height, colors, k + 1), delay: 10 })),
  });
}

function decodeFrame(gif, k) {
  const f = gif.frames[k];
  return lzwDecode(f.data, f.minCodeSize, f.width * f.height);
}

const ALL = ['static', 'dropout', 'echo', 'drift', 'smear', 'crumble'];

// ── parseGif ──────────────────────────────────────────────────────────────────

test('parses the screen, color tables, frames and loop count', () => {
  const lct = palette(4, 9);
  const bytes = buildGif({
    width: 50, height: 20, loops: 0, comment: 'hello',
    frames: [
      { indices: picture(50, 20, 16), delay: 7, transparent: 3 },
      { indices: picture(10, 5, 4), width: 10, height: 5, left: 4, top: 2, lct, interlaced: true },
    ],
  });
  const gif = parseGif(bytes);

  assert.equal(gif.version, '89a');
  assert.equal(gif.width, 50);
  assert.equal(gif.height, 20);
  assert.equal(gif.loops, 0);
  assert.equal(gif.end, bytes.length - 1);
  assert.deepEqual(gif.colorTables.map(t => t.count), [16, 4]);
  assert.deepEqual(Array.from(bytes.subarray(gif.colorTables[1].start, gif.colorTables[1].start + 12)), lct);

  const [a, b] = gif.frames;
  assert.deepEqual([a.left, a.top, a.width, a.height, a.interlaced, a.table, a.colors, a.transparent, a.minCodeSize], [0, 0, 50, 20, false, 0, 16, 3, 4]);
  assert.deepEqual([b.left, b.top, b.width, b.height, b.interlaced, b.table, b.colors, b.transparent, b.minCodeSize], [4, 2, 10, 5, true, 1, 4, -1, 2]);
  assert.deepEqual(decodeFrame(gif, 1).indices, picture(10, 5, 4));
  assert.equal(bytes[a.dataStart - 1], a.minCodeSize);
  assert.equal(bytes[a.dataEnd - 1], 0);
});

test('a GIF without any color table gives its frames no table and no color count', () => {
  const gif = parseGif(buildGif({ gct: null, frames: [{ indices: picture(40, 30, 4), minCodeSize: 2 }] }));
  assert.deepEqual(gif.colorTables, []);
  assert.equal(gif.frames[0].table, -1);
  assert.equal(gif.frames[0].colors, 0);
});

test('tolerates a missing trailer and keeps the data of a frame cut off midway', () => {
  const bytes = stillGif({ width: 60, height: 40, trailer: false });
  const whole = parseGif(bytes);
  assert.equal(whole.end, bytes.length);

  const cut = parseGif(bytes.subarray(0, bytes.length - 100));
  assert.equal(cut.frames.length, 1);
  assert.equal(cut.end, bytes.length - 100);
  assert.equal(cut.frames[0].dataEnd, bytes.length - 100);
  assert.ok(cut.frames[0].data.length < whole.frames[0].data.length);
});

test('a block cut off before any image data is left out', () => {
  const two = animatedGif({ frames: 2 });
  const gif = parseGif(two);
  const second = gif.frames[1];

  for (const end of [second.dataStart - 1, second.dataStart - 5, second.dataStart]) {
    const cut = parseGif(two.subarray(0, end));
    assert.equal(cut.frames.length, 1, `cut at ${end}`);
    assert.equal(two[cut.end], 0x2C, `cut at ${end} ends at ${cut.end}`);
    assert.ok(cut.end > gif.frames[0].dataEnd);
  }

  const still = stillGif();
  const end = parseGif(still).end;
  const cutComment = parseGif(Uint8Array.from([...still.subarray(0, end), 0x21, 0xFE, 30, 1, 2]));
  assert.equal(cutComment.end, end);
});

test('frames of zero size are kept as they are, and left out when cut off', () => {
  const bytes = buildGif({ frames: [{ indices: picture(40, 30, 16) }, { indices: Uint8Array.of(1), width: 0, height: 0, data: Uint8Array.of(4, 1) }] });
  const gif = parseGif(bytes);
  assert.equal(gif.frames.length, 1);
  assert.equal(gif.end, bytes.length - 1);

  const cut = bytes.subarray(0, bytes.length - 2);
  const out = glitchGif(loadGifSource(cut), { strategies: new Set(), intensity: 50, seed: 1 }).bytes;
  assert.equal(parseGif(out).end, out.length - 1);
  assert.equal(out[out.length - 1], 0x3B);
});

test('only frames that are kept list their local color table', () => {
  const bytes = buildGif({ frames: [{ indices: picture(40, 30, 16) }, { indices: picture(8, 8, 4), width: 8, height: 8, lct: palette(4) }] });
  const second = parseGif(bytes).frames[1];
  const cut = parseGif(bytes.subarray(0, second.dataStart));
  assert.equal(cut.frames.length, 1);
  assert.equal(cut.colorTables.length, 1);
});

test('a bad LZW code size after the first frame ends the file there', () => {
  const bytes = animatedGif({ frames: 2 });
  const second = parseGif(bytes).frames[1];
  const broken = Uint8Array.from(bytes);
  broken[second.dataStart - 1] = 12;
  const gif = parseGif(broken);
  assert.equal(gif.frames.length, 1);
  assert.ok(gif.end < second.dataStart);
});

test('stops at an unknown block once a frame is read', () => {
  const bytes = stillGif();
  const end = parseGif(bytes).end;
  const junk = Uint8Array.from([...bytes.subarray(0, end), 0x99, 1, 2, 3]);
  assert.equal(parseGif(junk).end, end);
});

test('rejects malformed GIFs with specific messages', () => {
  assert.throws(() => parseGif(Uint8Array.from([0x89, 0x50, 0x4E, 0x47])), /signature/);
  assert.throws(() => parseGif(Uint8Array.from(Buffer.from('GIF89a\x01\x00'))), /truncated header/);
  const header = [...Buffer.from('GIF89a', 'latin1'), 4, 0, 4, 0, 0, 0, 0];
  assert.throws(() => parseGif(Uint8Array.from([...header, 0x3B])), /Could not locate any image data/);
  assert.throws(() => parseGif(Uint8Array.from([...header, 0x77, 0x3B])), /Malformed GIF structure/);
  const badCodeSize = [...header, 0x2C, 0, 0, 0, 0, 4, 0, 4, 0, 0, 12, 1, 0, 0, 0x3B];
  assert.throws(() => parseGif(Uint8Array.from(badCodeSize)), /invalid LZW code size \(12\)/);
});

// ── LZW codes ─────────────────────────────────────────────────────────────────

test('repairing undamaged codes gives back the original data bit for bit', () => {
  for (const colors of [2, 4, 16, 256]) {
    for (const [width, height] of [[1, 1], [9, 7], [120, 90]]) {
      for (const clearWhenFull of [true, false]) {
        const m = Math.max(2, tableBits(colors));
        const data = lzwEncode(picture(width, height, colors), m, { clearWhenFull });
        const codes = unpackCodes(data, m);
        assert.deepEqual(repairCodes(codes, m, width * height, colors), data, `${colors} colors ${width}x${height} clear ${clearWhenFull}`);
        assert.deepEqual(packRawCodes(codes, m, width * height), { data, complete: true });
      }
    }
  }
});

test('minimum code size 1 widens codes after the first one, as Chrome and ImageIO read it', () => {
  const indices = Uint8Array.from({ length: 1200 }, (_, p) => ((p % 40) >> 2 ^ (p / 40) >> 2) & 1);
  const data = lzwEncode(indices, 1);
  const codes = unpackCodes(data, 1);
  assert.equal(codes[codes.length - 1], 3);
  assert.deepEqual(repairCodes(codes, 1, indices.length, 2), data);
  assert.deepEqual(packRawCodes(codes, 1, indices.length), { data, complete: true });
  assert.deepEqual(lzwDecode(data, 1, indices.length).indices, indices);
});

test('unpackCodes reads codes at the width a decoder uses, through a full table', () => {
  const indices = picture(400, 300, 256, 5);
  const data = lzwEncode(indices, 8, { clearWhenFull: false });
  const codes = unpackCodes(data, 8);
  assert.equal(codes[0], 256);
  assert.equal(codes[codes.length - 1], 257);
  assert.ok(codes.length > 4096, 'the table fills up');
  assert.deepEqual(lzwDecode(repairCodes(codes, 8, indices.length, 256), 8, indices.length).indices, indices);
});

test('an early end code and codes past the table are replaced by valid codes', () => {
  const indices = picture(60, 40, 16);
  const codes = unpackCodes(lzwEncode(indices, 4), 4);
  for (const bad of [17, 4095]) {
    const damaged = Uint16Array.from(codes);
    damaged[Math.floor(codes.length / 3)] = bad;
    assert.notEqual(lzwDecode(packRawCodes(damaged, 4, indices.length).data, 4, indices.length).stop, 'full');

    const repaired = lzwDecode(repairCodes(damaged, 4, indices.length, 16), 4, indices.length);
    assert.equal(repaired.stop, 'full', `code ${bad}`);
  }
});

test('a frame that comes up short starts over from the top', () => {
  const indices = picture(50, 40, 16, 3);
  const codes = unpackCodes(lzwEncode(indices, 4), 4);
  const half = codes.slice(0, Math.floor(codes.length / 2));
  const first = lzwDecode(packRawCodes(Uint16Array.from([...half, 17]), 4, indices.length).data, 4, indices.length);
  assert.equal(first.stop, 'eoi');

  const { indices: out, stop } = lzwDecode(repairCodes(half, 4, indices.length, 16), 4, indices.length);
  assert.equal(stop, 'full');
  assert.ok(first.filled < indices.length / 2);
  assert.deepEqual(out.subarray(0, first.filled), indices.subarray(0, first.filled));
  assert.ok(out.every((c, p) => c === out[p % first.filled]), 'the rest repeats the top');
});

test('codes beyond a full frame are dropped', () => {
  const indices = picture(30, 20, 16);
  const codes = unpackCodes(lzwEncode(indices, 4), 4);
  const extra = Uint16Array.from([...codes.subarray(0, -1), ...codes.subarray(1, 200), 17]);
  const repaired = repairCodes(extra, 4, indices.length, 16);
  assert.deepEqual(repaired, lzwEncode(indices, 4));
});

test('pixel indices past the color table wrap around it', () => {
  const indices = Uint8Array.from({ length: 64 }, (_, p) => p % 8);
  const codes = unpackCodes(lzwEncode(indices, 3), 3);
  const { indices: out, stop } = lzwDecode(repairCodes(codes, 3, 64, 5), 3, 64);
  assert.equal(stop, 'full');
  assert.deepEqual(out, indices.map(c => c % 5));
});

test('a frame of nothing but clear codes is filled rather than looping forever', () => {
  const out = lzwDecode(repairCodes(Uint16Array.of(4, 4, 4), 2, 50, 4), 2, 50);
  assert.equal(out.stop, 'full');
});

test('starting over stays fast when the codes are nearly all clear codes', () => {
  const codes = new Uint16Array(100_000).fill(4);
  codes[codes.length - 1] = 1;
  const start = performance.now();
  const out = lzwDecode(repairCodes(codes, 2, 400 * 400, 4), 2, 400 * 400);
  assert.equal(out.stop, 'full');
  assert.ok(performance.now() - start < 500, `took ${Math.round(performance.now() - start)} ms`);
});

test('packRawCodes reports a frame as complete exactly when the reference decoder fills it', () => {
  const indices = picture(80, 60, 16, 2);
  const codes = unpackCodes(lzwEncode(indices, 4), 4);
  const rand = makePrng(99);
  for (let t = 0; t < 200; t++) {
    const damaged = Uint16Array.from(codes);
    const hits = 1 + Math.floor(rand() * 4);
    for (let h = 0; h < hits; h++) damaged[Math.floor(rand() * damaged.length)] = Math.floor(rand() * 70000);
    const { data, complete } = packRawCodes(damaged, 4, indices.length);
    assert.equal(complete, lzwDecode(data, 4, indices.length).stop === 'full', `trial ${t}`);
  }
});

test('Echo and Drift copy codes wider than a byte intact', () => {
  const codes = Uint16Array.from({ length: 1000 }, (_, k) => 258 + (k * 37) % 3800);
  const info = { scanRanges: [{ start: 0, end: codes.length }], scanLength: codes.length };
  for (const name of ['echo', 'drift']) {
    const buf = Uint16Array.from(codes);
    runPipeline(buf, info, new Set([name]), 80, 5);
    const original = new Set(codes);
    assert.ok(buf.every(c => c === 0 || original.has(c)), name);
    assert.ok(buf.some((c, k) => c !== codes[k]), name);
  }
});

// ── Prism ─────────────────────────────────────────────────────────────────────

test('countColors matches the reference decoder, transparent pixels left out', () => {
  const bytes = buildGif({
    gct: palette(16), frames: [
      { indices: picture(40, 30, 16, 1) },
      { indices: picture(40, 30, 16, 2), transparent: 5 },
    ],
  });
  const source = loadGifSource(bytes);
  const [weights] = colorWeights(source.gif, source.codes);
  const expected = new Float64Array(16);
  source.gif.frames.forEach((f, k) => {
    for (const c of decodeFrame(source.gif, k).indices) if (c !== f.transparent) expected[c]++;
  });
  assert.deepEqual(weights, expected);
});

test('Prism changes only colors the image uses, and nothing outside the color tables', () => {
  const indices = picture(40, 30, 6);
  const bytes = buildGif({ gct: palette(16), frames: [{ indices }] });
  const source = loadGifSource(bytes);
  const { bytes: out } = glitchGif(source, { strategies: new Set(['prism']), intensity: 100, seed: 3 });
  const table = source.gif.colorTables[0].start;

  assert.equal(out.length, bytes.length);
  let changed = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (out[i] === bytes[i]) continue;
    const entry = Math.floor((i - table) / 3);
    assert.ok(i >= table && entry < 6, `byte ${i} (entry ${entry}) changed`);
    changed++;
  }
  assert.ok(changed > 0);
});

test('Prism rotates the channels of colors and flips a top bit of grays', () => {
  const gct = [10, 200, 90, 128, 128, 128];
  const bytes = buildGif({ gct, width: 10, height: 10, frames: [{ indices: Uint8Array.from({ length: 100 }, (_, p) => p % 2) }] });
  const source = loadGifSource(bytes);
  const at = source.gif.colorTables[0].start;
  const seen = new Set();

  for (let seed = 1; seed <= 20; seed++) {
    const { bytes: out } = glitchGif(source, { strategies: new Set(['prism']), intensity: 100, seed });
    const color = Array.from(out.subarray(at, at + 3));
    const gray  = Array.from(out.subarray(at + 3, at + 6));
    if (color.join() !== gct.slice(0, 3).join()) {
      assert.ok([[200, 90, 10], [90, 10, 200]].some(r => r.join() === color.join()), `seed ${seed} color ${color}`);
      seen.add('color');
    }
    if (gray.join() !== gct.slice(3).join()) {
      assert.equal(gray.filter((v, k) => v !== gct[3 + k]).length, 1, `seed ${seed} gray ${gray}`);
      assert.ok(gray.every((v, k) => v === gct[3 + k] || v === (gct[3 + k] ^ 0x80)), `seed ${seed} gray ${gray}`);
      seen.add('gray');
    }
  }
  assert.deepEqual([...seen].sort(), ['color', 'gray']);
});

test('Prism favors the colors that cover the most pixels', () => {
  const indices = Uint8Array.from({ length: 1000 }, (_, p) => (p % 100 === 0 ? 1 + (p / 100) % 7 : 0));
  const bytes = buildGif({ width: 50, height: 20, gct: palette(8, 4), frames: [{ indices }] });
  const source = loadGifSource(bytes);
  const at = source.gif.colorTables[0].start;
  let background = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const { bytes: out } = glitchGif(source, { strategies: new Set(['prism']), intensity: 1, seed });
    if (out.subarray(at, at + 3).some((v, k) => v !== bytes[at + k])) background++;
  }
  assert.ok(background >= 16, `background picked for ${background} of 20 seeds`);
});

// ── glitchGif ─────────────────────────────────────────────────────────────────

test('without strategies the file comes back unchanged', () => {
  for (const bytes of [stillGif({ width: 90, height: 70, colors: 256 }), animatedGif()]) {
    const out = glitchGif(loadGifSource(bytes), { strategies: new Set(), intensity: 50, seed: 1 });
    assert.deepEqual(out.bytes, bytes);
    assert.equal(out.cutFrames, 0);
  }
});

test('every strategy changes the image at low intensity, even on a small image', () => {
  const source = loadGifSource(stillGif({ width: 64, height: 64 }));
  const original = decodeFrame(source.gif, 0).indices;
  for (const name of [...ALL, 'prism']) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const out = glitchGif(source, { strategies: new Set([name]), intensity: 5, seed }).bytes;
      const gif = parseGif(out);
      const same = name === 'prism'
        ? Buffer.compare(Buffer.from(out), Buffer.from(source.bytes)) === 0
        : Buffer.compare(Buffer.from(decodeFrame(gif, 0).indices), Buffer.from(original)) === 0;
      assert.ok(!same, `${name} s${seed}`);
    }
  }
});

test('with protection every frame decodes in full, with every index inside its color table', () => {
  const sources = [
    stillGif({ width: 120, height: 90, colors: 256, seed: 4 }),
    stillGif({ width: 33, height: 21, colors: 2 }),
    animatedGif({ frames: 5 }),
    buildGif({ gct: palette(5), frames: [{ indices: picture(40, 30, 5), minCodeSize: 3 }] }),
    buildGif({ frames: [{ indices: picture(40, 30, 16), interlaced: true }] }),
  ].map(b => loadGifSource(b));
  const rand = makePrng(7);

  for (let t = 0; t < 120; t++) {
    const source = sources[t % sources.length];
    const strategies = new Set([...ALL, 'prism'].filter(() => rand() < 0.4));
    const settings = { strategies, intensity: Math.floor(rand() * 101), seed: Math.floor(rand() * 1e6), steady: rand() < 0.5 };
    const gif = parseGif(glitchGif(source, settings).bytes);
    assert.equal(gif.frames.length, source.gif.frames.length);
    gif.frames.forEach((f, k) => {
      const { indices, stop } = decodeFrame(gif, k);
      assert.equal(stop, 'full', `trial ${t} frame ${k}`);
      const limit = Math.min(f.colors, 1 << f.minCodeSize);
      assert.ok(indices.every(c => c < limit), `trial ${t} frame ${k}: index past the table`);
    });
  }
});

test('without protection cutFrames counts the frames decoders give up on', () => {
  const source = loadGifSource(animatedGif({ frames: 6, width: 60, height: 40 }));
  let seen = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const out = glitchGif(source, { strategies: new Set(['smear', 'drift']), intensity: 100, seed, protect: false });
    const gif = parseGif(out.bytes);
    const cut = gif.frames.filter((f, k) => decodeFrame(gif, k).stop !== 'full').length;
    assert.equal(out.cutFrames, cut, `seed ${seed}`);
    seen += cut;
  }
  assert.ok(seen > 0, 'some frames were cut off');
});

test('everything outside the image data stays as it was', () => {
  const bytes = buildGif({
    loops: 3, comment: 'keep me',
    frames: [{ indices: picture(40, 30, 16), delay: 4 }, { indices: picture(20, 10, 4), width: 20, height: 10, left: 5, top: 6, lct: palette(4, 2), transparent: 1 }],
  });
  const source = loadGifSource(bytes);
  const out = glitchGif(source, { strategies: new Set(ALL), intensity: 70, seed: 9 }).bytes;
  const gif = parseGif(out);

  const outside = (b, g) => {
    const parts = [];
    let at = 0;
    for (const f of g.frames) { parts.push(...b.subarray(at, f.dataStart)); at = f.dataEnd; }
    parts.push(...b.subarray(at));
    return parts;
  };
  assert.deepEqual(outside(out, gif), outside(bytes, source.gif));
  assert.equal(gif.loops, 3);
});

test('a cut-off file comes back closed, with every frame in full', () => {
  const bytes = stillGif({ width: 80, height: 60, colors: 64 });
  const source = loadGifSource(bytes.subarray(0, bytes.length - 300));
  const out = glitchGif(source, { strategies: new Set(['static']), intensity: 10, seed: 1 }).bytes;
  assert.equal(out[out.length - 1], 0x3B);
  assert.equal(out[out.length - 2], 0);
  assert.equal(decodeFrame(parseGif(out), 0).stop, 'full');
});

test('the same settings give the same file', () => {
  const source = loadGifSource(animatedGif());
  const settings = { strategies: new Set([...ALL, 'prism']), intensity: 40, seed: 12345 };
  assert.deepEqual(glitchGif(source, settings).bytes, glitchGif(source, settings).bytes);
});

test('steady repeats the damage of the first frame on every frame', () => {
  const frame = { indices: picture(40, 30, 16), delay: 5 };
  const source = loadGifSource(buildGif({ frames: [frame, frame, frame] }));
  const datas = steady => {
    const gif = parseGif(glitchGif(source, { strategies: new Set(['static', 'drift']), intensity: 60, seed: 4, steady }).bytes);
    return gif.frames.map(f => Buffer.from(f.data));
  };

  const still = datas(true);
  assert.deepEqual(still[1], still[0]);
  assert.deepEqual(still[2], still[0]);

  const moving = datas(false);
  assert.deepEqual(moving[0], still[0]);
  assert.notDeepEqual(moving[1], moving[0]);
});

test('loadGifSource rejects GIFs above the pixel limit before unpacking', () => {
  assert.throws(() => loadGifSource(animatedGif({ frames: 3 }), { maxPixels: 1000 }), /GIF too large/);
  assert.equal(loadGifSource(animatedGif({ frames: 3 }), { maxPixels: 3 * 24 * 16 }).pixels, 3 * 24 * 16);
});
