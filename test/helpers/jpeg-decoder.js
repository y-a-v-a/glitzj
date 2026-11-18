// An independent baseline JPEG decoder and a few fixtures, written from the
// specification without looking at the encoder, shared by the tests of the
// JPEG crush and JPEG surgery pages.

const assert = require('node:assert/strict');

function naiveZigzag() {
  const order = [];
  for (let s = 0; s < 15; s++) {
    const cells = [];
    for (let r = 0; r < 8; r++) {
      const c = s - r;
      if (c >= 0 && c < 8) cells.push(r * 8 + c);
    }
    if (s % 2 === 0) cells.reverse();
    order.push(...cells);
  }
  return order;
}

const C = u => (u === 0 ? Math.SQRT1_2 : 1);

function naiveDct(samples) {
  const out = new Float64Array(64);
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          sum += samples[y * 8 + x] * Math.cos((2 * x + 1) * u * Math.PI / 16) * Math.cos((2 * y + 1) * v * Math.PI / 16);
        }
      }
      out[v * 8 + u] = C(u) * C(v) * sum / 4;
    }
  }
  return out;
}

function naiveIdct(coefs) {
  const out = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
          sum += C(u) * C(v) * coefs[v * 8 + u] * Math.cos((2 * x + 1) * u * Math.PI / 16) * Math.cos((2 * y + 1) * v * Math.PI / 16);
        }
      }
      out[y * 8 + x] = sum / 4;
    }
  }
  return out;
}

// `trailing: true` accepts a scan that holds more data than the header asks
// for, as a file whose header understates its size does.
function decodeBaseline(bytes, { trailing = false } = {}) {
  const quant = [];
  const huff = {};
  let frame = null, pos = 2;
  assert.equal(bytes[0], 0xFF);
  assert.equal(bytes[1], 0xD8);

  for (;;) {
    assert.equal(bytes[pos], 0xFF, `marker expected at ${pos}`);
    const marker = bytes[pos + 1];
    const len = (bytes[pos + 2] << 8) | bytes[pos + 3];
    const seg = bytes.subarray(pos + 4, pos + 2 + len);
    pos += 2 + len;

    if (marker === 0xDB) {
      for (let i = 0; i < seg.length; i += 65) {
        assert.equal(seg[i] >> 4, 0, '8-bit tables only');
        quant[seg[i] & 15] = seg.subarray(i + 1, i + 65);
      }
    } else if (marker === 0xC0) {
      frame = { height: (seg[1] << 8) | seg[2], width: (seg[3] << 8) | seg[4], comps: [] };
      for (let i = 0; i < seg[5]; i++) {
        const o = 6 + i * 3;
        frame.comps.push({ id: seg[o], h: seg[o + 1] >> 4, v: seg[o + 1] & 15, tq: seg[o + 2] });
      }
    } else if (marker === 0xC4) {
      for (let i = 0; i < seg.length;) {
        const tag = seg[i];
        const counts = seg.subarray(i + 1, i + 17);
        const total = counts.reduce((a, b) => a + b, 0);
        const values = seg.subarray(i + 17, i + 17 + total);
        const map = new Map();
        let code = 0, k = 0;
        for (let len = 1; len <= 16; len++) {
          for (let n = 0; n < counts[len - 1]; n++) map.set(`${len}:${code++}`, values[k++]);
          code <<= 1;
        }
        assert.ok(code <= 1 << 17, 'Kraft');
        huff[tag] = map;
        i += 17 + total;
      }
    } else if (marker === 0xDA) {
      const scan = [];
      for (let i = 0; i < seg[0]; i++) scan.push({ id: seg[1 + i * 2], td: seg[2 + i * 2] >> 4, ta: seg[2 + i * 2] & 15 });
      return { ...decodeScan(bytes, pos, frame, scan, quant, huff, trailing), frame, quant, huff, scan };
    }
  }
}

function decodeScan(bytes, start, frame, scan, quant, huff, trailing) {
  let pos = start, acc = 0, nbits = 0;
  const bit = () => {
    if (nbits === 0) {
      let b = bytes[pos++];
      if (b === 0xFF) {
        assert.equal(bytes[pos], 0x00, `unstuffed 0xFF at ${pos - 1}`);
        pos++;
      }
      acc = b;
      nbits = 8;
    }
    nbits--;
    return (acc >> nbits) & 1;
  };
  const receive = n => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bit(); return v; };
  const extend = (v, n) => (n && v < 1 << (n - 1) ? v - (1 << n) + 1 : v);
  const symbol = map => {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | bit();
      const s = map.get(`${len}:${code}`);
      if (s !== undefined) return s;
    }
    throw new Error('bad Huffman code');
  };

  const hmax = Math.max(...frame.comps.map(c => c.h)), vmax = Math.max(...frame.comps.map(c => c.v));
  const mcuCols = Math.ceil(frame.width / (8 * hmax)), mcuRows = Math.ceil(frame.height / (8 * vmax));
  const comps = frame.comps.map((c, i) => ({ ...c, ...scan[i], bw: mcuCols * c.h, bh: mcuRows * c.v, pred: 0 }));
  for (const c of comps) c.coefs = new Int32Array(c.bw * c.bh * 64);
  const zz = naiveZigzag();

  for (let my = 0; my < mcuRows; my++) {
    for (let mx = 0; mx < mcuCols; mx++) {
      for (const c of comps) {
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            const o = ((my * c.v + by) * c.bw + mx * c.h + bx) * 64;
            const t = symbol(huff[c.td]);
            c.pred += extend(receive(t), t);
            c.coefs[o] = c.pred;
            for (let k = 1; k < 64;) {
              const rs = symbol(huff[0x10 | c.ta]);
              const run = rs >> 4, size = rs & 15;
              if (size === 0) {
                if (run !== 15) break;
                k += 16;
                continue;
              }
              k += run;
              c.coefs[o + zz[k]] = extend(receive(size), size);
              k++;
            }
          }
        }
      }
    }
  }
  if (!trailing) {
    assert.equal(bytes[pos], 0xFF);
    assert.equal(bytes[pos + 1], 0xD9, 'EOI right after the scan');
  }
  return { comps, mcuCols, mcuRows, hmax, vmax };
}

function decodePixels(bytes, options) {
  const { frame, quant, comps, hmax, vmax } = decodeBaseline(bytes, options);
  const planes = comps.map(c => {
    const pw = c.bw * 8, plane = new Float64Array(pw * c.bh * 8);
    const q = quant[c.tq];
    const zz = naiveZigzag();
    for (let b = 0; b < c.bw * c.bh; b++) {
      const deq = new Float64Array(64);
      for (let z = 0; z < 64; z++) deq[zz[z]] = c.coefs[b * 64 + zz[z]] * q[z];
      const px = naiveIdct(deq);
      const bx = b % c.bw, by = Math.floor(b / c.bw);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) plane[(by * 8 + y) * pw + bx * 8 + x] = px[y * 8 + x] + 128;
    }
    return { plane, pw, sx: hmax / c.h, sy: vmax / c.v };
  });
  const { width, height } = frame;
  const rgb = new Uint8ClampedArray(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [Y, Cb, Cr] = planes.map(p => p.plane[Math.floor(y / p.sy) * p.pw + Math.floor(x / p.sx)]);
      const o = (y * width + x) * 3;
      rgb[o] = Y + 1.402 * (Cr - 128);
      rgb[o + 1] = Y - 0.344136 * (Cb - 128) - 0.714136 * (Cr - 128);
      rgb[o + 2] = Y + 1.772 * (Cb - 128);
    }
  }
  return { width, height, rgb, frame };
}

function photo(width, height, seed = 1) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      rgba[o] = 128 + 100 * Math.sin(x / 7) + rand() * 20;
      rgba[o + 1] = (y * 255) / height;
      rgba[o + 2] = ((x + y) * 3) % 256;
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

function maxError(rgba, rgb) {
  let max = 0;
  for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) {
    for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(rgba[i + c] - rgb[j + c]));
  }
  return max;
}

module.exports = { naiveZigzag, naiveDct, naiveIdct, decodeBaseline, decodePixels, photo, maxError };
