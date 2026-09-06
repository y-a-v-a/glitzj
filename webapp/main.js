// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES    = 10 * 1024 * 1024; // 10 MB
const MAX_DIMENSION     = 4000;             // px
const MAX_RETRIES       = 20;
const DEFAULT_INTENSITY = 50;
const DEFAULT_SEED      = 1;
const STRATEGY_ORDER    = Object.keys(STRATEGY_FNS);

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  originalBytes: null,
  scanInfo: null,
  fileName: null,
  beforeUrl: null,
  afterUrl: null,
  activeStrategies: new Set(),
  intensity: DEFAULT_INTENSITY,
  seed: DEFAULT_SEED,
  autoRetry: false,
  protectMarkers: true,
};

// Incremented on every settings change; async decode results carrying an
// older generation are discarded so a slow probe can never overwrite a newer one.
let renderGen = 0;
let applyScheduled = false;

const els = {
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
  btnRandomise:     document.getElementById('btn-randomise'),
  btnReset:         document.getElementById('btn-reset'),
  btnExport:        document.getElementById('btn-export'),
  autoRetry:        document.getElementById('auto-retry'),
  protectMarkers:   document.getElementById('protect-markers'),
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

function loadFile(file) {
  hideError();

  if (file.size > MAX_FILE_BYTES) {
    return showError(`File too large (${formatBytes(file.size)}). Maximum is 10 MB.`);
  }

  const reader = new FileReader();

  reader.onload = e => {
    const bytes = new Uint8Array(e.target.result);
    const kind  = sniffImageType(bytes);

    if (kind !== 'jpeg') {
      return showError(kind
        ? `${kind.toUpperCase()} is not supported. Only JPEG files can be glitched.`
        : 'Only JPEG files are supported.');
    }

    const blobUrl = URL.createObjectURL(file);
    const img     = new Image();

    img.onload = () => {
      if (img.naturalWidth > MAX_DIMENSION || img.naturalHeight > MAX_DIMENSION) {
        URL.revokeObjectURL(blobUrl);
        return showError(
          `Image too large (${img.naturalWidth}×${img.naturalHeight}px). Maximum is ${MAX_DIMENSION}×${MAX_DIMENSION}px.`
        );
      }

      let scanInfo;
      try {
        scanInfo = parseJpeg(bytes);
      } catch (err) {
        URL.revokeObjectURL(blobUrl);
        return showError(err.message);
      }

      if (state.beforeUrl) URL.revokeObjectURL(state.beforeUrl);
      state.beforeUrl     = blobUrl;
      state.originalBytes = bytes;
      state.scanInfo      = scanInfo;
      state.fileName      = file.name || 'image.jpg';

      els.imgBefore.src    = blobUrl;
      els.imgBefore.hidden = false;
      els.dropHint.hidden  = true;
      els.beforeMeta.textContent = describeImage(img, file, scanInfo);

      applyStrategies();
    };

    img.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      showError('Could not decode the image. Is it a valid JPEG?');
    };

    img.src = blobUrl;
  };

  reader.onerror = () => showError('Could not read the file.');
  reader.readAsArrayBuffer(file);
}

function formatBytes(n) {
  return n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function describeImage(img, file, scanInfo) {
  const scans = scanInfo.scanCount === 1 ? '1 scan' : `${scanInfo.scanCount} scans`;
  return `${img.naturalWidth}×${img.naturalHeight} · ${formatBytes(file.size)} · ${scanInfo.frameType} · ${scans}`;
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function hideError() {
  els.error.hidden = true;
  els.error.textContent = '';
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
  if (!state.protectMarkers) p.set('raw', '1');
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

  state.protectMarkers = p.get('raw') !== '1';
}

function syncControls() {
  els.intensity.value            = state.intensity;
  els.intensityValue.textContent = state.intensity;
  els.seed.value                 = state.seed;
  els.protectMarkers.checked     = state.protectMarkers;
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
  syncControls();
  applyStrategies();
});

// ── Toggles ───────────────────────────────────────────────────────────────────

els.autoRetry.addEventListener('change', () => {
  state.autoRetry = els.autoRetry.checked;
  if (state.autoRetry && !els.afterBroken.hidden) scheduleApply();
});

els.protectMarkers.addEventListener('change', () => {
  state.protectMarkers = els.protectMarkers.checked;
  scheduleApply();
});

// ── Export ────────────────────────────────────────────────────────────────────

function exportName() {
  const base = (state.fileName || 'image').replace(/\.[^.]+$/, '');
  const fx   = STRATEGY_ORDER.filter(n => state.activeStrategies.has(n)).join('-');
  return `${base}_glitzj_${fx}_i${state.intensity}_s${state.seed}.jpg`;
}

function exportImage() {
  if (els.btnExport.disabled || !state.afterUrl) return;
  const a = document.createElement('a');
  a.href     = state.afterUrl;
  a.download = exportName();
  a.click();
}

els.btnExport.addEventListener('click', exportImage);

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === 'r' || e.key === 'R') randomiseSeed();
  if (e.key === 'e' || e.key === 'E') exportImage();
});

// ── After panel state ─────────────────────────────────────────────────────────

function showAfter(mode, url = null, meta = '') {
  els.afterPlaceholder.hidden = mode !== 'placeholder';
  els.afterBroken.hidden      = mode !== 'broken';
  els.imgAfter.hidden         = mode !== 'image';
  els.btnExport.disabled      = mode !== 'image';
  els.afterMeta.textContent   = meta;

  if (mode === 'image') {
    els.imgAfter.src = url;
  } else {
    els.imgAfter.removeAttribute('src');
  }

  if (state.afterUrl && state.afterUrl !== url) URL.revokeObjectURL(state.afterUrl);
  state.afterUrl = url;
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

  if (state.activeStrategies.size === 0) {
    showAfter('placeholder');
    return;
  }

  renderAttempt(renderGen, state.seed, 0);
}

function buildOutput(seed) {
  const buf = new Uint8Array(state.originalBytes);
  runPipeline(buf, state.scanInfo, state.activeStrategies, state.intensity, seed);
  if (state.protectMarkers) protectMarkers(buf, state.scanInfo);
  return buf;
}

function renderAttempt(gen, seed, attempt) {
  const buf   = buildOutput(seed);
  const url   = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
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
    showAfter('image', url, meta);
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
writeHash();
