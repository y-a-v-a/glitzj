'use strict';

// ── Showcase ──────────────────────────────────────────────────────────────────
//
// Carries out the recipes of showcase-data.js on one photo, with the tools'
// own code, and shows the results. Nothing on the page is a stored picture:
// each one is made here, one at a time, as it comes near the screen.
//
// A recipe can be opened in its tool. The photo is then handed to that page the
// way the tool pages hand a picture to each other (handoff.js), with the
// settings in the address, so the tool shows the same result and you carry on
// from there.

const SLICE_MS = 12;
const MAX_SIDE = 1024;
const THUMB_WIDTH = 280;
const RETRIES = 20;
const PARROTS = 'showcase/parrots.jpg';

const STRATEGY_ORDER = [...new Set([...Object.keys(STRATEGY_FNS), ...Object.keys(PNG_STRATEGY_FNS), ...Object.keys(GIF_STRATEGY_FNS)])];
const MIME = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif' };
const EXT = { jpeg: 'jpg', png: 'png', gif: 'gif' };

// Goes up when another photo is opened; work that started for an older one
// stops as soon as it notices.
let generation = 0;
const STALE = Symbol('stale');

let source = null;      // the photo everything is made from, as a stage
let own = false;        // true when it is the visitor's own picture

const $ = id => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function formatBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

const pause = () => new Promise(resolve => setTimeout(resolve, 0));

function check(gen) {
  if (gen !== generation) throw STALE;
}

// Runs a tool's steps in slices, so the page stays alive while it works.
async function drive(steps, gen) {
  let start = performance.now();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (performance.now() - start > SLICE_MS) {
      await pause();
      check(gen);
      start = performance.now();
    }
  }
}

// ── Pictures ──────────────────────────────────────────────────────────────────

function blankCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function pixelsToCanvas(rgba, width, height) {
  const canvas = blankCanvas(width, height);
  const data = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
  canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
  return canvas;
}

// A file as this browser shows it. Fails when the browser cannot open it,
// which is how a glitch that went too far is noticed.
function fileToCanvas(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      if (!img.naturalWidth || !img.naturalHeight) return reject(new Error('no size'));
      const canvas = blankCanvas(img.naturalWidth, img.naturalHeight);
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('could not be opened'));
    };
    img.src = url;
  });
}

function sniff(b) {
  if (b[0] === 0xFF && b[1] === 0xD8) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b[0] === 0x47 && b[1] === 0x49) return 'gif';
  return null;
}

// A stage is a picture a tool can work on: its pixels, and the file it is when
// a tool wants bytes or when it is handed to a tool's page. A result that is
// only pixels becomes a PNG file the moment a file is asked for, which is what
// Feed back does on the tool pages.
function makeStage(canvas, name, blob = null) {
  const { width, height } = canvas;
  const stage = {
    canvas, width, height, name, blob,
    cache: {},
    pixels: null,
    bytesRead: null,
    get rgba() {
      if (!this.pixels) this.pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
      return this.pixels;
    },
    async file() {
      if (!this.blob) this.blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      return this.blob;
    },
    async bytes() {
      if (!this.bytesRead) this.bytesRead = new Uint8Array(await (await this.file()).arrayBuffer());
      return this.bytesRead;
    },
  };
  return stage;
}

// ── The tools ─────────────────────────────────────────────────────────────────
//
// Each maker carries out one recipe on a stage and returns the result as
// { canvas, blob, ext, note, settings }: `blob` is the file the tool made, or
// null for a tool that makes pixels; `settings` is the recipe as carried out.

async function fileResult(bytes, format, settings, note = '') {
  const blob = new Blob([bytes], { type: MIME[format] });
  const canvas = await fileToCanvas(blob);
  const size = `a real ${format.toUpperCase()} file, ${formatBytes(blob.size)}`;
  return { canvas, blob, ext: EXT[format], note: note ? `${size} · ${note}` : size, settings };
}

function pixelResult(result, settings) {
  const { rgba, width, height } = result;
  return { canvas: pixelsToCanvas(rgba, width, height), blob: null, ext: 'png', note: `${width} × ${height} pixels`, settings };
}

const PIXEL_STEPS = { split: splitSteps, sort: sortSteps, bend: bendSteps, misread: misreadSteps, signal: signalSteps, mosh: moshSteps };

const MAKERS = {
  // The Glitch page works on a file's bytes. A result that no viewer opens is
  // tried again with the next seed, as Auto-retry does there.
  async glitch(stage, settings, gen) {
    const s = { ...SHOWCASE_GLITCH_DEFAULTS, ...settings };
    const bytes = await stage.bytes();
    check(gen);
    const kind = sniff(bytes);
    if (!kind) throw new Error('not a JPEG, PNG or GIF');
    const format = kind === 'jpeg' && s.png ? 'png' : kind;
    const names = STRATEGY_ORDER.filter(n => s.fx.includes(n) && (n !== 'prism' || format !== 'jpeg'));
    const options = seed => ({ strategies: new Set(names), intensity: s.intensity, seed });
    const cache = stage.cache;

    let build;
    if (format === 'gif') {
      if (!cache.glitchGif) cache.glitchGif = loadGifSource(bytes);
      build = seed => glitchGif(cache.glitchGif, { ...options(seed), protect: true, steady: false }).bytes;
    } else if (format === 'png') {
      if (!cache.glitchPng) {
        cache.glitchPng = kind === 'png'
          ? await loadPngSource(bytes)
          : await pngSourceFromPixels(stage.width, stage.height, stage.rgba);
        check(gen);
      }
      const png = cache.glitchPng;
      build = seed => encodePng(png.png, glitchPng(png, { ...options(seed), filter: s.filter, protect: true, keepAlpha: true }));
    } else {
      if (!cache.glitchJpeg) cache.glitchJpeg = parseJpeg(bytes);
      build = seed => {
        const buf = new Uint8Array(bytes);
        runPipeline(buf, cache.glitchJpeg, options(seed).strategies, s.intensity, seed);
        protectMarkers(buf, cache.glitchJpeg);
        return buf;
      };
    }

    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      const seed = s.seed + attempt;
      try {
        return await fileResult(build(seed), format, { ...settings, seed });
      } catch (err) {
        check(gen);
        if (attempt === RETRIES) throw err;
      }
    }
  },

  async gif(stage, settings) {
    const s = { ...SHOWCASE_GIF_DEFAULTS, ...settings };
    const made = renderDither(stage.rgba, stage.width, stage.height, s);
    const bytes = s.full && made.dot > 1 ? made.encode(made.dot) : made.bytes;
    return fileResult(bytes, 'gif', settings, `${made.colors} colors`);
  },

  async crush(stage, settings, gen) {
    const made = await drive(crushSteps(stage.rgba, stage.width, stage.height, settings), gen);
    const bits = made.bytes.length * 8 / (made.width * made.height);
    return fileResult(made.bytes, 'jpeg', settings, `${bits.toFixed(2)} bits per pixel`);
  },

  async surgery(stage, settings, gen) {
    const made = await drive(surgerySteps(stage, settings), gen);
    return fileResult(made.bytes, 'jpeg', settings);
  },
};

async function make(tool, settings, stage, gen) {
  if (MAKERS[tool]) return MAKERS[tool](stage, settings, gen);
  return pixelResult(await drive(PIXEL_STEPS[tool](stage, settings), gen), settings);
}

// ── One at a time ─────────────────────────────────────────────────────────────

const queue = [];
let working = false;

function enqueue(job, first = false) {
  if (first) queue.unshift(job);
  else queue.push(job);
  work();
}

async function work() {
  if (working) return;
  working = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      await job();
    } catch (err) {
      if (err !== STALE) console.error(err);
    }
    await pause();
  }
  working = false;
}

// ── The strip at the top ──────────────────────────────────────────────────────
//
// One picture cut into ten strips, each taken from the result its tool shows
// below. Pointing at a strip shows that tool's whole result.

const hero = {
  canvas: $('hero-canvas'),
  strips: $('hero-strips'),
  results: [],
  shown: -1,

  build() {
    this.strips.replaceChildren(...SHOWCASE_EXHIBITS.map((exhibit, i) => {
      const { title } = SHOWCASE_TOOLS[exhibit.tool];
      const link = el('a', { class: 'hero__strip', href: `#${exhibit.tool}`, 'aria-label': `${title}: ${exhibit.line}` },
        el('span', { class: 'hero__number', text: String(i + 1).padStart(2, '0'), 'aria-hidden': 'true' }),
        el('span', { class: 'hero__name', text: title, 'aria-hidden': 'true' }));
      const show = () => { this.shown = i; this.draw(); };
      const hide = () => { if (this.shown === i) { this.shown = -1; this.draw(); } };
      link.addEventListener('pointerenter', show);
      link.addEventListener('pointerleave', hide);
      link.addEventListener('focus', show);
      link.addEventListener('blur', hide);
      return link;
    }));
  },

  reset() {
    this.results = [];
    this.shown = -1;
    this.canvas.width = source.width;
    this.canvas.height = source.height;
    this.draw();
  },

  set(index, canvas) {
    this.results[index] = canvas;
    this.strips.children[index].classList.add('is-made');
    this.draw();
  },

  draw() {
    if (!source) return;
    const { width, height } = this.canvas;
    const ctx = this.canvas.getContext('2d');
    const count = SHOWCASE_EXHIBITS.length;
    const whole = this.results[this.shown];
    if (whole) return ctx.drawImage(whole, 0, 0, width, height);
    for (let i = 0; i < count; i++) {
      const from = this.results[i] || source.canvas;
      const x0 = Math.round(i * width / count), x1 = Math.round((i + 1) * width / count);
      const scale = from.width / width;
      ctx.drawImage(from, x0 * scale, 0, (x1 - x0) * scale, from.height, x0, 0, x1 - x0, height);
    }
  },
};

// ── A piece ───────────────────────────────────────────────────────────────────
//
// One tool with its looks, or one chain with its steps. Both are a large
// picture, a row of small ones to choose from, and the words that go with the
// chosen one. Every item is made once for its small picture; only the chosen
// one (and, in a chain, every step, since the next step works on it) keeps its
// result at full size.

const pieces = [];
let near = null;

function createPiece({ id, index, total, title, line, how, items, chain, heroIndex = -1 }) {
  const canvas = el('canvas', { class: 'piece__canvas', role: 'img' });
  const status = el('span', { class: 'piece__state', text: 'making…' });
  const frame = el('div', { class: 'piece__frame', title: 'Hold to see the original' }, canvas, status);
  const looks = el('div', { class: 'piece__looks', role: 'group', 'aria-label': chain ? 'Steps' : 'Looks' });

  const lookName = el('h4', { class: 'piece__look-name' });
  const note = el('p', { class: 'piece__note' });
  const recipe = el('p', { class: 'piece__recipe' });
  const meta = el('p', { class: 'piece__meta' });
  const open = el('a', { class: 'btn btn--primary', href: '#' });
  const compare = el('button', { class: 'btn btn--secondary', type: 'button', 'aria-pressed': 'false', text: 'Show the original' });

  const section = el('section', { class: `piece${chain ? ' piece--chain' : ''}`, id },
    el('div', { class: 'piece__picture' }, frame, looks),
    el('div', { class: 'piece__text' },
      el('p', { class: 'piece__index' }, el('b', { text: String(index).padStart(2, '0') }), ` / ${String(total).padStart(2, '0')}`),
      el('h3', { class: 'piece__title', text: title }),
      el('p', { class: 'piece__line', text: line }),
      el('p', { class: 'piece__how', text: how }),
      el('div', { class: 'piece__look', 'aria-live': 'polite' }, lookName, note, recipe, meta),
      el('div', { class: 'piece__actions' }, open, compare)));

  const piece = { section, items, chosen: chain ? items.length - 1 : 0, wanted: false, original: false };

  items.forEach((item, i) => {
    item.thumb = el('canvas', { class: 'look__thumb', 'aria-hidden': 'true' });
    item.button = el('button', { class: 'look', type: 'button', 'aria-pressed': 'false', title: item.name },
      item.thumb,
      el('span', { class: 'look__name', text: chain ? `${i + 1}. ${SHOWCASE_TOOLS[item.tool].title}` : item.name }));
    item.button.addEventListener('click', () => choose(i));
    looks.append(item.button);
  });

  function forget() {
    for (const item of items) {
      item.result = null;
      item.made = false;
      item.failed = '';
      item.pending = null;
      item.carried = item.settings;
      item.button.classList.remove('is-made');
      const ctx = item.thumb.getContext('2d');
      item.thumb.width = THUMB_WIDTH;
      item.thumb.height = Math.max(1, Math.round(THUMB_WIDTH * source.height / source.width));
      ctx.drawImage(source.canvas, 0, 0, item.thumb.width, item.thumb.height);
    }
    piece.wanted = false;
  }

  // Makes an item, once: the stage it works on is the photo, or in a chain
  // what the step before it made (which is made first if it has not been yet).
  function produce(i, gen) {
    const item = items[i];
    if (item.pending) return item.pending;
    if (item.result) return Promise.resolve(item.result);
    const mine = (async () => {
      try {
        check(gen);
        const stage = !chain || i === 0 ? source : (await produce(i - 1, gen)).stage;
        check(gen);
        const result = await make(item.tool, item.settings, stage, gen);
        check(gen);
        const base = stage.name.replace(/\.[^.]+$/, '');
        result.stage = makeStage(result.canvas, `${base}_${item.tool}.${result.ext}`, result.blob);
        item.carried = result.settings;
        item.note = result.note;
        item.made = true;
        item.failed = '';
        const ctx = item.thumb.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(result.canvas, 0, 0, item.thumb.width, item.thumb.height);
        item.button.classList.add('is-made');
        if (chain || i === piece.chosen) item.result = result;
        return result;
      } catch (err) {
        if (err !== STALE) {
          item.failed = err.message || 'it could not be made';
          item.made = true;
        }
        throw err;
      } finally {
        if (item.pending === mine) {
          item.pending = null;
          if (i === piece.chosen && gen === generation) show();
        }
      }
    })();
    item.pending = mine;
    return mine;
  }

  function request(i, first = false) {
    const item = items[i];
    const done = () => item.result || (item.made && i !== piece.chosen);
    if (item.pending || done()) return;
    const gen = generation;
    enqueue(() => (done() ? null : produce(i, gen)), first);
  }

  function choose(i) {
    if (i === piece.chosen) return;
    if (!chain) items[piece.chosen].result = null;
    piece.chosen = i;
    show();
    request(i, true);
  }

  // Puts the chosen item on the page: its picture (or, until it is made at
  // full size, its small one), and its words.
  function show() {
    const item = items[piece.chosen];
    items.forEach((other, i) => other.button.setAttribute('aria-pressed', String(i === piece.chosen)));

    const picture = piece.original ? source.canvas : item.result ? item.result.canvas : item.thumb;
    canvas.width = picture.width;
    canvas.height = picture.height;
    canvas.getContext('2d').drawImage(picture, 0, 0);
    const toolTitle = SHOWCASE_TOOLS[item.tool].title;
    canvas.setAttribute('aria-label', piece.original ? 'The original photo' : `${toolTitle}: ${item.name}`);
    frame.classList.toggle('is-original', piece.original);
    frame.classList.toggle('is-waiting', !item.result && !item.failed);
    frame.classList.toggle('is-failed', Boolean(item.failed));
    status.textContent = item.failed ? `This one failed: ${item.failed}` : piece.original ? 'the original' : 'making…';
    fit();

    lookName.textContent = chain ? `Step ${piece.chosen + 1}: ${toolTitle}` : item.name;
    note.textContent = item.text;
    recipe.textContent = showcaseRecipe(item.tool, item.carried);
    meta.textContent = item.result ? item.note : '';
    open.textContent = chain ? `Open this step in ${toolTitle}` : `Open this in ${toolTitle}`;
    open.href = showcaseLink(item.tool, item.carried);

    if (heroIndex >= 0 && item.result) hero.set(heroIndex, item.result.canvas);
  }

  // Sharp pixels when the picture is shown at its own size or larger; smoothed
  // when it has to be shown smaller, where sharp pixels would flicker.
  function fit() {
    const shown = canvas.getBoundingClientRect().width * (window.devicePixelRatio || 1);
    canvas.classList.toggle('is-crisp', shown >= canvas.width);
  }

  function setOriginal(on) {
    if (piece.original === on) return;
    piece.original = on;
    compare.setAttribute('aria-pressed', String(on));
    show();
  }

  compare.addEventListener('click', () => setOriginal(!piece.original));
  frame.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.pointerType !== 'mouse') return;
    setOriginal(true);
    const release = () => {
      setOriginal(false);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  });
  frame.addEventListener('contextmenu', e => e.preventDefault());

  // Opening a recipe in its tool: the picture it works on goes along, the
  // settings are in the address.
  open.addEventListener('click', async e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const href = open.href;
    open.setAttribute('aria-busy', 'true');
    try {
      const i = piece.chosen;
      const stage = !chain || i === 0 ? source : (await produce(i - 1, generation)).stage;
      await Handoff.save(await stage.file(), stage.name, '');
    } catch {}
    location.href = href;
  });

  piece.reset = () => { forget(); show(); };
  piece.want = () => {
    if (piece.wanted) return;
    piece.wanted = true;
    items.forEach((_, i) => request(i));
  };
  piece.first = () => request(piece.chosen);
  piece.fit = fit;
  return piece;
}

// ── The page ──────────────────────────────────────────────────────────────────

function build() {
  hero.build();
  const total = SHOWCASE_EXHIBITS.length;

  SHOWCASE_EXHIBITS.forEach((exhibit, i) => {
    const piece = createPiece({
      id: exhibit.tool,
      index: i + 1,
      total,
      title: SHOWCASE_TOOLS[exhibit.tool].title,
      line: exhibit.line,
      how: exhibit.how,
      heroIndex: i,
      items: exhibit.looks.map(look => ({ tool: exhibit.tool, name: look.name, text: look.note, settings: look.settings })),
    });
    pieces.push(piece);
    $('exhibits').append(piece.section);
  });

  SHOWCASE_CHAINS.forEach((chain, i) => {
    const piece = createPiece({
      id: `chain-${i + 1}`,
      index: i + 1,
      total: SHOWCASE_CHAINS.length,
      title: chain.name,
      line: chain.steps.map(step => SHOWCASE_TOOLS[step.tool].title).join(' → '),
      how: chain.note,
      chain: true,
      items: chain.steps.map(step => ({ tool: step.tool, name: SHOWCASE_TOOLS[step.tool].title, text: 'The settings of this step:', settings: step.settings })),
    });
    pieces.push(piece);
    $('chains').append(piece.section);
  });

  // The small pictures of a piece are made when it comes near the screen.
  near = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting || !source) continue;
      const piece = pieces.find(p => p.section === entry.target);
      if (piece) piece.want();
    }
  }, { rootMargin: '600px 0px' });
  for (const piece of pieces) near.observe(piece.section);

  window.addEventListener('resize', () => pieces.forEach(piece => piece.fit()));
}

// Starts everything over on another photo.
function start(stage, mine) {
  generation++;
  queue.length = 0;
  source = stage;
  own = mine;
  document.body.classList.add('has-picture');
  document.body.classList.toggle('is-own', mine);
  document.querySelector('.showcase').style.setProperty('--ar', stage.width / stage.height);
  $('picture-name').textContent = mine ? stage.name : 'two parrots';
  hero.reset();
  for (const piece of pieces) piece.reset();
  // First the ten pictures the strip at the top is cut from, then whatever is
  // on screen.
  for (const piece of pieces.slice(0, SHOWCASE_EXHIBITS.length)) piece.first();
  for (const piece of pieces) {
    near.unobserve(piece.section);
    near.observe(piece.section);
  }
}

function notice(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

async function openParrots() {
  const gen = ++generation;
  notice('');
  try {
    const response = await fetch(PARROTS);
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    const canvas = await fileToCanvas(blob);
    if (gen !== generation) return;
    start(makeStage(canvas, 'parrots.jpg', blob), false);
  } catch {
    if (gen === generation) notice('The photo of the parrots could not be loaded. Open a picture of your own to see the page at work.');
  }
}

// A visitor's own picture is made small enough to keep the page quick, and
// saved as a JPEG, so that the Glitch page has a file to work on and every
// tool that is opened from here gets the picture this page used.
async function openOwn(file) {
  const gen = ++generation;
  notice('');
  try {
    const first = await fileToCanvas(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(first.width, first.height));
    const small = blankCanvas(Math.max(1, Math.round(first.width * scale)), Math.max(1, Math.round(first.height * scale)));
    const ctx = small.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, small.width, small.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(first, 0, 0, small.width, small.height);
    const blob = await new Promise(resolve => small.toBlob(resolve, 'image/jpeg', 0.92));
    const canvas = await fileToCanvas(blob);
    if (gen !== generation) return;
    const base = (file.name || 'picture').replace(/\.[^.]+$/, '') || 'picture';
    start(makeStage(canvas, `${base}.jpg`, blob), true);
  } catch {
    if (gen === generation) notice('That file could not be opened as a picture.');
  }
}

$('btn-own').addEventListener('click', () => $('file-input').click());
$('btn-parrots').addEventListener('click', openParrots);
$('file-input').addEventListener('change', () => {
  if ($('file-input').files[0]) openOwn($('file-input').files[0]);
  $('file-input').value = '';
});

window.addEventListener('dragover', e => {
  e.preventDefault();
  document.body.classList.add('is-dropping');
});
window.addEventListener('dragleave', e => {
  if (e.relatedTarget === null) document.body.classList.remove('is-dropping');
});
window.addEventListener('drop', e => {
  e.preventDefault();
  document.body.classList.remove('is-dropping');
  const file = e.dataTransfer.files[0];
  if (file) openOwn(file);
});
document.addEventListener('paste', e => {
  const item = Array.from(e.clipboardData?.items || []).find(it => it.kind === 'file');
  const file = item?.getAsFile();
  if (!file) return;
  e.preventDefault();
  openOwn(file);
});

build();
openParrots();
