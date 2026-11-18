const test = require('node:test');
const assert = require('node:assert/strict');
const { load, noisePicture } = require('./helpers/load.js');

load('source.js');

const V = SourceView;

// Literal versions, one pixel at a time, of what the buttons promise.
function turnedClockwise({ rgba, width, height }) {
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.set(rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (x * height + height - 1 - y) * 4);
  }
  return { rgba: out, width: height, height: width };
}

function mirrored({ rgba, width, height }, horizontal) {
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tx = horizontal ? width - 1 - x : x, ty = horizontal ? y : height - 1 - y;
      out.set(rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (ty * width + tx) * 4);
    }
  }
  return { rgba: out, width, height };
}

function cropped({ rgba, width }, x0, y0, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(rgba.subarray(((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + w) * 4), y * w * 4);
  return { rgba: out, width: w, height: h };
}

const show = (picture, view) => V.pixels(picture.rgba, picture.width, picture.height, view);

test('an untouched view returns the very pixels it was given', () => {
  const picture = noisePicture(7, 5);
  const out = show(picture, V.identity());
  assert.equal(out.rgba, picture.rgba);
  assert.ok(V.isIdentity(V.identity()) && V.isIdentity(null));
  assert.ok(!V.isIdentity(V.rotate(V.identity())) && !V.isIdentity(V.flip(V.identity())) && !V.isIdentity(V.zoomTo(V.identity(), 200)));
  assert.ok(V.isIdentity({ turns: 0, mirror: false, zoom: 100, cx: 10, cy: 990 }), 'where the middle is does not matter when nothing is cut off');
});

test('every button does to the picture on screen what it says, whatever was done before', () => {
  const picture = noisePicture(9, 6);
  // Walk through all eight ways a picture can lie, by every button from each.
  const seen = new Set();
  const queue = [{ view: V.identity(), shown: picture }];
  while (queue.length) {
    const { view, shown } = queue.shift();
    const key = `${view.turns}${view.mirror}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assert.deepEqual(show(picture, view), shown, key);

    const steps = [
      [V.rotate(view, true), turnedClockwise(shown)],
      [V.rotate(view, false), turnedClockwise(turnedClockwise(turnedClockwise(shown)))],
      [V.flip(view, true), mirrored(shown, true)],
      [V.flip(view, false), mirrored(shown, false)],
    ];
    for (const [next, expected] of steps) {
      assert.deepEqual(show(picture, next), expected, `from ${key}`);
      queue.push({ view: next, shown: expected });
    }
  }
  assert.equal(seen.size, 8);
});

test('four quarter turns, or the same flip twice, is where you started', () => {
  let view = V.zoomTo(V.pan(V.zoomTo(V.identity(), 300), 0.4, -0.2), 300);
  const start = { ...view };
  for (let i = 0; i < 4; i++) view = V.rotate(view, true);
  assert.deepEqual(view, start);
  assert.deepEqual(V.rotate(V.rotate(start, true), false), start);
  assert.deepEqual(V.flip(V.flip(start, true), true), start);
  assert.deepEqual(V.flip(V.flip(start, false), false), start);
});

test('zooming is cropping: the pixels inside, at their own size', () => {
  const picture = noisePicture(40, 20);
  const middle = show(picture, V.zoomTo(V.identity(), 200));
  assert.deepEqual(middle, cropped(picture, 10, 5, 20, 10));

  const corner = show(picture, { turns: 0, mirror: false, zoom: 400, cx: 0, cy: 0 });
  assert.deepEqual(corner, cropped(picture, 0, 0, 10, 5), 'the view stays inside the picture');
  const far = show(picture, { turns: 0, mirror: false, zoom: 400, cx: 1000, cy: 1000 });
  assert.deepEqual(far, cropped(picture, 30, 15, 10, 5));

  assert.deepEqual(V.rect(40, 20, { turns: 1, zoom: 200, cx: 500, cy: 500 }), { x: 5, y: 10, width: 10, height: 20, fullWidth: 20, fullHeight: 40 });
  const tiny = show(noisePicture(3, 2), V.zoomTo(V.identity(), 800));
  assert.deepEqual([tiny.width, tiny.height], [1, 1], 'never less than a pixel');
});

test('turning or flipping a zoomed view keeps looking at the same part', () => {
  const picture = noisePicture(48, 32);
  const view = { turns: 0, mirror: false, zoom: 400, cx: 250, cy: 750 };   // 12 × 8 px at (6, 20)
  const part = show(picture, view);
  assert.deepEqual(part, cropped(picture, 6, 20, 12, 8));
  assert.deepEqual(show(picture, V.rotate(view, true)), turnedClockwise(part));
  assert.deepEqual(show(picture, V.rotate(V.rotate(view, true), true)), turnedClockwise(turnedClockwise(part)));
  assert.deepEqual(show(picture, V.flip(view, true)), mirrored(part, true));
  assert.deepEqual(show(picture, V.flip(view, false)), mirrored(part, false));
  assert.deepEqual(show(picture, V.flip(V.rotate(view, false), false)), mirrored(turnedClockwise(turnedClockwise(turnedClockwise(part))), false));
});

test('zoom steps up and down a fixed ladder; dragging moves by a share of what is visible', () => {
  let view = V.identity();
  const ladder = [];
  for (let i = 0; i < 10; i++) { view = V.zoomStep(view, 1); ladder.push(view.zoom); }
  assert.deepEqual(ladder.slice(0, 6), [150, 200, 300, 400, 600, 800]);
  assert.equal(view.zoom, 800);
  assert.equal(V.zoomStep(V.zoomTo(V.identity(), 250), -1).zoom, 200);
  assert.equal(V.zoomStep(V.identity(), -1).zoom, 100);

  const zoomed = V.zoomTo(V.identity(), 400);
  assert.deepEqual([V.pan(zoomed, 1, 0).cx, V.pan(zoomed, 0, -1).cy], [750, 250], 'one screen to the right is a quarter of the picture at 4×');
  assert.equal(V.pan(zoomed, 99, 0).cx, 875, 'and no further than the edge: the middle of the last screenful');
  assert.equal(V.pan(V.pan(zoomed, 99, 0), -0.4, 0).cx, 775, 'so a drag back moves at once');
});

test('a view survives being written into the page address', () => {
  assert.equal(V.encode(V.identity()), '');
  assert.equal(V.encode({ turns: 1 }), '1');
  assert.equal(V.encode({ turns: 3, mirror: true }), '3m');
  assert.equal(V.encode({ turns: 0, zoom: 200, cx: 250, cy: 500 }), '0@200,250,500');
  for (const view of [{ turns: 2, mirror: true, zoom: 600, cx: 112, cy: 887 }, { turns: 1, mirror: false, zoom: 100, cx: 500, cy: 500 }, { turns: 0, mirror: true, zoom: 150, cx: 400, cy: 600 }]) {
    assert.deepEqual(V.decode(V.encode(view)), V.sanitize(view));
  }
  for (const junk of ['', 'x', '9', '1@', '1@200', '2m@a,b,c', null, undefined, '1m@200,5,5,5']) assert.deepEqual(V.decode(junk), V.identity(), String(junk));
  assert.deepEqual(V.decode('1@99999,5000,0'), { turns: 1, mirror: false, zoom: 800, cx: 937, cy: 63 }, 'values out of range are pulled in');
  assert.deepEqual(V.sanitize({ turns: -1, zoom: 'abc', cx: NaN }), { turns: 3, mirror: false, zoom: 100, cx: 500, cy: 500 });
});

test('a view is put into words for the line above the picture', () => {
  assert.equal(V.describe(V.identity()), '');
  assert.equal(V.describe({ turns: 3, mirror: true, zoom: 150 }), 'turned 270°, mirrored, 1.5× zoom');
});

test('one-pixel-wide and one-pixel-high pictures turn and flip too', () => {
  for (const [w, h] of [[1, 1], [1, 6], [6, 1]]) {
    const picture = noisePicture(w, h);
    let shown = picture, view = V.identity();
    for (let i = 0; i < 4; i++) {
      view = V.rotate(view, true);
      shown = turnedClockwise(shown);
      assert.deepEqual(show(picture, view), shown);
      assert.deepEqual(show(picture, V.flip(view, false)), mirrored(shown, false));
    }
  }
});
