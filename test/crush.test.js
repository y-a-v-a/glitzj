const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const file of ['jpeg.js', 'crush.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'webapp', file), 'utf8');
  vm.runInThisContext(src, { filename: file });
}

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

function decodeBaseline(bytes) {
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
      return { ...decodeScan(bytes, pos, frame, scan, quant, huff), frame, quant };
    }
  }
}

function decodeScan(bytes, start, frame, scan, quant, huff) {
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
  assert.equal(bytes[pos], 0xFF);
  assert.equal(bytes[pos + 1], 0xD9, 'EOI right after the scan');
  return { comps, mcuCols, mcuRows, hmax, vmax };
}

function decodePixels(bytes) {
  const { frame, quant, comps, hmax, vmax } = decodeBaseline(bytes);
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
