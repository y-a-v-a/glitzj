'use strict';

// ── Signal ────────────────────────────────────────────────────────────────────
//
// Analog color television sends a whole picture down one wire as a single
// wavering voltage. Brightness is the voltage itself. Color rides on top as a
// small fast wave, the subcarrier: how tall the wave is says how strong the
// color is, and how far it is shifted against a reference says which color.
// The receiver has to pull the two apart again, and it never quite can. The
// rainbows on a striped shirt, the crawling dots along a color edge, the hue
// that smears to the right: none of that is drawn on. It is what a correct
// receiver does with a signal that is slightly wrong.
//
// So this does not imitate the look. It builds the signal and receives it:
//
//   pixels → raster of scan lines → brightness and two color signals →
//   composite signal (NTSC: four samples per subcarrier wave, the wave
//   flipped on every other line) → noise, ghosts, lost sync, tape trouble →
//   separate brightness from color → demodulate the color → pixels
//
// The signal is one number per sample, 0 for black and 1 for white.

const SIGNAL_LINES = ['240', '480', '720', 'source'];
const SIGNAL_DECODERS = ['notch', 'comb', 'mono'];
const SIGNAL_OVERSAMPLE = 754 / 640;   // samples per square pixel at four times the subcarrier
const SIGNAL_HBLANK = 0.16;            // the gap between lines, as a share of the line
const SIGNAL_VBLANK = 0.08;            // the gap between frames, as a share of the frame

// A fixed table of bell-curve noise; every line reads it from a different
// place, which is far cheaper than drawing fresh numbers for every sample.
const SIGNAL_NOISE = (() => {
  const table = new Float32Array(65536);
  const next = gaussian(prng(0xC0FFEE));
  for (let i = 0; i < table.length; i++) table[i] = next();
  return table;
})();

function signalRaster(width, height, lines) {
  const wanted = lines === 'source' ? height : Number(lines) || 480;
  const rows = Math.max(8, Math.min(height, wanted, 2000));
  const columns = Math.max(8, Math.min(4000, Math.round(rows * width / height)));
  return { rows, columns, samples: Math.round(columns * SIGNAL_OVERSAMPLE) };
}

function boxBlur(src, dst, n, radius) {
  let sum = 0;
  const size = radius * 2 + 1;
  for (let i = -radius; i <= radius; i++) sum += src[Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < n; i++) {
    dst[i] = sum / size;
    sum += src[Math.min(n - 1, i + radius + 1)] - src[Math.max(0, i - radius)];
  }
}

// The clean signal, kept as two parts per line: brightness, and the color wave
// as it is on even lines. On odd lines, and on every other frame, the wave is
// upside down; the sum of the parts is what goes down the wire.
function signalEncode(rgba, width, height, raster) {
  const { rows, samples: n } = raster;
  const pixels = resizePixels(rgba, width, height, n, rows);
  const luma = new Float32Array(rows * n), chroma = new Float32Array(rows * n);
  const i0 = new Float32Array(n), q0 = new Float32Array(n), i1 = new Float32Array(n), q1 = new Float32Array(n);

  for (let row = 0; row < rows; row++) {
    const base = row * n;
    for (let x = 0; x < n; x++) {
      const o = (base + x) * 4;
      const r = pixels[o] / 255, g = pixels[o + 1] / 255, b = pixels[o + 2] / 255;
      luma[base + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      i0[x] = 0.5959 * r - 0.2746 * g - 0.3213 * b;
      q0[x] = 0.2115 * r - 0.5227 * g + 0.3112 * b;
    }
    // The color signals are much less sharp than the brightness: there is
    // only room for so much on the subcarrier.
    boxBlur(i0, i1, n, 3);
    boxBlur(q0, q1, n, 7);
    for (let x = 0; x < n; x++) {
      const phase = x & 3;
      chroma[base + x] = phase === 0 ? i1[x] : phase === 1 ? q1[x] : phase === 2 ? -i1[x] : -q1[x];
    }
  }
  return { ...raster, luma, chroma };
}

const SIGNAL_DEFAULTS = {
  lines: '480',
  decoder: 'notch',
  noise: 12,
  ghost: 15,
  jitter: 8,
  wobble: 10,
  hhold: 0,
  vhold: 0,
  tracking: 15,
  dropouts: 10,
  color: 100,
  tint: 0,
  hue: 10,
  bleed: 40,
  soft: 30,
  seed: 1,
};

// Receives one frame. `frame` counts frames for moving pictures: the noise
// changes, the color wave flips, and whatever has lost its hold rolls on.
function* signalFrame(encoded, settings, frame = 0) {
  const s = { ...SIGNAL_DEFAULTS, ...settings };
  const { rows, columns, samples: n, luma, chroma } = encoded;
  const moving = frame > 0;
  const seed = (s.seed * 7919 + frame * 104729) | 0;
  const still = (s.seed * 7919) | 0;

  const period = n + Math.round(n * SIGNAL_HBLANK);       // a line including its gap
  const frameRows = rows + Math.round(rows * SIGNAL_VBLANK);
  const out = new Uint8ClampedArray(columns * rows * 4);

  const noise = (s.noise / 100) ** 1.5 * 0.6;
  const ghost = (s.ghost / 100) * 0.7;
  const ghostDelay = Math.max(2, Math.round(n * (0.012 + 0.05 * hashRandom(still, 11))));
  const jitter = (s.jitter / 100) ** 2 * n * 0.04;
  const wobble = (s.wobble / 100) * n * 0.012;
  const slope = (s.hhold / 100) * period * 1.5 / rows;
  const hDrift = moving ? frame * (s.hhold / 100) * period * 0.02 : 0;
  const roll = Math.round((s.vhold / 100) * frameRows * (moving ? frame * 0.03 : 1)) % frameRows;
  const gain = s.color / 100;
  const tint = s.tint * Math.PI / 180;
  const hueNoise = (s.hue / 100) ** 1.5 * 1.2;
  const bleed = 1 - (s.bleed / 100) * 0.94;               // one-pole coefficients: 1 passes
  const soft = 1 - (s.soft / 100) * 0.85;                 // everything, small smears
  const wobblePhase = frame * 0.31 + hashRandom(still, 5) * 6.28;

  // Tape trouble: a band of rows where the heads lose the track, placed by the
  // seed and drifting upward in a moving picture, plus the few rows at the
  // bottom where a video recorder switches heads.
  const bandHeight = (s.tracking / 100) * rows * 0.3;
  const bandTop = ((hashRandom(still, 3) * frameRows - frame * 1.7) % frameRows + frameRows) % frameRows;
  const headSwitch = s.tracking > 0 ? Math.max(2, Math.round(rows * 0.014)) : 0;

  // Dropouts: specks of missing tape, each a white dash with a fading tail.
  const dropStart = new Int32Array(rows).fill(-1);
  const dropLength = new Int32Array(rows);
  const drops = Math.round((s.dropouts / 100) ** 2 * rows * 0.25);
  for (let k = 0; k < drops; k++) {
    const row = Math.floor(hashRandom(seed + k, 21) * rows);
    dropStart[row] = Math.floor(hashRandom(seed + k, 22) * n);
    dropLength[row] = 6 + Math.floor(hashRandom(seed + k, 23) ** 3 * n * 0.25);
  }

  const comp = new Float32Array(n + 4);        // this line as received
  const prev = new Float32Array(n + 4);        // the line before it, for the comb
  const yLine = new Float32Array(n), iLine = new Float32Array(n), qLine = new Float32Array(n);
  const ch = new Float32Array(n + 4);

  for (let row = 0; row < rows; row++) {
    // Which line of the picture arrives on this row of the screen.
    const srcRow = (row + roll) % frameRows;
    const blank = srcRow >= rows;

    // How late the line starts, in samples.
    let offset = slope * row + hDrift;
    if (jitter) {
      offset += (hashRandom(seed + row, 1) * 2 - 1) * jitter;
      if (hashRandom(seed + row, 2) < (s.jitter / 100) ** 2 * 0.06) offset += (hashRandom(seed + row, 4) * 2 - 1) * n * 0.06;
    }
    if (wobble) {
      offset += wobble * (Math.sin(row * 0.021 + wobblePhase) + 0.5 * Math.sin(row * 0.057 - wobblePhase * 1.7));
      offset += wobble * 6 * Math.exp(-row / (rows * 0.03)) * Math.sin(wobblePhase * 2.3);
    }
    let lineNoise = noise, colorLoss = 1;
    const inBand = bandHeight > 0 && ((srcRow - bandTop + frameRows) % frameRows) < bandHeight;
    if (inBand) {
      const depth = Math.sin(Math.PI * ((srcRow - bandTop + frameRows) % frameRows) / bandHeight);
      offset += (hashRandom(seed + row, 6) * 2 - 1) * n * 0.08 * depth;
      lineNoise += 0.35 * depth * hashRandom(seed + row, 7);
      if (hashRandom(seed + row, 8) < 0.4 * depth) colorLoss = 0;
    }
    if (headSwitch && row >= rows - headSwitch) {
      offset += n * (0.04 + 0.1 * hashRandom(seed + row, 9));
      lineNoise += 0.25;
    }

    // Fetch the line as it arrives: shifted, wrapped around the gap between
    // lines, color wave upside down on odd lines and odd frames.
    const flip = ((srcRow + frame) & 1) ? -1 : 1;
    const base = srcRow * n;
    const whole = Math.floor(offset), frac = offset - whole;
    prev.set(comp);
    if (blank) {
      comp.fill(0);
    } else {
      for (let x = 0; x < n; x++) {
        let t = (x - whole) % period;
        if (t < 0) t += period;
        const t1 = t === 0 ? period - 1 : t - 1;
        const a = t < n ? luma[base + t] + flip * chroma[base + t] : 0;
        const b = t1 < n ? luma[base + t1] + flip * chroma[base + t1] : 0;
        comp[x] = a + (b - a) * frac;
      }
    }

    if (ghost) for (let x = ghostDelay; x < n; x++) comp[x] += ghost * comp[x - ghostDelay] - ghost * 0.35 * comp[x - (ghostDelay >> 1)];
    if (lineNoise) {
      let k = Math.floor(hashRandom(seed + row, 10) * 65536);
      for (let x = 0; x < n; x++, k = (k + 1) & 65535) comp[x] += lineNoise * SIGNAL_NOISE[k];
    }
    if (dropStart[row] >= 0) {
      const end = Math.min(n, dropStart[row] + dropLength[row]);
      for (let x = dropStart[row]; x < end; x++) comp[x] = 1.1 - 0.9 * (x - dropStart[row]) / dropLength[row] + comp[x] * 0.2;
    }
    comp[n] = comp[n + 1] = comp[n + 2] = comp[n + 3] = comp[n - 1];

    // Pull brightness and color apart.
    if (s.decoder === 'mono') {
      for (let x = 0; x < n; x++) { yLine[x] = comp[x]; ch[x] = 0; }
    } else if (s.decoder === 'comb') {
      // Two neighboring lines carry the color wave in opposite directions, so
      // their sum is brightness and their difference is color. That holds
      // only as long as the two lines show the same thing.
      for (let x = 0; x < n; x++) {
        yLine[x] = (comp[x] + prev[x]) / 2;
        ch[x] = (comp[x] - prev[x]) / 2;
      }
    } else {
      // A notch: averaging samples half a wave apart cancels the subcarrier,
      // and with it any fine detail that happens to look like it.
      for (let x = 0; x < n; x++) {
        const y = 0.25 * comp[x < 2 ? 0 : x - 2] + 0.5 * comp[x] + 0.25 * comp[x + 2];
        yLine[x] = y;
        ch[x] = comp[x] - y;
      }
    }

    // Demodulate: multiply by the reference wave, which the receiver locks to
    // the start of each line, so it arrives as late as the line does.
    if (s.decoder !== 'mono') {
      const error = tint + (hueNoise ? (hashRandom(seed + row, 12) * 2 - 1) * hueNoise : 0);
      const theta = -Math.PI / 2 * offset + error;
      let cos = Math.cos(theta) * flip, sin = Math.sin(theta) * flip;
      const level = 2 * gain * colorLoss;
      let i3 = 0, i2 = 0, i1 = 0, q3 = 0, q2 = 0, q1 = 0, iSmooth = 0, qSmooth = 0;
      for (let x = 0; x < n; x++) {
        const iNow = ch[x] * cos * level, qNow = ch[x] * sin * level;
        // Averaging four samples removes what the multiplication adds at
        // twice the subcarrier; the one-pole filter after it is the bleed.
        iSmooth += bleed * ((iNow + i1 + i2 + i3) / 4 - iSmooth);
        qSmooth += bleed * ((qNow + q1 + q2 + q3) / 4 - qSmooth);
        iLine[x] = iSmooth;
        qLine[x] = qSmooth;
        i3 = i2; i2 = i1; i1 = iNow;
        q3 = q2; q2 = q1; q1 = qNow;
        const t = cos; cos = -sin; sin = t;       // a quarter wave further
      }
    }

    // Back to pixels, at the width of the picture.
    let ySmooth = yLine[0];
    if (soft < 1) for (let x = 0; x < n; x++) { ySmooth += soft * (yLine[x] - ySmooth); yLine[x] = ySmooth; }
    const o0 = row * columns * 4;
    const scale = n / columns;
    for (let x = 0; x < columns; x++) {
      const pos = Math.min(n - 1.001, Math.max(0, (x + 0.5) * scale - 0.5));
      const j = Math.floor(pos), f = pos - j;
      const y = yLine[j] + (yLine[j + 1] - yLine[j]) * f;
      let r = y, g = y, b = y;
      if (s.decoder !== 'mono') {
        const i = iLine[j] + (iLine[j + 1] - iLine[j]) * f;
        const q = qLine[j] + (qLine[j + 1] - qLine[j]) * f;
        r = y + 0.956 * i + 0.619 * q;
        g = y - 0.272 * i - 0.647 * q;
        b = y - 1.106 * i + 1.703 * q;
      }
      const o = o0 + x * 4;
      out[o] = r * 255 + 0.5;
      out[o + 1] = g * 255 + 0.5;
      out[o + 2] = b * 255 + 0.5;
      out[o + 3] = 255;
    }

    if ((row & 63) === 63) yield row / rows;
  }

  return { rgba: out, width: columns, height: rows };
}

function* signalSteps(source, settings, frame = 0) {
  const s = { ...SIGNAL_DEFAULTS, ...settings };
  const cache = source.cache || (source.cache = {});
  if (!cache.flat) cache.flat = flattenOnWhite(source.rgba);
  if (!cache.signal || cache.signal.lines !== s.lines) {
    const raster = signalRaster(source.width, source.height, s.lines);
    cache.signal = { lines: s.lines, encoded: signalEncode(cache.flat, source.width, source.height, raster) };
    yield 0;
  }
  return yield* signalFrame(cache.signal.encoded, s, frame);
}
