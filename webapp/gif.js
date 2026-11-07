// ── GIF block walk, LZW codes and re-encoding ─────────────────────────────────
//
// GIF has no checksums, so like JPEG it could be damaged in place. But every
// frame stores its pixels as LZW codes of up to 12 bits, packed without
// regard for byte boundaries, and a code only means something relative to the table
// built since the last clear code. Moving bytes around therefore turns
// whatever moved into noise. Instead each frame's data is unpacked once at load
// time into its codes, one array entry per code; strategies damage that array,
// and the codes are packed again into fresh sub-blocks. Moved codes still
// point into the same table, so Echo and Drift repeat and displace real
// fragments of the picture.
//
// parseGif() returns:
// {
//   version, width, height,
//   colorTables: [{ start, count }, ...],   // global table first, if any
//   frames: [{
//     left, top, width, height, interlaced,
//     table,            // index into colorTables of the table it uses, or -1
//     colors,           // entries in that table, 0 without one
//     transparent,      // transparent color index, or -1
//     minCodeSize,
//     dataStart,        // offset of the first sub-block length byte
//     dataEnd,          // offset after the block terminator (or end of file)
//     data,             // the frame's sub-block payloads, joined
//   }, ...],
//   end,                // offset of the trailer, or where the file is cut off
//   loops,              // NETSCAPE loop count (0 = forever), or -1 without one
// }
//
// A file that ends without a trailer, or partway through a block, is accepted:
// browsers render such files. A frame cut off in its image data keeps the
// data that arrived; any other block cut off is left out, and encodeGif()
// always closes the output properly.
//
// Throws a descriptive Error for malformed input.

const GIF_SIGNATURES = ['GIF87a', 'GIF89a'];

function parseGif(bytes) {
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (!GIF_SIGNATURES.includes(signature)) {
    throw new Error('Not a valid GIF (missing signature).');
  }

  let globalColors = 0;
  if (bytes[10] & 0x80) globalColors = 2 << (bytes[10] & 7);
  if (bytes.length < 13 + globalColors * 3) {
    throw new Error('Not a valid GIF (truncated header).');
  }

  const colorTables = globalColors ? [{ start: 13, count: globalColors }] : [];
  const frames = [];
  let transparent = -1;
  let loops = -1;
  let i = 13 + globalColors * 3;

  while (i < bytes.length) {
    const blockStart = i;
    const introducer = bytes[i];
    if (introducer === 0x3B) break;

    if (introducer === 0x21) {
      const label = bytes[i + 1];
      const body  = i + 2;
      const next  = skipSubBlocks(bytes, body);
      if (next < 0) break;
      if (label === 0xF9 && bytes[body] >= 4) {
        transparent = bytes[body + 1] & 1 ? bytes[body + 4] : -1;
      }
      if (label === 0xFF && bytes[body] === 11 && bytes[body + 12] >= 3 && bytes[body + 13] === 1
        && String.fromCharCode(...bytes.subarray(body + 1, body + 12)) === 'NETSCAPE2.0') {
        loops = bytes[body + 14] | (bytes[body + 15] << 8);
      }
      i = next;
      continue;
    }

    if (introducer !== 0x2C) {
      if (frames.length) break;
      throw new Error(`Malformed GIF structure at byte offset ${i}.`);
    }

    const flags  = bytes[i + 9];
    const colors = flags & 0x80 ? 2 << (flags & 7) : 0;
    const codeSizeAt = i + 10 + colors * 3;
    if (codeSizeAt + 1 >= bytes.length) break;

    const frame = {
      left:   bytes[i + 1] | (bytes[i + 2] << 8),
      top:    bytes[i + 3] | (bytes[i + 4] << 8),
      width:  bytes[i + 5] | (bytes[i + 6] << 8),
      height: bytes[i + 7] | (bytes[i + 8] << 8),
      interlaced: (flags & 0x40) !== 0,
      table:  globalColors ? 0 : -1,
      colors: colors || globalColors,
      transparent,
      minCodeSize: bytes[codeSizeAt],
      dataStart: codeSizeAt + 1,
    };
    transparent = -1;
    if (frame.minCodeSize < 1 || frame.minCodeSize > 11) {
      if (frames.length) break;
      throw new Error(`GIF frame ${frames.length + 1} has an invalid LZW code size (${frame.minCodeSize}).`);
    }

    const parts = [];
    i = frame.dataStart;
    while (i < bytes.length && bytes[i] !== 0) {
      const end = Math.min(i + 1 + bytes[i], bytes.length);
      parts.push(bytes.subarray(i + 1, end));
      i = end;
    }
    const terminated = i < bytes.length;
    if (terminated) i++;
    frame.dataEnd = i;
    frame.data = concatBytes(parts);

    const empty = frame.width === 0 || frame.height === 0;
    if (!terminated && (empty || frame.data.length === 0)) {
      i = blockStart;
      break;
    }
    if (empty) continue;
    if (colors) {
      frame.table = colorTables.length;
      colorTables.push({ start: blockStart + 10, count: colors });
    }
    frames.push(frame);
  }

  if (frames.length === 0) {
    throw new Error('Could not locate any image data in this GIF.');
  }

  return {
    version: signature.slice(3),
    width:  bytes[6] | (bytes[7] << 8),
    height: bytes[8] | (bytes[9] << 8),
    colorTables,
    frames,
    end: Math.min(i, bytes.length),
    loops,
  };
}

// Returns the offset after the block terminator, or -1 if the file ends first.
function skipSubBlocks(bytes, i) {
  while (i < bytes.length && bytes[i] !== 0) i += 1 + bytes[i];
  return i < bytes.length ? i + 1 : -1;
}

// ── LZW codes ─────────────────────────────────────────────────────────────────
// Codes are packed least significant bit first. With minimum code size m, the
// codes below 2^m are single pixels, 2^m clears the table and 2^m + 1 ends
// the data. Codes start m + 1 bits wide; every code after the first adds a
// table entry, and after every code the width grows by a bit if the next
// entry would not fit, up to 12 bits and 4096 entries. Checking after the
// first code too only matters for m = 1, which the GIF spec does not allow:
// Chrome and macOS ImageIO decoded such a file this way, Firefox not at all. Encoders send a clear code when the
// table is full, or keep using it as it is.

const LZW_MAX_CODES = 4096;

// Unpacks codes up to and including the end code, tracking the code width as
// a decoder does. Codes a decoder would reject still count as entries, so
// widths stay what the encoder intended.
function unpackCodes(data, minCodeSize) {
  const clear = 1 << minCodeSize;
  const codes = new Uint16Array(Math.ceil(data.length * 8 / (minCodeSize + 1)));
  let next = clear + 2, width = minCodeSize + 1, first = true;
  let bits = 0, nbits = 0, i = 0, n = 0;

  for (;;) {
    while (nbits < width && i < data.length) {
      bits |= data[i++] << nbits;
      nbits += 8;
    }
    if (nbits < width) break;
    const code = bits & ((1 << width) - 1);
    bits >>>= width;
    nbits -= width;
    codes[n++] = code;

    if (code === clear) {
      next = clear + 2;
      width = minCodeSize + 1;
      first = true;
      continue;
    }
    if (code === clear + 1) break;
    if (!first && next < LZW_MAX_CODES) next++;
    if (next === 1 << width && width < 12) width++;
    first = false;
  }

  return codes.slice(0, n);
}

// Packs codes at the width a decoder will read them with. It follows the
// table a decoder builds, keeping only the length of every entry, which is
// all it takes to count pixels: `filled` is how many pixels the codes so far
// decode to. `broken` is set by the first code a decoder would give up on (an
// end code counts); from there on only the code width is tracked.
class CodePacker {
  constructor(minCodeSize, sizeHint) {
    this.minCodeSize = minCodeSize;
    this.clear  = 1 << minCodeSize;
    this.length = new Int32Array(LZW_MAX_CODES);
    this.length.fill(1, 0, this.clear);
    this.out    = new Uint8Array(Math.max(16, sizeHint));
    this.o      = 0;
    this.bits   = 0;
    this.nbits  = 0;
    this.filled = 0;
    this.broken = false;
    this.reset();
  }

  reset() {
    this.next  = this.clear + 2;
    this.width = this.minCodeSize + 1;
    this.prev  = -1;
  }

  // Whether a decoder takes this code as picture data right now.
  accepts(code) {
    if (code === this.clear || code === this.clear + 1) return false;
    return this.prev < 0 ? code < this.clear : code <= this.next && code < LZW_MAX_CODES;
  }

  flushByte() {
    if (this.o === this.out.length) {
      const grown = new Uint8Array(this.out.length * 2);
      grown.set(this.out);
      this.out = grown;
    }
    this.out[this.o++] = this.bits & 0xFF;
    this.bits >>>= 8;
    this.nbits -= 8;
  }

  write(code) {
    this.bits |= code << this.nbits;
    this.nbits += this.width;
    while (this.nbits >= 8) this.flushByte();
  }

  // Codes too wide for the current width are cut to it, as a decoder will
  // read them.
  push(code) {
    code &= (1 << this.width) - 1;
    if (code === this.clear) {
      this.write(code);
      this.reset();
      return;
    }
    if (!this.broken && !this.accepts(code)) this.broken = true;
    this.write(code);
    if (code === this.clear + 1) return;

    const { length, prev, next } = this;
    if (!this.broken) this.filled += code < next ? length[code] : length[prev] + 1;
    if (prev >= 0 && next < LZW_MAX_CODES) {
      if (!this.broken) length[next] = length[prev] + 1;
      this.next = next + 1;
    }
    if (this.next === 1 << this.width && this.width < 12) this.width++;
    this.prev = code;
  }

  finish() {
    if (this.nbits > 0) this.flushByte();
    return this.out.subarray(0, this.o);
  }
}

// ── Code repair ───────────────────────────────────────────────────────────────
// Decoders disagree about damaged LZW data. A code pointing past the table, an
// early end code, or data that runs out before the frame is full made Chrome
// stop drawing and leave the rest transparent; Firefox showed nothing for a
// single-frame GIF with a bad code yet reported it as loaded, and filled a
// cut-off frame with white, as macOS ImageIO did. Pixel indices past the end
// of the color table came out black in Chrome, wrapped around the table in
// Firefox and arbitrary in ImageIO.
//
// Repair keeps every code a decoder accepts, clear codes included wherever
// the damage put them, and replaces the others: an early end code or a code
// past the table becomes a valid code derived from its value, and a pixel
// index past the color table wraps around it as in Firefox. Damage usually
// changes how many pixels the codes decode to. Codes beyond a full frame are
// dropped. A frame that comes up short starts over from its first code after
// a clear code, which decodes exactly like the top of the frame, so the
// picture rolls around like a TV losing vertical hold. Every frame then ends
// with an end code at exactly its size.

function replacementCode(code, packer, colors) {
  const { clear, next, prev } = packer;
  if (prev < 0) return code % colors;
  const last = next < LZW_MAX_CODES ? next : next - 1;
  const k = code % (colors + last - clear - 1);
  return k < colors ? k : clear + 2 + k - colors;
}

// Starting over costs a walk through the codes per pass, so the passes after
// the first may visit at most as many codes as the frame has pixels; codes
// that are nearly all clear codes would otherwise take pixels × codes steps.
// What is still missing then repeats the last code.
function repairCodes(codes, minCodeSize, pixels, colors) {
  const clear   = 1 << minCodeSize;
  const palette = colors > 0 ? Math.min(colors, clear) : clear;
  const packer  = new CodePacker(minCodeSize, codes.length * 2);
  let budget = codes.length + pixels;

  for (let pass = 0; packer.filled < pixels && budget > 0; pass++) {
    const before = packer.filled;
    if (pass > 0) packer.push(clear);

    for (let k = 0; k < codes.length && packer.filled < pixels && budget-- > 0; k++) {
      let code = codes[k];
      if (code !== clear && !packer.accepts(code)) code = replacementCode(code, packer, palette);
      else if (code < clear && code >= palette) code %= palette;
      packer.push(code);
    }

    if (packer.filled === before) break;
  }

  while (packer.filled < pixels) packer.push(packer.prev < 0 ? 0 : packer.prev);
  packer.push(clear + 1);
  return packer.finish();
}

// Without protection the codes go back exactly as damaged. `complete` tells
// whether decoders reach the end of the frame without giving up.
function packRawCodes(codes, minCodeSize, pixels) {
  const packer = new CodePacker(minCodeSize, codes.length * 2);
  let complete = false;
  for (const code of codes) {
    if (!packer.broken && packer.filled >= pixels) complete = true;
    packer.push(code);
  }
  complete ||= !packer.broken && packer.filled >= pixels;
  return { data: packer.finish(), complete };
}

// ── Strategy: Prism (GIF) ─────────────────────────────────────────────────────
// Rotates the red, green and blue values of randomly chosen palette entries,
// so every pixel drawn in such a color shifts hue. A photo squeezed into 256
// colors spreads each tone over many entries, so this lays bare the bands the
// palette is built from. A gray has no hue to rotate; one of its channels gets
// its top bit flipped instead, which splits grays into colors.
//
// Entries are drawn among the colors the frames use, weighted by how many
// pixels each one covers and never twice, so the colors that fill most of the
// picture are the likeliest to change, not a shade found on a few edge pixels.
// Transparent pixels do not count, as their color never shows. Intensity
// drives the share of used colors picked: 0–25%, at least one above 0.

// Adds how many pixels each color index covers in a frame's codes to counts,
// decoding only as far as a decoder would.
function countColors(codes, minCodeSize, pixels, counts) {
  const clear  = 1 << minCodeSize;
  const prefix = new Int32Array(LZW_MAX_CODES);
  const suffix = new Uint16Array(LZW_MAX_CODES);
  let next = clear + 2, prev = -1, filled = 0;

  for (const code of codes) {
    if (filled >= pixels) break;
    if (code === clear) {
      next = clear + 2;
      prev = -1;
      continue;
    }
    if (code === clear + 1 || (prev < 0 ? code >= clear : code > next)) break;

    let c = code === next ? prev : code;
    for (; c >= clear; c = prefix[c], filled++) counts[suffix[c]]++;
    counts[c]++;
    filled++;
    if (code === next) {
      counts[c]++;
      filled++;
    }
    if (prev >= 0 && next < LZW_MAX_CODES) {
      prefix[next] = prev;
      suffix[next] = c;
      next++;
    }
    prev = code;
  }
}

// Returns, per color table, the pixel count of every entry.
function colorWeights(gif, codes) {
  const weights = gif.colorTables.map(t => new Float64Array(t.count));
  gif.frames.forEach((frame, k) => {
    if (frame.table < 0) return;
    const counts = new Float64Array(1 << frame.minCodeSize);
    countColors(codes[k], frame.minCodeSize, frame.width * frame.height, counts);
    if (frame.transparent >= 0) counts[frame.transparent] = 0;
    const table = weights[frame.table];
    for (let c = 0; c < Math.min(counts.length, table.length); c++) table[c] += counts[c];
  });
  return weights;
}

function applyGifPrism(bytes, gif, weights, intensity, seed) {
  const share = (intensity / 100) * 0.25;
  if (share <= 0) return;

  gif.colorTables.forEach(({ start }, t) => {
    const left  = Float64Array.from(weights[t]);
    let total   = left.reduce((n, w) => n + w, 0);
    const used  = left.filter(w => w > 0).length;
    if (used === 0) return;

    const rand  = makePrng(seed);
    const picks = Math.max(1, Math.round(used * share));
    for (let k = 0; k < picks; k++) {
      let at = rand() * total;
      let entry = 0;
      while (entry < left.length - 1 && (left[entry] === 0 || at >= left[entry])) at -= left[entry++];
      total -= left[entry];
      left[entry] = 0;

      const o = start + entry * 3;
      const [r, g, b] = bytes.subarray(o, o + 3);
      const turn = rand();
      if (r === g && g === b) bytes[o + Math.floor(turn * 3)] ^= 0x80;
      else bytes.set(turn < 0.5 ? [g, b, r] : [b, r, g], o);
    }
  });
}

// ── Encode ────────────────────────────────────────────────────────────────────

function subBlocksLength(data) {
  return data.length + Math.ceil(data.length / 255) + 1;
}

function writeSubBlocks(out, o, data) {
  for (let i = 0; i < data.length; i += 255) {
    const n = Math.min(255, data.length - i);
    out[o++] = n;
    out.set(data.subarray(i, i + n), o);
    o += n;
  }
  out[o++] = 0;
  return o;
}

// Copies the file up to gif.end with each frame's image data replaced by
// datas[k], and closes it with a trailer.
function encodeGif(bytes, gif, datas) {
  let size = gif.end + 1;
  gif.frames.forEach((frame, k) => { size += subBlocksLength(datas[k]) - (frame.dataEnd - frame.dataStart); });

  const out = new Uint8Array(size);
  let at = 0;
  let o  = 0;
  gif.frames.forEach((frame, k) => {
    out.set(bytes.subarray(at, frame.dataStart), o);
    o  = writeSubBlocks(out, o + frame.dataStart - at, datas[k]);
    at = frame.dataEnd;
  });
  out.set(bytes.subarray(at, gif.end), o);
  out[o + gif.end - at] = 0x3B;
  return out;
}

// ── Source and pipeline ───────────────────────────────────────────────────────

// Static, Smear and Crumble hit a share of the codes, and every damaged code
// shifts all the pixels after it, so JPEG densities would leave nothing
// standing. At this scale intensity 100 makes one hit per 2000 codes.
const GIF_DENSITY_SCALE = 0.0005;

const GIF_STRATEGY_FNS = {
  prism: applyGifPrism,
};

// Repair works in proportion to the pixels of every frame, so maxPixels is
// checked against the frame sizes before any codes are unpacked.
function loadGifSource(bytes, { maxPixels = Infinity } = {}) {
  const gif = parseGif(bytes);
  const pixels = gif.frames.reduce((n, f) => n + f.width * f.height, 0);
  if (pixels > maxPixels) {
    const mp = n => Math.round(n / 1e6);
    throw new Error(`GIF too large (${mp(pixels)} million pixels across its frames). Maximum is ${mp(maxPixels)} million.`);
  }

  const codes = gif.frames.map(f => unpackCodes(f.data, f.minCodeSize));
  return { gif, bytes, codes, pixels, weights: null };
}

// Frame 0 uses the seed itself, so a still GIF does not depend on `steady`.
function frameSeed(seed, k, steady) {
  return steady ? seed : (seed ^ Math.imul(k, 0x9E3779B1)) >>> 0;
}

// Returns { bytes, cutFrames }: the glitched file and, without protection,
// the number of frames decoders give up on before the end. Order: strategies
// on each frame's codes, repair (or raw packing), Prism.
function glitchGif(source, { strategies, intensity, seed, protect = true, steady = false }) {
  const { gif, codes } = source;
  let cutFrames = 0;

  const datas = gif.frames.map((frame, k) => {
    const buf = new Uint16Array(codes[k]);
    const scanInfo = { scanRanges: [{ start: 0, end: buf.length }], scanLength: buf.length, densityScale: GIF_DENSITY_SCALE };
    runPipeline(buf, scanInfo, strategies, intensity, frameSeed(seed, k, steady));

    const pixels = frame.width * frame.height;
    if (protect) return repairCodes(buf, frame.minCodeSize, pixels, frame.colors);
    const raw = packRawCodes(buf, frame.minCodeSize, pixels);
    if (!raw.complete) cutFrames++;
    return raw.data;
  });

  let bytes = source.bytes;
  if (strategies.has('prism')) {
    bytes = bytes.slice(0, gif.end);
    source.weights ||= colorWeights(gif, codes);
    applyGifPrism(bytes, gif, source.weights, intensity, seed);
  }

  return { bytes: encodeGif(bytes, gif, datas), cutFrames };
}
