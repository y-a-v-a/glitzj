'use strict';

// ── JPEG crush ────────────────────────────────────────────────────────────────
//
// A baseline JPEG encoder of its own rather than canvas.toBlob, so the same
// image and settings give the same bytes in every browser, and so the knobs
// browsers hide (separate color quality, subsampling, generation loss) exist.

const ZIGZAG = new Uint8Array([
   0,  1,  8, 16,  9,  2,  3, 10,
  17, 24, 32, 25, 18, 11,  4,  5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13,  6,  7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
]);

const LUMA_QUANT = new Uint8Array([
  16, 11, 10, 16,  24,  40,  51,  61,
  12, 12, 14, 19,  26,  58,  60,  55,
  14, 13, 16, 24,  40,  57,  69,  56,
  14, 17, 22, 29,  51,  87,  80,  62,
  18, 22, 37, 56,  68, 109, 103,  77,
  24, 35, 55, 64,  81, 104, 113,  92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103,  99,
]);

const CHROMA_QUANT = new Uint8Array([
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
]);

const SUBSAMPLING = {
  '444': [1, 1],
  '422': [2, 1],
  '420': [2, 2],
  '411': [4, 1],
  '410': [4, 2],
};

const AAN_SCALE = [1, 1.387039845, 1.306562965, 1.175875602, 1, 0.785694958, 0.541196100, 0.275899379];

function scaleQuant(base, quality) {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) out[i] = Math.min(255, Math.max(1, Math.floor((base[i] * scale + 50) / 100)));
  return out;
}

function fdct1d(d, o, s) {
  const d0 = d[o], d1 = d[o + s], d2 = d[o + 2 * s], d3 = d[o + 3 * s];
  const d4 = d[o + 4 * s], d5 = d[o + 5 * s], d6 = d[o + 6 * s], d7 = d[o + 7 * s];
  const tmp0 = d0 + d7, tmp7 = d0 - d7, tmp1 = d1 + d6, tmp6 = d1 - d6;
  const tmp2 = d2 + d5, tmp5 = d2 - d5, tmp3 = d3 + d4, tmp4 = d3 - d4;

  const tmp10 = tmp0 + tmp3, tmp13 = tmp0 - tmp3, tmp11 = tmp1 + tmp2, tmp12 = tmp1 - tmp2;
  d[o] = tmp10 + tmp11;
  d[o + 4 * s] = tmp10 - tmp11;
  const z1 = (tmp12 + tmp13) * 0.707106781;
  d[o + 2 * s] = tmp13 + z1;
  d[o + 6 * s] = tmp13 - z1;

  const t10 = tmp4 + tmp5, t11 = tmp5 + tmp6, t12 = tmp6 + tmp7;
  const z5 = (t10 - t12) * 0.382683433;
  const z2 = 0.541196100 * t10 + z5;
  const z4 = 1.306562965 * t12 + z5;
  const z3 = t11 * 0.707106781;
  const z11 = tmp7 + z3, z13 = tmp7 - z3;
  d[o + 5 * s] = z13 + z2;
  d[o + 3 * s] = z13 - z2;
  d[o + s] = z11 + z4;
  d[o + 7 * s] = z11 - z4;
}

function idct1d(d, o, s) {
  let tmp0 = d[o], tmp1 = d[o + 2 * s], tmp2 = d[o + 4 * s], tmp3 = d[o + 6 * s];
  const tmp10 = tmp0 + tmp2, tmp11 = tmp0 - tmp2;
  const tmp13 = tmp1 + tmp3;
  const tmp12 = (tmp1 - tmp3) * 1.414213562 - tmp13;
  tmp0 = tmp10 + tmp13;
  tmp3 = tmp10 - tmp13;
  tmp1 = tmp11 + tmp12;
  tmp2 = tmp11 - tmp12;

  const tmp4 = d[o + s], tmp5 = d[o + 3 * s], tmp6 = d[o + 5 * s], tmp7 = d[o + 7 * s];
  const z13 = tmp6 + tmp5, z10 = tmp6 - tmp5, z11 = tmp4 + tmp7, z12 = tmp4 - tmp7;
  const o7 = z11 + z13;
  const o11 = (z11 - z13) * 1.414213562;
  const z5 = (z10 + z12) * 1.847759065;
  const o10 = 1.082392200 * z12 - z5;
  const o12 = -2.613125930 * z10 + z5;
  const o6 = o12 - o7;
  const o5 = o11 - o6;
  const o4 = o10 + o5;

  d[o] = tmp0 + o7;
  d[o + 7 * s] = tmp0 - o7;
  d[o + s] = tmp1 + o6;
  d[o + 6 * s] = tmp1 - o6;
  d[o + 2 * s] = tmp2 + o5;
  d[o + 5 * s] = tmp2 - o5;
  d[o + 4 * s] = tmp3 + o4;
  d[o + 3 * s] = tmp3 - o4;
}

function fdct(block) {
  for (let r = 0; r < 64; r += 8) fdct1d(block, r, 1);
  for (let c = 0; c < 8; c++) fdct1d(block, c, 8);
}

function idct(block) {
  for (let c = 0; c < 8; c++) idct1d(block, c, 8);
  for (let r = 0; r < 64; r += 8) idct1d(block, r, 1);
}

function crushLayout(width, height, subsampling) {
  const [h, v] = SUBSAMPLING[subsampling] || SUBSAMPLING['420'];
  const mcuCols = Math.ceil(width / (8 * h));
  const mcuRows = Math.ceil(height / (8 * v));
  const comps = [
    { id: 1, h, v, table: 0 },
    { id: 2, h: 1, v: 1, table: 1 },
    { id: 3, h: 1, v: 1, table: 1 },
  ];
  for (const c of comps) {
    c.bw = mcuCols * c.h;
    c.bh = mcuRows * c.v;
    c.pw = c.bw * 8;
    c.ph = c.bh * 8;
  }
  return { h, v, mcuCols, mcuRows, comps };
}

function flattenRgba(rgba, width, height) {
  const out = new Uint8ClampedArray(width * height * 3);
  for (let i = 0, j = 0; j < out.length; i += 4, j += 3) {
    const a = rgba[i + 3];
    if (a === 255) {
      out[j] = rgba[i];
      out[j + 1] = rgba[i + 1];
      out[j + 2] = rgba[i + 2];
    } else {
      const bg = 255 * (255 - a);
      out[j] = (rgba[i] * a + bg) / 255;
      out[j + 1] = (rgba[i + 1] * a + bg) / 255;
      out[j + 2] = (rgba[i + 2] * a + bg) / 255;
    }
  }
  return out;
}

function toPlanes(rgb, width, height, layout) {
  const { h, v, comps } = layout;
  const pw = comps[0].pw, ph = comps[0].ph;
  const y = new Uint8ClampedArray(pw * ph);
  const cb = new Uint8ClampedArray(pw * ph);
  const cr = new Uint8ClampedArray(pw * ph);

  for (let py = 0; py < ph; py++) {
    const row = Math.min(py, height - 1) * width;
    for (let px = 0; px < pw; px++) {
      const i = (row + Math.min(px, width - 1)) * 3;
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      const o = py * pw + px;
      y[o] = 0.299 * r + 0.587 * g + 0.114 * b;
      cb[o] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
      cr[o] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
    }
  }

  if (h === 1 && v === 1) return [y, cb, cr];

  const cw = comps[1].pw, ch = comps[1].ph, n = h * v;
  const shrink = full => {
    const out = new Uint8ClampedArray(cw * ch);
    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        let sum = 0;
        for (let dy = 0; dy < v; dy++) {
          const o = (cy * v + dy) * pw + cx * h;
          for (let dx = 0; dx < h; dx++) sum += full[o + dx];
        }
        out[cy * cw + cx] = sum / n;
      }
    }
    return out;
  };
  return [y, shrink(cb), shrink(cr)];
}

function toRgb(planes, width, height, layout) {
  const { h, v, comps } = layout;
  const [y, cb, cr] = planes;
  const pw = comps[0].pw, cw = comps[1].pw;
  const out = new Uint8ClampedArray(width * height * 3);
  for (let py = 0; py < height; py++) {
    const crow = ((py / v) | 0) * cw;
    for (let px = 0; px < width; px++) {
      const lum = y[py * pw + px];
      const c = crow + ((px / h) | 0);
      const b1 = cb[c] - 128, r1 = cr[c] - 128;
      const o = (py * width + px) * 3;
      out[o] = lum + 1.402 * r1;
      out[o + 1] = lum - 0.344136 * b1 - 0.714136 * r1;
      out[o + 2] = lum + 1.772 * b1;
    }
  }
  return out;
}

function quantizeComponent(plane, comp, quant, keep) {
  const div = new Float64Array(64), mul = new Float64Array(64);
  for (let k = 0; k < 64; k++) {
    mul[k] = quant[k] * AAN_SCALE[k >> 3] * AAN_SCALE[k & 7];
    div[k] = mul[k] * 8;
  }
  const block = new Float64Array(64);
  const q = new Int16Array(64);
  const coefs = keep ? new Int16Array(comp.bw * comp.bh * 64) : null;
  const stride = comp.pw;

  for (let by = 0; by < comp.bh; by++) {
    for (let bx = 0; bx < comp.bw; bx++) {
      const base = by * 8 * stride + bx * 8;
      for (let r = 0; r < 8; r++) {
        const o = base + r * stride;
        for (let c = 0; c < 8; c++) block[r * 8 + c] = plane[o + c] - 128;
      }
      fdct(block);
      for (let k = 0; k < 64; k++) {
        const limit = k === 0 ? 1024 : 1023;
        q[k] = Math.max(-limit, Math.min(limit, Math.round(block[k] / div[k])));
      }

      if (keep) {
        const o = (by * comp.bw + bx) * 64;
        for (let z = 0; z < 64; z++) coefs[o + z] = q[ZIGZAG[z]];
        continue;
      }

      for (let k = 0; k < 64; k++) block[k] = q[k] * mul[k];
      idct(block);
      for (let r = 0; r < 8; r++) {
        const o = base + r * stride;
        for (let c = 0; c < 8; c++) plane[o + c] = block[r * 8 + c] / 8 + 128;
      }
    }
  }
  return coefs;
}

function rollRgb(rgb, width, height, dx, dy) {
  const out = new Uint8ClampedArray(rgb.length);
  const sx = ((dx % width) + width) % width;
  const sy = ((dy % height) + height) % height;
  for (let y = 0; y < height; y++) {
    const ty = (y + sy) % height;
    const src = y * width * 3;
    const dst = ty * width * 3;
    const split = (width - sx) * 3;
    out.set(rgb.subarray(src, src + split), dst + sx * 3);
    out.set(rgb.subarray(src + split, src + width * 3), dst);
  }
  return out;
}

// ── Huffman ───────────────────────────────────────────────────────────────────

function bitLength(value) {
  let v = Math.abs(value), n = 0;
  while (v) { n++; v >>= 1; }
  return n;
}

function walkScan(layout, coefs, emit) {
  const { comps, mcuCols, mcuRows } = layout;
  const preds = [0, 0, 0];
  for (let my = 0; my < mcuRows; my++) {
    for (let mx = 0; mx < mcuCols; mx++) {
      for (let ci = 0; ci < comps.length; ci++) {
        const c = comps[ci], data = coefs[ci];
        const dcTable = c.table * 2, acTable = dcTable + 1;
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            const o = ((my * c.v + by) * c.bw + mx * c.h + bx) * 64;
            const diff = data[o] - preds[ci];
            preds[ci] = data[o];
            const cat = bitLength(diff);
            emit(dcTable, cat, diff < 0 ? diff + (1 << cat) - 1 : diff, cat);

            let run = 0;
            for (let k = 1; k < 64; k++) {
              const value = data[o + k];
              if (value === 0) { run++; continue; }
              while (run > 15) { emit(acTable, 0xF0, 0, 0); run -= 16; }
              const size = bitLength(value);
              emit(acTable, (run << 4) | size, value < 0 ? value + (1 << size) - 1 : value, size);
              run = 0;
            }
            if (run) emit(acTable, 0x00, 0, 0);
          }
        }
      }
    }
  }
}

function optimalTable(counts) {
  const freq = Array.from(counts);
  freq[256] = 1;
  const codesize = new Int32Array(257);
  const others = new Int32Array(257).fill(-1);

  for (;;) {
    let c1 = -1, c2 = -1, v = Infinity;
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v) { v = freq[i]; c1 = i; }
    v = Infinity;
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v && i !== c1) { v = freq[i]; c2 = i; }
    if (c2 < 0) break;

    freq[c1] += freq[c2];
    freq[c2] = 0;
    codesize[c1]++;
    while (others[c1] >= 0) { c1 = others[c1]; codesize[c1]++; }
    others[c1] = c2;
    codesize[c2]++;
    while (others[c2] >= 0) { c2 = others[c2]; codesize[c2]++; }
  }

  const bits = new Int32Array(33);
  for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;
  for (let i = 32; i > 16; i--) {
    while (bits[i] > 0) {
      let j = i - 2;
      while (bits[j] === 0) j--;
      bits[i] -= 2;
      bits[i - 1]++;
      bits[j + 1] += 2;
      bits[j]--;
    }
  }
  let longest = 16;
  while (bits[longest] === 0) longest--;
  bits[longest]--;

  const values = [];
  for (let len = 1; len <= 32; len++) {
    for (let s = 0; s < 256; s++) if (codesize[s] === len) values.push(s);
  }
  return { bits: Array.from(bits.subarray(1, 17)), values };
}

function huffmanCodes({ bits, values }) {
  const code = new Uint16Array(256), size = new Uint8Array(256);
  let c = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++, k++) {
      code[values[k]] = c++;
      size[values[k]] = len;
    }
    c <<= 1;
  }
  return { code, size };
}

class ByteWriter {
  constructor(capacity) {
    this.buf = new Uint8Array(Math.max(1024, capacity));
    this.len = 0;
    this.acc = 0;
    this.nbits = 0;
  }

  byte(b) {
    if (this.len === this.buf.length) {
      const grown = new Uint8Array(this.buf.length * 2);
      grown.set(this.buf);
      this.buf = grown;
    }
    this.buf[this.len++] = b;
  }

  bytes(list) {
    for (const b of list) this.byte(b);
  }

  bits(value, count) {
    if (!count) return;
    this.acc = (this.acc << count) | (value & ((1 << count) - 1));
    this.nbits += count;
    while (this.nbits >= 8) {
      this.nbits -= 8;
      const b = (this.acc >>> this.nbits) & 0xFF;
      this.byte(b);
      if (b === 0xFF) this.byte(0);
    }
    this.acc &= (1 << this.nbits) - 1;
  }

  flushBits() {
    if (this.nbits) this.bits((1 << (8 - this.nbits)) - 1, 8 - this.nbits);
  }

  result() {
    return this.buf.slice(0, this.len);
  }
}

function encodeJpeg({ width, height, layout, quant, coefs }) {
  const counts = [0, 1, 2, 3].map(() => new Float64Array(257));
  walkScan(layout, coefs, (table, symbol) => { counts[table][symbol]++; });
  const specs = counts.map(optimalTable);
  const codes = specs.map(huffmanCodes);

  const w = new ByteWriter(width * height);
  w.bytes([0xFF, 0xD8]);
  w.bytes([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);

  w.bytes([0xFF, 0xDB, 0x00, 2 + 2 * 65]);
  quant.forEach((table, id) => {
    w.byte(id);
    for (let z = 0; z < 64; z++) w.byte(table[ZIGZAG[z]]);
  });

  const { h, v } = layout;
  w.bytes([0xFF, 0xC0, 0x00, 17, 8, height >> 8, height & 0xFF, width >> 8, width & 0xFF, 3]);
  w.bytes([1, (h << 4) | v, 0, 2, 0x11, 1, 3, 0x11, 1]);

  const dhtLength = 2 + specs.reduce((n, s) => n + 17 + s.values.length, 0);
  w.bytes([0xFF, 0xC4, dhtLength >> 8, dhtLength & 0xFF]);
  [0x00, 0x10, 0x01, 0x11].forEach((tag, i) => {
    w.byte(tag);
    w.bytes(specs[i].bits);
    w.bytes(specs[i].values);
  });

  w.bytes([0xFF, 0xDA, 0x00, 12, 3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
  walkScan(layout, coefs, (table, symbol, extra, extraBits) => {
    const c = codes[table];
    w.bits(c.code[symbol], c.size[symbol]);
    w.bits(extra, extraBits);
  });
  w.flushBits();
  w.bytes([0xFF, 0xD9]);
  return w.result();
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

const CRUSH_DEFAULTS = {
  quality: 0,
  split: false,
  chroma: 0,
  subsampling: '420',
  generations: 1,
  shift: 0,
};

function* crushSteps(rgba, width, height, settings) {
  const s = { ...CRUSH_DEFAULTS, ...settings };
  const layout = crushLayout(width, height, s.subsampling);
  const quant = [
    scaleQuant(LUMA_QUANT, s.quality),
    scaleQuant(CHROMA_QUANT, s.split ? s.chroma : s.quality),
  ];
  const generations = Math.max(1, Math.round(s.generations));
  const shift = Math.round(s.shift);
  const progress = generation => ({ generation, generations });

  let rgb = flattenRgba(rgba, width, height);
  let moved = 0;
  for (let g = 1; g < generations; g++) {
    const planes = toPlanes(rgb, width, height, layout);
    yield progress(g);
    for (let i = 0; i < 3; i++) {
      quantizeComponent(planes[i], layout.comps[i], quant[layout.comps[i].table], false);
      yield progress(g);
    }
    rgb = toRgb(planes, width, height, layout);
    if (shift) {
      rgb = rollRgb(rgb, width, height, shift, shift);
      moved += shift;
    }
    yield progress(g);
  }
  if (moved) rgb = rollRgb(rgb, width, height, -moved, -moved);

  const planes = toPlanes(rgb, width, height, layout);
  yield progress(generations);
  const coefs = [];
  for (let i = 0; i < 3; i++) {
    coefs.push(quantizeComponent(planes[i], layout.comps[i], quant[layout.comps[i].table], true));
    yield progress(generations);
  }
  const bytes = encodeJpeg({ width, height, layout, quant, coefs });
  return { bytes, width, height, quant };
}

function crushJpeg(rgba, width, height, settings) {
  const steps = crushSteps(rgba, width, height, settings);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}
