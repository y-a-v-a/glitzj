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

// ── Strategy: Static ──────────────────────────────────────────────────────────
// XOR-masks scan bytes with seeded pseudo-random values.
// Intensity drives mutation density: 0 = nothing touched, 100 = every byte.

function applyStatic(buf, scanStart, scanEnd, intensity, seed) {
  const rand    = makePrng(seed);
  const density = intensity / 100;
  for (let i = scanStart; i < scanEnd; i++) {
    if (rand() < density) {
      buf[i] ^= Math.floor(rand() * 256);
    }
  }
}

// ── Strategy: Dropout ─────────────────────────────────────────────────────────
// Zeroes out 1–5 randomly placed byte runs in the scan data.
// Intensity drives total zeroed length (0–30% of scan data);
// run count scales with intensity too.

function applyDropout(buf, scanStart, scanEnd, intensity, seed) {
  const rand      = makePrng(seed);
  const scanLen   = scanEnd - scanStart;
  const totalZero = Math.floor(scanLen * (intensity / 100) * 0.30);
  if (totalZero === 0) return;

  const runCount = Math.max(1, Math.round((intensity / 100) * 5));
  const runLen   = Math.floor(totalZero / runCount);
  if (runLen === 0) return;

  for (let r = 0; r < runCount; r++) {
    const start = scanStart + Math.floor(rand() * (scanLen - runLen));
    for (let i = start; i < start + runLen; i++) {
      buf[i] = 0x00;
    }
  }
}

// ── Strategy: Echo ────────────────────────────────────────────────────────────
// Copies a source block (seed-derived offset, fixed at 2% of scan data)
// and pastes it over adjacent ranges repeatedly.
// Intensity drives repetition count (1–8).

function applyEcho(buf, scanStart, scanEnd, intensity, seed) {
  const rand      = makePrng(seed);
  const scanLen   = scanEnd - scanStart;
  const blockLen  = Math.max(1, Math.floor(scanLen * 0.02));
  const reps      = Math.max(1, Math.round((intensity / 100) * 8));

  // Seed-derived source offset
  const srcOffset = scanStart + Math.floor(rand() * (scanLen - blockLen * (reps + 1)));
  const source    = buf.slice(srcOffset, srcOffset + blockLen);

  for (let r = 1; r <= reps; r++) {
    const dst = srcOffset + blockLen * r;
    if (dst + blockLen > scanEnd) break;
    buf.set(source, dst);
  }
}

// ── Strategy: Drift ───────────────────────────────────────────────────────────
// Shifts a run of scan bytes forward by N positions, displacing neighbours.
// Intensity drives shift distance: 0–5% of scan data length.

function applyDrift(buf, scanStart, scanEnd, intensity, seed) {
  const rand     = makePrng(seed);
  const scanLen  = scanEnd - scanStart;
  const shift    = Math.floor(scanLen * (intensity / 100) * 0.05);
  if (shift === 0) return;

  // Run length: a third of scan data, placed randomly
  const runLen   = Math.floor(scanLen / 3);
  const runStart = scanStart + Math.floor(rand() * (scanLen - runLen - shift));
  if (runStart + runLen + shift > scanEnd) return;

  // Copy run forward by shift bytes (memmove style, back-to-front to avoid overlap)
  for (let i = runLen - 1; i >= 0; i--) {
    buf[runStart + shift + i] = buf[runStart + i];
  }
  // Zero the vacated prefix
  for (let i = 0; i < shift; i++) {
    buf[runStart + i] = 0x00;
  }
}

// ── Strategy: Smear ───────────────────────────────────────────────────────────
// Adds random byte-value offsets to the early scan data (low-frequency DCT).
// Intensity drives how far into the scan data the corruption reaches (0–25%).

function applySmear(buf, scanStart, scanEnd, intensity, seed) {
  const rand    = makePrng(seed);
  const scanLen = scanEnd - scanStart;
  const reach   = Math.floor(scanLen * (intensity / 100) * 0.25);
  for (let i = scanStart; i < scanStart + reach; i++) {
    buf[i] = (buf[i] + Math.floor(rand() * 256)) & 0xFF;
  }
}

// ── Strategy: Crumble ─────────────────────────────────────────────────────────
// Adds random byte-value offsets to the late scan data (high-frequency DCT).
// Intensity drives how far back from the end the corruption reaches (0–25%).

function applyCrumble(buf, scanStart, scanEnd, intensity, seed) {
  const rand    = makePrng(seed);
  const scanLen = scanEnd - scanStart;
  const reach   = Math.floor(scanLen * (intensity / 100) * 0.25);
  for (let i = scanEnd - reach; i < scanEnd; i++) {
    buf[i] = (buf[i] + Math.floor(rand() * 256)) & 0xFF;
  }
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

function runPipeline(buf, scanStart, scanEnd, activeStrategies, intensity, seed) {
  for (const [name, fn] of Object.entries(STRATEGY_FNS)) {
    if (activeStrategies.has(name)) {
      fn(buf, scanStart, scanEnd, intensity, seed);
    }
  }
}
