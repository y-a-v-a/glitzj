'use strict';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION  = 4000;

const DEFAULTS = {
  dither: 'floyd-steinberg',
  strength: 100,
  serpentine: true,
  seed: 1,
  palette: 'adaptive',
  colors: 16,
  dark: '#000000',
  light: '#ffffff',
  dot: 1,
  brightness: 0,
  contrast: 0,
  full: true,
};

const RANGES = {
  strength:   [0, 100],
  seed:       [0, 2 ** 31 - 1],
  colors:     [2, 256],
  dot:        [1, 16],
  brightness: [-100, 100],
  contrast:   [-100, 100],
};

const DIFFUSION = new Set(Object.keys(DITHER_KERNELS));

const state = {
  settings: { ...DEFAULTS },
  source: null,
  fileName: '',
  beforeUrl: null,
  result: null,
  afterUrl: null,
  renderQueued: false,
  loadGen: 0,
};

const $ = id => document.getElementById(id);

const els = {
  panels:      $('panels'),
  dropZone:    $('drop-zone'),
  dropHint:    $('drop-hint'),
  fileInput:   $('file-input'),
  imgBefore:   $('img-before'),
  imgAfter:    $('img-after'),
  afterSurface: $('after-surface'),
  placeholder: $('after-placeholder'),
  beforeMeta:  $('before-meta'),
  afterMeta:   $('after-meta'),
  error:       $('error'),
  zoom:        $('zoom'),
  exportFull:  $('export-full'),
  btnExport:   $('btn-export'),
  btnReset:    $('btn-reset'),
  btnRandom:   $('btn-randomise'),
  seedGroup:   $('seed-group'),
  serpentine:  $('serpentine'),
  serpentineToggle: $('serpentine-toggle'),
  colorsGroup: $('colors-group'),
  duotoneGroup: $('duotone-group'),
};

const inputs = {
  dither:     $('dither'),
  strength:   $('strength'),
  serpentine: $('serpentine'),
  seed:       $('seed'),
  palette:    $('palette'),
  colors:     $('colors'),
  dark:       $('dark'),
  light:      $('light'),
  dot:        $('dot'),
  brightness: $('brightness'),
  contrast:   $('contrast'),
  full:       $('export-full'),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(n) {
  return n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function hideError() {
  els.error.hidden = true;
  els.error.textContent = '';
}

function clampSetting(key, value) {
  const [lo, hi] = RANGES[key];
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULTS[key];
}

function sanitize(raw) {
  const s = { ...DEFAULTS };
  if (DITHER_METHODS.includes(raw.dither)) s.dither = raw.dither;
  if (PALETTE_KINDS.includes(raw.palette)) s.palette = raw.palette;
  for (const key of Object.keys(RANGES)) if (raw[key] !== undefined && raw[key] !== '') s[key] = clampSetting(key, raw[key]);
  for (const key of ['dark', 'light']) if (/^#[0-9a-f]{6}$/i.test(raw[key] || '')) s[key] = raw[key].toLowerCase();
  for (const key of ['serpentine', 'full']) if (raw[key] !== undefined) s[key] = raw[key] === true || raw[key] === '1';
  return s;
}

// ── Settings ⇄ URL hash ───────────────────────────────────────────────────────

function writeHash() {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(state.settings)) {
    if (value === DEFAULTS[key]) continue;
    p.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
  const hash = p.toString();
  try {
    history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
  } catch {}
}

function readHash() {
  return sanitize(Object.fromEntries(new URLSearchParams(location.hash.slice(1))));
}

// ── Controls ──────────────────────────────────────────────────────────────────

function syncControls() {
  const s = state.settings;
  for (const [key, el] of Object.entries(inputs)) {
    if (el.type === 'checkbox') el.checked = s[key];
    else el.value = s[key];
    if (el.type === 'range') el.style.setProperty('--fill', `${(el.value - el.min) / (el.max - el.min) * 100}%`);
    const out = $(`${key}-value`);
    if (out) out.textContent = key === 'dot' ? `${s[key]}×` : s[key];
  }

  for (const btn of document.querySelectorAll('[data-for]')) {
    const [lo, hi] = RANGES[btn.dataset.for];
    const value = s[btn.dataset.for];
    btn.disabled = Number(btn.dataset.step) < 0 ? value <= lo : value >= hi;
  }

  const diffusion = DIFFUSION.has(s.dither);
  els.serpentine.disabled = !diffusion;
  els.serpentineToggle.hidden = s.dither === 'none';
  els.seedGroup.hidden = s.dither !== 'noise';
  $('strength-group').hidden = s.dither === 'none';
  els.colorsGroup.hidden = s.palette === 'websafe' || s.palette === 'rgb';
  els.duotoneGroup.hidden = s.palette !== 'duotone';
  document.querySelector('label[for="colors"]').textContent = s.palette === 'adaptive' ? 'Colors' : 'Levels';
}

function update(changes) {
  state.settings = sanitize({ ...state.settings, ...changes });
  syncControls();
  writeHash();
  scheduleRender();
}

for (const [key, el] of Object.entries(inputs)) {
  const event = el.type === 'range' || el.type === 'color' ? 'input' : 'change';
  el.addEventListener(event, () => update({ [key]: el.type === 'checkbox' ? el.checked : el.value }));
}

for (const btn of document.querySelectorAll('[data-for]')) {
  btn.addEventListener('click', () => {
    const key = btn.dataset.for;
    update({ [key]: state.settings[key] + Number(btn.dataset.step) });
  });
}

els.btnRandom.addEventListener('click', randomSeed);
els.btnReset.addEventListener('click', () => update({ ...DEFAULTS }));
els.btnExport.addEventListener('click', exportGif);
els.zoom.addEventListener('change', applyZoom);

function randomSeed() {
  update({ seed: Math.floor(Math.random() * 1_000_000) });
}

document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, select, textarea')) return;
  const key = e.key.toLowerCase();
  if (key === 'e' && state.result) { e.preventDefault(); exportGif(); }
  if (key === 'r' && state.settings.dither === 'noise') { e.preventDefault(); randomSeed(); }
  if (key === 'z') { e.preventDefault(); els.zoom.checked = !els.zoom.checked; applyZoom(); }
});

window.addEventListener('hashchange', () => {
  state.settings = readHash();
  syncControls();
  scheduleRender();
});

// ── File input ────────────────────────────────────────────────────────────────

els.dropZone.addEventListener('click', () => els.fileInput.click());

els.dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    els.fileInput.click();
  }
});

els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files[0]) loadFile(els.fileInput.files[0]);
  els.fileInput.value = '';
});

window.addEventListener('dragover', e => {
  e.preventDefault();
  els.dropZone.classList.add('drag-over');
});

window.addEventListener('dragleave', e => {
  if (e.relatedTarget === null) els.dropZone.classList.remove('drag-over');
});

window.addEventListener('drop', e => {
  e.preventDefault();
  els.dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

document.addEventListener('paste', e => {
  const item = Array.from(e.clipboardData?.items || []).find(it => it.kind === 'file');
  const file = item?.getAsFile();
  if (!file) return;
  e.preventDefault();
  loadFile(file);
});

function loadFile(file) {
  hideError();
  const gen = ++state.loadGen;

  if (file.size > MAX_FILE_BYTES) {
    return showError(`File too large (${formatBytes(file.size)}). Maximum is 10 MB.`);
  }

  const url = URL.createObjectURL(file);
  const img = new Image();

  img.onload = () => {
    if (gen !== state.loadGen) return URL.revokeObjectURL(url);
    const { naturalWidth: width, naturalHeight: height } = img;
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      URL.revokeObjectURL(url);
      return showError(`Image too large (${width}×${height}px). Maximum is ${MAX_DIMENSION}×${MAX_DIMENSION}px.`);
    }
    if (!width || !height) {
      URL.revokeObjectURL(url);
      return showError('This image has no size the browser can draw.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);

    if (state.beforeUrl) URL.revokeObjectURL(state.beforeUrl);
    state.beforeUrl = url;
    state.source = { rgba: ctx.getImageData(0, 0, width, height).data, width, height };
    state.fileName = file.name || 'image';

    els.imgBefore.src = url;
    els.imgBefore.hidden = false;
    els.dropHint.hidden = true;
    els.panels.style.setProperty('--ar', width / height);
    els.beforeMeta.textContent = `${width}×${height} · ${formatBytes(file.size)}${file.type === 'image/gif' ? ' · first frame' : ''}`;

    scheduleRender();
  };

  img.onerror = () => {
    URL.revokeObjectURL(url);
    if (gen === state.loadGen) showError('Could not decode the image. Is it an image file your browser can show?');
  };

  img.src = url;
}

// ── Render ────────────────────────────────────────────────────────────────────

function scheduleRender() {
  if (!state.source || state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    render();
  });
}

function render() {
  const { rgba, width, height } = state.source;
  let result;
  try {
    result = renderDither(rgba, width, height, state.settings);
  } catch (err) {
    return showError(`Could not render the GIF: ${err.message}`);
  }

  const url = URL.createObjectURL(new Blob([result.bytes], { type: 'image/gif' }));
  const previous = state.afterUrl;
  state.afterUrl = url;
  els.imgAfter.src = url;
  if (previous) URL.revokeObjectURL(previous);
  els.imgAfter.hidden = false;
  els.placeholder.hidden = true;
  els.btnExport.disabled = false;
  state.result = result;

  const parts = [`${result.width}×${result.height} dots`, `${result.colors} colors`];
  if (result.transparent) parts.push('+ transparent');
  parts.push(formatBytes(result.bytes.length));
  els.afterMeta.textContent = parts.join(' · ');
  els.afterMeta.title = result.dot > 1
    ? `Each dot covers ${result.dot}×${result.dot} pixels of the original. Exported at original size: ${width}×${height} px`
    : '';
  applyZoom();
}

function applyZoom() {
  const on = els.zoom.checked && state.result;
  els.afterSurface.classList.toggle('panel__surface--zoom', Boolean(on));
  els.imgAfter.style.width = on ? `${state.result.width * state.result.dot}px` : '';
}

// ── Export ────────────────────────────────────────────────────────────────────

function exportName() {
  const s = state.settings;
  const base = state.fileName.replace(/\.[^.]+$/, '') || 'image';
  const palette = s.palette === 'adaptive' || s.palette === 'grayscale' || s.palette === 'duotone' ? `${s.palette}${s.colors}` : s.palette;
  const seed = s.dither === 'noise' ? `_seed${s.seed}` : '';
  return `${base}_${s.dither}_${palette}_dot${s.dot}${seed}.gif`;
}

function exportGif() {
  const { result } = state;
  if (!result) return;
  const bytes = state.settings.full && result.dot > 1 ? result.encode(result.dot) : result.bytes;
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = exportName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ── Start ─────────────────────────────────────────────────────────────────────

state.settings = readHash();
syncControls();
