// ── Dithering and GIF writing ─────────────────────────────────────────────────
//
// Turns RGBA pixels into a palette GIF. Unlike gif.js, which rewrites the
// frames of an existing GIF, this writes a new single-frame GIF89a from
// scratch. The pipeline, run by renderDither():
//
//   shrink by the dot size → brightness and contrast → palette → dither to
//   palette indices → (optionally) enlarge the indices → LZW-encode
//
// Pixels with alpha below 128 become the transparent index; GIF has no
// partial transparency.

const DITHER_KERNELS = {
  'floyd-steinberg': { div: 16, taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
  'atkinson':        { div: 8,  taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
  'jarvis':          { div: 48, taps: [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]] },
  'stucki':          { div: 42, taps: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]] },
  'burkes':          { div: 32, taps: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]] },
  'sierra':          { div: 32, taps: [[1, 0, 5], [2, 0, 3], [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2], [-1, 2, 2], [0, 2, 3], [1, 2, 2]] },
  'sierra-lite':     { div: 4,  taps: [[1, 0, 2], [-1, 1, 1], [0, 1, 1]] },
};

const ORDERED_SIZES = { 'bayer-2': 2, 'bayer-4': 4, 'bayer-8': 8 };

const DITHER_METHODS = ['none', ...Object.keys(DITHER_KERNELS), ...Object.keys(ORDERED_SIZES), 'noise'];

const PALETTE_KINDS = ['adaptive', 'grayscale', 'duotone', 'websafe', 'rgb'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bayerMatrix(n) {
  let m = [0];
  for (let size = 1; size < n; size *= 2) {
    const next = new Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = 4 * m[y * size + x];
        next[y * 2 * size + x]                     = v;
        next[y * 2 * size + x + size]              = v + 2;
        next[(y + size) * 2 * size + x]            = v + 3;
        next[(y + size) * 2 * size + x + size]     = v + 1;
      }
    }
    m = next;
  }
  return m;
}

// ── Resampling and tone ───────────────────────────────────────────────────────

function shrinkPixels(rgba, width, height, dot) {
  const w = Math.ceil(width / dot);
  const h = Math.ceil(height / dot);
  const out = new Float32Array(w * h * 4);

  for (let by = 0; by < h; by++) {
    const y1 = Math.min(height, (by + 1) * dot);
    for (let bx = 0; bx < w; bx++) {
      const x1 = Math.min(width, (bx + 1) * dot);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = by * dot; y < y1; y++) {
        for (let x = bx * dot; x < x1; x++) {
          const i = (y * width + x) * 4;
          const al = rgba[i + 3];
          r += rgba[i] * al;
          g += rgba[i + 1] * al;
          b += rgba[i + 2] * al;
          a += al;
          n++;
        }
      }
      const o = (by * w + bx) * 4;
      if (a > 0) {
        out[o]     = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
      }
      out[o + 3] = a / n;
    }
  }

  return { pixels: out, width: w, height: h };
}

function adjustTone(pixels, { brightness = 0, contrast = 0, mono = false }) {
  const c = contrast * 2.55;
  const factor = (259 * (c + 255)) / (255 * (259 - c));
  const shift = brightness * 2.55;
  const clamp = v => (v < 0 ? 0 : v > 255 ? 255 : v);

  for (let i = 0; i < pixels.length; i += 4) {
    let r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    if (mono) r = g = b = 0.299 * r + 0.587 * g + 0.114 * b;
    pixels[i]     = clamp(factor * (r - 128) + 128 + shift);
    pixels[i + 1] = clamp(factor * (g - 128) + 128 + shift);
    pixels[i + 2] = clamp(factor * (b - 128) + 128 + shift);
  }
}

// ── Palettes ──────────────────────────────────────────────────────────────────
function grayPalette(levels) {
  const out = new Uint8Array(levels * 3);
  for (let i = 0; i < levels; i++) out.fill(Math.round(i * 255 / (levels - 1)), i * 3, i * 3 + 3);
  return out;
}

function rampPalette(levels, from, to) {
  const out = new Uint8Array(levels * 3);
  for (let i = 0; i < levels; i++) {
    const t = i / (levels - 1);
    for (let ch = 0; ch < 3; ch++) out[i * 3 + ch] = Math.round(from[ch] + (to[ch] - from[ch]) * t);
  }
  return out;
}

function cubePalette(steps) {
  const out = new Uint8Array(steps ** 3 * 3);
  let o = 0;
  for (let r = 0; r < steps; r++) {
    for (let g = 0; g < steps; g++) {
      for (let b = 0; b < steps; b++) {
        out[o++] = Math.round(r * 255 / (steps - 1));
        out[o++] = Math.round(g * 255 / (steps - 1));
        out[o++] = Math.round(b * 255 / (steps - 1));
      }
    }
  }
  return out;
}

function medianCutPalette(pixels, count) {
  const hist = new Uint32Array(32768);
  const sums = new Float64Array(32768 * 3);
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    hist[key]++;
    sums[key * 3] += r;
    sums[key * 3 + 1] += g;
    sums[key * 3 + 2] += b;
  }

  const cells = [];
  for (let key = 0; key < 32768; key++) if (hist[key]) cells.push(key);
  if (cells.length === 0) return new Uint8Array(3);

  const channel = (key, ch) => (key >> (10 - ch * 5)) & 31;
  const makeBox = list => {
    const lo = [31, 31, 31], hi = [0, 0, 0];
    let total = 0;
    for (const key of list) {
      total += hist[key];
      for (let ch = 0; ch < 3; ch++) {
        const v = channel(key, ch);
        if (v < lo[ch]) lo[ch] = v;
        if (v > hi[ch]) hi[ch] = v;
      }
    }
    const sides = hi.map((v, ch) => v - lo[ch]);
    const axis = sides.indexOf(Math.max(...sides));
    return { list, total, axis, side: sides[axis] };
  };

  const boxes = [makeBox(cells)];
  while (boxes.length < count) {
    let best = -1, score = 0;
    boxes.forEach((box, k) => {
      const s = box.total * box.side;
      if (box.list.length > 1 && box.side > 0 && s > score) { score = s; best = k; }
    });
    if (best < 0) break;

    const box = boxes[best];
    const sorted = box.list.slice().sort((a, b) => channel(a, box.axis) - channel(b, box.axis));
    let seen = 0, cut = 1;
    for (let k = 0; k < sorted.length - 1; k++) {
      seen += hist[sorted[k]];
      cut = k + 1;
      if (seen * 2 >= box.total) break;
    }
    boxes.splice(best, 1, makeBox(sorted.slice(0, cut)), makeBox(sorted.slice(cut)));
  }

  const out = new Uint8Array(boxes.length * 3);
  boxes.forEach((box, k) => {
    let r = 0, g = 0, b = 0;
    for (const key of box.list) {
      r += sums[key * 3];
      g += sums[key * 3 + 1];
      b += sums[key * 3 + 2];
    }
    out[k * 3]     = Math.round(r / box.total);
    out[k * 3 + 1] = Math.round(g / box.total);
    out[k * 3 + 2] = Math.round(b / box.total);
  });
  return out;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function buildPalette(pixels, { palette, colors, dark, light }) {
  switch (palette) {
    case 'grayscale': return grayPalette(Math.max(2, colors));
    case 'duotone':   return rampPalette(Math.max(2, colors), hexToRgb(dark), hexToRgb(light));
    case 'websafe':   return cubePalette(6);
    case 'rgb':       return cubePalette(2);
    default:          return medianCutPalette(pixels, colors);
  }
}

// How far ordered and noise dither push a pixel: the mean distance from each
// palette color to its nearest neighbor, measured on the channel where they
// differ most. That is exactly the step size for gray ramps and color cubes.
function paletteSpread(palette) {
  const n = palette.length / 3;
  if (n < 2) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    let nearest = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = Math.max(
        Math.abs(palette[i * 3] - palette[j * 3]),
        Math.abs(palette[i * 3 + 1] - palette[j * 3 + 1]),
        Math.abs(palette[i * 3 + 2] - palette[j * 3 + 2]),
      );
      if (d > 0 && d < nearest) nearest = d;
    }
    if (nearest !== Infinity) total += nearest;
  }
  return total / n;
}

function nearestFinder(palette) {
  const n = palette.length / 3;
  const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => palette[a * 3] - palette[b * 3] || a - b);
  const reds = Int16Array.from(order, k => palette[k * 3]);
  const cache = new Int16Array(262144).fill(-1);
  return (r, g, b) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    const hit = cache[key];
    if (hit >= 0) return hit;

    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (reds[mid] < r) lo = mid + 1; else hi = mid;
    }

    let best = 0, bestD = Infinity;
    const consider = j => {
      const k = order[j];
      const dr = r - palette[k * 3], dg = g - palette[k * 3 + 1], db = b - palette[k * 3 + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD || (d === bestD && k < best)) { bestD = d; best = k; }
    };
    for (let up = lo, down = lo - 1; up < n || down >= 0;) {
      if (up < n) {
        const dr = reds[up] - r;
        if (dr * dr > bestD) up = n; else consider(up++);
      }
      if (down >= 0) {
        const dr = r - reds[down];
        if (dr * dr > bestD) down = -1; else consider(down--);
      }
    }
    cache[key] = best;
    return best;
  };
}

// ── Dither ────────────────────────────────────────────────────────────────────

function ditherPixels(pixels, width, height, palette, { method = 'floyd-steinberg', strength = 1, serpentine = true, seed = 1, transparentIndex = -1 } = {}) {
  const indices = new Uint8Array(width * height);
  const nearest = nearestFinder(palette);
  const clamp = v => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
  const kernel = DITHER_KERNELS[method];

  if (kernel) {
    const work = new Float32Array(width * height * 3);
    for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
      work[j] = pixels[i];
      work[j + 1] = pixels[i + 1];
      work[j + 2] = pixels[i + 2];
    }
    const taps = kernel.taps.length;
    const dxs = Int8Array.from(kernel.taps, ([dx]) => dx);
    const dys = Int8Array.from(kernel.taps, ([, dy]) => dy);
    const weights = Float32Array.from(kernel.taps, ([, , w]) => (w / kernel.div) * strength);

    for (let y = 0; y < height; y++) {
      const reverse = serpentine && (y & 1);
      const dir = reverse ? -1 : 1;
      for (let step = 0; step < width; step++) {
        const x = reverse ? width - 1 - step : step;
        const p = y * width + x;
        if (transparentIndex >= 0 && pixels[p * 4 + 3] < 128) {
          indices[p] = transparentIndex;
          continue;
        }
        const r = work[p * 3], g = work[p * 3 + 1], b = work[p * 3 + 2];
        const k = nearest(clamp(r), clamp(g), clamp(b));
        indices[p] = k;
        const er = r - palette[k * 3], eg = g - palette[k * 3 + 1], eb = b - palette[k * 3 + 2];

        for (let t = 0; t < taps; t++) {
          const nx = x + dxs[t] * dir, ny = y + dys[t];
          if (nx < 0 || nx >= width || ny >= height) continue;
          const q = (ny * width + nx) * 3;
          const w = weights[t];
          work[q] += er * w;
          work[q + 1] += eg * w;
          work[q + 2] += eb * w;
        }
      }
    }
    return indices;
  }

  const spread = paletteSpread(palette) * strength;
  const size = ORDERED_SIZES[method];
  const matrix = size ? bayerMatrix(size).map(v => (v + 0.5) / (size * size) - 0.5) : null;
  const random = method === 'noise' ? mulberry32(seed) : null;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const noise = random ? random() - 0.5 : 0;
      if (transparentIndex >= 0 && pixels[p * 4 + 3] < 128) {
        indices[p] = transparentIndex;
        continue;
      }
      const offset = (matrix ? matrix[(y % size) * size + (x % size)] : noise) * spread;
      const i = p * 4;
      indices[p] = nearest(clamp(pixels[i] + offset), clamp(pixels[i + 1] + offset), clamp(pixels[i + 2] + offset));
    }
  }
  return indices;
}

function enlargeIndices(indices, width, height, factor, outWidth, outHeight) {
  const out = new Uint8Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    const row = Math.min(height - 1, Math.floor(y / factor)) * width;
    for (let x = 0; x < outWidth; x++) out[y * outWidth + x] = indices[row + Math.min(width - 1, Math.floor(x / factor))];
  }
  return out;
}

// ── GIF89a writer ─────────────────────────────────────────────────────────────

function lzwEncodeIndices(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out = [];
  let bits = 0, nbits = 0, width = minCodeSize + 1;
  const emit = code => {
    bits |= code << nbits;
    nbits += width;
    while (nbits >= 8) { out.push(bits & 0xFF); bits >>>= 8; nbits -= 8; }
  };

  const child = new Int16Array(4096 * 256);
  const stamp = new Uint32Array(4096 * 256);
  let generation = 1, next = clear + 2;

  emit(clear);
  if (indices.length === 0) {
    emit(end);
    if (nbits > 0) out.push(bits & 0xFF);
    return Uint8Array.from(out);
  }

  let w = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i];
    const key = (w << 8) | c;
    if (stamp[key] === generation) { w = child[key]; continue; }
    emit(w);
    if (next < 4096) {
      child[key] = next++;
      stamp[key] = generation;
      if (next > (1 << width) && width < 12) width++;
    } else {
      emit(clear);
      generation++;
      next = clear + 2;
      width = minCodeSize + 1;
    }
    w = c;
  }
  emit(w);
  if (next === (1 << width) && width < 12) width++;
  emit(end);
  if (nbits > 0) out.push(bits & 0xFF);
  return Uint8Array.from(out);
}

function encodeIndexedGif({ width, height, indices, palette, transparentIndex = -1 }) {
  const colors = Math.max(2, palette.length / 3);
  let depth = 1;
  while ((1 << depth) < colors) depth++;
  const minCodeSize = Math.max(2, depth);
  const data = lzwEncodeIndices(indices, minCodeSize);

  const tableBytes = (1 << depth) * 3;
  const gce = transparentIndex >= 0 ? 8 : 0;
  const out = new Uint8Array(13 + tableBytes + gce + 10 + 1 + data.length + Math.ceil(data.length / 255) + 1 + 1);
  let o = 0;
  const u16 = v => { out[o++] = v & 0xFF; out[o++] = (v >> 8) & 0xFF; };

  for (const ch of 'GIF89a') out[o++] = ch.charCodeAt(0);
  u16(width);
  u16(height);
  out[o++] = 0x80 | ((depth - 1) << 4) | (depth - 1);
  out[o++] = 0;
  out[o++] = 0;
  out.set(palette.subarray(0, Math.min(palette.length, tableBytes)), o);
  o += tableBytes;

  if (gce) {
    out.set([0x21, 0xF9, 0x04, 0x01, 0x00, 0x00, transparentIndex, 0x00], o);
    o += gce;
  }

  out[o++] = 0x2C;
  u16(0);
  u16(0);
  u16(width);
  u16(height);
  out[o++] = 0;

  out[o++] = minCodeSize;
  for (let i = 0; i < data.length; i += 255) {
    const n = Math.min(255, data.length - i);
    out[o++] = n;
    out.set(data.subarray(i, i + n), o);
    o += n;
  }
  out[o++] = 0;
  out[o++] = 0x3B;
  return out;
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

function renderDither(rgba, width, height, settings) {
  const dot = Math.max(1, Math.floor(settings.dot || 1));
  const { pixels, width: w, height: h } = shrinkPixels(rgba, width, height, dot);
  const mono = settings.palette === 'grayscale' || settings.palette === 'duotone';

  adjustTone(pixels, { brightness: settings.brightness, contrast: settings.contrast, mono });

  let hasAlpha = false;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 128) { hasAlpha = true; break; }

  const wanted = Math.max(2, Math.min(256, Math.floor(settings.colors || 2)));
  const ditherInput = settings.palette === 'duotone' ? { ...settings, palette: 'grayscale' } : settings;
  const palette = buildPalette(pixels, { ...ditherInput, colors: hasAlpha ? Math.min(wanted, 255) : wanted });

  const opaque = palette.length / 3;
  const transparentIndex = hasAlpha ? opaque : -1;
  const indices = ditherPixels(pixels, w, h, palette, {
    method: settings.dither,
    strength: (settings.strength ?? 100) / 100,
    serpentine: settings.serpentine,
    seed: settings.seed,
    transparentIndex,
  });

  let shown = settings.palette === 'duotone'
    ? rampPalette(opaque, hexToRgb(settings.dark), hexToRgb(settings.light))
    : palette;
  if (hasAlpha) {
    const withClear = new Uint8Array((opaque + 1) * 3);
    withClear.set(shown);
    shown = withClear;
  }

  const encode = factor => {
    if (factor <= 1) return encodeIndexedGif({ width: w, height: h, indices, palette: shown, transparentIndex });
    const ow = Math.min(width, w * factor), oh = Math.min(height, h * factor);
    return encodeIndexedGif({ width: ow, height: oh, indices: enlargeIndices(indices, w, h, factor, ow, oh), palette: shown, transparentIndex });
  };

  return { bytes: encode(1), width: w, height: h, dot, colors: opaque, transparent: hasAlpha, encode };
}
