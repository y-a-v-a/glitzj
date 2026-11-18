'use strict';

// ── Split ─────────────────────────────────────────────────────────────────────
//
// A color picture is several pictures stacked on top of each other: three
// lights on a screen, four inks on paper, one brightness and two color signals
// on a video cable. Each stack only looks like one picture while its layers
// stay exactly on top of each other. Split takes the layers apart, moves each
// one on its own and stacks them again:
//
//   pixels → planes of one color model → move every plane → stack → pixels
//
// Every plane can be shifted, and the planes can be zoomed and turned against
// each other and torn sideways in bands. Planes are sampled without smoothing,
// so a pixel stays a pixel however far it travels.

const SPLIT_MODELS = {
  rgb:  { planes: ['R', 'G', 'B'], blank: [0, 0, 0] },
  cmyk: { planes: ['C', 'M', 'Y', 'K'], blank: [0, 0, 0, 0] },
  ycc:  { planes: ['Y', 'Cb', 'Cr'], blank: [0, 128, 128] },
};

const SPLIT_EDGES = ['wrap', 'smear', 'blank'];
const SPLIT_WIRINGS = ['straight', 'next', 'previous', 'mirror'];

const SPLIT_MAX_ZOOM = 0.25;             // scale difference at zoom ±100
const SPLIT_MAX_TWIST = Math.PI / 12;    // angle difference at twist ±100
const SPLIT_MAX_TEAR = 0.25;             // of the width, at tear 100

function splitPlanes(rgba, width, height, model) {
  const n = width * height;
  const count = SPLIT_MODELS[model].planes.length;
  const planes = Array.from({ length: count }, () => new Uint8Array(n));

  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (model === 'rgb') {
      planes[0][p] = r;
      planes[1][p] = g;
      planes[2][p] = b;
    } else if (model === 'cmyk') {
      const k = 255 - Math.max(r, g, b);
      const rest = 255 - k;
      planes[0][p] = rest ? Math.round((rest - r) * 255 / rest) : 0;
      planes[1][p] = rest ? Math.round((rest - g) * 255 / rest) : 0;
      planes[2][p] = rest ? Math.round((rest - b) * 255 / rest) : 0;
      planes[3][p] = k;
    } else {
      planes[0][p] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      planes[1][p] = Math.max(0, Math.min(255, Math.round(-0.168736 * r - 0.331264 * g + 0.5 * b + 128)));
      planes[2][p] = Math.max(0, Math.min(255, Math.round(0.5 * r - 0.418688 * g - 0.081312 * b + 128)));
    }
  }
  return planes;
}

function stackPlanes(planes, model, out, from, to) {
  for (let p = from, i = from * 4; p < to; p++, i += 4) {
    if (model === 'rgb') {
      out[i] = planes[0][p];
      out[i + 1] = planes[1][p];
      out[i + 2] = planes[2][p];
    } else if (model === 'cmyk') {
      const paper = 255 - planes[3][p];
      out[i] = (255 - planes[0][p]) * paper / 255 + 0.5;
      out[i + 1] = (255 - planes[1][p]) * paper / 255 + 0.5;
      out[i + 2] = (255 - planes[2][p]) * paper / 255 + 0.5;
    } else {
      const y = planes[0][p], cb = planes[1][p] - 128, cr = planes[2][p] - 128;
      out[i] = y + 1.402 * cr + 0.5;
      out[i + 1] = y - 0.344136 * cb - 0.714136 * cr + 0.5;
      out[i + 2] = y + 1.772 * cb + 0.5;
    }
  }
}

// Where each plane sits relative to the middle one, from -1 to 1: the first
// and last plane move furthest, in opposite directions.
function splitSpread(index, count) {
  return count < 2 ? 0 : (index / (count - 1)) * 2 - 1;
}

function splitWiring(wiring, count) {
  return Array.from({ length: count }, (_, i) => {
    if (wiring === 'next') return (i + 1) % count;
    if (wiring === 'previous') return (i + count - 1) % count;
    if (wiring === 'mirror') return count - 1 - i;
    return i;
  });
}

// Sideways displacement for every row of every plane. The rows are cut into
// bands, the same bands for all planes; about half of them tear, each plane by
// its own amount.
function tearOffsets(width, height, count, { tear, band, seed }) {
  const amp = (tear / 100) * SPLIT_MAX_TEAR * width;
  if (!(amp > 0)) return null;
  const random = prng(seed);
  const rows = Array.from({ length: count }, () => new Int32Array(height));
  const mean = Math.max(1, (band / 100) ** 2 * height * 0.5);

  for (let y = 0; y < height;) {
    const size = Math.max(1, Math.round(mean * (0.25 + random() * 1.5)));
    const torn = random() < 0.5;
    const push = random() * 2 - 1;
    for (let p = 0; p < count; p++) {
      const own = random() * 2 - 1;
      const dx = torn ? Math.round(amp * (0.5 * push + 0.5 * own)) : 0;
      rows[p].fill(dx, y, Math.min(height, y + size));
    }
    y += size;
  }
  return rows;
}

function movePlaneRows(src, dst, width, height, from, to, move) {
  const { dx, dy, scale, angle, edge, blank, tear } = move;
  const cx = (width - 1) / 2, cy = (height - 1) / 2;
  const cos = Math.cos(angle) / scale, sin = Math.sin(angle) / scale;
  const straight = scale === 1 && angle === 0;

  for (let y = from; y < to; y++) {
    const shift = dx + (tear ? tear[y] : 0);
    const row = y * width;

    if (straight) {
      let sy = y - dy;
      if (sy < 0 || sy >= height) {
        if (edge === 'blank') { dst.fill(blank, row, row + width); continue; }
        sy = edge === 'wrap' ? ((sy % height) + height) % height : Math.max(0, Math.min(height - 1, sy));
      }
      const srow = sy * width;
      if (edge === 'wrap') {
        const s = ((shift % width) + width) % width;
        dst.set(src.subarray(srow, srow + width - s), row + s);
        dst.set(src.subarray(srow + width - s, srow + width), row);
      } else {
        const lo = Math.max(0, shift), hi = Math.min(width, width + shift);
        if (hi > lo) dst.set(src.subarray(srow + lo - shift, srow + hi - shift), row + lo);
        const left = edge === 'blank' ? blank : src[srow];
        const right = edge === 'blank' ? blank : src[srow + width - 1];
        if (lo > 0) dst.fill(left, row, row + Math.min(lo, width));
        if (hi < width) dst.fill(right, row + Math.max(hi, 0), row + width);
      }
      continue;
    }

    // The source position of the output pixel (x, y): undo the shift, then
    // the turn and the zoom around the center of the picture.
    const v = y - dy - cy;
    let sx = (-shift - cx) * cos + v * sin + cx + 0.5;
    let sy = -(-shift - cx) * sin + v * cos + cy + 0.5;
    for (let x = 0; x < width; x++, sx += cos, sy -= sin) {
      let ix = Math.floor(sx), iy = Math.floor(sy);
      if (ix < 0 || ix >= width || iy < 0 || iy >= height) {
        if (edge === 'blank') { dst[row + x] = blank; continue; }
        if (edge === 'wrap') {
          ix = ((ix % width) + width) % width;
          iy = ((iy % height) + height) % height;
        } else {
          ix = ix < 0 ? 0 : ix >= width ? width - 1 : ix;
          iy = iy < 0 ? 0 : iy >= height ? height - 1 : iy;
        }
      }
      dst[row + x] = src[iy * width + ix];
    }
  }
}

const SPLIT_DEFAULTS = {
  model: 'rgb',
  offsets: [0, 0, 0, 0, 0, 0, 0, 0],
  zoom: 0,
  twist: 0,
  tear: 0,
  band: 30,
  seed: 1,
  edge: 'wrap',
  wiring: 'straight',
};

function* splitSteps(source, settings) {
  const s = { ...SPLIT_DEFAULTS, ...settings };
  const { width, height } = source;
  const model = SPLIT_MODELS[s.model] ? s.model : 'rgb';
  const { planes: names, blank } = SPLIT_MODELS[model];
  const count = names.length;

  const cache = source.cache || (source.cache = {});
  if (!cache.split || cache.split.model !== model) {
    cache.split = { model, planes: splitPlanes(source.rgba, width, height, model) };
    yield 0;
  }
  const planes = cache.split.planes;
  if (!cache.splitMoved || cache.splitMoved.length !== count || cache.splitMoved[0].length !== width * height) {
    cache.splitMoved = planes.map(() => new Uint8Array(width * height));
  }
  const moved = cache.splitMoved;

  const tear = tearOffsets(width, height, count, s);
  const wiring = splitWiring(s.wiring, count);
  const moves = names.map((_, p) => {
    const spread = splitSpread(p, count);
    return {
      dx: s.offsets[p * 2] || 0,
      dy: s.offsets[p * 2 + 1] || 0,
      scale: 1 + spread * (s.zoom / 100) * SPLIT_MAX_ZOOM,
      angle: spread * (s.twist / 100) * SPLIT_MAX_TWIST,
      edge: s.edge,
      blank: blank[p],
      tear: tear ? tear[p] : null,
    };
  });

  const out = new Uint8ClampedArray(width * height * 4);
  const chunk = Math.max(8, Math.floor(400_000 / width));
  for (let y = 0; y < height; y += chunk) {
    const to = Math.min(height, y + chunk);
    for (let p = 0; p < count; p++) movePlaneRows(planes[wiring[p]], moved[p], width, height, y, to, moves[p]);
    stackPlanes(moved, model, out, y * width, to * width);
    yield to / height;
  }
  for (let i = 3; i < out.length; i += 4) out[i] = source.rgba[i];

  return { rgba: out, width, height };
}
