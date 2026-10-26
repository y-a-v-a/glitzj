const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const file of ['jpeg.js', 'strategies.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'webapp', file), 'utf8');
  vm.runInThisContext(src, { filename: file });
}

// ── Synthetic JPEG builder ────────────────────────────────────────────────────

function segment(marker, payload) {
  const len = payload.length + 2;
  return [0xFF, marker, len >> 8, len & 0xFF, ...payload];
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24;
  };
}

function buildJpeg({ progressive = false, rst = false, eoi = true, entropyLen = 4000, seed = 7 } = {}) {
  const rand = lcg(seed);
  const bytes = [0xFF, 0xD8];
  const ranges = [];
  const rstPositions = [];

  bytes.push(...segment(0xE0, [0x4A, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  bytes.push(...segment(0xDB, [0, ...Array(64).fill(1)]));
  bytes.push(...segment(progressive ? 0xC2 : 0xC0, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]));
  bytes.push(...segment(0xC4, [0x00, ...Array(16).fill(0)]));
  if (rst) bytes.push(...segment(0xDD, [0, 4]));

  const scans = progressive ? 3 : 1;
  for (let s = 0; s < scans; s++) {
    bytes.push(...segment(0xDA, [1, 1, 0x00, 0, 63, 0]));
    let rangeStart = bytes.length;
    let emitted = 0;
    let rstIndex = 0;
    while (emitted < entropyLen) {
      if (rst && emitted > 0 && emitted % 1000 === 0) {
        ranges.push({ start: rangeStart, end: bytes.length });
        rstPositions.push(bytes.length);
        bytes.push(0xFF, 0xD0 + (rstIndex++ % 8));
        rangeStart = bytes.length;
      }
      const b = rand();
      if (b === 0xFF) {
        bytes.push(0xFF, 0x00);
        emitted += 2;
      } else {
        bytes.push(b);
        emitted += 1;
      }
    }
    ranges.push({ start: rangeStart, end: bytes.length });
  }

  if (eoi) bytes.push(0xFF, 0xD9);

  return { bytes: Uint8Array.from(bytes), ranges, rstPositions };
}

function logicalBytes(buf, scanInfo) {
  const out = [];
  for (const { start, end } of scanInfo.scanRanges) {
    for (let i = start; i < end; i++) out.push(buf[i]);
  }
  return out;
}

function outsideScanEqual(a, b, scanInfo) {
  const mutable = new Uint8Array(a.length);
  for (const { start, end } of scanInfo.scanRanges) mutable.fill(1, start, end);
  for (let i = 0; i < a.length; i++) {
    if (!mutable[i] && a[i] !== b[i]) return false;
  }
  return true;
}

function fakeMarkerCount(buf, scanInfo) {
  let n = 0;
  for (const { start, end } of scanInfo.scanRanges) {
    for (let i = start; i < end; i++) {
      if (buf[i] === 0xFF && (i + 1 >= end || buf[i + 1] !== 0x00)) n++;
    }
  }
  return n;
}

// ── parseJpeg ─────────────────────────────────────────────────────────────────

test('baseline: one scan range covering the entropy data', () => {
  const { bytes, ranges } = buildJpeg();
  const info = parseJpeg(bytes);
  assert.equal(info.frameType, 'baseline sequential DCT');
  assert.equal(info.scanCount, 1);
  assert.deepEqual(info.scanRanges, ranges);
  assert.equal(info.scanLength, ranges.reduce((n, r) => n + r.end - r.start, 0));
  assert.equal(bytes[info.scanEnd], 0xFF);
  assert.equal(bytes[info.scanEnd + 1], 0xD9);
});

test('restart markers split ranges and are excluded from them', () => {
  const { bytes, ranges, rstPositions } = buildJpeg({ rst: true });
  const info = parseJpeg(bytes);
  assert.deepEqual(info.scanRanges, ranges);
  assert.equal(info.scanRanges.length, 4);
  for (const pos of rstPositions) {
    assert.ok(!info.scanRanges.some(r => pos >= r.start && pos < r.end), `RST at ${pos} inside a range`);
  }
});

test('progressive: ranges from every SOS are collected', () => {
  const { bytes, ranges } = buildJpeg({ progressive: true });
  const info = parseJpeg(bytes);
  assert.equal(info.frameType, 'progressive DCT');
  assert.equal(info.scanCount, 3);
  assert.deepEqual(info.scanRanges, ranges);
});

test('missing EOI is tolerated and trailing bytes become scan data', () => {
  const { bytes, ranges } = buildJpeg({ eoi: false });
  const info = parseJpeg(bytes);
  assert.deepEqual(info.scanRanges, ranges);
  assert.equal(info.scanEnd, bytes.length);
});

test('file ending in a lone 0xFF is tolerated', () => {
  const { bytes } = buildJpeg({ eoi: false });
  const withFF = Uint8Array.from([...bytes, 0xFF]);
  const info = parseJpeg(withFF);
  assert.equal(info.scanEnd, withFF.length);
});

test('rejects non-JPEG, missing SOF, missing SOS and truncated segments', () => {
  assert.throws(() => parseJpeg(Uint8Array.from([0x89, 0x50, 0x4E, 0x47])), /SOI/);

  const noSof = [0xFF, 0xD8, ...segment(0xDB, [0, ...Array(64).fill(1)]), ...segment(0xDA, [1, 1, 0, 0, 63, 0]), 1, 2, 3, 0xFF, 0xD9];
  assert.throws(() => parseJpeg(Uint8Array.from(noSof)), /frame marker/);

  const noSos = [0xFF, 0xD8, ...segment(0xC0, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]), 0xFF, 0xD9];
  assert.throws(() => parseJpeg(Uint8Array.from(noSos)), /scan data/);

  const truncated = [0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x40, 8];
  assert.throws(() => parseJpeg(Uint8Array.from(truncated)), /overruns/);
});

// ── Logical scan helpers ──────────────────────────────────────────────────────

test('copyScanBytes and writeScanBytes span range boundaries', () => {
  const { bytes } = buildJpeg({ rst: true });
  const info = parseJpeg(bytes);
  const logical = logicalBytes(bytes, info);

  const copied = copyScanBytes(bytes, info, 990, 30);
  assert.deepEqual(Array.from(copied), logical.slice(990, 1020));

  const buf = new Uint8Array(bytes);
  const payload = Uint8Array.from(Array(30).fill(0xAB));
  writeScanBytes(buf, info, 990, payload);
  const after = logicalBytes(buf, info);
  assert.deepEqual(after.slice(990, 1020), Array(30).fill(0xAB));
  assert.deepEqual(after.slice(0, 990), logical.slice(0, 990));
  assert.deepEqual(after.slice(1020), logical.slice(1020));
  assert.ok(outsideScanEqual(bytes, buf, info));
});

// ── Strategies ────────────────────────────────────────────────────────────────

const STRATEGIES = Object.keys(STRATEGY_FNS);
const FIXTURES = {
  baseline: buildJpeg(),
  rst: buildJpeg({ rst: true, seed: 11 }),
  progressive: buildJpeg({ progressive: true, seed: 23 }),
};

for (const [label, fixture] of Object.entries(FIXTURES)) {
  const info = parseJpeg(fixture.bytes);

  for (const name of STRATEGIES) {
    test(`${name} on ${label}: never touches bytes outside scan ranges`, () => {
      for (const intensity of [0, 37, 100]) {
        for (const seed of [1, 42, 999999]) {
          const buf = new Uint8Array(fixture.bytes);
          runPipeline(buf, info, new Set([name]), intensity, seed);
          assert.ok(outsideScanEqual(fixture.bytes, buf, info), `i=${intensity} s=${seed}`);
        }
      }
    });

    test(`${name} on ${label}: deterministic for a given seed`, () => {
      const a = new Uint8Array(fixture.bytes);
      const b = new Uint8Array(fixture.bytes);
      runPipeline(a, info, new Set([name]), 70, 4242);
      runPipeline(b, info, new Set([name]), 70, 4242);
      assert.deepEqual(a, b);
    });

    test(`${name} on ${label}: full intensity changes the scan data`, () => {
      const buf = new Uint8Array(fixture.bytes);
      runPipeline(buf, info, new Set([name]), 100, 5);
      assert.notDeepEqual(buf, fixture.bytes);
    });
  }

  test(`intensity 0 on ${label} is a no-op for every strategy except echo`, () => {
    for (const name of STRATEGIES.filter(n => n !== 'echo')) {
      const buf = new Uint8Array(fixture.bytes);
      runPipeline(buf, info, new Set([name]), 0, 9);
      assert.deepEqual(buf, fixture.bytes, name);
    }
  });

  test(`all strategies together on ${label} preserve structure`, () => {
    const buf = new Uint8Array(fixture.bytes);
    runPipeline(buf, info, new Set(STRATEGIES), 100, 77);
    assert.ok(outsideScanEqual(fixture.bytes, buf, info));
  });
}

// ── Marker protection ─────────────────────────────────────────────────────────

test('protectMarkers removes every fake marker the pipeline introduces', () => {
  for (const fixture of Object.values(FIXTURES)) {
    const info = parseJpeg(fixture.bytes);
    let introduced = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const buf = new Uint8Array(fixture.bytes);
      runPipeline(buf, info, new Set(STRATEGIES), 100, seed);
      introduced += fakeMarkerCount(buf, info);
      protectMarkers(buf, info);
      assert.equal(fakeMarkerCount(buf, info), 0);
      assert.ok(outsideScanEqual(fixture.bytes, buf, info));
      const reparsed = parseJpeg(buf);
      assert.deepEqual(reparsed.scanRanges, info.scanRanges);
    }
    assert.ok(introduced > 0, 'fixture should provoke fake markers before protection');
  }
});

test('protectMarkers leaves valid stuffing alone and fixes edge cases', () => {
  const { bytes } = buildJpeg({ entropyLen: 64 });
  const info = parseJpeg(bytes);
  const { start, end } = info.scanRanges[0];

  const buf = new Uint8Array(bytes);
  buf[start] = 0xFF; buf[start + 1] = 0x00;
  buf[start + 2] = 0xFF; buf[start + 3] = 0x37;
  buf[end - 1] = 0xFF;
  protectMarkers(buf, info);

  assert.equal(buf[start], 0xFF);
  assert.equal(buf[start + 1], 0x00);
  assert.equal(buf[start + 2], 0xFE);
  assert.equal(buf[start + 3], 0x37);
  assert.equal(buf[end - 1], 0xFE);
  assert.equal(buf[end], 0xFF);
  assert.equal(buf[end + 1], 0xD9);
});

test('protectMarkers is idempotent on an untouched file', () => {
  const { bytes } = buildJpeg({ rst: true });
  const info = parseJpeg(bytes);
  const buf = new Uint8Array(bytes);
  protectMarkers(buf, info);
  assert.deepEqual(buf, bytes);
});

// ── Reproducibility ───────────────────────────────────────────────────────────
// Shared links and export filenames promise that the same image, settings and
// seed give the same bytes. This digest pins that promise for JPEG, so a change
// meant for another format cannot silently alter existing results.

test('JPEG output for fixed settings matches the recorded digest', () => {
  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha256');
  for (const fixture of Object.values(FIXTURES)) {
    const info = parseJpeg(fixture.bytes);
    for (const name of STRATEGIES) {
      for (const [intensity, seed] of [[13, 1], [50, 777], [100, 42]]) {
        const buf = new Uint8Array(fixture.bytes);
        runPipeline(buf, info, new Set([name]), intensity, seed);
        protectMarkers(buf, info);
        hash.update(buf);
      }
    }
    const all = new Uint8Array(fixture.bytes);
    runPipeline(all, info, new Set(STRATEGIES), 64, 4242);
    hash.update(all);
  }
  assert.equal(hash.digest('hex'), '19fd68fffa750c68d1e7202f678e84e3463d4458c42812852eb7ffc5a4113df7');
});
