const test = require('node:test');
const assert = require('node:assert/strict');
const { load, noisePicture, run } = require('./helpers/load.js');

load('pixels.js', 'bend.js');

const off = Object.fromEntries(BEND_PEDALS.map(name => [name, false]));
const bend = (picture, settings) => run(bendSteps({ ...picture, cache: {} }, { ...off, ...settings }));

test('the Hilbert curve visits every pixel once and only ever steps to a neighbor', () => {
  for (const [w, h] of [[1, 1], [1, 9], [9, 1], [7, 5], [16, 16], [3, 40], [101, 37], [64, 48]]) {
    const order = hilbertOrder(w, h);
    assert.equal(new Set(order).size, w * h, `${w}×${h} covers`);
    for (let i = 1; i < order.length; i++) {
      const dx = Math.abs(order[i] % w - order[i - 1] % w);
      const dy = Math.abs(Math.floor(order[i] / w) - Math.floor(order[i - 1] / w));
      assert.ok(Math.max(dx, dy) === 1, `${w}×${h} step ${i} jumps ${dx},${dy}`);
    }
  }
});

test('the other scan orders visit every pixel once, in their own order', () => {
  assert.equal(scanOrder(4, 3, 'rows'), null);
  assert.deepEqual(Array.from(scanOrder(3, 2, 'columns')), [0, 3, 1, 4, 2, 5]);
  assert.deepEqual(Array.from(scanOrder(3, 3, 'serpentine')), [0, 1, 2, 5, 4, 3, 6, 7, 8]);
});

test('µ-law follows G.711 and survives a round trip', () => {
  assert.ok(ulawToSample(0xFF) === 0 && ulawToSample(0x7F) === 0, 'both zeros are silence');
  assert.equal(Math.round(ulawToSample(0x00) * 32768), -32124);
  assert.equal(Math.round(ulawToSample(0x80) * 32768), 32124);
  for (let byte = 0; byte < 256; byte++) {
    if (byte === 0x7F) continue;                     // negative zero comes back as zero
    assert.equal(sampleToUlaw(ulawToSample(byte)), byte);
  }
});

test('samples that do not fit clip or wrap around', () => {
  assert.equal(sampleToByte(0, 'linear', 'clip'), 128);
  assert.equal(sampleToByte(5, 'linear', 'clip'), 255);
  assert.equal(sampleToByte(-5, 'linear', 'clip'), 0);
  assert.equal(sampleToByte(1.5, 'linear', 'wrap'), sampleToByte(-0.5, 'linear', 'wrap'));
  assert.equal(sampleToByte(-0.5, 'linear', 'wrap'), 64);
  for (let byte = 0; byte < 256; byte++) {
    assert.equal(sampleToByte(byteToSample(byte, 'linear'), 'linear', 'clip'), byte);
    assert.equal(sampleToByte(byteToSample(byte, 'linear'), 'linear', 'wrap'), byte);
  }
});

test('with every pedal off the picture comes back, whatever the tape', () => {
  const picture = noisePicture(13, 9);
  for (const scan of BEND_SCANS) {
    for (const tracks of BEND_TRACKS) {
      for (const backwards of [false, true]) {
        assert.deepEqual(bend(picture, { scan, tracks, backwards }).rgba, picture.rgba, `${scan} ${tracks}`);
      }
    }
  }
  const ulaw = bend(picture, { codec: 'ulaw' }).rgba;
  for (let i = 0; i < ulaw.length; i++) {
    if (i % 4 !== 3 && picture.rgba[i] === 0x7F) continue;
    assert.equal(ulaw[i], picture.rgba[i]);
  }
});

test('the tape holds the colors in turn on one track, or one color per track', () => {
  const picture = noisePicture(6, 4);
  const one = bend(picture, { tracks: 'one' });
  const three = bend(picture, { tracks: 'three' });
  assert.equal(one.tracks.length, 1);
  assert.equal(one.tracks[0].length, 72);
  assert.deepEqual(three.tracks.map(t => t.length), [24, 24, 24]);
  assert.equal(one.tracks[0][4], byteToSample(picture.rgba[5], 'linear'));
  assert.equal(three.tracks[1][1], byteToSample(picture.rgba[5], 'linear'));
  assert.equal(bendLine(6, 4, { scan: 'rows', tracks: 'one' }), 18);
  assert.equal(bendLine(6, 4, { scan: 'columns', tracks: 'three' }), 4);
});

test('echo repeats a click at the delay, fainter each time, and keeps the level', () => {
  const tape = new Float32Array(400);
  tape[10] = 1;
  pedalEcho(tape, 50, 50, 100);
  const delay = bendEchoDelay(50, 100), feedback = 0.46;
  assert.ok(Math.abs(tape[10] - (1 - feedback)) < 1e-6);
  assert.ok(Math.abs(tape[10 + delay] - (1 - feedback) * feedback) < 1e-6);
  assert.ok(Math.abs(tape[10 + 2 * delay] - (1 - feedback) * feedback ** 2) < 1e-6);
  assert.equal(tape[11], 0);

  const flat = new Float32Array(5000).fill(0.5);
  pedalEcho(flat, 20, 80, 100);
  assert.ok(Math.abs(flat[4999] - 0.5) < 1e-3, 'a flat tape ends up as bright as it was');
  assert.equal(bendEchoDelay(0, 300), 2);
  assert.equal(bendEchoDelay(100, 300), 4800);
});

test('on one track an echo lands on another color; on three tracks it stays in its own', () => {
  const rgba = new Uint8ClampedArray(64 * 4).fill(128);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  rgba[0] = 255;                                              // one red pixel
  const picture = { rgba, width: 64, height: 1 };
  // A short echo that is not a whole number of pixels long.
  const echoA = [5, 6, 7, 8, 9, 10].find(a => bendEchoDelay(a, 64 * 3) % 3 !== 0);
  const knob = { echo: true, echoA, echoB: 100 };
  const one = bend(picture, { ...knob, tracks: 'one' }).rgba;
  const three = bend(picture, { ...knob, tracks: 'three' }).rgba;
  let strayOne = 0, strayThree = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (one[i + 1] !== 128 || one[i + 2] !== 128) strayOne++;
    if (three[i + 1] !== 128 || three[i + 2] !== 128) strayThree++;
  }
  assert.ok(strayOne > 0);
  assert.equal(strayThree, 0);
});

test('backwards, the echo comes before the click', () => {
  const rgba = new Uint8ClampedArray(200 * 4).fill(128);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  rgba[100 * 4] = rgba[100 * 4 + 1] = rgba[100 * 4 + 2] = 255;
  const picture = { rgba, width: 200, height: 1 };
  const knob = { echo: true, echoA: 40, echoB: 60, tracks: 'three' };
  const forward = bend(picture, knob).rgba, backward = bend(picture, { ...knob, backwards: true }).rgba;
  const touched = data => { const at = []; for (let x = 0; x < 200; x++) if (data[x * 4] !== 128) at.push(x); return at; };
  assert.ok(touched(forward).every(x => x >= 100) && touched(forward).length > 1);
  assert.ok(touched(backward).every(x => x <= 100) && touched(backward).length > 1);
});

test('speed leaves the tape alone in the middle and stretches or squeezes it otherwise', () => {
  assert.equal(bendSpeedFactor(50), 1);
  assert.equal(bendSpeedFactor(100), 2);
  assert.equal(bendSpeedFactor(0), 0.5);
  const ramp = Float32Array.from({ length: 100 }, (_, i) => i / 100);
  const same = Float32Array.from(ramp);
  pedalSpeed(same, 50);
  assert.deepEqual(same, ramp);
  const fast = Float32Array.from(ramp);
  pedalSpeed(fast, 100);
  assert.ok(Math.abs(fast[10] - ramp[20]) < 1e-6);
  assert.equal(fast[60], 0, 'past the end of the tape there is silence');
});

test('crush leaves few levels and holds samples; drive is gain and bias', () => {
  const tape = Float32Array.from({ length: 64 }, (_, i) => Math.sin(i));
  pedalCrush(tape, 100, 50);                         // one bit, held
  const hold = Math.round(96 ** 0.5);
  assert.ok(new Set(tape).size <= 3);
  for (let i = 0; i < 64; i++) assert.equal(tape[i], tape[i - (i % hold)]);

  const loud = Float32Array.from([0.1, -0.2]);
  pedalDrive(loud, 100, 100);
  assert.ok(Math.abs(loud[0] - (0.1 * 24 + 1)) < 1e-5 && Math.abs(loud[1] - (-0.2 * 24 + 1)) < 1e-5);
});

test('no pedal blows up: a loud noisy tape stays finite through all of them at any setting', () => {
  for (const knobs of [[0, 0], [50, 50], [100, 100], [0, 100], [100, 0]]) {
    for (const name of BEND_PEDALS) {
      for (const type of BEND_FILTERS) {
        const random = prng(3);
        const tape = Float32Array.from({ length: 6000 }, () => random() * 2 - 1);
        BEND_PEDAL_FNS[name](tape, knobs[0], knobs[1], 300, type);
        assert.ok(tape.every(Number.isFinite), `${name} ${knobs} ${type}`);
        assert.ok(tape.every(v => Math.abs(v) < 1000), `${name} ${knobs} ${type} runs away`);
      }
    }
  }
});

test('a low-pass filter keeps a flat tape flat and a high-pass removes it', () => {
  const low = new Float32Array(4000).fill(0.5), high = new Float32Array(4000).fill(0.5);
  pedalFilter(low, 50, 20, 300, 'low');
  pedalFilter(high, 50, 20, 300, 'high');
  assert.ok(Math.abs(low[3999] - 0.5) < 1e-3);
  assert.ok(Math.abs(high[3999]) < 1e-3);
});

test('the same settings give the same picture, and the source is never changed', () => {
  const picture = noisePicture(40, 20);
  const original = Uint8ClampedArray.from(picture.rgba);
  const all = Object.fromEntries(BEND_PEDALS.map(name => [name, true]));
  const a = bend(picture, { ...all, scan: 'hilbert' }).rgba;
  assert.deepEqual(bend(picture, { ...all, scan: 'hilbert' }).rgba, a);
  assert.notDeepEqual(a, original);
  assert.deepEqual(picture.rgba, original);
  assert.ok(a.every((v, i) => i % 4 !== 3 || v === 255));
});

test('the tape exports as an 8-bit mono WAV file', () => {
  const wav = bendWav([Float32Array.from([0, 1, -1]), Float32Array.from([0.5])], 44100);
  const view = new DataView(wav.buffer);
  const text = (at, n) => String.fromCharCode(...wav.subarray(at, at + n));
  assert.equal(wav.length, 48);
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), 40);
  assert.equal(text(8, 8), 'WAVEfmt ');
  assert.deepEqual([view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)], [1, 1, 44100, 8]);
  assert.equal(text(36, 4), 'data');
  assert.equal(view.getUint32(40, true), 4);
  assert.deepEqual(Array.from(wav.subarray(44)), [128, 255, 0, 192]);
});
