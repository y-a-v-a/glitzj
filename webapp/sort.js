'use strict';

// ── Sort, interrupted ─────────────────────────────────────────────────────────
//
// Pixel sorting puts the pixels of every row (or column) in order of
// brightness, which turns a photo into streaks. A finished sort looks the same
// whichever algorithm did the work. A sort that is stopped halfway does not:
// every algorithm leaves its own kind of mess behind. Bubble sort drags bright
// pixels along like wet paint, merge sort leaves a comb of small gradients,
// shell sort weaves several half-sorted pictures into each other, heap sort
// lays the pixels out as the tree it is building, and a radix sort that has
// only seen the low bits has neatly ordered the noise.
//
// So this runs real sorting algorithms on the pixels and pulls the plug:
//
//   pixels → lines → spans to sort → keys → run the algorithm part of the
//   way → pixels
//
// Every algorithm works on one Float64Array per line in which each entry packs
// a pixel's key and its position, key * 4096 + position, so that comparing two
// entries compares their keys, equal keys keep their order, and the position
// says which pixel to copy when the algorithm is done.

const SORT_POS = 4096;                    // positions per line; images are at most 4000 px
const SORT_KEY_BITS = 10;                 // scalar keys run from 0 to 1023
const SORT_ALGORITHMS = ['bubble', 'insertion', 'selection', 'quick', 'merge', 'shell', 'heap', 'radix', 'bogo'];
const SORT_KEYS = ['brightness', 'hue', 'saturation', 'red', 'green', 'blue', 'number'];
const SORT_SPANS = ['threshold', 'chunks', 'all'];
const SORT_DIRECTIONS = ['right', 'left', 'down', 'up'];

const SORT_KEY_FNS = {
  brightness: (r, g, b) => (r * 306 + g * 601 + b * 117) >> 8,
  red:        r => r << 2,
  green:      (r, g) => g << 2,
  blue:       (r, g, b) => b << 2,
  hue(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return 0;
    let h;
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return Math.min(1023, Math.floor(h * 1024 / 6));
  },
  saturation(r, g, b) {
    const max = Math.max(r, g, b);
    return max === 0 ? 0 : Math.floor((max - Math.min(r, g, b)) * 1023 / max);
  },
  // The pixel as the one number it is stored as: 0xRRGGBB.
  number: (r, g, b) => (r << 16) | (g << 8) | b,
};

function sortKeyBits(key) {
  return key === 'number' ? 24 : SORT_KEY_BITS;
}

// ── The algorithms, each stopped at fraction t of its work ────────────────────
// All of them sort a[lo..hi) in ascending order and are complete at t = 1.

function sortFully(a, lo, hi) {
  a.subarray(lo, hi).sort();
}

// k passes of bubble sort. A pass carries the largest value seen so far to the
// right and lets everything else slip one place to the left, so after k passes
// each place holds the smallest value not yet placed among the first k + 1
// still waiting. A heap of k + 1 entries gives exactly that without running
// the passes one by one.
function sortBubble(a, lo, hi, t, scratch) {
  const n = hi - lo;
  const k = Math.round(t * t * (n - 1));
  if (k <= 0) return;
  if (k >= n - 1) return sortFully(a, lo, hi);

  const heap = scratch;
  let size = 0, w = lo;
  const push = v => {
    let i = size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent] <= v) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = v;
  };
  const pop = () => {
    const top = heap[0], last = heap[--size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= size) break;
      if (c + 1 < size && heap[c + 1] < heap[c]) c++;
      if (heap[c] >= last) break;
      heap[i] = heap[c];
      i = c;
    }
    heap[i] = last;
    return top;
  };

  for (let i = lo; i < hi; i++) {
    push(a[i]);
    if (size > k) a[w++] = pop();
  }
  while (size) a[w++] = pop();
}

// Insertion sort has sorted the first part and has not looked at the rest.
function sortInsertion(a, lo, hi, t) {
  sortFully(a, lo, lo + Math.round(t * (hi - lo)));
}

// Selection sort has found the smallest values and swapped each into place;
// whatever stood there was thrown to where the small value came from.
function sortSelection(a, lo, hi, t, scratch) {
  const n = hi - lo;
  const m = Math.round(t * n);
  if (m <= 0) return;
  if (m >= n) return sortFully(a, lo, hi);

  const sorted = scratch.subarray(0, n);
  sorted.set(a.subarray(lo, hi));
  sorted.sort();
  // Entries start out in position order, so an entry's position minus lo is
  // the place it started at.
  const where = new Int32Array(n);      // where the entry that started at i is now
  const origin = new Int32Array(n);     // which entry is at i now
  for (let i = 0; i < n; i++) where[i] = origin[i] = i;

  for (let i = 0; i < m; i++) {
    const want = sorted[i] % SORT_POS - lo;
    const j = where[want];
    if (j === i) continue;
    const other = origin[i];
    const tmp = a[lo + i];
    a[lo + i] = a[lo + j];
    a[lo + j] = tmp;
    origin[i] = want;
    origin[j] = other;
    where[want] = i;
    where[other] = j;
  }
}

// Quicksort stopped at a recursion depth: every part has been split around a
// pivot into smaller and larger, but the parts themselves are still a jumble.
function sortQuick(a, lo, hi, t) {
  const n = hi - lo;
  const maxDepth = Math.ceil(Math.log2(Math.max(2, n))) + 2;
  const depth = Math.round(t * maxDepth);
  if (depth <= 0) return;
  if (depth >= maxDepth) return sortFully(a, lo, hi);

  const stack = [lo, hi, 0];
  while (stack.length) {
    const d = stack.pop(), h = stack.pop(), l = stack.pop();
    if (h - l < 2 || d >= depth) continue;
    const pivot = a[(l + h) >> 1];
    let i = l, j = h - 1;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const tmp = a[i];
        a[i] = a[j];
        a[j] = tmp;
        i++;
        j--;
      }
    }
    stack.push(l, j + 1, d + 1, i, h, d + 1);
  }
}

// Bottom-up merge sort after a few rounds: sorted runs of 2, 4, 8, … pixels
// that have not been merged with their neighbors yet.
function sortMerge(a, lo, hi, t) {
  const n = hi - lo;
  const rounds = Math.ceil(Math.log2(Math.max(2, n)));
  const done = Math.round(t * rounds);
  if (done <= 0) return;
  if (done >= rounds) return sortFully(a, lo, hi);
  const run = 1 << done;
  for (let s = lo; s < hi; s += run) sortFully(a, s, Math.min(hi, s + run));
}

// Shell sort sorts every gap-th entry among themselves, for gaps that halve
// each round. Stopped early, the line is several sorted lines woven together.
function sortShell(a, lo, hi, t, scratch) {
  const n = hi - lo;
  const gaps = [];
  for (let g = n >> 1; g >= 1; g >>= 1) gaps.push(g);
  const done = Math.round(t * gaps.length);
  if (done <= 0) return;
  if (done >= gaps.length) return sortFully(a, lo, hi);

  for (let s = 0; s < done; s++) {
    const gap = gaps[s];
    for (let r = 0; r < gap; r++) {
      let count = 0;
      for (let i = lo + r; i < hi; i += gap) scratch[count++] = a[i];
      const strand = scratch.subarray(0, count);
      strand.sort();
      count = 0;
      for (let i = lo + r; i < hi; i += gap) a[i] = strand[count++];
    }
  }
}

// Heap sort first arranges the line as a heap, a tree stored row by row with
// every parent larger than its children, then moves the largest value to the
// end again and again. The first quarter of the slider builds the heap.
function sortHeap(a, lo, hi, t) {
  const n = hi - lo;
  if (t <= 0 || n < 2) return;
  if (t >= 1) return sortFully(a, lo, hi);

  const sift = (i, end) => {
    const v = a[lo + i];
    for (;;) {
      let c = 2 * i + 1;
      if (c >= end) break;
      if (c + 1 < end && a[lo + c + 1] > a[lo + c]) c++;
      if (a[lo + c] <= v) break;
      a[lo + i] = a[lo + c];
      i = c;
    }
    a[lo + i] = v;
  };

  const parents = n >> 1;
  const build = Math.min(parents, Math.ceil(Math.min(1, t / 0.25) * parents));
  for (let i = parents - 1; i >= parents - build; i--) sift(i, n);
  if (t <= 0.25) return;

  const taken = Math.round((t - 0.25) / 0.75 * (n - 1));
  for (let end = n - 1; end > n - 1 - taken; end--) {
    const tmp = a[lo];
    a[lo] = a[lo + end];
    a[lo + end] = tmp;
    sift(0, end);
  }
}

// A radix sort that starts with the lowest bit of the key. After b bits the
// line is in order of the last b bits only: the least meaningful part of every
// pixel, sorted with great care.
function sortRadix(a, lo, hi, t, scratch, keyBits) {
  const bits = Math.round(t * keyBits);
  if (bits <= 0) return;
  if (bits >= keyBits) return sortFully(a, lo, hi);
  const n = hi - lo;
  for (let bit = 0; bit < bits; bit++) {
    const div = SORT_POS * 2 ** bit;
    let zeros = 0, ones = 0;
    for (let i = lo; i < hi; i++) {
      const v = a[i];
      if (Math.floor(v / div) & 1) scratch[n + ones++] = v;
      else scratch[zeros++] = v;
    }
    a.set(scratch.subarray(0, zeros), lo);
    a.set(scratch.subarray(n, n + ones), lo + zeros);
  }
}

// Bogosort shuffles and hopes. At 100 it got lucky.
function sortBogo(a, lo, hi, t, scratch, keyBits, random) {
  const n = hi - lo;
  if (t >= 1) return sortFully(a, lo, hi);
  const swaps = Math.round(t * n);
  for (let s = 0; s < swaps; s++) {
    const i = lo + Math.floor(random() * n), j = lo + Math.floor(random() * n);
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
}

const SORT_FNS = {
  bubble: sortBubble,
  insertion: sortInsertion,
  selection: sortSelection,
  quick: sortQuick,
  merge: sortMerge,
  shell: sortShell,
  heap: sortHeap,
  radix: sortRadix,
  bogo: sortBogo,
};

// ── Pipeline ──────────────────────────────────────────────────────────────────

const SORT_DEFAULTS = {
  algorithm: 'bubble',
  progress: 50,
  jitter: 0,
  key: 'brightness',
  direction: 'right',
  span: 'threshold',
  low: 25,
  high: 80,
  size: 30,
  seed: 1,
};

function* sortSteps(source, settings) {
  const s = { ...SORT_DEFAULTS, ...settings };
  const { rgba, width, height } = source;
  const vertical = s.direction === 'down' || s.direction === 'up';
  const descending = s.direction === 'left' || s.direction === 'up';
  const lines = vertical ? width : height;
  const length = vertical ? height : width;
  const stride = vertical ? width : 1;

  const keyFn = SORT_KEY_FNS[s.key] || SORT_KEY_FNS.brightness;
  const keyBits = sortKeyBits(s.key);
  const keyMax = 2 ** keyBits - 1;
  const algorithm = SORT_FNS[s.algorithm] || sortBubble;
  const random = prng(s.seed);
  const lowCut = Math.min(s.low, s.high) * 2.55, highCut = Math.max(s.low, s.high) * 2.55;
  const meanChunk = Math.max(2, (s.size / 100) ** 2 * length);

  const src = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
  const out = new Uint8ClampedArray(rgba);
  const dst = new Uint32Array(out.buffer);
  const packed = new Float64Array(length);
  const scratch = new Float64Array(length * 2);
  const inSpan = new Uint8Array(length);
  let sorted = 0;

  for (let line = 0; line < lines; line++) {
    const base = vertical ? line : line * width;
    const lineRandom = random();
    const t = Math.max(0, Math.min(1, s.progress / 100 + (lineRandom * 2 - 1) * (s.jitter / 100) * 0.5));

    for (let i = 0; i < length; i++) {
      const o = (base + i * stride) * 4;
      const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      const key = keyFn(r, g, b);
      packed[i] = (descending ? keyMax - key : key) * SORT_POS + i;
      if (s.span === 'threshold') {
        const luma = (r * 306 + g * 601 + b * 117) >> 10;
        inSpan[i] = luma >= lowCut && luma <= highCut ? 1 : 0;
      }
    }

    const sortSpan = (lo, hi) => {
      if (hi - lo < 2) return;
      algorithm(packed, lo, hi, t, scratch, keyBits, random);
      for (let i = lo; i < hi; i++) dst[base + i * stride] = src[base + (packed[i] % SORT_POS) * stride];
      sorted += hi - lo;
    };

    if (s.span === 'all') {
      sortSpan(0, length);
    } else if (s.span === 'chunks') {
      for (let lo = 0; lo < length;) {
        const hi = Math.min(length, lo + Math.max(2, Math.round(meanChunk * (0.25 + random() * 1.5))));
        sortSpan(lo, hi);
        lo = hi;
      }
    } else {
      for (let i = 0; i < length;) {
        if (!inSpan[i]) { i++; continue; }
        let j = i + 1;
        while (j < length && inSpan[j]) j++;
        sortSpan(i, j);
        i = j;
      }
    }

    if ((line & 15) === 15) yield line / lines;
  }

  return { rgba: out, width, height, sorted };
}
