'use strict';

// ── JPEG surgery ──────────────────────────────────────────────────────────────
//
// A JPEG does not store pixels. It cuts the picture into blocks of 8 × 8,
// describes every block as a mix of 64 wave patterns, from flat to finely
// checkered, and stores how much of each pattern the block holds, divided by a
// table of step sizes and rounded. The table travels in the file's header,
// next to the picture's size and the way the color was shrunk, and a decoder
// believes all of it.
//
// The Glitch page damages a JPEG blindly, as stored bytes. This page opens it
// up: it uses the encoder of the JPEG crush page (crush.js) up to the point
// where the numbers are known, and then does two things before packing them
// into a file.
//
//   cut   operate on the numbers themselves: drop a range of patterns, mirror
//         each block, shift every pattern to the next finer one, give blocks
//         the texture of other blocks, let the brightness drift
//   lie   write a header that does not match: step sizes for another quality,
//         another width, another color layout
//
// The result is always a correct baseline JPEG. Any decoder reads it without
// complaint and shows exactly what the file tells it to.

const SURGERY_SAMPLINGS = ['honest', ...Object.keys(SUBSAMPLING)];

// Zigzag position → the position of the mirrored pattern (rows and columns of
// the 8 × 8 pattern grid swapped).
const ZIGZAG_TRANSPOSED = (() => {
  const at = new Uint8Array(64);
  for (let z = 0; z < 64; z++) at[ZIGZAG[z]] = z;
  return Uint8Array.from({ length: 64 }, (_, z) => {
    const k = ZIGZAG[z];
    return at[(k & 7) * 8 + (k >> 3)];
  });
})();

// ── Cuts ──────────────────────────────────────────────────────────────────────
// Each works on one component's numbers: blocks of 64 in zigzag order, the
// first being the block's average (DC), the rest ever finer patterns (AC).

function cutBand(coefs, low, high) {
  const lo = Math.min(low, high), hi = Math.max(low, high);
  if (lo === 0 && hi === 63) return;
  for (let o = 0; o < coefs.length; o += 64) {
    for (let k = 0; k < lo; k++) coefs[o + k] = 0;
    for (let k = hi + 1; k < 64; k++) coefs[o + k] = 0;
  }
}

function cutTranspose(coefs) {
  const block = new Int16Array(64);
  for (let o = 0; o < coefs.length; o += 64) {
    block.set(coefs.subarray(o, o + 64));
    for (let z = 0; z < 64; z++) coefs[o + ZIGZAG_TRANSPOSED[z]] = block[z];
  }
}

// Moves every pattern `shift` places along the zigzag, from coarse toward
// fine, wrapping around; the average stays where it is.
function cutShift(coefs, shift) {
  const k = ((shift % 63) + 63) % 63;
  if (!k) return;
  const block = new Int16Array(64);
  for (let o = 0; o < coefs.length; o += 64) {
    block.set(coefs.subarray(o, o + 64));
    for (let j = 1; j < 64; j++) coefs[o + 1 + ((j - 1 + k) % 63)] = block[j];
  }
}

function cutNegate(coefs) {
  for (let o = 0; o < coefs.length; o += 64) {
    for (let k = 1; k < 64; k++) coefs[o + k] = -coefs[o + k];
  }
}

// Gives a share of the blocks the patterns of a random other block. Each keeps
// its own average, so the picture stays where it is and only its texture moves.
function cutTransplant(coefs, amount, random) {
  if (amount <= 0) return;
  const blocks = coefs.length / 64;
  const original = Int16Array.from(coefs);
  for (let b = 0; b < blocks; b++) {
    const donor = Math.floor(random() * blocks);
    if (random() * 100 >= amount) continue;
    coefs.set(original.subarray(donor * 64 + 1, donor * 64 + 64), b * 64 + 1);
  }
}

// A JPEG stores each block's average as the difference from the block before
// it, so one wrong difference shifts everything that follows. This makes that
// happen on purpose: at random places along the scan the average jumps, and
// stays wrong until the next jump.
function cutDrift(layout, coefs, quant, amount, random) {
  if (amount <= 0) return;
  const { comps, mcuCols, mcuRows } = layout;
  const mcus = mcuCols * mcuRows;
  const jumps = Math.max(1, Math.round((amount / 100) ** 1.5 * 60));
  const reach = 40 + amount * 1.6;                  // pixel values

  comps.forEach((c, ci) => {
    const at = new Map();
    for (let j = 0; j < jumps; j++) at.set(Math.floor(random() * mcus), (random() * 2 - 1) * reach);
    const step = quant[c.table][0] / 8;             // pixel values per unit of DC
    const share = ci === 0 ? 1 : 0.6;
    let drift = 0;
    for (let m = 0; m < mcus; m++) {
      if (at.has(m)) drift = random() < 0.25 ? 0 : at.get(m) * share;
      if (!drift) continue;
      const add = Math.round(drift / step);
      const mx = m % mcuCols, my = (m - mx) / mcuCols;
      for (let by = 0; by < c.v; by++) {
        for (let bx = 0; bx < c.h; bx++) {
          const o = ((my * c.v + by) * c.bw + mx * c.h + bx) * 64;
          coefs[ci][o] = Math.max(-1023, Math.min(1023, coefs[ci][o] + add));
        }
      }
    }
  });
}

// ── Lies ──────────────────────────────────────────────────────────────────────

// What the header will claim, and whether it is true.
function surgeryHeader(layout, width, height, s) {
  const lyingAboutLayout = s.sampling !== 'honest' && s.sampling !== s.subsampling;
  const [h, v] = lyingAboutLayout ? SUBSAMPLING[s.sampling] : [layout.h, layout.v];
  const blocks = layout.mcuCols * layout.mcuRows * (layout.h * layout.v + 2);
  const mcus = Math.floor(blocks / (h * v + 2));

  // A picture so small that it holds less than one unit of the claimed layout
  // cannot carry that lie.
  if ((!lyingAboutLayout && !s.widen) || mcus < 1) return { width, height, h: layout.h, v: layout.v, honest: true };

  // The claimed size has to be a whole number of units, and no more of them
  // than the file holds, or the decoder would run out of data.
  const honestCols = lyingAboutLayout ? Math.ceil(width / (8 * h)) : layout.mcuCols;
  // A JPEG header has 16 bits for each side.
  const most = unit => Math.floor(65535 / (8 * unit));
  const cols = Math.max(1, Math.min(mcus, most(h), honestCols + s.widen));
  const rows = Math.max(1, Math.min(most(v), Math.floor(mcus / cols)));
  return { width: cols * 8 * h, height: rows * 8 * v, h, v, honest: false };
}

function encodeSurgery({ layout, coefs, tables, header, sharedCodes }) {
  // When the header lies about the color layout, the decoder hands blocks to
  // the wrong component. That only decodes if every component uses the same
  // Huffman codes, so then there is one pair of tables for all of them.
  const scanLayout = sharedCodes
    ? { ...layout, comps: layout.comps.map(c => ({ ...c, table: 0 })) }
    : layout;
  const tableCount = sharedCodes ? 2 : 4;

  const counts = Array.from({ length: tableCount }, () => new Float64Array(257));
  walkScan(scanLayout, coefs, (table, symbol) => { counts[table][symbol]++; });
  const specs = counts.map(optimalTable);
  const codes = specs.map(huffmanCodes);

  const { width, height, h, v } = header;
  const w = new ByteWriter(layout.comps[0].pw * layout.comps[0].ph);
  w.bytes([0xFF, 0xD8]);
  w.bytes([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);

  w.bytes([0xFF, 0xDB, 0x00, 2 + 2 * 65]);
  tables.forEach((table, id) => {
    w.byte(id);
    for (let z = 0; z < 64; z++) w.byte(table[ZIGZAG[z]]);
  });

  w.bytes([0xFF, 0xC0, 0x00, 17, 8, height >> 8, height & 0xFF, width >> 8, width & 0xFF, 3]);
  w.bytes([1, (h << 4) | v, 0, 2, 0x11, 1, 3, 0x11, 1]);

  const dhtLength = 2 + specs.reduce((n, spec) => n + 17 + spec.values.length, 0);
  w.bytes([0xFF, 0xC4, dhtLength >> 8, dhtLength & 0xFF]);
  [0x00, 0x10, 0x01, 0x11].slice(0, tableCount).forEach((tag, i) => {
    w.byte(tag);
    w.bytes(specs[i].bits);
    w.bytes(specs[i].values);
  });

  const selectors = sharedCodes ? [0x00, 0x00, 0x00] : [0x00, 0x11, 0x11];
  w.bytes([0xFF, 0xDA, 0x00, 12, 3, 1, selectors[0], 2, selectors[1], 3, selectors[2], 0, 63, 0]);
  walkScan(scanLayout, coefs, (table, symbol, extra, extraBits) => {
    const c = codes[table];
    w.bits(c.code[symbol], c.size[symbol]);
    w.bits(extra, extraBits);
  });
  w.flushBits();
  w.bytes([0xFF, 0xD9]);
  return w.result();
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

const SURGERY_DEFAULTS = {
  quality: 50,
  subsampling: '420',
  low: 0,
  high: 63,
  transpose: false,
  negate: false,
  shift: 0,
  transplant: 0,
  drift: 0,
  swapColors: false,
  seed: 1,
  lie: true,
  declared: 25,
  swapTables: false,
  widen: 0,
  sampling: 'honest',
};

function* surgerySteps(source, settings) {
  const s = { ...SURGERY_DEFAULTS, ...settings };
  const { width, height } = source;
  const cache = source.cache || (source.cache = {});
  const key = `${s.quality}/${s.subsampling}`;

  // The honest part: the same numbers the JPEG crush page would store.
  if (!cache.surgery || cache.surgery.key !== key) {
    const layout = crushLayout(width, height, s.subsampling);
    const quant = [scaleQuant(LUMA_QUANT, s.quality), scaleQuant(CHROMA_QUANT, s.quality)];
    const planes = toPlanes(flattenRgba(source.rgba, width, height), width, height, layout);
    yield 0.1;
    const coefs = [];
    for (let i = 0; i < 3; i++) {
      coefs.push(quantizeComponent(planes[i], layout.comps[i], quant[layout.comps[i].table], true));
      yield 0.1 + 0.2 * (i + 1);
    }
    cache.surgery = { key, layout, quant, coefs };
  }
  const { layout, quant } = cache.surgery;
  let coefs = cache.surgery.coefs.map(c => Int16Array.from(c));

  const random = prng(s.seed);
  cutDrift(layout, coefs, quant, s.drift, random);
  for (const c of coefs) {
    cutTransplant(c, s.transplant, random);
    if (s.transpose) cutTranspose(c);
    cutShift(c, s.shift);
    if (s.negate) cutNegate(c);
    cutBand(c, s.low, s.high);
  }
  if (s.swapColors) coefs = [coefs[0], coefs[2], coefs[1]];
  yield 0.8;

  let tables = s.lie ? [scaleQuant(LUMA_QUANT, s.declared), scaleQuant(CHROMA_QUANT, s.declared)] : quant;
  if (s.swapTables) tables = [tables[1], tables[0]];
  const header = surgeryHeader(layout, width, height, s);
  const sharedCodes = header.h !== layout.h || header.v !== layout.v;
  const bytes = encodeSurgery({ layout, coefs, tables, header, sharedCodes });

  return { bytes, type: 'image/jpeg', ext: 'jpg', width: header.width, height: header.height, honest: header.honest && !s.lie && !s.swapTables };
}
