const test = require('node:test');
const assert = require('node:assert/strict');
const { load, noisePicture, smoothPicture, run } = require('./helpers/load.js');

load('pixels.js', 'misread.js');

const misread = (picture, settings) => run(misreadSteps({ ...picture, cache: {} }, settings));
const honest = { width: 0 };

function maxDifference(a, b) {
  assert.equal(a.length, b.length);
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

test('read the way it was written, every format gives the picture back', () => {
  const noise = noisePicture(24, 10);
  const smooth = smoothPicture(96, 64);
  for (const format of ['rgb24', 'bgr24', 'rgba32', 'planar']) {
    const out = misread(noise, { ...honest, written: format, read: format });
    assert.equal(out.width, 24);
    assert.equal(out.height, 10);
    assert.deepEqual(out.rgba, noise.rgba, format);
  }
  assert.ok(maxDifference(misread(noise, { ...honest, written: 'rgb565', read: 'rgb565' }).rgba, noise.rgba) <= 8);
  // The video formats share one color sample between neighbors, so only a
  // smooth picture survives them closely.
  assert.ok(maxDifference(misread(smooth, { ...honest, written: 'i420', read: 'i420' }).rgba, smooth.rgba) <= 12);
  assert.ok(maxDifference(misread(smooth, { ...honest, written: 'yuyv', read: 'yuyv' }).rgba, smooth.rgba) <= 12);
  const odd = smoothPicture(95, 63);
  const back = misread(odd, { ...honest, written: 'i420', read: 'i420' });
  assert.equal(back.height, 63, 'an odd-sized frame is read back at its own height');
  assert.ok(maxDifference(back.rgba, odd.rgba) <= 12);
});

test('gray and black-and-white keep the brightness', () => {
  const picture = smoothPicture(16, 8);
  const gray = misread(picture, { ...honest, written: 'gray8', read: 'gray8' }).rgba;
  const mono = misread(picture, { ...honest, written: 'mono1', read: 'mono1' }).rgba;
  for (let i = 0; i < gray.length; i += 4) {
    const luma = 0.299 * picture.rgba[i] + 0.587 * picture.rgba[i + 1] + 0.114 * picture.rgba[i + 2];
    assert.ok(Math.abs(gray[i] - luma) <= 1 && gray[i] === gray[i + 1] && gray[i] === gray[i + 2]);
    assert.equal(mono[i], luma >= 128 ? 255 : 0);
    assert.equal(gray[i + 3], 255);
  }
});

test('the written stream has the size its format promises', () => {
  const { rgba, width, height } = noisePicture(7, 5);
  const sizes = { rgb24: 105, bgr24: 105, rgba32: 140, rgb565: 70, gray8: 35, mono1: 5, planar: 105, i420: 35 + 2 * 4 * 3, yuyv: 72 };
  for (const [format, size] of Object.entries(sizes)) {
    assert.equal(misreadWrite(rgba, width, height, format).length, size, format);
    assert.ok(MISREAD_FORMATS[format], format);
  }
  assert.deepEqual(Object.keys(MISREAD_FORMATS).sort(), Object.keys(sizes).sort());
});

test('one pixel too wide and every row starts one pixel later in the stream', () => {
  const picture = noisePicture(20, 10);
  const out = misread(picture, { width: 1 });
  assert.equal(out.width, 21);
  assert.equal(out.height, Math.ceil(200 / 21));
  for (let p = 0; p < 200; p++) {
    for (let ch = 0; ch < 3; ch++) assert.equal(out.rgba[p * 4 + ch], picture.rgba[p * 4 + ch]);
  }
  for (let i = 200 * 4; i < out.rgba.length; i++) assert.equal(out.rgba[i], 0, 'past the end of the data there is nothing');
});

test('RGB read as RGBA takes four bytes for every three, so the picture is a quarter shorter', () => {
  const picture = noisePicture(16, 8);
  const out = misread(picture, { ...honest, written: 'rgb24', read: 'rgba32' });
  assert.equal(out.width, 16);
  assert.equal(out.height, 6);
  const stream = misreadWrite(picture.rgba, 16, 8, 'rgb24');
  for (let p = 0; p < 16 * 6; p++) {
    assert.deepEqual(Array.from(out.rgba.subarray(p * 4, p * 4 + 4)), [stream[p * 4], stream[p * 4 + 1], stream[p * 4 + 2], 255]);
  }
});

test('a result is never taller than four times the picture or 4000 rows', () => {
  const out = misread(noisePicture(16, 8), { ...honest, written: 'rgba32', read: 'mono1' });
  assert.equal(out.height, 32);
  assert.equal(misreadHeight(1e9, 100, 'gray8'), 4000);
  assert.equal(misreadHeight(0, 100, 'gray8'), 1);
});

test('text editors damage the bytes the way the real ones do', () => {
  const bytes = Uint8Array.from([0x41, 0x0A, 0x0D, 0x0A, 0x00, 0x61, 0x7A, 0x7B, 0xE9, 0xFF, 0xC3, 0xA9, 0x80]);
  assert.deepEqual(Array.from(misreadEdit(bytes, 'none')), Array.from(bytes));
  assert.deepEqual(Array.from(misreadEdit(bytes, 'crlf')), [0x41, 0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x61, 0x7A, 0x7B, 0xE9, 0xFF, 0xC3, 0xA9, 0x80]);
  assert.deepEqual(Array.from(misreadEdit(bytes, 'ascii')), [0x41, 0x0A, 0x0D, 0x0A, 0x00, 0x61, 0x7A, 0x7B, 0x69, 0x7F, 0x43, 0x29, 0x00]);
  assert.deepEqual(Array.from(misreadEdit(bytes, 'upper')), [0x41, 0x0A, 0x0D, 0x0A, 0x00, 0x41, 0x5A, 0x7B, 0xE9, 0xFF, 0xC3, 0xA9, 0x80]);
  assert.deepEqual(Array.from(misreadEdit(bytes, 'nul')), [0x41, 0x0A, 0x0D, 0x0A, 0x61, 0x7A, 0x7B, 0xE9, 0xFF, 0xC3, 0xA9, 0x80]);
  // Latin-1 to UTF-8: é (E9) becomes C3 A9, ÿ (FF) becomes C3 BF.
  assert.deepEqual(Array.from(misreadEdit(Uint8Array.from([0x41, 0xE9, 0xFF, 0x80]), 'mojibake')), [0x41, 0xC3, 0xA9, 0xC3, 0xBF, 0xC2, 0x80]);
  // UTF-8: E9 and FF are invalid and become EF BF BD each; C3 A9 is a valid é
  // and passes; a lone 80 is invalid.
  assert.deepEqual(Array.from(misreadEdit(Uint8Array.from([0x41, 0xE9, 0xFF, 0xC3, 0xA9, 0x80]), 'utf8')),
    [0x41, 0xEF, 0xBF, 0xBD, 0xEF, 0xBF, 0xBD, 0xC3, 0xA9, 0xEF, 0xBF, 0xBD]);
  assert.deepEqual(Array.from(misreadEdit(Uint8Array.from([0xEF, 0xBB, 0xBF, 0x41]), 'utf8')), [0xEF, 0xBB, 0xBF, 0x41], 'a byte order mark is kept');
});

test('editors that make the data longer stop at the length that is needed', () => {
  const bytes = new Uint8Array(1000).fill(0x0A);
  assert.equal(misreadEdit(bytes, 'crlf', 100).length, 100);
  assert.equal(misreadEdit(new Uint8Array(1000).fill(0xFF), 'mojibake', 101).length, 101);
  assert.equal(misreadEdit(new Uint8Array(1000).fill(0xFF), 'utf8', 99).length, 99);
  assert.equal(misreadEdit(bytes, 'crlf').length, 2000);
});

test('skipping bytes, shifting bits, reversing bits and swapping pairs', () => {
  const bytes = Uint8Array.from([0b10110001, 0b01000000, 0b11111111, 0b00000001]);
  assert.equal(misreadShift(bytes, {}), bytes);
  assert.deepEqual(Array.from(misreadShift(bytes, { skip: 1 })), [0b01000000, 0b11111111, 0b00000001]);
  assert.deepEqual(Array.from(misreadShift(bytes, { bits: 3 })), [0b10001010, 0b00000111, 0b11111000, 0b00001000]);
  assert.deepEqual(Array.from(misreadShift(bytes, { reverse: true })), [0b10001101, 0b00000010, 0b11111111, 0b10000000]);
  assert.deepEqual(Array.from(misreadShift(bytes, { swap: true })), [0b01000000, 0b10110001, 0b00000001, 0b11111111]);
  assert.deepEqual(Array.from(misreadShift(bytes.subarray(0, 3), { swap: true })), [0b01000000, 0b10110001, 0b11111111], 'an odd byte at the end stays');
  assert.equal(misreadShift(bytes, { skip: 99 }).length, 0);
});

test('one byte skipped turns red into green into blue', () => {
  const picture = noisePicture(8, 4);
  const out = misread(picture, { ...honest, skip: 1 }).rgba;
  for (let p = 0; p < 31; p++) {
    assert.deepEqual(
      [out[p * 4], out[p * 4 + 1], out[p * 4 + 2]],
      [picture.rgba[p * 4 + 1], picture.rgba[p * 4 + 2], picture.rgba[(p + 1) * 4]],
    );
  }
});

test('transparent pictures are laid over white before they are written', () => {
  const rgba = new Uint8ClampedArray(4 * 4 * 4);   // fully transparent black
  const out = misread({ rgba, width: 4, height: 4 }, honest).rgba;
  assert.ok(out.every(v => v === 255));
});

test('changing a setting on the same picture reuses the written bytes only when the format is the same', () => {
  const source = { ...noisePicture(12, 6), cache: {} };
  const a = run(misreadSteps(source, { ...honest, written: 'rgb24', read: 'gray8' })).rgba;
  run(misreadSteps(source, { ...honest, written: 'i420', read: 'gray8' }));
  assert.deepEqual(run(misreadSteps(source, { ...honest, written: 'rgb24', read: 'gray8' })).rgba, a);
});
