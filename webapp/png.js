// ── PNG chunk walk, row layout and re-encoding ────────────────────────────────
//
// Unlike JPEG, PNG cannot be damaged in place: its pixel data sits inside a
// zlib stream guarded by an Adler-32 checksum, and every chunk carries a CRC.
// Instead the IDAT data is inflated once at load time into its raw form, which
// is a filter-type byte followed by the filtered bytes of each row (per Adam7
// pass when interlaced). Strategies damage that raw stream, and encodePng()
// wraps it in a fresh zlib stream with new CRCs, so every result is a
// well-formed PNG.
//
// parsePng() returns:
// {
//   width, height, bitDepth, colorType, colorName, interlaced,
//   channels, bitsPerPixel,
//   head,       // signature-less bytes of the kept chunks before IDAT (IHDR first)
//   tail,       // bytes of the kept chunks after IDAT, without IEND
//   idat,       // concatenated compressed image data
//   idatCount,
//   animated,   // APNG animation chunks were dropped; only the default image remains
// }
//
// A file that ends without IEND, or partway through an IDAT chunk, is
// accepted: browsers render such files, and encodePng() always closes the
// output properly.
//
// Throws a descriptive Error for malformed input.

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

const PNG_CHANNELS   = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_BIT_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const PNG_COLOR_NAMES = { 0: 'grayscale', 2: 'RGB', 3: 'indexed', 4: 'grayscale + alpha', 6: 'RGBA' };

// Ancillary chunks that stay meaningful when only the pixel values change.
// Any other chunk flagged unsafe-to-copy (e.g. Apple's iDOT, which points at
// IDAT offsets, or the APNG animation chunks) must be dropped.
const PNG_KEEP_CHUNKS = new Set([
  'PLTE', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'hIST',
  'pHYs', 'sPLT', 'tIME', 'tEXt', 'zTXt', 'iTXt', 'eXIf', 'cICP', 'mDCV', 'cLLI',
]);

const PNG_FILTER_TYPES = ['none', 'sub', 'up', 'average', 'paeth'];

const ADAM7_PASSES = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

const IDAT_CHUNK_BYTES = 1 << 20;

function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function writeUint32(bytes, offset, value) {
  bytes[offset]     = value >>> 24;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
}

function readChunkType(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function isSafeToCopy(type) {
  return (type.charCodeAt(3) & 0x20) !== 0;
}

function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function readPngHeader(bytes, o) {
  const width       = readUint32(bytes, o);
  const height      = readUint32(bytes, o + 4);
  const bitDepth    = bytes[o + 8];
  const colorType   = bytes[o + 9];
  const compression = bytes[o + 10];
  const filter      = bytes[o + 11];
  const interlace   = bytes[o + 12];

  if (width === 0 || height === 0) {
    throw new Error('PNG has zero width or height.');
  }
  if (!PNG_BIT_DEPTHS[colorType]?.includes(bitDepth)) {
    throw new Error(`Unsupported PNG color type ${colorType} with bit depth ${bitDepth}.`);
  }
  if (compression !== 0 || filter !== 0 || interlace > 1) {
    throw new Error('PNG uses an unknown compression, filter or interlace method.');
  }

  return { width, height, bitDepth, colorType, interlaced: interlace === 1 };
}

function parsePng(bytes) {
  for (let k = 0; k < PNG_SIGNATURE.length; k++) {
    if (bytes[k] !== PNG_SIGNATURE[k]) throw new Error('Not a valid PNG (missing signature).');
  }

  let i = PNG_SIGNATURE.length;
  let header = null;
  let hasPalette = false;
  let animated = false;
  let idatSeen = false;
  let idatDone = false;
  const head = [];
  const tail = [];
  const idat = [];

  while (i + 8 <= bytes.length) {
    const length   = readUint32(bytes, i);
    const type     = readChunkType(bytes, i + 4);
    const dataEnd  = i + 8 + length;
    const chunkEnd = dataEnd + 4;

    if (!header) {
      if (type !== 'IHDR') throw new Error('Not a valid PNG (IHDR must come first).');
      if (length !== 13 || chunkEnd > bytes.length) throw new Error('Not a valid PNG (malformed IHDR).');
      header = readPngHeader(bytes, i + 8);
      head.push(bytes.subarray(i, chunkEnd));
      i = chunkEnd;
      continue;
    }

    if (type === 'IEND') break;

    if (chunkEnd > bytes.length) {
      if (type === 'IDAT' && !idatDone) {
        idat.push(bytes.subarray(i + 8, Math.min(dataEnd, bytes.length)));
        break;
      }
      if (idatSeen) break;
      throw new Error(`PNG chunk ${type} overruns file at byte offset ${i}.`);
    }

    if (type === 'IDAT') {
      if (idatDone) throw new Error('PNG image data (IDAT) is split by other chunks.');
      idatSeen = true;
      idat.push(bytes.subarray(i + 8, dataEnd));
    } else {
      if (idatSeen) idatDone = true;
      if (type === 'PLTE') hasPalette = true;
      if (type === 'acTL') animated = true;
      if (PNG_KEEP_CHUNKS.has(type) || isSafeToCopy(type)) {
        (idatSeen ? tail : head).push(bytes.subarray(i, chunkEnd));
      }
    }

    i = chunkEnd;
  }

  if (!header) {
    throw new Error('Not a valid PNG (missing IHDR).');
  }
  if (idat.length === 0) {
    throw new Error('Could not locate image data (IDAT) in this PNG.');
  }
  if (header.colorType === 3 && !hasPalette) {
    throw new Error('Indexed PNG without a palette (PLTE).');
  }

  const channels = PNG_CHANNELS[header.colorType];

  return {
    ...header,
    colorName: PNG_COLOR_NAMES[header.colorType],
    channels,
    bitsPerPixel: channels * header.bitDepth,
    head: concatBytes(head),
    tail: concatBytes(tail),
    idat: concatBytes(idat),
    idatCount: idat.length,
    animated,
  };
}

// ── Row layout ────────────────────────────────────────────────────────────────
// Locates every row in the raw stream. The result doubles as the scanInfo the
// strategies expect: the whole raw stream is one mutable range, filter bytes
// included, and filterPositions lets PNG-aware code find the row starts.

// Calls visit(passHeight, rowLength) for every non-empty pass.
function forEachPass(png, visit) {
  const passes = png.interlaced ? ADAM7_PASSES : [[0, 0, 1, 1]];
  for (const [x0, y0, dx, dy] of passes) {
    const passWidth  = Math.ceil((png.width - x0) / dx);
    const passHeight = Math.ceil((png.height - y0) / dy);
    if (passWidth > 0 && passHeight > 0) visit(passHeight, Math.ceil(passWidth * png.bitsPerPixel / 8));
  }
}

// Size of the raw stream, computed from the header without allocating.
function pngRawLength(png) {
  let length = 0;
  forEachPass(png, (passHeight, rowLength) => { length += passHeight * (rowLength + 1); });
  return length;
}

function layoutPng(png) {
  const filterPositions = [];
  const rowLengths = [];
  const priorRows = [];
  let offset = 0;

  forEachPass(png, (passHeight, rowLength) => {
    for (let y = 0; y < passHeight; y++) {
      filterPositions.push(offset);
      rowLengths.push(rowLength);
      priorRows.push(y === 0 ? -1 : offset - rowLength - 1);
      offset += rowLength + 1;
    }
  });

  return {
    rawLength: offset,
    bytesPerPixel: Math.max(1, png.bitsPerPixel >> 3),
    filterPositions: Int32Array.from(filterPositions),
    rowLengths: Int32Array.from(rowLengths),
    priorRows: Int32Array.from(priorRows),
    scanRanges: [{ start: 0, end: offset }],
    scanLength: offset,
  };
}

// ── Inflate ───────────────────────────────────────────────────────────────────
// Stops reading once the expected raw size is reached, so a stream that
// inflates to more than the header promises cannot exhaust memory. A cut-off
// or corrupt stream keeps the rows that did inflate; the rest stays zero.
// Returns { raw, inflated }, inflated being the number of bytes that arrived.

async function inflatePng(png, layout) {
  const raw    = new Uint8Array(layout.rawLength);
  const stream = new Blob([png.idat]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  let filled = 0;

  try {
    while (filled < raw.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const n = Math.min(value.length, raw.length - filled);
      raw.set(value.subarray(0, n), filled);
      filled += n;
    }
  } catch {
    // Truncated or damaged stream; browsers render the part that inflates too.
  }
  reader.cancel().catch(() => {});

  if (filled === 0) {
    throw new Error('Could not decompress the PNG image data.');
  }
  return { raw, inflated: filled };
}

// ── Filters ───────────────────────────────────────────────────────────────────

function paethPredictor(a, b, c) {
  const p  = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// The row kernels below run once per byte of image data, so each filter type
// gets its own loop, split where the left neighbor (a) starts to exist. A row
// without a prior row (p < 0) sees zeros above it: Up then equals None and
// Paeth equals Sub. Typed arrays wrap stored values to 0–255 by themselves.

function unfilterRow(raw, out, type, s, p, len, bpp) {
  const end   = s + len;
  const first = Math.min(end, s + bpp);
  if (p < 0 && type === 2) type = 0;
  if (p < 0 && type === 4) type = 1;

  switch (type) {
    case 1:
      for (let i = s; i < first; i++) out[i] = raw[i];
      for (let i = first; i < end; i++) out[i] = raw[i] + out[i - bpp];
      return;
    case 2:
      for (let i = s, j = p; i < end; i++, j++) out[i] = raw[i] + out[j];
      return;
    case 3:
      if (p < 0) {
        for (let i = s; i < first; i++) out[i] = raw[i];
        for (let i = first; i < end; i++) out[i] = raw[i] + (out[i - bpp] >> 1);
      } else {
        for (let i = s, j = p; i < first; i++, j++) out[i] = raw[i] + (out[j] >> 1);
        for (let i = first, j = p + bpp; i < end; i++, j++) out[i] = raw[i] + ((out[i - bpp] + out[j]) >> 1);
      }
      return;
    case 4:
      for (let i = s, j = p; i < first; i++, j++) out[i] = raw[i] + out[j];
      for (let i = first, j = p + bpp; i < end; i++, j++) {
        out[i] = raw[i] + paethPredictor(out[i - bpp], out[j], out[j - bpp]);
      }
      return;
    default:
      out.set(raw.subarray(s, end), s);
  }
}

// Writes the filtered bytes of recon[s, s + len) to out starting at offset o.
function filterRowBytes(recon, out, type, s, p, len, bpp, o) {
  const end   = s + len;
  const first = Math.min(end, s + bpp);
  const d     = o - s;
  if (p < 0 && type === 2) type = 0;
  if (p < 0 && type === 4) type = 1;

  switch (type) {
    case 1:
      for (let i = s; i < first; i++) out[i + d] = recon[i];
      for (let i = first; i < end; i++) out[i + d] = recon[i] - recon[i - bpp];
      return;
    case 2:
      for (let i = s, j = p; i < end; i++, j++) out[i + d] = recon[i] - recon[j];
      return;
    case 3:
      if (p < 0) {
        for (let i = s; i < first; i++) out[i + d] = recon[i];
        for (let i = first; i < end; i++) out[i + d] = recon[i] - (recon[i - bpp] >> 1);
      } else {
        for (let i = s, j = p; i < first; i++, j++) out[i + d] = recon[i] - (recon[j] >> 1);
        for (let i = first, j = p + bpp; i < end; i++, j++) out[i + d] = recon[i] - ((recon[i - bpp] + recon[j]) >> 1);
      }
      return;
    case 4:
      for (let i = s, j = p; i < first; i++, j++) out[i + d] = recon[i] - recon[j];
      for (let i = first, j = p + bpp; i < end; i++, j++) {
        out[i + d] = recon[i] - paethPredictor(recon[i - bpp], recon[j], recon[j - bpp]);
      }
      return;
    default:
      out.set(recon.subarray(s, end), o);
  }
}

// Reverses the filter of every row. Filter-byte positions are kept (as 0) so
// the reconstructed buffer shares the raw layout and is itself a valid raw
// stream with every row unfiltered. Decoders stop at a row whose filter type
// is not 0–4, so from such a row on the input is copied verbatim, leaving the
// output to stop at the same row.
function unfilterPng(raw, layout) {
  const out = new Uint8Array(raw.length);
  const { filterPositions, rowLengths, priorRows, bytesPerPixel: bpp } = layout;

  for (let r = 0; r < filterPositions.length; r++) {
    const type  = raw[filterPositions[r]];
    if (type > 4) {
      out.set(raw.subarray(filterPositions[r]), filterPositions[r]);
      break;
    }

    const prior = priorRows[r] < 0 ? -1 : priorRows[r] + 1;
    unfilterRow(raw, out, type, filterPositions[r] + 1, prior, rowLengths[r], bpp);
  }

  return out;
}

// Filters row r of a reconstructed buffer with the given type and writes the
// filter byte plus filtered bytes to out, starting at offset at.
function filterRow(recon, layout, r, type, out, at) {
  const { filterPositions, rowLengths, priorRows, bytesPerPixel: bpp } = layout;
  const prior = priorRows[r] < 0 ? -1 : priorRows[r] + 1;
  out[at] = type;
  filterRowBytes(recon, out, type, filterPositions[r] + 1, prior, rowLengths[r], bpp, at + 1);
}

function refilterPng(recon, layout, type) {
  const out = new Uint8Array(recon.length);
  for (let r = 0; r < layout.filterPositions.length; r++) {
    filterRow(recon, layout, r, type, out, layout.filterPositions[r]);
  }
  return out;
}

// libpng's heuristic for picking a filter: the smallest sum of filtered bytes
// read as signed values tends to compress best.
function filterScore(bytes, start, end) {
  let score = 0;
  for (let i = start; i < end; i++) score += bytes[i] < 128 ? bytes[i] : 256 - bytes[i];
  return score;
}

const OPTIMIZE_SLICE_MS = 12;

// Re-picks each row's filter so the export compresses well, without changing
// a decoded pixel: per row it keeps whichever scores best of the row as it
// stands and the five filters applied to the decoded row. Rows from the first
// invalid filter byte on are left alone, so the image still stops there.
// Scoring six candidates per row takes seconds on the largest images, so the
// work yields to the page every few milliseconds and returns null as soon as
// cancelled() reports the result is no longer wanted.
async function optimizeFilters(raw, layout, cancelled = () => false) {
  const out     = new Uint8Array(raw);
  const recon   = unfilterPng(raw, layout);
  const scratch = new Uint8Array(Math.max(0, ...layout.rowLengths) + 1);
  let sliceStart = performance.now();

  for (let r = 0; r < layout.filterPositions.length; r++) {
    const pos = layout.filterPositions[r];
    const len = layout.rowLengths[r];
    if (raw[pos] > 4) break;

    if (performance.now() - sliceStart > OPTIMIZE_SLICE_MS) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (cancelled()) return null;
      sliceStart = performance.now();
    }

    let best = filterScore(raw, pos + 1, pos + 1 + len);
    for (let type = 0; type < PNG_FILTER_TYPES.length; type++) {
      filterRow(recon, layout, r, type, scratch, 0);
      const score = filterScore(scratch, 1, len + 1);
      if (score < best) {
        best = score;
        out.set(scratch.subarray(0, len + 1), pos);
      }
    }
  }

  return out;
}

// ── Filter protection ─────────────────────────────────────────────────────────
// Strategies treat the raw stream as one run of bytes, so they also hit the
// filter-type byte at the start of each row. A value above 4 makes decoders
// stop at that row (Chrome leaves the rest transparent), and a changed but
// valid value re-reads every following row through the wrong filter, which
// buries whatever the strategy did. Restoring the original filter bytes keeps
// the damage to pixel data; Prism changes filter bytes deliberately afterwards.

function protectFilters(buf, reference, layout) {
  for (const pos of layout.filterPositions) buf[pos] = reference[pos];
}

// ── Strategy: Prism (PNG only) ────────────────────────────────────────────────
// Swaps the filter type of randomly chosen rows without re-encoding them, so
// those rows, and the ones predicted from them, decode into bands of shifted
// color. Intensity drives the share of rows picked: 0–10%, at least one row
// above 0. An invalid filter byte (protection off) is left as it is, so
// decoders still stop there.

function applyPrism(buf, layout, intensity, seed) {
  const rand  = makePrng(seed);
  const rows  = layout.completeRows ?? layout.filterPositions.length;
  const share = (intensity / 100) * 0.10;
  if (share <= 0) return;

  const picks = Math.max(1, Math.round(rows * share));
  for (let k = 0; k < picks; k++) {
    const pos = layout.filterPositions[Math.floor(rand() * rows)];
    if (buf[pos] <= 4) buf[pos] = (buf[pos] + 1 + Math.floor(rand() * 4)) % 5;
  }
}

const PNG_STRATEGY_FNS = {
  prism: applyPrism,
};

// ── Alpha restore ─────────────────────────────────────────────────────────────
// Damaged alpha bytes punch holes, and because filters predict each row from
// the one above, a single damaged row can leave everything below it
// transparent. Copying the original alpha back into an unfiltered result keeps
// the silhouette while the color damage stays: at 8 and 16 bits per channel
// every filter predicts a byte only from the same channel, so color bytes
// never depend on alpha bytes.

function hasAlphaChannel(png) {
  return png.colorType === 4 || png.colorType === 6;
}

function restoreAlpha(recon, original, layout, png) {
  const { filterPositions, rowLengths, bytesPerPixel: bpp } = layout;
  const alphaBytes = png.bitDepth >> 3;

  for (let r = 0; r < filterPositions.length; r++) {
    if (recon[filterPositions[r]] !== 0) break;
    const start = filterPositions[r] + 1;
    for (let k = bpp - alphaBytes; k < rowLengths[r]; k += bpp) {
      for (let j = 0; j < alphaBytes; j++) recon[start + k + j] = original[start + k + j];
    }
  }
}

// ── Encode ────────────────────────────────────────────────────────────────────

// Eight lookup tables let crc32() consume eight bytes per step (slice-by-8),
// which matters because every preview recomputes the CRC over all image data.
// Int32Array keeps every entry a small integer for the JIT; a Uint32Array of
// the same values measured slower than the plain byte-wise loop in Chrome.
const CRC_TABLES = (() => {
  const t = new Int32Array(2048);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    for (let k = 1; k < 8; k++) {
      const prev = t[(k - 1) * 256 + n];
      t[k * 256 + n] = (prev >>> 8) ^ t[prev & 0xFF];
    }
  }
  return t;
})();

function crc32(bytes, start, end) {
  const t = CRC_TABLES;
  let c = -1;
  let i = start;
  for (; i + 8 <= end; i += 8) {
    c ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    const hi = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
    c = t[1792 + (c & 0xFF)] ^ t[1536 + ((c >>> 8) & 0xFF)] ^ t[1280 + ((c >>> 16) & 0xFF)] ^ t[1024 + (c >>> 24)]
      ^ t[768 + (hi & 0xFF)] ^ t[512 + ((hi >>> 8) & 0xFF)] ^ t[256 + ((hi >>> 16) & 0xFF)] ^ t[hi >>> 24];
  }
  for (; i < end; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < bytes.length) {
    const end = Math.min(i + 5552, bytes.length);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function storedZlibLength(raw) {
  return 2 + Math.max(1, Math.ceil(raw.length / 65535)) * 5 + raw.length + 4;
}

// Writes raw bytes to out at offset o as a zlib stream of stored
// (uncompressed) deflate blocks. Much faster than compressing, which matters
// for the live preview.
function writeStoredZlib(out, o, raw) {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  out[o]     = 0x78;
  out[o + 1] = 0x01;
  o += 2;

  for (let k = 0; k < blocks; k++) {
    const start = k * 65535;
    const len   = Math.min(65535, raw.length - start);
    out[o]     = k === blocks - 1 ? 1 : 0;
    out[o + 1] = len & 0xFF;
    out[o + 2] = len >> 8;
    out[o + 3] = ~len & 0xFF;
    out[o + 4] = (~len >> 8) & 0xFF;
    out.set(raw.subarray(start, start + len), o + 5);
    o += 5 + len;
  }

  writeUint32(out, o, adler32(raw));
}

async function zlibCompress(raw) {
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function writeChunk(out, o, type, data) {
  writeUint32(out, o, data.length);
  for (let k = 0; k < 4; k++) out[o + 4 + k] = type.charCodeAt(k);
  out.set(data, o + 8);
  writeUint32(out, o + 8 + data.length, crc32(out, o + 4, o + 8 + data.length));
  return o + 12 + data.length;
}

function buildPng(png, zlib) {
  const idatCount = Math.max(1, Math.ceil(zlib.length / IDAT_CHUNK_BYTES));
  const out = new Uint8Array(
    PNG_SIGNATURE.length + png.head.length + idatCount * 12 + zlib.length + png.tail.length + 12
  );

  out.set(PNG_SIGNATURE, 0);
  out.set(png.head, PNG_SIGNATURE.length);
  let o = PNG_SIGNATURE.length + png.head.length;

  for (let k = 0; k < idatCount; k++) {
    o = writeChunk(out, o, 'IDAT', zlib.subarray(k * IDAT_CHUNK_BYTES, (k + 1) * IDAT_CHUNK_BYTES));
  }

  out.set(png.tail, o);
  writeChunk(out, o + png.tail.length, 'IEND', new Uint8Array(0));
  return out;
}

// For the preview: the stored zlib stream goes straight into a single IDAT
// chunk of the output, so the image data is copied only once.
function encodePng(png, raw) {
  const zlibLength = storedZlibLength(raw);
  const out = new Uint8Array(PNG_SIGNATURE.length + png.head.length + 12 + zlibLength + png.tail.length + 12);
  out.set(PNG_SIGNATURE, 0);
  out.set(png.head, PNG_SIGNATURE.length);

  const at = PNG_SIGNATURE.length + png.head.length;
  writeUint32(out, at, zlibLength);
  for (let k = 0; k < 4; k++) out[at + 4 + k] = 'IDAT'.charCodeAt(k);
  writeStoredZlib(out, at + 8, raw);
  writeUint32(out, at + 8 + zlibLength, crc32(out, at + 4, at + 8 + zlibLength));

  const o = at + 12 + zlibLength;
  out.set(png.tail, o);
  writeChunk(out, o + png.tail.length, 'IEND', new Uint8Array(0));
  return out;
}

// For export: filters re-picked per row and real deflate compression. The
// decoded pixels are identical to encodePng(source.png, raw). Returns null if
// cancelled before it finished.
async function encodePngCompressed(source, raw, cancelled = () => false) {
  const optimized = await optimizeFilters(raw, source.layout, cancelled);
  if (!optimized) return null;
  return buildPng(source.png, await zlibCompress(optimized));
}

// ── Source and pipeline ───────────────────────────────────────────────────────
// A source holds everything derived once per loaded file. The unfiltered image
// and the re-filtered base are computed on first use and cached, the base for
// the most recently requested filter only; switching back to the file's own
// filters releases it, since at the size limit each copy is 64 MB.

// Byte strategies hit PNG far harder than JPEG wherever a row is predicted
// from its neighbors: one damaged byte carries on into every pixel predicted
// from it. Static, Smear and Crumble therefore scale their per-byte odds by
// the base's filter mix, averaging a weight per row: None keeps damage local
// (2% of the JPEG odds), Sub, Up and Average spread it along a line or cone
// (0.05%), and Paeth cascades it furthest on textured images (0.01%).
// Indexed by filter type.
const PNG_DENSITY_WEIGHTS = [0.02, 0.0005, 0.0005, 0.0005, 0.0001];

// Averages over the rows that inflated; see loadPngSource().
function pngDensityScale(bytes, layout) {
  const rows = layout.completeRows ?? layout.filterPositions.length;
  let total = 0;
  for (let r = 0; r < rows; r++) total += PNG_DENSITY_WEIGHTS[bytes[layout.filterPositions[r]]] ?? 0;
  return total / rows;
}

function makeBase(filter, bytes, layout) {
  return { filter, bytes, densityScale: pngDensityScale(bytes, layout) };
}

// Decoded image data costs memory regardless of how well the file compressed,
// so maxRawBytes is checked against the header before anything is allocated.
// In a cut-off file the rows that never inflated are all zeros, which would
// read as filter None; strategies and the density scale skip them instead.
async function loadPngSource(bytes, { maxRawBytes = Infinity } = {}) {
  const png = parsePng(bytes);
  const rawLength = pngRawLength(png);
  if (rawLength > maxRawBytes) {
    const mb = n => Math.round(n / 1024 / 1024);
    throw new Error(`PNG image data too large (${mb(rawLength)} MB uncompressed). Maximum is ${mb(maxRawBytes)} MB.`);
  }

  const layout = layoutPng(png);
  const { raw, inflated } = await inflatePng(png, layout);

  let rows = 0;
  while (rows < layout.filterPositions.length && layout.filterPositions[rows] + 1 + layout.rowLengths[rows] <= inflated) rows++;
  if (rows === 0) {
    throw new Error('Could not decompress the PNG image data.');
  }
  if (rows < layout.filterPositions.length) {
    layout.completeRows = rows;
    layout.scanLength   = layout.filterPositions[rows];
    layout.scanRanges   = [{ start: 0, end: layout.scanLength }];
  }

  const original = makeBase('keep', raw, layout);
  return { png, layout, raw, recon: null, original, base: original };
}

function sourceRecon(source) {
  source.recon ||= unfilterPng(source.raw, source.layout);
  return source.recon;
}

function sourceBase(source, filter) {
  if (filter === 'keep') {
    source.base = source.original;
    return source.original;
  }
  if (source.base.filter !== filter) {
    const type = PNG_FILTER_TYPES.indexOf(filter);
    source.base = makeBase(filter, refilterPng(sourceRecon(source), source.layout, type), source.layout);
  }
  return source.base;
}

// Returns the damaged raw stream, ready for encodePng(). Order: byte
// strategies in catalogue order, filter protection, PNG strategies, alpha
// restore.
function glitchPng(source, { strategies, intensity, seed, filter = 'keep', protect = true, keepAlpha = true }) {
  const { bytes: base, densityScale } = sourceBase(source, filter);
  let buf = new Uint8Array(base);

  runPipeline(buf, { ...source.layout, densityScale }, strategies, intensity, seed);
  if (protect) protectFilters(buf, base, source.layout);

  for (const [name, fn] of Object.entries(PNG_STRATEGY_FNS)) {
    if (strategies.has(name)) fn(buf, source.layout, intensity, seed);
  }

  if (keepAlpha && hasAlphaChannel(source.png)) {
    buf = unfilterPng(buf, source.layout);
    restoreAlpha(buf, sourceRecon(source), source.layout, source.png);
  }
  return buf;
}
