'use strict';

// ── Mosh ──────────────────────────────────────────────────────────────────────
//
// Video is not stored as pictures. A codec stores a full picture now and then,
// a keyframe, and for the frames in between only instructions: cut the previous
// frame into blocks, take each block from where it was a moment ago (a motion
// vector), and add a small correction on top. Datamoshing removes the
// keyframes, so the instructions meant for one picture are carried out on
// another, again and again, and nothing ever comes along to put it right.
//
// A still picture has no frames in between, so this makes one. It moves the
// picture a little (a zoom, a pan, a turn) or takes a second picture, and then
// does what a video encoder does:
//
//   picture → the frame that would come next → cut into blocks, search for
//   where each block came from (motion vectors) → what the vectors cannot
//   explain (the correction) → carry out those instructions on the picture,
//   then on the result, then on that result …
//
// The search is a real one, and it makes the mistakes real encoders make: in a
// flat sky every position matches equally well, so the vectors there point
// anywhere. Those mistakes are what the smears grow from.

const MOSH_MOTIONS = ['zoom', 'pan', 'spin', 'fall', 'scatter', 'donor'];
const MOSH_BLOCKS = ['8', '16', '32'];
const MOSH_SIZES = ['640', '1280', 'source'];

function moshSize(width, height, size) {
  const limit = size === 'source' ? 4000 : Number(size) || 1280;
  const scale = Math.min(1, limit / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function moshLuma(rgba, count) {
  const out = new Uint8Array(count);
  for (let p = 0, i = 0; p < count; p++, i += 4) out[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  return out;
}

// The frame that would come next if the camera moved: the picture zoomed,
// shifted or turned a little, edges repeated.
function moshNextFrame(rgba, width, height, motion, strength, direction) {
  const out = new Uint8ClampedArray(rgba.length);
  const cx = (width - 1) / 2, cy = (height - 1) / 2;
  const amount = strength / 100;
  let scale = 1, angle = 0, dx = 0, dy = 0;
  if (motion === 'zoom') scale = 1 + amount * 0.08;
  if (motion === 'spin') angle = amount * Math.PI / 30;
  if (motion === 'pan') {
    const reach = amount * Math.max(width, height) * 0.03;
    dx = Math.cos(direction * Math.PI / 180) * reach;
    dy = Math.sin(direction * Math.PI / 180) * reach;
  }
  const cos = Math.cos(angle) / scale, sin = Math.sin(angle) / scale;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x - cx - dx, v = y - cy - dy;
      let sx = Math.round(u * cos + v * sin + cx), sy = Math.round(-u * sin + v * cos + cy);
      sx = sx < 0 ? 0 : sx >= width ? width - 1 : sx;
      sy = sy < 0 ? 0 : sy >= height ? height - 1 : sy;
      const s = (sy * width + sx) * 4, o = (y * width + x) * 4;
      out[o] = rgba[s]; out[o + 1] = rgba[s + 1]; out[o + 2] = rgba[s + 2]; out[o + 3] = 255;
    }
  }
  return out;
}

// For every block of the next frame, where in the previous frame it seems to
// have come from: a logarithmic search (steps of half a block, then half of
// that, down to one pixel) for the smallest sum of absolute differences in
// brightness, as fast encoders do. Ties keep the vector found first.
function moshSearch(prevLuma, nextLuma, width, height, block) {
  const cols = Math.ceil(width / block), rows = Math.ceil(height / block);
  const vx = new Int16Array(cols * rows), vy = new Int16Array(cols * rows);

  const cost = (bx, by, ox, oy, best) => {
    let sum = 0;
    const x1 = Math.min(width, bx + block), y1 = Math.min(height, by + block);
    for (let y = by; y < y1; y++) {
      let sy = y + oy;
      sy = sy < 0 ? 0 : sy >= height ? height - 1 : sy;
      const row = y * width, srow = sy * width;
      for (let x = bx; x < x1; x++) {
        let sx = x + ox;
        sx = sx < 0 ? 0 : sx >= width ? width - 1 : sx;
        const d = nextLuma[row + x] - prevLuma[srow + sx];
        sum += d < 0 ? -d : d;
      }
      if (sum >= best) return sum;
    }
    return sum;
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const bx = c * block, by = r * block;
      let ox = 0, oy = 0, best = cost(bx, by, 0, 0, Infinity);
      for (let step = block >> 1; step >= 1 && best > 0; step >>= 1) {
        let moved = true;
        while (moved) {
          moved = false;
          let tx = ox, ty = oy;
          for (let k = 0; k < 8; k++) {
            const nx = ox + [-1, 0, 1, -1, 1, -1, 0, 1][k] * step, ny = oy + [-1, -1, -1, 0, 0, 1, 1, 1][k] * step;
            if (Math.abs(nx) > block * 2 || Math.abs(ny) > block * 2) continue;
            const v = cost(bx, by, nx, ny, best);
            if (v < best) { best = v; tx = nx; ty = ny; moved = true; }
          }
          ox = tx; oy = ty;
        }
      }
      vx[r * cols + c] = ox;
      vy[r * cols + c] = oy;
    }
  }
  return { vx, vy, cols, rows };
}

// Vectors that no search found. Fall: the brighter a block, the further up it
// takes its pixels from, so bright things run down the picture (turned by the
// direction). Scatter: every block takes its pixels from somewhere nearby.
function moshInvent(luma, width, height, block, motion, strength, direction, seed) {
  const cols = Math.ceil(width / block), rows = Math.ceil(height / block);
  const vx = new Int16Array(cols * rows), vy = new Int16Array(cols * rows);
  const reach = (strength / 100) * block * 1.5;
  const random = prng(seed);
  const ax = Math.cos(direction * Math.PI / 180), ay = Math.sin(direction * Math.PI / 180);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (motion === 'scatter') {
        vx[i] = Math.round((random() * 2 - 1) * reach);
        vy[i] = Math.round((random() * 2 - 1) * reach);
        continue;
      }
      let sum = 0, count = 0;
      const x1 = Math.min(width, (c + 1) * block), y1 = Math.min(height, (r + 1) * block);
      for (let y = r * block; y < y1; y++) for (let x = c * block; x < x1; x++) { sum += luma[y * width + x]; count++; }
      const pull = (sum / count / 255) * reach;
      vx[i] = Math.round(-ax * pull);
      vy[i] = Math.round(-ay * pull);
    }
  }
  return { vx, vy, cols, rows };
}

// Carries the instructions out once: every block is filled from where its
// vector points in the frame before, plus a share of the correction.
function moshStep(prev, out, width, height, block, vectors, residual, share) {
  const { vx, vy, cols } = vectors;
  for (let y = 0; y < height; y++) {
    const r = Math.floor(y / block);
    for (let x = 0; x < width; x++) {
      const i = r * cols + Math.floor(x / block);
      let sx = x + vx[i], sy = y + vy[i];
      sx = sx < 0 ? 0 : sx >= width ? width - 1 : sx;
      sy = sy < 0 ? 0 : sy >= height ? height - 1 : sy;
      const s = (sy * width + sx) * 4, o = (y * width + x) * 4;
      if (residual) {
        const k = (y * width + x) * 3;
        out[o] = prev[s] + residual[k] * share;
        out[o + 1] = prev[s + 1] + residual[k + 1] * share;
        out[o + 2] = prev[s + 2] + residual[k + 2] * share;
      } else {
        out[o] = prev[s]; out[o + 1] = prev[s + 1]; out[o + 2] = prev[s + 2];
      }
      out[o + 3] = 255;
    }
  }
}

const MOSH_DEFAULTS = {
  motion: 'zoom',
  strength: 40,
  direction: 90,
  block: '16',
  frames: 24,
  correction: 0,
  size: '1280',
  seed: 1,
};

// `donor` is a second picture, { rgba, width, height }, for the donor motion:
// the next frame is then that picture instead of a moved copy of this one.
function* moshSteps(source, settings, donor = null) {
  const s = { ...MOSH_DEFAULTS, ...settings };
  const cache = source.cache || (source.cache = {});
  const block = Number(s.block) || 16;
  const motion = s.motion === 'donor' && !donor ? 'zoom' : s.motion;

  if (!cache.flat) cache.flat = flattenOnWhite(source.rgba);
  if (!cache.moshFirst || cache.moshFirst.size !== s.size) {
    const { width, height } = moshSize(source.width, source.height, s.size);
    const first = resizePixels(cache.flat, source.width, source.height, width, height);
    cache.moshFirst = { size: s.size, width, height, first, luma: moshLuma(first, width * height) };
    cache.moshPlan = cache.moshRun = null;
    yield 0;
  }
  const { width, height, first, luma } = cache.moshFirst;

  // The instructions: vectors and the correction that goes with them.
  const planKey = [motion, s.strength, s.direction, block, motion === 'scatter' ? s.seed : 0, motion === 'donor' ? donor.id : 0].join('/');
  if (!cache.moshPlan || cache.moshPlan.key !== planKey) {
    let vectors, residual = null;
    if (motion === 'fall' || motion === 'scatter') {
      vectors = moshInvent(luma, width, height, block, motion, s.strength, s.direction, s.seed);
    } else {
      const next = motion === 'donor'
        ? resizePixels(flattenOnWhite(donor.rgba), donor.width, donor.height, width, height)
        : moshNextFrame(first, width, height, motion, s.strength, s.direction);
      yield 0.05;
      vectors = moshSearch(luma, moshLuma(next, width * height), width, height, block);
      yield 0.15;
      // What the vectors leave unexplained: the next frame minus the previous
      // frame moved by them.
      const moved = new Uint8ClampedArray(first.length);
      moshStep(first, moved, width, height, block, vectors, null, 0);
      residual = new Int16Array(width * height * 3);
      for (let p = 0, i = 0, k = 0; p < width * height; p++, i += 4, k += 3) {
        residual[k] = next[i] - moved[i];
        residual[k + 1] = next[i + 1] - moved[i + 1];
        residual[k + 2] = next[i + 2] - moved[i + 2];
      }
    }
    cache.moshPlan = { key: planKey, vectors, residual };
    cache.moshRun = null;
    yield 0.2;
  }
  const { vectors, residual } = cache.moshPlan;
  const share = s.correction / 100;
  const useResidual = share > 0 && residual ? residual : null;

  // Carry them out, frame after frame, picking up where the last render of
  // the same instructions stopped if this one asks for more frames.
  const runKey = `${planKey}/${s.correction}`;
  let run = cache.moshRun;
  if (!run || run.key !== runKey || run.count > s.frames) {
    run = cache.moshRun = { key: runKey, count: 0, frame: Uint8ClampedArray.from(first), spare: new Uint8ClampedArray(first.length) };
  }
  while (run.count < s.frames) {
    moshStep(run.frame, run.spare, width, height, block, vectors, useResidual, share);
    [run.frame, run.spare] = [run.spare, run.frame];
    run.count++;
    yield 0.2 + 0.8 * run.count / s.frames;
  }

  return { rgba: Uint8ClampedArray.from(run.frame), width, height, vectors };
}
