'use strict';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION  = 4000;
const SLICE_MS = 12;

const DEFAULTS = { ...CRUSH_DEFAULTS };

const RANGES = {
  quality:     [0, 100],
  chroma:      [0, 100],
  generations: [1, 50],
  shift:       [0, 16],
};

const state = {
  settings: { ...DEFAULTS },
  source: null,
  fileName: '',
  fileSize: 0,
  fileNote: '',
  result: null,
  afterUrl: null,
  job: 0,
  loadGen: 0,
};

const $ = id => document.getElementById(id);

const els = {
  panels:       $('panels'),
  panelAfter:   $('panel-after'),
  dropZone:     $('drop-zone'),
  dropHint:     $('drop-hint'),
  fileInput:    $('file-input'),
  imgBefore:    $('img-before'),
  imgAfter:     $('img-after'),
  afterSurface: $('after-surface'),
  placeholder:  $('after-placeholder'),
  beforeMeta:   $('before-meta'),
  afterMeta:    $('after-meta'),
  error:        $('error'),
  zoom:         $('zoom'),
  btnExport:    $('btn-export'),
  btnReuse:    $('btn-reuse'),
  btnReset:     $('btn-reset'),
  chromaGroup:  $('chroma-group'),
};

const inputs = {
  quality:     $('quality'),
  split:       $('split'),
  chroma:      $('chroma'),
  subsampling: $('subsampling'),
  generations: $('generations'),
  shift:       $('shift'),
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

function sanitize(raw) {
  const s = { ...DEFAULTS };
  for (const [key, [lo, hi]] of Object.entries(RANGES)) {
    if (raw[key] === undefined || raw[key] === '') continue;
    const n = Math.round(Number(raw[key]));
    if (Number.isFinite(n)) s[key] = Math.min(hi, Math.max(lo, n));
  }
  if (Object.hasOwn(SUBSAMPLING, raw.subsampling)) s.subsampling = raw.subsampling;
  if (raw.split !== undefined) s.split = raw.split === true || raw.split === '1';
  return s;
}

// ── Settings ⇄ URL hash ───────────────────────────────────────────────────────

const HASH_KEYS = { quality: 'q', split: 'split', chroma: 'cq', subsampling: 'sub', generations: 'gen', shift: 'shift' };

function writeHash() {
  const p = new URLSearchParams();
  for (const [key, short] of Object.entries(HASH_KEYS)) {
    const value = state.settings[key];
    if (value === DEFAULTS[key]) continue;
    p.set(short, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
  if (picture.param()) p.set('src', picture.param());
  const hash = p.toString().replace(/%2C/g, ',').replace(/%40/g, '@');
  try {
    history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
  } catch {}
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const raw = {};
  for (const [key, short] of Object.entries(HASH_KEYS)) if (p.has(short)) raw[key] = p.get(short);
  return sanitize(raw);
}

// ── Controls ──────────────────────────────────────────────────────────────────

function syncControls() {
  const s = state.settings;
  for (const [key, el] of Object.entries(inputs)) {
    if (el.type === 'checkbox') el.checked = s[key];
    else el.value = s[key];
    if (el.type === 'range') el.style.setProperty('--fill', `${(el.value - el.min) / (el.max - el.min) * 100}%`);
    const out = $(`${key}-value`);
    if (out) out.textContent = key === 'shift' ? `${s[key]} px` : s[key];
  }

  for (const btn of document.querySelectorAll('[data-for]')) {
    const [lo, hi] = RANGES[btn.dataset.for];
    const value = s[btn.dataset.for];
    btn.disabled = Number(btn.dataset.step) < 0 ? value <= lo : value >= hi;
  }

  els.chromaGroup.hidden = !s.split;
  inputs.shift.disabled = s.generations === 1;
  document.querySelector('label[for="quality"]').textContent = s.split ? 'Detail quality' : 'Quality';
}

function update(changes) {
  state.settings = sanitize({ ...state.settings, ...changes });
  syncControls();
  writeHash();
  scheduleRender();
}

for (const [key, el] of Object.entries(inputs)) {
  const event = el.type === 'range' ? 'input' : 'change';
  el.addEventListener(event, () => update({ [key]: el.type === 'checkbox' ? el.checked : el.value }));
}

for (const btn of document.querySelectorAll('[data-for]')) {
  btn.addEventListener('click', () => {
    const key = btn.dataset.for;
    update({ [key]: state.settings[key] + Number(btn.dataset.step) });
  });
}

els.btnReset.addEventListener('click', () => update({ ...DEFAULTS }));
els.zoom.addEventListener('change', applyZoom);
els.btnReuse.addEventListener('click', reuseResult);

document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, select, textarea')) return;
  const key = e.key.toLowerCase();
  if (key === 'e' && state.result) { e.preventDefault(); exporter.export(); }
  if (key === '0') { e.preventDefault(); update({ quality: 0 }); }
  if (key === 'z') { e.preventDefault(); els.zoom.checked = !els.zoom.checked; applyZoom(); }
});

const hashView = () => new URLSearchParams(location.hash.slice(1)).get('src');

window.addEventListener('hashchange', () => {
  state.settings = readHash();
  picture.fromParam(hashView());
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

// `own` marks an image the app made itself (a result fed back in, or the image
// carried over from another page), which may be larger than a file may be.
// `restored` is the carried-over image: it arrives without anyone asking, so
// it fails silently and is not stored again.
function loadFile(file, { own = false, restored = false } = {}) {
  if (!restored) hideError();
  const gen = ++state.loadGen;
  const fail = restored ? () => {} : showError;

  if (!own && file.size > MAX_FILE_BYTES) {
    return fail(`File too large (${formatBytes(file.size)}). Maximum is 10 MB.`);
  }

  const url = URL.createObjectURL(file);
  const img = new Image();

  img.onload = () => {
    if (gen !== state.loadGen) return URL.revokeObjectURL(url);
    const { naturalWidth: width, naturalHeight: height } = img;
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      URL.revokeObjectURL(url);
      return fail(`Image too large (${width}×${height}px). Maximum is ${MAX_DIMENSION}×${MAX_DIMENSION}px.`);
    }
    if (!width || !height) {
      URL.revokeObjectURL(url);
      return fail('This image has no size the browser can draw.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);

    URL.revokeObjectURL(url);
    state.fileName = file.name || 'image';
    state.fileSize = file.size;
    state.fileNote = file.type === 'image/gif' ? ' · first frame' : '';
    els.dropHint.hidden = true;
    picture.open(file, state.fileName, { rgba: ctx.getImageData(0, 0, width, height).data, width, height }, { view: file.sourceView, keep: !restored });
  };

  img.onerror = () => {
    URL.revokeObjectURL(url);
    if (gen === state.loadGen) fail('Could not decode the image. Is it an image file your browser can show?');
  };

  img.src = url;
}

// The picture as it is turned, mirrored and zoomed on the Before panel
// (source.js). Whatever it shows is what gets rendered.
const picture = SourceView.manage({
  surface: els.dropZone,
  canvas: els.imgBefore,
  changed(shown, view) {
    const { width, height } = shown;
    state.source = shown;
    els.panels.style.setProperty('--ar', width / height);
    const how = SourceView.describe(view);
    els.beforeMeta.textContent = `${width}×${height} · ${formatBytes(state.fileSize)}${state.fileNote}${how ? ` · ${how}` : ''}`;
    writeHash();
    scheduleRender();
  },
});

// ── Render ────────────────────────────────────────────────────────────────────

function scheduleRender() {
  if (!state.source) return;
  const job = ++state.job;
  requestAnimationFrame(() => {
    if (job === state.job) runJob(job);
  });
}

function runJob(job) {
  const { rgba, width, height } = state.source;
  const settings = { ...state.settings };
  const steps = crushSteps(rgba, width, height, settings);

  const slice = () => {
    if (job !== state.job) return;
    const start = performance.now();
    try {
      for (;;) {
        const step = steps.next();
        if (step.done) return show(step.value, settings);
        if (performance.now() - start > SLICE_MS) {
          setBusy(step.value);
          return setTimeout(slice, 0);
        }
      }
    } catch (err) {
      setBusy(null);
      showError(`Could not compress the image: ${err.message}`);
    }
  };
  slice();
}

function setBusy(progress) {
  els.panelAfter.classList.toggle('is-busy', Boolean(progress));
  if (!progress) return;
  els.afterMeta.textContent = progress.generations > 1
    ? `crushing… generation ${progress.generation} of ${progress.generations}`
    : 'crushing…';
}

function show(result, settings) {
  setBusy(null);
  const url = URL.createObjectURL(new Blob([result.bytes], { type: 'image/jpeg' }));
  const previous = state.afterUrl;
  state.afterUrl = url;
  els.imgAfter.src = url;
  if (previous) URL.revokeObjectURL(previous);
  els.imgAfter.hidden = false;
  els.placeholder.hidden = true;
  els.btnExport.disabled = false;
  els.btnReuse.disabled = false;
  state.result = { ...result, name: exportName(settings) };

  const bpp = result.bytes.length * 8 / (result.width * result.height);
  const parts = [formatBytes(result.bytes.length), `${bpp.toFixed(2)} bits per pixel`];
  if (state.fileSize) parts.push(`${Math.round(result.bytes.length / state.fileSize * 100)}% of the original`);
  els.afterMeta.textContent = parts.join(' · ');
  const steps = table => {
    const lo = Math.min(...table), hi = Math.max(...table);
    return lo === hi ? `${lo}` : `${lo}–${hi}`;
  };
  els.afterMeta.title = `Quantization steps: detail ${steps(result.quant[0])}, color ${steps(result.quant[1])} (255 is the most a baseline JPEG allows)`;
  applyZoom();
  exporter.sync();
}

function applyZoom() {
  const on = els.zoom.checked && state.result;
  els.afterSurface.classList.toggle('panel__surface--zoom', Boolean(on));
  els.imgAfter.style.width = on ? `${state.result.width}px` : '';
}

// ── Export ────────────────────────────────────────────────────────────────────

function exportName(s) {
  const base = state.fileName.replace(/\.[^.]+$/, '') || 'image';
  const parts = [base, 'crush', `q${s.quality}`];
  if (s.split) parts.push(`cq${s.chroma}`);
  parts.push(s.subsampling);
  if (s.generations > 1) parts.push(`gen${s.generations}`, `shift${s.shift}`);
  return `${parts.join('_')}.jpg`;
}

// The Export button and its options (export.js).
const exporter = Exporter.create({
  button: els.btnExport,
  result() {
    const { result } = state;
    if (!result) return null;
    return {
      name: result.name,
      width: result.width,
      height: result.height,
      ext: 'jpg',
      file: async () => new Blob([result.bytes], { type: 'image/jpeg' }),
    };
  },
});

function reuseResult() {
  const { result } = state;
  if (!result) return;
  loadFile(new File([result.bytes], result.name, { type: 'image/jpeg' }), { own: true });
}

// ── Start ─────────────────────────────────────────────────────────────────────

state.settings = readHash();
picture.fromParam(hashView());
syncControls();
Handoff.load().then(file => {
  if (file && !state.source && !state.loadGen) loadFile(file, { own: true, restored: true });
});
