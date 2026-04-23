// ── Seeded PRNG (mulberry32) ───────────────────────────────────────────────────
// A fast, good-quality 32-bit PRNG seeded with a single integer.

function makePrng(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function forEachLogicalChunk(scanInfo, logicalStart, length, visit) {
  if (length <= 0) return;

  let rangeBase = 0;
  let cursor = logicalStart;
  let remaining = length;

  for (const range of scanInfo.scanRanges) {
    const rangeLen = range.end - range.start;
    const rangeLimit = rangeBase + rangeLen;

    if (cursor >= rangeLimit) {
      rangeBase = rangeLimit;
      continue;
    }

    const localStart = Math.max(0, cursor - rangeBase);
    const chunkLen = Math.min(rangeLen - localStart, remaining);
    const physicalStart = range.start + localStart;

    visit(physicalStart, physicalStart + chunkLen);

    cursor += chunkLen;
    remaining -= chunkLen;
    if (remaining === 0) return;

    rangeBase = rangeLimit;
  }
}

function copyScanBytes(buf, scanInfo, logicalStart, length) {
  const out = new Uint8Array(length);
  let outOffset = 0;

  forEachLogicalChunk(scanInfo, logicalStart, length, (start, end) => {
    out.set(buf.subarray(start, end), outOffset);
    outOffset += end - start;
  });

  return out;
}

function writeScanBytes(buf, scanInfo, logicalStart, source) {
  let sourceOffset = 0;

  forEachLogicalChunk(scanInfo, logicalStart, source.length, (start, end) => {
    const chunkLen = end - start;
    buf.set(source.subarray(sourceOffset, sourceOffset + chunkLen), start);
    sourceOffset += chunkLen;
  });
}

function fillScanBytes(buf, scanInfo, logicalStart, length, value) {
  forEachLogicalChunk(scanInfo, logicalStart, length, (start, end) => {
    buf.fill(value, start, end);
  });
}

function mutateScanBytes(buf, scanInfo, logicalStart, length, visit) {
  forEachLogicalChunk(scanInfo, logicalStart, length, (start, end) => {
    for (let i = start; i < end; i++) {
      visit(i);
    }
  });
}

// ── Strategy: Static ──────────────────────────────────────────────────────────
// XOR-masks scan bytes with seeded pseudo-random values.
// Intensity drives mutation density: 0 = nothing touched, 100 = every byte.

function applyStatic(buf, scanInfo, intensity, seed) {
  const rand    = makePrng(seed);
  const density = intensity / 100;

  for (const range of scanInfo.scanRanges) {
    for (let i = range.start; i < range.end; i++) {
      if (rand() < density) {
        buf[i] ^= Math.floor(rand() * 256);
      }
    }
  }
}

// ── Strategy: Dropout ─────────────────────────────────────────────────────────
// Zeroes out 1–5 randomly placed byte runs in the scan data.
// Intensity drives total zeroed length (0–30% of scan data);
// run count scales with intensity too.

function applyDropout(buf, scanInfo, intensity, seed) {
  const rand      = makePrng(seed);
  const scanLen   = scanInfo.scanLength;
  const totalZero = Math.floor(scanLen * (intensity / 100) * 0.30);
  if (totalZero === 0) return;

  const runCount = Math.max(1, Math.round((intensity / 100) * 5));
  const runLen   = Math.floor(totalZero / runCount);
  if (runLen === 0) return;

  for (let r = 0; r < runCount; r++) {
    const maxStart = scanLen - runLen;
    const start = Math.floor(rand() * (maxStart + 1));
    fillScanBytes(buf, scanInfo, start, runLen, 0x00);
  }
}

// ── Strategy: Echo ────────────────────────────────────────────────────────────
// Copies a source block (seed-derived offset, fixed at 2% of scan data)
// and pastes it over adjacent ranges repeatedly.
// Intensity drives repetition count (1–8).

function applyEcho(buf, scanInfo, intensity, seed) {
  const rand      = makePrng(seed);
  const scanLen   = scanInfo.scanLength;
  const blockLen  = Math.max(1, Math.floor(scanLen * 0.02));
  const reps      = Math.max(1, Math.round((intensity / 100) * 8));
  if (blockLen >= scanLen) return;

  // Seed-derived source offset
  const maxStart = Math.max(0, scanLen - blockLen * (reps + 1));
  const srcOffset = Math.floor(rand() * (maxStart + 1));
  const source    = copyScanBytes(buf, scanInfo, srcOffset, blockLen);

  for (let r = 1; r <= reps; r++) {
    const dst = srcOffset + blockLen * r;
    if (dst + blockLen > scanLen) break;
    writeScanBytes(buf, scanInfo, dst, source);
  }
}

// ── Strategy: Drift ───────────────────────────────────────────────────────────
// Shifts a run of scan bytes forward by N positions, displacing neighbours.
// Intensity drives shift distance: 0–5% of scan data length.

function applyDrift(buf, scanInfo, intensity, seed) {
  const rand     = makePrng(seed);
  const scanLen  = scanInfo.scanLength;
  const shift    = Math.floor(scanLen * (intensity / 100) * 0.05);
  if (shift === 0) return;

  // Run length: a third of scan data, placed randomly
  const runLen   = Math.max(1, Math.floor(scanLen / 3));
  if (runLen + shift > scanLen) return;

  const maxStart = scanLen - runLen - shift;
  const runStart = Math.floor(rand() * (maxStart + 1));
  const source   = copyScanBytes(buf, scanInfo, runStart, runLen);

  writeScanBytes(buf, scanInfo, runStart + shift, source);
  fillScanBytes(buf, scanInfo, runStart, shift, 0x00);
}

// ── Strategy: Smear ───────────────────────────────────────────────────────────
// Adds random byte-value offsets to the early scan data (low-frequency DCT).
// Intensity drives how far into the scan data the corruption reaches (0–25%).

function applySmear(buf, scanInfo, intensity, seed) {
  const rand    = makePrng(seed);
  const scanLen = scanInfo.scanLength;
  const reach   = Math.floor(scanLen * (intensity / 100) * 0.25);
  mutateScanBytes(buf, scanInfo, 0, reach, i => {
    buf[i] = (buf[i] + Math.floor(rand() * 256)) & 0xFF;
  });
}

// ── Strategy: Crumble ─────────────────────────────────────────────────────────
// Adds random byte-value offsets to the late scan data (high-frequency DCT).
// Intensity drives how far back from the end the corruption reaches (0–25%).

function applyCrumble(buf, scanInfo, intensity, seed) {
  const rand    = makePrng(seed);
  const scanLen = scanInfo.scanLength;
  const reach   = Math.floor(scanLen * (intensity / 100) * 0.25);
  mutateScanBytes(buf, scanInfo, scanLen - reach, reach, i => {
    buf[i] = (buf[i] + Math.floor(rand() * 256)) & 0xFF;
  });
}

// ── Pipeline ──────────────────────────────────────────────────────────────────
// Applies all active strategies in fixed catalogue order.

const STRATEGY_FNS = {
  static:  applyStatic,
  dropout: applyDropout,
  echo:    applyEcho,
  drift:   applyDrift,
  smear:   applySmear,
  crumble: applyCrumble,
};

function runPipeline(buf, scanInfo, activeStrategies, intensity, seed) {
  for (const [name, fn] of Object.entries(STRATEGY_FNS)) {
    if (activeStrategies.has(name)) {
      fn(buf, scanInfo, intensity, seed);
    }
  }
}
