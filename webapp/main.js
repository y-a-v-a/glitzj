// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES    = 10 * 1024 * 1024; // 10 MB
const MAX_DIMENSION     = 4000;             // px
const MAX_PNG_RAW_BYTES = 64 * 1024 * 1024; // 64 MB, a 4000×4000 RGBA image
const MAX_RETRIES       = 20;
const DEFAULT_INTENSITY = 50;
const DEFAULT_SEED      = 1;
const DEFAULT_FILTER    = 'keep';
const PNG_PACK_DELAY_MS = 400;
const PNG_PACK_MAX_RAW  = 16 * 1024 * 1024; // larger results are packed on click
const STRATEGY_ORDER    = [...Object.keys(STRATEGY_FNS), ...Object.keys(PNG_STRATEGY_FNS)];
const PNG_FILTERS       = ['keep', ...PNG_FILTER_TYPES];

const FORMATS = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg', strategies: Object.keys(STRATEGY_FNS) },
  png:  { mime: 'image/png',  ext: 'png', strategies: STRATEGY_ORDER },
};

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  format: null,
  originalBytes: null,
  scanInfo: null,
  pngSource: null,
  fileName: null,
  beforeUrl: null,
  after: null,
  packed: null,
  exporting: false,
  activeStrategies: new Set(),
  intensity: DEFAULT_INTENSITY,
  seed: DEFAULT_SEED,
  pngFilter: DEFAULT_FILTER,
  autoRetry: false,
  protect: true,
  keepAlpha: true,
  asPng: false,
};

// Incremented on every settings change; async decode results carrying an
// older generation are discarded so a slow probe can never overwrite a newer one.
let renderGen = 0;
let applyScheduled = false;

// Incremented on every file load; PNG loading is asynchronous, so a slow file
// must not replace one that was opened after it.
let loadGen = 0;
let packTimer = 0;

const els = {
  panels:           document.querySelector('.panels'),
  dropZone:         document.getElementById('drop-zone'),
  dropHint:         document.getElementById('drop-hint'),
  fileInput:        document.getElementById('file-input'),
  imgBefore:        document.getElementById('img-before'),
  imgAfter:         document.getElementById('img-after'),
  beforeMeta:       document.getElementById('before-meta'),
  afterMeta:        document.getElementById('after-meta'),
  afterPlaceholder: document.getElementById('after-placeholder'),
  afterBroken:      document.getElementById('after-broken'),
  error:            document.getElementById('error'),
  intensity:        document.getElementById('intensity'),
  intensityValue:   document.getElementById('intensity-value'),
  seed:             document.getElementById('seed'),
  pngFilter:        document.getElementById('png-filter'),
  pngFilterGroup:   document.getElementById('png-filter-group'),
  btnRandomise:     document.getElementById('btn-randomise'),
  btnReset:         document.getElementById('btn-reset'),
  btnExport:        document.getElementById('btn-export'),
  autoRetry:        document.getElementById('auto-retry'),
  protect:          document.getElementById('protect-markers'),
  protectToggle:    document.getElementById('protect-toggle'),
  protectLabel:     document.getElementById('protect-label'),
  keepAlpha:        document.getElementById('keep-alpha'),
  keepAlphaToggle:  document.getElementById('keep-alpha-toggle'),
  asPng:            document.getElementById('as-png'),
  asPngToggle:      document.getElementById('as-png-toggle'),
  strategyBtns:     document.querySelectorAll('.btn--strategy'),
};

// ── File input ───────────────────────────────────────────────────────────────

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

// Files may be dropped anywhere on the page; the drop zone only provides the
// visual affordance. Cancelling dragover/drop at window level also stops the
// browser from navigating to a file dropped outside the zone.
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
  const items = Array.from(e.clipboardData?.items || []);
  const item  = items.find(it => it.kind === 'file');
  const file  = item?.getAsFile();
  if (!file) return;
  e.preventDefault();
  loadFile(file);
});

function sniffImageType(b) {
  if (b[0] === 0xFF && b[1] === 0xD8) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'heic';
  if (b[0] === 0x3C || (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF)) return 'svg';
  return null;
}

// A JPEG keeps its scan data even when glitched as PNG, so switching back is
// instant; the PNG source is only built while that mode is on.
async function decodeSource(kind, bytes, img) {
  if (kind === 'jpeg') {
    const scanInfo  = parseJpeg(bytes);
    const pngSource = state.asPng ? await convertJpegToPng(img) : null;
    return { scanInfo, pngSource };
  }

  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress PNG data. Try a recent Chrome, Firefox or Safari.');
  }
  const pngSource = await loadPngSource(bytes, { maxRawBytes: MAX_PNG_RAW_BYTES });
  return { pngSource };
}

function loadFile(file) {
  hideError();
  const gen = ++loadGen;

  if (file.size > MAX_FILE_BYTES) {
    return showError(`File too large (${formatBytes(file.size)}). Maximum is 10 MB.`);
  }

  const reader = new FileReader();

  reader.onload = e => {
    if (gen !== loadGen) return;

    const bytes = new Uint8Array(e.target.result);
    const kind  = sniffImageType(bytes);

    if (!FORMATS[kind]) {
      return showError(kind
        ? `${kind.toUpperCase()} is not supported. Only JPEG and PNG files can be glitched.`
        : 'Only JPEG and PNG files are supported.');
    }

    const blobUrl = URL.createObjectURL(file);
    const img     = new Image();

    img.onload = async () => {
      if (gen !== loadGen) {
        URL.revokeObjectURL(blobUrl);
        return;
      }
      if (img.naturalWidth > MAX_DIMENSION || img.naturalHeight > MAX_DIMENSION) {
        URL.revokeObjectURL(blobUrl);
        return showError(
          `Image too large (${img.naturalWidth}×${img.naturalHeight}px). Maximum is ${MAX_DIMENSION}×${MAX_DIMENSION}px.`
        );
      }

      let decoded;
      try {
        decoded = await decodeSource(kind, bytes, img);
      } catch (err) {
        URL.revokeObjectURL(blobUrl);
        if (gen === loadGen) showError(err.message);
        return;
      }
      if (gen !== loadGen) {
        URL.revokeObjectURL(blobUrl);
        return;
      }

      if (state.beforeUrl) URL.revokeObjectURL(state.beforeUrl);
      state.beforeUrl     = blobUrl;
      state.format        = kind;
      state.originalBytes = bytes;
      state.scanInfo      = decoded.scanInfo || null;
      state.pngSource     = decoded.pngSource || null;
      state.fileName      = file.name || `image.${FORMATS[kind].ext}`;

      els.imgBefore.src    = blobUrl;
      els.imgBefore.hidden = false;
      els.dropHint.hidden  = true;
      els.beforeMeta.textContent = describeImage(img, file);

      syncFormatUi();
      applyStrategies();
    };

    img.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      if (gen === loadGen) showError(`Could not decode the image. Is it a valid ${kind.toUpperCase()}?`);
    };

    img.src = blobUrl;
  };

  reader.onerror = () => {
    if (gen === loadGen) showError('Could not read the file.');
  };
  reader.readAsArrayBuffer(file);
}

// Draws the JPEG as the browser shows it (orientation applied, colors in the
// canvas color space) and turns the pixels into a PNG source. Returns null if
// another file is opened before it finishes.
async function convertJpegToPng(img) {
  const gen = loadGen;
  await img.decode();
  const width  = img.naturalWidth;
  const height = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width  = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height);
  return pngSourceFromPixels(width, height, data, () => gen !== loadGen);
}

function formatBytes(n) {
  return n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function describeImage(img, file) {
  const parts = [`${img.naturalWidth}×${img.naturalHeight}`, formatBytes(file.size)];

  if (state.format === 'png') {
    const { png } = state.pngSource;
    parts.push(`PNG ${png.colorName} ${png.bitDepth}-bit`);
    if (png.interlaced) parts.push('interlaced');
    if (png.animated) parts.push('first frame only');
  } else {
    const { frameType, scanCount } = state.scanInfo;
    parts.push(frameType, scanCount === 1 ? '1 scan' : `${scanCount} scans`);
  }

  return parts.join(' · ');
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function hideError() {
  els.error.hidden = true;
  els.error.textContent = '';
}

// ── Format-specific controls ──────────────────────────────────────────────────
// Strategies a format cannot use are hidden but stay selected, so switching
// back to a PNG restores them. Tooltips describe what each control does to the
// loaded format.

els.strategyBtns.forEach(btn => { btn.dataset.titleJpeg = btn.title; });
els.protectToggle.dataset.titleJpeg = els.protectToggle.title;

// The format the pipeline produces: the file's own, except that a JPEG can be
// glitched as PNG. Null while its pixels are still being converted.
function outputFormat() {
  if (state.format === 'jpeg' && state.asPng) return state.pngSource ? 'png' : null;
  return state.format;
}

function isPngMode() {
  return state.format === 'png' || (state.format === 'jpeg' && state.asPng);
}

function isAvailable(name) {
  return FORMATS[outputFormat() || 'png'].strategies.includes(name);
}

function effectiveStrategies() {
  return new Set(STRATEGY_ORDER.filter(n => state.activeStrategies.has(n) && isAvailable(n)));
}

function syncFormatUi() {
  const png = isPngMode();
  const titleKey = png ? 'titlePng' : 'titleJpeg';

  els.strategyBtns.forEach(btn => {
    btn.hidden = btn.dataset.format === 'png' && !png;
    btn.title  = btn.dataset[titleKey] || btn.dataset.titleJpeg;
  });

  els.panels.classList.toggle('panels--png', png);
  els.pngFilterGroup.hidden    = !png;
  els.keepAlphaToggle.hidden   = !(png && state.pngSource && hasAlphaChannel(state.pngSource.png));
  els.asPngToggle.hidden       = state.format !== 'jpeg';
  els.protectLabel.textContent = png ? 'Protect filters' : 'Protect markers';
  els.protectToggle.title      = els.protectToggle.dataset[titleKey];
}

// ── Settings ⇄ URL hash ───────────────────────────────────────────────────────
// Settings are mirrored into the hash so a result can be reproduced by sharing
// the link together with the source image.

function writeHash() {
  const p = new URLSearchParams();
  const fx = STRATEGY_ORDER.filter(n => state.activeStrategies.has(n));
  if (fx.length) p.set('fx', fx.join(','));
  if (state.intensity !== DEFAULT_INTENSITY) p.set('i', String(state.intensity));
  if (state.seed !== DEFAULT_SEED) p.set('s', String(state.seed));
  if (state.pngFilter !== DEFAULT_FILTER) p.set('f', state.pngFilter);
  if (!state.protect) p.set('raw', '1');
  if (!state.keepAlpha) p.set('alpha', '0');
  if (state.asPng) p.set('png', '1');
  const hash = p.toString();
  try {
    history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
  } catch {
    // history API unavailable (e.g. sandboxed frame) — the hash is a convenience only.
  }
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));

  const fx = (p.get('fx') || '').split(',').filter(n => STRATEGY_ORDER.includes(n));
  state.activeStrategies = new Set(fx);

  const i = Number(p.get('i'));
  if (p.has('i') && Number.isFinite(i)) state.intensity = Math.min(100, Math.max(0, Math.round(i)));

  const s = Number(p.get('s'));
  if (p.has('s') && Number.isFinite(s)) state.seed = Math.max(0, Math.floor(s));

  const f = p.get('f');
  state.pngFilter = PNG_FILTERS.includes(f) ? f : DEFAULT_FILTER;

  state.protect   = p.get('raw') !== '1';
  state.keepAlpha = p.get('alpha') !== '0';
  state.asPng     = p.get('png') === '1';
}

function syncControls() {
  els.intensity.value            = state.intensity;
  els.intensityValue.textContent = state.intensity;
  els.seed.value                 = state.seed;
  els.pngFilter.value            = state.pngFilter;
  els.protect.checked            = state.protect;
  els.keepAlpha.checked          = state.keepAlpha;
  els.asPng.checked              = state.asPng;
  els.autoRetry.checked          = state.autoRetry;
  els.strategyBtns.forEach(btn => {
    const on = state.activeStrategies.has(btn.dataset.strategy);
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
}

// ── Intensity ────────────────────────────────────────────────────────────────

els.intensity.addEventListener('input', () => {
  state.intensity = Number(els.intensity.value);
  els.intensityValue.textContent = state.intensity;
  scheduleApply();
});

// ── Seed ─────────────────────────────────────────────────────────────────────

els.seed.addEventListener('input', () => {
  const n = Math.floor(Number(els.seed.value));
  state.seed = Number.isFinite(n) && n >= 0 ? n : 0;
  scheduleApply();
});

function randomiseSeed() {
  state.seed = Math.floor(Math.random() * 1_000_000);
  els.seed.value = state.seed;
  scheduleApply();
}

els.btnRandomise.addEventListener('click', randomiseSeed);

// ── PNG filter ────────────────────────────────────────────────────────────────

els.pngFilter.addEventListener('change', () => {
  state.pngFilter = els.pngFilter.value;
  scheduleApply();
});

// ── Strategy toggles ─────────────────────────────────────────────────────────

els.strategyBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.strategy;
    if (state.activeStrategies.has(name)) {
      state.activeStrategies.delete(name);
    } else {
      state.activeStrategies.add(name);
    }
    const on = state.activeStrategies.has(name);
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
    scheduleApply();
  });
});

// ── Reset ─────────────────────────────────────────────────────────────────────

els.btnReset.addEventListener('click', () => {
  state.activeStrategies.clear();
  state.intensity = DEFAULT_INTENSITY;
  state.seed      = DEFAULT_SEED;
  state.pngFilter = DEFAULT_FILTER;
  syncControls();
  applyStrategies();
});

// ── Toggles ───────────────────────────────────────────────────────────────────

els.autoRetry.addEventListener('change', () => {
  state.autoRetry = els.autoRetry.checked;
  if (state.autoRetry && !els.afterBroken.hidden) scheduleApply();
});

els.protect.addEventListener('change', () => {
  state.protect = els.protect.checked;
  scheduleApply();
});

els.keepAlpha.addEventListener('change', () => {
  state.keepAlpha = els.keepAlpha.checked;
  scheduleApply();
});

els.asPng.addEventListener('change', async () => {
  state.asPng = els.asPng.checked;
  syncFormatUi();
  applyStrategies();
  if (!state.asPng || state.format !== 'jpeg' || state.pngSource) return;

  const gen = loadGen;
  let source = null;
  try {
    source = await convertJpegToPng(els.imgBefore);
  } catch (err) {
    if (gen === loadGen) showError(`Could not convert the JPEG: ${err.message}`);
  }
  if (gen !== loadGen || !source) return;
  state.pngSource = source;
  syncFormatUi();
  applyStrategies();
});

// ── Export ────────────────────────────────────────────────────────────────────

// Called when an output is built, with the seed it was built with, so the
// name always describes the result it travels with.
function exportName(seed) {
  const png    = outputFormat() === 'png';
  const base   = (state.fileName || 'image').replace(/\.[^.]+$/, '');
  const fx     = STRATEGY_ORDER.filter(n => effectiveStrategies().has(n)).join('-');
  const filter = png && state.pngFilter !== DEFAULT_FILTER ? `_${state.pngFilter}` : '';
  const raw    = state.protect ? '' : '_raw';
  const alpha  = png && !state.keepAlpha && hasAlphaChannel(state.pngSource.png) ? '_noalpha' : '';
  return `${base}_glitzj_${fx}_i${state.intensity}_s${seed}${filter}${raw}${alpha}.${FORMATS[outputFormat()].ext}`;
}

function download(href, name) {
  const a = document.createElement('a');
  a.href     = href;
  a.download = name;
  a.click();
}

function downloadBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: FORMATS.png.mime }));
  download(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// PNG previews are stored uncompressed so they render quickly. A compressed
// copy for export is prepared once a result has stayed on screen briefly, so
// a click usually downloads at once instead of after an asynchronous step.
// Packing yields to the page as it goes; a job for a result that has been
// replaced is cancelled, unless an export is waiting for it.
function canPack(result) {
  return !!result?.raw && typeof CompressionStream !== 'undefined';
}

function startPack(result) {
  if (state.packed) state.packed.cancelled = true;
  const job = { result, bytes: null, cancelled: false, exporting: false, promise: null };
  job.promise = encodePngCompressed(result.source, result.raw, () => job.cancelled).then(
    bytes => { job.bytes = bytes; return bytes; },
    () => null
  );
  state.packed = job;
  return job;
}

function schedulePack(result) {
  clearTimeout(packTimer);
  if (state.packed && state.packed.result !== result && !state.packed.exporting) {
    state.packed.cancelled = true;
    state.packed = null;
  }
  if (!canPack(result) || result.raw.length > PNG_PACK_MAX_RAW) return;
  packTimer = setTimeout(() => startPack(result), PNG_PACK_DELAY_MS);
}

function setExporting(on) {
  state.exporting = on;
  els.btnExport.textContent = on ? 'Exporting…' : 'Export';
  els.btnExport.disabled    = on || els.imgAfter.hidden;
}

// Exports the result on screen, which may still belong to the previous file
// or settings while a new render is pending; everything needed travels with it.
async function exportImage() {
  const result = state.after;
  if (els.btnExport.disabled || !result) return;

  if (!canPack(result)) {
    download(result.url, result.name);
    return;
  }

  let job = state.packed?.result === result ? state.packed : null;
  let bytes = job?.bytes;

  if (!bytes) {
    clearTimeout(packTimer);
    if (job) job.exporting = true;
    setExporting(true);
    try {
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      job ||= startPack(result);
      job.exporting = true;
      bytes = await job.promise;
    } finally {
      setExporting(false);
    }
  }

  // If compressing failed, the uncompressed preview encoding is still a valid
  // file; it is rebuilt here because the preview URL may have been revoked.
  downloadBytes(bytes || encodePng(result.source.png, result.raw), result.name);
}

els.btnExport.addEventListener('click', exportImage);

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === 'r' || e.key === 'R') randomiseSeed();
  if (e.key === 'e' || e.key === 'E') exportImage();
});

// ── After panel state ─────────────────────────────────────────────────────────

// result: { url, name, raw, source } for a rendered image; raw and source are
// set for PNG output only.
function showAfter(mode, result = null, meta = '') {
  els.afterPlaceholder.hidden = mode !== 'placeholder';
  els.afterBroken.hidden      = mode !== 'broken';
  els.imgAfter.hidden         = mode !== 'image';
  els.btnExport.disabled      = mode !== 'image' || state.exporting;
  els.afterMeta.textContent   = meta;

  if (mode === 'image') {
    els.imgAfter.src = result.url;
  } else {
    els.imgAfter.removeAttribute('src');
  }

  if (state.after && state.after.url !== result?.url) URL.revokeObjectURL(state.after.url);
  state.after = result;
  schedulePack(result);
}

// ── Strategy pipeline ─────────────────────────────────────────────────────────

// Coalesces bursts of input events (e.g. dragging the intensity slider) into
// one pipeline run per animation frame.
function scheduleApply() {
  if (applyScheduled) return;
  applyScheduled = true;
  requestAnimationFrame(() => {
    applyScheduled = false;
    applyStrategies();
  });
}

function applyStrategies() {
  writeHash();
  renderGen += 1;

  if (!state.originalBytes) return;

  if (!outputFormat()) {
    showAfter('placeholder', null, 'converting to PNG…');
    return;
  }

  if (effectiveStrategies().size === 0) {
    showAfter('placeholder');
    return;
  }

  renderAttempt(renderGen, state.seed, 0);
}

// Returns the output file, plus for PNG the raw stream it wraps and the
// source it came from, which export needs to compress it.
function buildOutput(seed) {
  const strategies = effectiveStrategies();

  if (outputFormat() === 'png') {
    const raw = glitchPng(state.pngSource, {
      strategies,
      intensity: state.intensity,
      seed,
      filter:    state.pngFilter,
      protect:   state.protect,
      keepAlpha: state.keepAlpha,
    });
    return { bytes: encodePng(state.pngSource.png, raw), raw, source: state.pngSource };
  }

  const buf = new Uint8Array(state.originalBytes);
  runPipeline(buf, state.scanInfo, strategies, state.intensity, seed);
  if (state.protect) protectMarkers(buf, state.scanInfo);
  return { bytes: buf, raw: null, source: null };
}

function renderAttempt(gen, seed, attempt) {
  const { bytes, raw, source } = buildOutput(seed);
  const name  = exportName(seed);
  const url   = URL.createObjectURL(new Blob([bytes], { type: FORMATS[outputFormat()].mime }));
  const probe = new Image();

  probe.onload = () => {
    if (gen !== renderGen) {
      URL.revokeObjectURL(url);
      return;
    }
    if (seed !== state.seed) {
      state.seed = seed;
      els.seed.value = seed;
      writeHash();
    }
    const meta = attempt > 0 ? `seed ${seed} after ${attempt} ${attempt === 1 ? 'retry' : 'retries'}` : '';
    showAfter('image', { url, name, raw, source }, meta);
  };

  probe.onerror = () => {
    URL.revokeObjectURL(url);
    if (gen !== renderGen) return;
    if (state.autoRetry && attempt < MAX_RETRIES) {
      renderAttempt(gen, seed + 1, attempt + 1);
      return;
    }
    showAfter('broken', null, attempt > 0 ? `gave up after ${attempt} retries` : '');
  };

  probe.src = url;
}

// ── Init ──────────────────────────────────────────────────────────────────────

readHash();
syncControls();
syncFormatUi();
writeHash();
