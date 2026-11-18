'use strict';

// ── Bend ──────────────────────────────────────────────────────────────────────
//
// The oldest trick in databending: open a picture in a sound editor as if it
// were a recording, run it through audio effects, and save it as a picture
// again. An echo in sound is a ghost in the picture; a filter that rings
// leaves ripples beside every edge; a tape that runs a little fast tilts the
// whole frame.
//
//   pixels → one long tape of samples → pedals → samples → pixels
//
// The tape is the color values in the order the scan visits the pixels. With
// the colors on one track (red, green, blue, red, …) an echo of any length
// that is not a multiple of three lands on the wrong color, which is where
// the rainbows come from. A scan along a Hilbert curve keeps neighbors on the
// tape close together in the picture, so the same echo spreads in blocks
// instead of sideways.
//
// Samples run from -1 to 1. The pedals are ordinary textbook audio effects,
// applied in a fixed order, each working in place on the tape.

const BEND_SCANS = ['rows', 'serpentine', 'columns', 'hilbert'];
const BEND_TRACKS = ['one', 'three'];
const BEND_CODECS = ['linear', 'ulaw'];
const BEND_OVERFLOWS = ['clip', 'wrap'];
const BEND_FILTERS = ['low', 'high', 'band'];
const BEND_PEDALS = ['speed', 'drive', 'crush', 'filter', 'phaser', 'vibrato', 'echo', 'reverb'];

// ── Scan orders ───────────────────────────────────────────────────────────────

// A space-filling curve through a rectangle of any size: the generalized
// Hilbert curve by Jakub Červený. Consecutive points are always neighbors.
function hilbertOrder(width, height) {
  const order = new Uint32Array(width * height);
  let count = 0;
  const sgn = Math.sign, half = v => Math.floor(v / 2);

  const walk = (x, y, ax, ay, bx, by) => {
    const w = Math.abs(ax + ay), h = Math.abs(bx + by);
    const dax = sgn(ax), day = sgn(ay), dbx = sgn(bx), dby = sgn(by);

    if (h === 1) {
      for (let i = 0; i < w; i++, x += dax, y += day) order[count++] = y * width + x;
      return;
    }
    if (w === 1) {
      for (let i = 0; i < h; i++, x += dbx, y += dby) order[count++] = y * width + x;
      return;
    }

    let ax2 = half(ax), ay2 = half(ay), bx2 = half(bx), by2 = half(by);
    const w2 = Math.abs(ax2 + ay2), h2 = Math.abs(bx2 + by2);

    if (2 * w > 3 * h) {
      if (w2 % 2 && w > 2) { ax2 += dax; ay2 += day; }
      walk(x, y, ax2, ay2, bx, by);
      walk(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by);
    } else {
      if (h2 % 2 && h > 2) { bx2 += dbx; by2 += dby; }
      walk(x, y, bx2, by2, ax2, ay2);
      walk(x + bx2, y + by2, ax, ay, bx - bx2, by - by2);
      walk(x + (ax - dax) + (bx2 - dbx), y + (ay - day) + (by2 - dby), -bx2, -by2, -(ax - ax2), -(ay - ay2));
    }
  };

  if (width >= height) walk(0, 0, width, 0, 0, height);
  else walk(0, 0, 0, height, width, 0);
  return order;
}

// The pixel index for every position on the tape, or null for plain rows.
function scanOrder(width, height, scan) {
  if (scan === 'hilbert') return hilbertOrder(width, height);
  if (scan !== 'serpentine' && scan !== 'columns') return null;
  const order = new Uint32Array(width * height);
  let k = 0;
  if (scan === 'columns') {
    for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) order[k++] = y * width + x;
  } else {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) order[k++] = y * width + (y & 1 ? width - 1 - x : x);
    }
  }
  return order;
}

// ── Bytes ⇄ samples ───────────────────────────────────────────────────────────
// Linear is what a sound editor calls unsigned 8-bit PCM. µ-law is the
// telephone encoding that squeezes loud sounds, the other classic way to
// import raw data: white becomes silence, mid gray the loudest sound there is.

function ulawToSample(byte) {
  const u = ~byte & 0xFF;
  const magnitude = ((((u & 0x0F) << 3) + 0x84) << ((u >> 4) & 7)) - 0x84;
  return (u & 0x80 ? -magnitude : magnitude) / 32768;
}

function sampleToUlaw(sample) {
  let s = Math.round(sample * 32768);
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > 32635) s = 32635;
  s += 0x84;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  return ~(sign | (exponent << 4) | ((s >> (exponent + 3)) & 0x0F)) & 0xFF;
}

const ULAW_TO_SAMPLE = Float32Array.from({ length: 256 }, (_, byte) => ulawToSample(byte));

function byteToSample(byte, codec) {
  return codec === 'ulaw' ? ULAW_TO_SAMPLE[byte] : (byte - 128) / 128;
}

function sampleToByte(sample, codec, overflow) {
  if (overflow === 'wrap') sample = sample - 2 * Math.floor((sample + 1) / 2);
  else sample = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  if (codec === 'ulaw') return sampleToUlaw(sample);
  const v = Math.round(sample * 128) + 128;
  return v > 255 ? 255 : v < 0 ? 0 : v;
}

// ── Pedals ────────────────────────────────────────────────────────────────────
// Each takes the tape, its two knobs (0 to 100) and the number of samples in
// one line of the picture, the natural unit for anything that takes time.

const knobLog = (knob, min, max) => min * (max / min) ** (knob / 100);

// Tape speed: the tape is played faster or slower and recorded again, so every
// line comes out a little longer or shorter than the picture is wide.
function bendSpeedFactor(knob) {
  const v = (knob - 50) / 50;
  return 2 ** (v * v * v);
}

function pedalSpeed(x, a) {
  const factor = bendSpeedFactor(a);
  if (factor === 1) return;
  const src = Float32Array.from(x);
  const n = x.length;
  for (let i = 0; i < n; i++) {
    const pos = i * factor;
    const j = Math.floor(pos);
    if (j >= n - 1) { x[i] = j === n - 1 ? src[j] : 0; continue; }
    const f = pos - j;
    x[i] = src[j] * (1 - f) + src[j + 1] * f;
  }
}

// Drive: louder, with the zero line moved. What no longer fits is clipped or
// wraps around when the tape is turned back into bytes.
function pedalDrive(x, a, b) {
  const gain = knobLog(a, 1, 24);
  const bias = (b - 50) / 50;
  for (let i = 0; i < x.length; i++) x[i] = x[i] * gain + bias;
}

// Crush: fewer bits per sample, and each sample held for a while.
function pedalCrush(x, a, b) {
  const bits = 8 - (a / 100) * 7;
  const levels = 2 ** (bits - 1);
  const hold = Math.max(1, Math.round(knobLog(b, 1, 96)));
  let held = 0;
  for (let i = 0; i < x.length; i++) {
    if (i % hold === 0) held = Math.round(x[i] * levels) / levels;
    x[i] = held;
  }
}

// A resonant filter. Turned up, the resonance rings at the cutoff frequency
// after every edge.
function pedalFilter(x, a, b, line, type) {
  const cutoff = knobLog(100 - a, 0.0015, 0.16);
  const f = 2 * Math.sin(Math.PI * cutoff);
  const q = 1 / knobLog(b, 0.5, 40);
  let low = 0, band = 0;
  for (let i = 0; i < x.length; i++) {
    low += f * band;
    const high = x[i] - low - q * band;
    band += f * high;
    if (band > 8) band = 8; else if (band < -8) band = -8;
    x[i] = type === 'high' ? high : type === 'band' ? band : low;
  }
}

// Phaser: four all-pass filters whose tuning sweeps slowly, mixed with the
// untouched tape, so bands of frequencies cancel and come back.
function pedalPhaser(x, a, b, line) {
  const period = line * knobLog(100 - a, 0.5, 96);
  const depth = b / 100;
  const z = new Float64Array(4);
  let feedback = 0;
  const step = 2 * Math.PI / period;
  for (let i = 0; i < x.length; i++) {
    const coef = 0.15 + 0.8 * (0.5 + 0.5 * Math.sin(i * step));
    let v = x[i] + feedback * 0.6 * depth;
    for (let s = 0; s < 4; s++) {
      const y = -coef * v + z[s];
      z[s] = v + coef * y;
      v = y;
    }
    feedback = v;
    x[i] = x[i] * (1 - depth / 2) + v * depth / 2;
  }
}

// Vibrato: the tape speeds up and slows down, wow and flutter. Lines are
// pushed back and forth in waves.
function pedalVibrato(x, a, b, line) {
  const period = line * knobLog(100 - a, 0.5, 96);
  const depth = knobLog(b, 1, line / 4 + 2);
  const size = Math.ceil(depth) + 3;
  const history = new Float32Array(size);
  const step = 2 * Math.PI / period;
  for (let i = 0; i < x.length; i++) {
    history[i % size] = x[i];
    const delay = depth * (0.5 - 0.5 * Math.cos(i * step));
    const whole = Math.floor(delay), f = delay - whole;
    const at = k => (i - k < 0 ? 0 : history[(i - k) % size]);
    x[i] = at(whole) * (1 - f) + at(whole + 1) * f;
  }
}

// How many samples the echo waits: from a couple of samples to sixteen lines.
function bendEchoDelay(knob, line) {
  return Math.max(1, Math.round(knobLog(knob, 2, line * 16)));
}

// Echo: what was on the tape a moment ago is mixed in again, and the echo
// echoes too. The level is turned down by as much as the echoes add, so the
// picture keeps its brightness.
function pedalEcho(x, a, b, line) {
  const delay = bendEchoDelay(a, line);
  const feedback = (b / 100) * 0.92;
  for (let i = 0; i < x.length; i++) x[i] = (1 - feedback) * x[i] + (i < delay ? 0 : feedback * x[i - delay]);
}

// Reverb: the classic Schroeder room, four echoes of unrelated lengths side by
// side and two all-pass filters to blur them.
function pedalReverb(x, a, b, line) {
  const size = knobLog(a, 0.05, 6) * line;
  const mix = b / 100;
  const combs = [1.0, 1.117, 1.271, 1.433].map(k => ({ buf: new Float32Array(Math.max(2, Math.round(size * k))), i: 0 }));
  const passes = [0.193, 0.071].map(k => ({ buf: new Float32Array(Math.max(2, Math.round(size * k))), i: 0 }));
  for (let i = 0; i < x.length; i++) {
    const dry = x[i];
    let wet = 0;
    for (const c of combs) {
      const out = c.buf[c.i];
      c.buf[c.i] = dry + out * 0.78;
      if (++c.i === c.buf.length) c.i = 0;
      wet += out;
    }
    wet *= 0.25 * 0.22;
    for (const p of passes) {
      const delayed = p.buf[p.i];
      const v = wet + delayed * 0.5;
      p.buf[p.i] = v;
      if (++p.i === p.buf.length) p.i = 0;
      wet = delayed - v * 0.5;
    }
    x[i] = dry * (1 - mix) + wet * mix;
  }
}

const BEND_PEDAL_FNS = {
  speed: pedalSpeed,
  drive: pedalDrive,
  crush: pedalCrush,
  filter: pedalFilter,
  phaser: pedalPhaser,
  vibrato: pedalVibrato,
  echo: pedalEcho,
  reverb: pedalReverb,
};

// ── Pipeline ──────────────────────────────────────────────────────────────────

const BEND_DEFAULTS = {
  scan: 'rows',
  tracks: 'one',
  codec: 'linear',
  overflow: 'clip',
  backwards: false,
  speed: false, speedA: 52,
  drive: false, driveA: 30, driveB: 50,
  crush: false, crushA: 50, crushB: 20,
  filter: false, filterA: 35, filterB: 60, filterType: 'low',
  phaser: false, phaserA: 60, phaserB: 80,
  vibrato: false, vibratoA: 50, vibratoB: 50,
  echo: true, echoA: 62, echoB: 55,
  reverb: false, reverbA: 40, reverbB: 50,
};

// Samples per line of the picture along the scan.
function bendLine(width, height, s) {
  const pixels = s.scan === 'columns' ? height : width;
  return pixels * (s.tracks === 'one' ? 3 : 1);
}

function* bendSteps(source, settings) {
  const s = { ...BEND_DEFAULTS, ...settings };
  const { width, height } = source;
  const n = width * height;
  const cache = source.cache || (source.cache = {});

  if (!cache.flat) cache.flat = flattenOnWhite(source.rgba);
  if (!cache.scan || cache.scan.kind !== s.scan) {
    cache.scan = { kind: s.scan, order: scanOrder(width, height, s.scan) };
    yield 0.05;
  }
  const rgba = cache.flat, order = cache.scan.order;
  const line = bendLine(width, height, s);
  const active = BEND_PEDALS.filter(name => s[name]);

  // One track holds all three colors in turn; three tracks hold one each.
  const one = s.tracks === 'one';
  const tracks = one ? [new Float32Array(n * 3)] : [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let k = 0; k < n; k++) {
    const i = (order ? order[k] : k) * 4;
    for (let ch = 0; ch < 3; ch++) {
      const v = byteToSample(rgba[i + ch], s.codec);
      if (one) tracks[0][k * 3 + ch] = v; else tracks[ch][k] = v;
    }
  }
  yield 0.1;

  let done = 0;
  const total = tracks.length * active.length || 1;
  for (const track of tracks) {
    if (s.backwards) track.reverse();
    for (const name of active) {
      BEND_PEDAL_FNS[name](track, s[`${name}A`], s[`${name}B`], line, s.filterType);
      yield 0.1 + 0.8 * (++done / total);
    }
    if (s.backwards) track.reverse();
  }

  const out = new Uint8ClampedArray(n * 4);
  for (let k = 0; k < n; k++) {
    const i = (order ? order[k] : k) * 4;
    for (let ch = 0; ch < 3; ch++) {
      out[i + ch] = sampleToByte(one ? tracks[0][k * 3 + ch] : tracks[ch][k], s.codec, s.overflow);
    }
    out[i + 3] = 255;
  }

  return { rgba: out, width, height, tracks, order, line };
}

// ── Sound ─────────────────────────────────────────────────────────────────────

// The tape as a WAV file: 8-bit unsigned PCM, mono, tracks one after another.
function bendWav(tracks, sampleRate = 44100) {
  const length = tracks.reduce((sum, t) => sum + t.length, 0);
  const out = new Uint8Array(44 + length);
  const view = new DataView(out.buffer);
  const text = (at, s) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + length, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, 'data');
  view.setUint32(40, length, true);
  let o = 44;
  for (const track of tracks) {
    for (let i = 0; i < track.length; i++) out[o++] = sampleToByte(track[i], 'linear', 'clip');
  }
  return out;
}
