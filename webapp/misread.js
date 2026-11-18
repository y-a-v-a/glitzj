'use strict';

// ── Misread ───────────────────────────────────────────────────────────────────
//
// A picture file without its header is a long row of bytes that means nothing
// by itself. The width, the order of the colors, the number of bits per pixel:
// all of that is an agreement between whoever wrote the bytes and whoever
// reads them. Misread writes the picture down correctly and then breaks the
// agreement:
//
//   pixels → written as raw bytes in one format → (saved by a text editor) →
//   (bytes skipped, bits shifted or reversed) → read back in another format,
//   at another width → pixels
//
// Nothing here is random. Every result is exactly what a program would show
// that was told the wrong thing about the same bytes.

const MISREAD_FORMATS = {
  rgb24:  { label: 'RGB, 3 bytes per pixel', bpp: 3 },
  bgr24:  { label: 'BGR, 3 bytes per pixel', bpp: 3 },
  rgba32: { label: 'RGBA, 4 bytes per pixel', bpp: 4 },
  rgb565: { label: 'RGB 5-6-5, 2 bytes per pixel', bpp: 2 },
  gray8:  { label: 'Gray, 1 byte per pixel', bpp: 1 },
  mono1:  { label: 'Black and white, 1 bit per pixel', bpp: 1 / 8 },
  planar: { label: 'Planar RGB: all red, then green, then blue', bpp: 3 },
  i420:   { label: 'YUV 4:2:0 planar, as video frames', bpp: 1.5 },
  yuyv:   { label: 'YUYV 4:2:2, as webcams send it', bpp: 2 },
};

const MISREAD_EDITORS = ['none', 'crlf', 'utf8', 'mojibake', 'ascii', 'upper', 'nul'];
const MISREAD_MAX_HEIGHT = 4000;

const lumaOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const clamp255 = v => (v < 0 ? 0 : v > 255 ? 255 : v);

// ── Writing ───────────────────────────────────────────────────────────────────

function misreadWrite(rgba, width, height, format) {
  const n = width * height;
  let out;

  switch (format) {
    case 'bgr24':
    case 'rgb24': {
      out = new Uint8Array(n * 3);
      const swap = format === 'bgr24';
      for (let p = 0, i = 0, o = 0; p < n; p++, i += 4, o += 3) {
        out[o] = rgba[swap ? i + 2 : i];
        out[o + 1] = rgba[i + 1];
        out[o + 2] = rgba[swap ? i : i + 2];
      }
      break;
    }
    case 'rgba32':
      out = new Uint8Array(rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + n * 4));
      for (let i = 3; i < out.length; i += 4) out[i] = 255;
      break;
    case 'rgb565':
      out = new Uint8Array(n * 2);
      for (let p = 0, i = 0; p < n; p++, i += 4) {
        const v = ((rgba[i] >> 3) << 11) | ((rgba[i + 1] >> 2) << 5) | (rgba[i + 2] >> 3);
        out[p * 2] = v & 0xFF;
        out[p * 2 + 1] = v >> 8;
      }
      break;
    case 'gray8':
      out = new Uint8Array(n);
      for (let p = 0, i = 0; p < n; p++, i += 4) out[p] = lumaOf(rgba[i], rgba[i + 1], rgba[i + 2]) + 0.5;
      break;
    case 'mono1':
      out = new Uint8Array(Math.ceil(n / 8));
      for (let p = 0, i = 0; p < n; p++, i += 4) {
        if (lumaOf(rgba[i], rgba[i + 1], rgba[i + 2]) >= 128) out[p >> 3] |= 0x80 >> (p & 7);
      }
      break;
    case 'planar':
      out = new Uint8Array(n * 3);
      for (let p = 0, i = 0; p < n; p++, i += 4) {
        out[p] = rgba[i];
        out[n + p] = rgba[i + 1];
        out[2 * n + p] = rgba[i + 2];
      }
      break;
    case 'i420': {
      const cw = Math.ceil(width / 2), ch = Math.ceil(height / 2);
      out = new Uint8Array(n + 2 * cw * ch);
      for (let p = 0, i = 0; p < n; p++, i += 4) out[p] = lumaOf(rgba[i], rgba[i + 1], rgba[i + 2]) + 0.5;
      for (let cy = 0; cy < ch; cy++) {
        for (let cx = 0; cx < cw; cx++) {
          let r = 0, g = 0, b = 0, count = 0;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const x = cx * 2 + dx, y = cy * 2 + dy;
              if (x >= width || y >= height) continue;
              const i = (y * width + x) * 4;
              r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; count++;
            }
          }
          r /= count; g /= count; b /= count;
          out[n + cy * cw + cx] = clamp255(-0.168736 * r - 0.331264 * g + 0.5 * b + 128.5);
          out[n + cw * ch + cy * cw + cx] = clamp255(0.5 * r - 0.418688 * g - 0.081312 * b + 128.5);
        }
      }
      break;
    }
    case 'yuyv': {
      const pairs = Math.ceil(n / 2);
      out = new Uint8Array(pairs * 4);
      for (let k = 0; k < pairs; k++) {
        const i = k * 8, j = Math.min(i + 4, (n - 1) * 4);
        const r = (rgba[i] + rgba[j]) / 2, g = (rgba[i + 1] + rgba[j + 1]) / 2, b = (rgba[i + 2] + rgba[j + 2]) / 2;
        out[k * 4] = lumaOf(rgba[i], rgba[i + 1], rgba[i + 2]) + 0.5;
        out[k * 4 + 1] = clamp255(-0.168736 * r - 0.331264 * g + 0.5 * b + 128.5);
        out[k * 4 + 2] = lumaOf(rgba[j], rgba[j + 1], rgba[j + 2]) + 0.5;
        out[k * 4 + 3] = clamp255(0.5 * r - 0.418688 * g - 0.081312 * b + 128.5);
      }
      break;
    }
    default:
      throw new Error(`Unknown format ${format}`);
  }
  return out;
}

// ── A text editor in between ──────────────────────────────────────────────────
// What happens to binary data that is opened as text and saved again. Editors
// that make the data longer push everything after each change further along,
// which is what tilts and recolors the picture.

function misreadEdit(bytes, editor, limit = Infinity) {
  switch (editor) {
    // Windows line endings: every lone line feed gets a carriage return.
    case 'crlf': {
      const out = new Uint8Array(Math.min(limit, bytes.length * 2));
      let o = 0;
      for (let i = 0; i < bytes.length && o < out.length; i++) {
        if (bytes[i] === 0x0A && (i === 0 || bytes[i - 1] !== 0x0D)) out[o++] = 0x0D;
        if (o < out.length) out[o++] = bytes[i];
      }
      return out.subarray(0, o);
    }
    // Opened as UTF-8: every byte that is not valid UTF-8 becomes the
    // replacement character, three bytes long.
    case 'utf8': {
      const part = bytes.subarray(0, Math.min(bytes.length, limit));
      const out = new TextEncoder().encode(new TextDecoder('utf-8', { ignoreBOM: true }).decode(part));
      return out.subarray(0, Math.min(out.length, limit));
    }
    // Opened as Latin-1, saved as UTF-8: every byte above 127 becomes two.
    case 'mojibake': {
      const out = new Uint8Array(Math.min(limit, bytes.length * 2));
      let o = 0;
      for (let i = 0; i < bytes.length && o < out.length; i++) {
        const b = bytes[i];
        if (b < 0x80) { out[o++] = b; continue; }
        out[o++] = 0xC0 | (b >> 6);
        if (o < out.length) out[o++] = 0x80 | (b & 0x3F);
      }
      return out.subarray(0, o);
    }
    // Sent through something that only knows 7-bit ASCII: the top bit is lost.
    case 'ascii': {
      const out = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] & 0x7F;
      return out;
    }
    // Caps lock: every byte that is a lowercase letter becomes its capital.
    case 'upper': {
      const out = new Uint8Array(bytes);
      for (let i = 0; i < out.length; i++) if (out[i] >= 0x61 && out[i] <= 0x7A) out[i] -= 0x20;
      return out;
    }
    // Treated as text in which a zero byte cannot occur: the zeros vanish.
    case 'nul': {
      const out = new Uint8Array(bytes.length);
      let o = 0;
      for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) out[o++] = bytes[i];
      return out.subarray(0, o);
    }
    default:
      return bytes;
  }
}

// ── Bits and bytes ────────────────────────────────────────────────────────────

const BIT_REVERSED = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = 0;
    for (let bit = 0; bit < 8; bit++) if (i & (1 << bit)) v |= 0x80 >> bit;
    table[i] = v;
  }
  return table;
})();

function misreadShift(bytes, { skip = 0, bits = 0, reverse = false, swap = false }) {
  if (!skip && !bits && !reverse && !swap) return bytes;
  const src = bytes.subarray(Math.min(skip, bytes.length));
  const out = new Uint8Array(src.length);
  if (bits) {
    for (let i = 0; i < src.length; i++) out[i] = ((src[i] << bits) | ((src[i + 1] || 0) >> (8 - bits))) & 0xFF;
  } else {
    out.set(src);
  }
  if (reverse) for (let i = 0; i < out.length; i++) out[i] = BIT_REVERSED[out[i]];
  if (swap) {
    for (let i = 0; i + 1 < out.length; i += 2) {
      const t = out[i];
      out[i] = out[i + 1];
      out[i + 1] = t;
    }
  }
  return out;
}

// ── Reading ───────────────────────────────────────────────────────────────────

function misreadHeight(length, width, format, maxHeight = MISREAD_MAX_HEIGHT) {
  const rows = Math.ceil(length / (width * MISREAD_FORMATS[format].bpp));
  return Math.max(1, Math.min(maxHeight, rows));
}

function misreadRead(bytes, width, format, maxHeight = MISREAD_MAX_HEIGHT) {
  const height = misreadHeight(bytes.length, width, format, maxHeight);
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  const len = bytes.length;
  const put = (p, r, g, b) => {
    const o = p * 4;
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
  };
  const putYuv = (p, y, u, v) => {
    const cb = u - 128, cr = v - 128;
    put(p, y + 1.402 * cr + 0.5, y - 0.344136 * cb - 0.714136 * cr + 0.5, y + 1.772 * cb + 0.5);
  };

  switch (format) {
    case 'rgb24':
      for (let p = 0, i = 0; p < n && i < len; p++, i += 3) put(p, bytes[i], bytes[i + 1] || 0, bytes[i + 2] || 0);
      break;
    case 'bgr24':
      for (let p = 0, i = 0; p < n && i < len; p++, i += 3) put(p, bytes[i + 2] || 0, bytes[i + 1] || 0, bytes[i]);
      break;
    case 'rgba32':
      // The fourth byte is skipped: read as transparency it would hide most
      // of the damage.
      for (let p = 0, i = 0; p < n && i < len; p++, i += 4) put(p, bytes[i], bytes[i + 1] || 0, bytes[i + 2] || 0);
      break;
    case 'rgb565':
      for (let p = 0, i = 0; p < n && i < len; p++, i += 2) {
        const v = bytes[i] | ((bytes[i + 1] || 0) << 8);
        const r = v >> 11, g = (v >> 5) & 63, b = v & 31;
        put(p, (r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2));
      }
      break;
    case 'gray8':
      for (let p = 0; p < n && p < len; p++) put(p, bytes[p], bytes[p], bytes[p]);
      break;
    case 'mono1':
      for (let p = 0; p < n && (p >> 3) < len; p++) {
        const v = bytes[p >> 3] & (0x80 >> (p & 7)) ? 255 : 0;
        put(p, v, v, v);
      }
      break;
    case 'planar': {
      // Each plane is as long as the picture the reader expects.
      const plane = width * Math.max(1, Math.round(len / 3 / width));
      for (let p = 0; p < n && p < plane; p++) put(p, bytes[p] || 0, bytes[plane + p] || 0, bytes[2 * plane + p] || 0);
      break;
    }
    case 'i420': {
      const cw = Math.ceil(width / 2), ch = Math.ceil(height / 2);
      const uAt = n, vAt = n + cw * ch;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const p = y * width + x;
          if (p >= len) break;
          const c = (y >> 1) * cw + (x >> 1);
          putYuv(p, bytes[p], uAt + c < len ? bytes[uAt + c] : 128, vAt + c < len ? bytes[vAt + c] : 128);
        }
      }
      break;
    }
    case 'yuyv':
      for (let p = 0; p < n; p++) {
        const k = (p >> 1) * 4;
        if (k >= len) break;
        putYuv(p, bytes[k + (p & 1) * 2] || 0, k + 1 < len ? bytes[k + 1] : 128, k + 3 < len ? bytes[k + 3] : 128);
      }
      break;
    default:
      throw new Error(`Unknown format ${format}`);
  }
  return { rgba: out, width, height };
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

const MISREAD_DEFAULTS = {
  written: 'rgb24',
  read: 'rgb24',
  width: 1,
  editor: 'none',
  skip: 0,
  bits: 0,
  reverse: false,
  swap: false,
};

function* misreadSteps(source, settings) {
  const s = { ...MISREAD_DEFAULTS, ...settings };
  const { width, height } = source;
  const cache = source.cache || (source.cache = {});

  if (!cache.flat) cache.flat = flattenOnWhite(source.rgba);
  if (!cache.written || cache.written.format !== s.written) {
    cache.written = { format: s.written, bytes: misreadWrite(cache.flat, width, height, s.written) };
    yield 0.2;
  }
  const written = cache.written.bytes;

  const readWidth = Math.max(1, Math.min(MISREAD_MAX_HEIGHT, width + s.width));
  const maxHeight = Math.min(MISREAD_MAX_HEIGHT, height * 4);
  const needed = Math.ceil(readWidth * maxHeight * MISREAD_FORMATS[s.read].bpp) + s.skip + 1;

  const edited = misreadEdit(written, s.editor, needed);
  yield 0.5;
  const shifted = misreadShift(edited, s);
  yield 0.7;
  const result = misreadRead(shifted, readWidth, s.read, maxHeight);
  result.written = written.length;
  return result;
}
