// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DIMENSION  = 4000;             // px

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  originalBytes: null,
  scanStart: 0,
  scanEnd: 0,
  activeStrategies: new Set(),
  intensity: 50,
  seed: 1,
  autoRetry: false,
};

const els = {
  dropZone:       document.getElementById('drop-zone'),
  fileInput:      document.getElementById('file-input'),
  imgBefore:      document.getElementById('img-before'),
  imgAfter:       document.getElementById('img-after'),
  afterPlaceholder: document.getElementById('after-placeholder'),
  afterBroken:    document.getElementById('after-broken'),
  intensity:      document.getElementById('intensity'),
  intensityValue: document.getElementById('intensity-value'),
  seed:           document.getElementById('seed'),
  btnRandomise:   document.getElementById('btn-randomise'),
  btnReset:       document.getElementById('btn-reset'),
  btnExport:      document.getElementById('btn-export'),
  autoRetry:      document.getElementById('auto-retry'),
  strategyBtns:   document.querySelectorAll('.btn--strategy'),
};

// ── File input ───────────────────────────────────────────────────────────────

els.dropZone.addEventListener('click', () => els.fileInput.click());

els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files[0]) loadFile(els.fileInput.files[0]);
});

els.dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  els.dropZone.classList.add('drag-over');
});

els.dropZone.addEventListener('dragleave', () => {
  els.dropZone.classList.remove('drag-over');
});

els.dropZone.addEventListener('drop', e => {
  e.preventDefault();
  els.dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

function loadFile(file) {
  if (file.type !== 'image/jpeg') {
    return showError('Only JPEG files are supported.');
  }
  if (file.size > MAX_FILE_BYTES) {
    return showError(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`);
  }

  const reader = new FileReader();
  reader.onload = e => {
    const bytes = new Uint8Array(e.target.result);

    const img = new Image();
    const blobUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(blobUrl);
      if (img.naturalWidth > MAX_DIMENSION || img.naturalHeight > MAX_DIMENSION) {
        return showError(
          `Image too large (${img.naturalWidth}×${img.naturalHeight}px). Maximum is ${MAX_DIMENSION}×${MAX_DIMENSION}px.`
        );
      }

      let scanBounds;
      try {
        scanBounds = parseJpeg(bytes);
      } catch (err) {
        return showError(err.message);
      }

      state.originalBytes = bytes;
      state.scanStart     = scanBounds.scanStart;
      state.scanEnd       = scanBounds.scanEnd;
      els.imgBefore.src = URL.createObjectURL(file);
      els.imgBefore.hidden = false;
      els.dropZone.querySelector('.panel__hint').hidden = true;
      setAfterState('placeholder');
      els.btnExport.disabled = true;
    };

    img.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      showError('Could not decode the image. Is it a valid JPEG?');
    };

    img.src = blobUrl;
  };

  reader.readAsArrayBuffer(file);
}

function showError(message) {
  alert(message);
}

// ── Intensity ────────────────────────────────────────────────────────────────

els.intensity.addEventListener('input', () => {
  state.intensity = Number(els.intensity.value);
  els.intensityValue.textContent = state.intensity;
  applyStrategies();
});

// ── Seed ─────────────────────────────────────────────────────────────────────

els.seed.addEventListener('input', () => {
  state.seed = Number(els.seed.value);
  applyStrategies();
});

els.btnRandomise.addEventListener('click', () => {
  state.seed = Math.floor(Math.random() * 1_000_000);
  els.seed.value = state.seed;
  applyStrategies();
});

// ── Strategy toggles ─────────────────────────────────────────────────────────

els.strategyBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.strategy;
    if (state.activeStrategies.has(name)) {
      state.activeStrategies.delete(name);
      btn.classList.remove('active');
    } else {
      state.activeStrategies.add(name);
      btn.classList.add('active');
    }
    applyStrategies();
  });
});

// ── Reset ─────────────────────────────────────────────────────────────────────

els.btnReset.addEventListener('click', () => {
  state.activeStrategies.clear();
  state.intensity = 50;
  state.seed = 1;
  els.intensity.value = 50;
  els.intensityValue.textContent = 50;
  els.seed.value = 1;
  els.strategyBtns.forEach(btn => btn.classList.remove('active'));
  setAfterState('placeholder');
  els.btnExport.disabled = true;
});

// ── Auto-retry ────────────────────────────────────────────────────────────────

els.autoRetry.addEventListener('change', () => {
  state.autoRetry = els.autoRetry.checked;
});

// ── Export ────────────────────────────────────────────────────────────────────

els.btnExport.addEventListener('click', () => {
  if (!els.imgAfter.src || els.btnExport.disabled) return;
  const a = document.createElement('a');
  a.href = els.imgAfter.src;
  a.download = 'glitzj.jpg';
  a.click();
});

// ── After panel state ─────────────────────────────────────────────────────────

function setAfterState(mode, src) {
  els.afterPlaceholder.hidden = mode !== 'placeholder';
  els.afterBroken.hidden      = mode !== 'broken';
  els.imgAfter.hidden         = mode !== 'image';
  if (mode === 'image' && src) els.imgAfter.src = src;
}

// ── Strategy pipeline (stub — strategies implemented in later tasks) ──────────

function applyStrategies() {
  if (!state.originalBytes) return;
  if (state.activeStrategies.size === 0) {
    setAfterState('placeholder');
    els.btnExport.disabled = true;
    return;
  }

  const buf = new Uint8Array(state.originalBytes);
  // strategies will mutate buf here

  renderResult(buf);
}

function renderResult(buf, attempt = 0) {
  const blob = new Blob([buf], { type: 'image/jpeg' });
  const url  = URL.createObjectURL(blob);
  const img  = new Image();

  img.onload = () => {
    setAfterState('image', url);
    els.btnExport.disabled = false;
  };

  img.onerror = () => {
    URL.revokeObjectURL(url);
    if (state.autoRetry && attempt < 20) {
      state.seed += 1;
      els.seed.value = state.seed;
      const retryBuf = new Uint8Array(state.originalBytes);
      renderResult(retryBuf, attempt + 1);
    } else {
      setAfterState('broken');
      els.btnExport.disabled = true;
    }
  };

  img.src = url;
}
