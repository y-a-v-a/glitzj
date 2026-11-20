'use strict';

// ── Small shared helpers for the pixel tools ──────────────────────────────────

// Seeded random numbers in [0, 1): the same seed always gives the same series.
function prng(seed) {
  let a = (seed >>> 0) || 0x9E3779B9;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A random number in [0, 1) that depends only on the two whole numbers given,
// so a value can be looked up for any row or frame without running a series.
function hashRandom(a, b) {
  let h = Math.imul(a | 0, 0x27D4EB2D) ^ Math.imul((b | 0) + 0x165667B1, 0x9E3779B1);
  h = Math.imul(h ^ (h >>> 15), 0x85EBCA6B);
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Normally distributed random numbers (mean 0, deviation 1) from a prng().
function gaussian(random) {
  let spare = null;
  return () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u, v, s;
    do {
      u = random() * 2 - 1;
      v = random() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const f = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * f;
    return u * f;
  };
}

// Pixels with transparency, laid over white: the tools that treat the picture
// as plain RGB data have no use for an alpha channel.
function flattenOnWhite(rgba) {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  if (opaque) return rgba;
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3], bg = 255 * (255 - a);
    out[i] = (rgba[i] * a + bg) / 255;
    out[i + 1] = (rgba[i + 1] * a + bg) / 255;
    out[i + 2] = (rgba[i + 2] * a + bg) / 255;
    out[i + 3] = 255;
  }
  return out;
}

// Resizes RGBA pixels. Shrinking averages the pixels each new pixel covers;
// enlarging interpolates between neighbors.
function resizePixels(rgba, width, height, outWidth, outHeight) {
  if (outWidth === width && outHeight === height) return rgba;

  const pass = (src, w, h, ow, channels, horizontal) => {
    const n = horizontal ? h : w;       // lines to process
    const len = horizontal ? w : h;     // length of each line
    const outLen = ow;
    const out = new Float32Array(n * outLen * channels);
    const scale = len / outLen;
    for (let o = 0; o < outLen; o++) {
      let from, to, wFrom = 1, wTo = 0, box = false;
      if (scale > 1) {
        box = true;
        from = o * scale;
        to = Math.min(len, (o + 1) * scale);
      } else {
        const c = Math.min(len - 1, Math.max(0, (o + 0.5) * scale - 0.5));
        from = Math.floor(c);
        to = Math.min(len - 1, from + 1);
        wTo = c - from;
        wFrom = 1 - wTo;
      }
      for (let line = 0; line < n; line++) {
        const at = k => (horizontal ? line * w + k : k * w + line) * channels;
        const dst = (horizontal ? line * outLen + o : o * w + line) * channels;
        if (!box) {
          const a = at(from), b = at(to);
          for (let ch = 0; ch < channels; ch++) out[dst + ch] = src[a + ch] * wFrom + src[b + ch] * wTo;
          continue;
        }
        let total = 0;
        for (let k = Math.floor(from); k < to; k++) {
          const weight = Math.min(k + 1, to) - Math.max(k, from);
          const a = at(k);
          for (let ch = 0; ch < channels; ch++) out[dst + ch] += src[a + ch] * weight;
          total += weight;
        }
        for (let ch = 0; ch < channels; ch++) out[dst + ch] /= total;
      }
    }
    return out;
  };

  const wide = pass(rgba, width, height, outWidth, 4, true);
  const tall = pass(wide, outWidth, height, outHeight, 4, false);
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  out.set(tall);   // a clamped array rounds to the nearest whole number itself
  return out;
}
