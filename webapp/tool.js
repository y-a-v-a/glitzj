'use strict';

// ── Tool page shell ───────────────────────────────────────────────────────────
//
// Everything the pixel tools (Split, Sort, Bend, Misread, Signal, JPEG surgery)
// have in common: opening an image, settings mirrored in the page address,
// controls wired up from the markup, rendering in time slices, 1:1 view,
// export, and feeding a result back in as the next source.
//
// A page describes its settings and hands over a generator that does the work:
//
//   createTool({
//     slug: 'sort',
//     busy: 'sorting',
//     settings: {
//       progress: { default: 50, min: 0, max: 100, hash: 'p' },  // whole number
//       algorithm: { default: 'bubble', choices: [...] },        // one of a list
//       reverse: { default: false },                             // on or off
//       offsets: { default: [0, 0], min: -99, max: 99 },         // whole numbers
//     },
//     *steps(source, settings, tool) { ...; yield 0.5; ...; return result; },
//     nameParts: settings => ['bubble', 'p50'],
//   });
//
// The generator yields now and then (optionally a progress fraction) so the
// page stays responsive and a newer render can replace it. It returns either
// pixels, { rgba, width, height }, which are drawn on the canvas and exported
// as PNG, or a finished file, { bytes, type, ext, width, height }, which is
// shown by the browser's own decoder. `info` (a list of strings) lands in the
// line above the result.
//
// Markup the shell wires up by itself:
//
//   data-setting="key"              input, select or checkbox bound to a setting
//   data-for="key" data-step="±n"   button that steps a number
//   data-choice="key" data-value    button that picks one of a list
//   data-toggle="key"               button that switches a setting on or off
//   id="<key>-value"                shows the setting's current value
//
// A page that gives a `surprise(dice, tool)` function gets its Surprise me
// button wired: it returns the settings for a random look, on top of the
// defaults.

function createTool(config) {
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_DIMENSION = 4000;
  const SLICE_MS = 12;

  const $ = id => document.getElementById(id);
  const schema = config.settings;
  const keys = Object.keys(schema);
  const defaults = Object.fromEntries(keys.map(key => [key, schema[key].default]));

  const state = {
    settings: { ...defaults },
    source: null,
    fileName: '',
    fileSize: 0,
    beforeUrl: null,
    afterUrl: null,
    result: null,
    resultName: '',
    job: 0,
    loadGen: 0,
  };

  const els = {
    panels:       $('panels'),
    panelAfter:   $('panel-after'),
    dropZone:     $('drop-zone'),
    dropHint:     $('drop-hint'),
    fileInput:    $('file-input'),
    imgBefore:    $('img-before'),
    after:        $('img-after'),
    afterSurface: $('after-surface'),
    placeholder:  $('after-placeholder'),
    beforeMeta:   $('before-meta'),
    afterMeta:    $('after-meta'),
    error:        $('error'),
    zoom:         $('zoom'),
    btnExport:    $('btn-export'),
    btnReset:     $('btn-reset'),
    btnReuse:     $('btn-reuse'),
    btnRandom:    $('btn-randomise'),
    btnSurprise:  $('btn-surprise'),
  };

  const isCanvas = els.after.tagName === 'CANVAS';
  if (!isCanvas) els.after.addEventListener('error', () => showError('The browser could not show this result.'));
  const tool = {
    els,
    extra: {},
    get settings() { return state.settings; },
    get source() { return state.source; },
    get result() { return state.result; },
    get resultName() { return state.resultName; },
    defaults,
    update,
    render: scheduleRender,
    loadFile,
    showError,
  };

  // ── Helpers ─────────────────────────────────────────────────────────────────

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

  const clampInt = (value, spec, fallback) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(spec.max, Math.max(spec.min, n)) : fallback;
  };

  function sanitize(raw) {
    const s = {};
    for (const key of keys) {
      const spec = schema[key], d = spec.default, v = raw[key];
      if (v === undefined || v === '') { s[key] = d; continue; }
      if (Array.isArray(d)) {
        const list = Array.isArray(v) ? v : String(v).split(',');
        s[key] = d.map((fallback, i) => (list[i] === undefined || list[i] === '' ? fallback : clampInt(list[i], spec, fallback)));
      } else if (spec.choices) {
        s[key] = spec.choices.includes(v) ? v : d;
      } else if (typeof d === 'boolean') {
        s[key] = v === true || v === '1';
      } else if (typeof d === 'number') {
        s[key] = clampInt(v, spec, d);
      } else {
        s[key] = spec.test && !spec.test.test(v) ? d : String(v);
      }
    }
    return s;
  }

  const same = (a, b) => (Array.isArray(a) ? a.join() === b.join() : a === b);

  // ── Settings ⇄ URL hash ─────────────────────────────────────────────────────

  function writeHash() {
    const p = new URLSearchParams();
    for (const key of keys) {
      const value = state.settings[key];
      if (same(value, defaults[key])) continue;
      p.set(schema[key].hash || key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
    }
    const hash = p.toString().replace(/%2C/g, ',');
    try {
      history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
    } catch {}
  }

  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const raw = {};
    for (const key of keys) {
      const short = schema[key].hash || key;
      if (p.has(short)) raw[key] = p.get(short);
    }
    return sanitize(raw);
  }

  // ── Controls ────────────────────────────────────────────────────────────────

  const inputs = Array.from(document.querySelectorAll('[data-setting]'));
  const steppers = Array.from(document.querySelectorAll('[data-for]'));
  const choices = Array.from(document.querySelectorAll('[data-choice]'));
  const toggles = Array.from(document.querySelectorAll('[data-toggle]'));

  function syncControls() {
    const s = state.settings;
    for (const el of inputs) {
      const key = el.dataset.setting;
      if (el.type === 'checkbox') el.checked = s[key];
      else if (document.activeElement !== el || el.type === 'range') el.value = s[key];
      if (el.type === 'range') el.style.setProperty('--fill', `${(el.value - el.min) / (el.max - el.min) * 100}%`);
    }
    for (const key of keys) {
      const out = $(`${key}-value`);
      if (out) out.textContent = schema[key].format ? schema[key].format(s[key], s, tool) : s[key];
    }
    for (const btn of steppers) {
      const spec = schema[btn.dataset.for], value = s[btn.dataset.for];
      btn.disabled = Number(btn.dataset.step) < 0 ? value <= spec.min : value >= spec.max;
    }
    for (const btn of choices) {
      const on = s[btn.dataset.choice] === btn.dataset.value;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    for (const btn of toggles) {
      const on = s[btn.dataset.toggle];
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    if (config.sync) config.sync(s, tool);
  }

  function update(changes) {
    state.settings = sanitize({ ...state.settings, ...changes });
    syncControls();
    writeHash();
    scheduleRender();
  }

  for (const el of inputs) {
    const live = el.type === 'range' || el.type === 'color' || el.type === 'number';
    el.addEventListener(live ? 'input' : 'change', () => {
      update({ [el.dataset.setting]: el.type === 'checkbox' ? el.checked : el.value });
    });
    if (el.type === 'number') el.addEventListener('blur', syncControls);
  }

  for (const btn of steppers) {
    btn.addEventListener('click', () => {
      const key = btn.dataset.for;
      update({ [key]: state.settings[key] + Number(btn.dataset.step) });
    });
  }

  for (const btn of choices) {
    btn.addEventListener('click', () => update({ [btn.dataset.choice]: btn.dataset.value }));
  }

  for (const btn of toggles) {
    btn.addEventListener('click', () => update({ [btn.dataset.toggle]: !state.settings[btn.dataset.toggle] }));
  }

  function randomSeed() {
    update({ seed: Math.floor(Math.random() * 1_000_000) });
  }

  // Rolls a whole new look. The page decides what a good roll is; the shell
  // hands it the dice.
  const dice = {
    pick: list => list[Math.floor(Math.random() * list.length)],
    between: (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1)),
    chance: p => Math.random() < p,
    seed: () => Math.floor(Math.random() * 1_000_000),
  };

  function surprise() {
    if (config.surprise) update({ ...defaults, ...config.surprise(dice, tool) });
  }

  if (els.btnSurprise) els.btnSurprise.addEventListener('click', surprise);
  if (els.btnRandom) els.btnRandom.addEventListener('click', randomSeed);
  els.btnReset.addEventListener('click', () => update({ ...defaults }));
  els.btnExport.addEventListener('click', exportResult);
  if (els.btnReuse) els.btnReuse.addEventListener('click', reuseResult);
  els.zoom.addEventListener('change', applyZoom);

  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest('input:not([type="range"]):not([type="checkbox"]), select, textarea')) return;
    const key = e.key.toLowerCase();
    if (config.keys && config.keys(e, tool)) return e.preventDefault();
    if (key === 'e' && state.result) { e.preventDefault(); exportResult(); }
    if (key === 'x' && els.btnSurprise) { e.preventDefault(); surprise(); }
    if (key === 'r' && els.btnRandom && !els.btnRandom.closest('[hidden]')) { e.preventDefault(); randomSeed(); }
    if (key === 'z') { e.preventDefault(); els.zoom.checked = !els.zoom.checked; applyZoom(); }
  });

  window.addEventListener('hashchange', () => {
    state.settings = readHash();
    syncControls();
    scheduleRender();
  });

  // ── File input ──────────────────────────────────────────────────────────────

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

  // `own` marks an image the app made itself (a result fed back in, or the
  // image carried over from another page): it skips the file size limit, since
  // a glitched PNG is often far larger than the photo it came from.
  function loadFile(file, { own = false, quiet = false, restored = false } = {}) {
    if (!quiet) hideError();
    const gen = ++state.loadGen;
    const fail = message => { if (!quiet) showError(message); };

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

      if (state.beforeUrl) URL.revokeObjectURL(state.beforeUrl);
      state.beforeUrl = url;
      state.source = { rgba: ctx.getImageData(0, 0, width, height).data, width, height, cache: {} };
      state.fileName = file.name || 'image';
      state.fileSize = file.size;

      els.imgBefore.src = url;
      els.imgBefore.hidden = false;
      els.dropHint.hidden = true;
      els.panels.style.setProperty('--ar', width / height);
      els.beforeMeta.textContent = `${width}×${height} · ${formatBytes(file.size)}${file.type === 'image/gif' ? ' · first frame' : ''}`;

      if (!restored) Handoff.save(file, state.fileName);
      if (config.loaded) config.loaded(state.source, tool);
      syncControls();
      scheduleRender();
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      if (gen === state.loadGen) fail('Could not decode the image. Is it an image file your browser can show?');
    };

    img.src = url;
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  function scheduleRender() {
    if (!state.source) return;
    const job = ++state.job;
    requestAnimationFrame(() => {
      if (job === state.job) runJob(job);
    });
  }

  function runJob(job) {
    const settings = { ...state.settings };
    let steps;
    try {
      steps = config.steps(state.source, settings, tool);
    } catch (err) {
      return showError(`Could not render: ${err.message}`);
    }

    const slice = () => {
      if (job !== state.job) return;
      const start = performance.now();
      try {
        for (;;) {
          const step = steps.next();
          if (step.done) return show(step.value, settings);
          if (performance.now() - start > SLICE_MS) {
            setBusy(true, step.value);
            return setTimeout(slice, 0);
          }
        }
      } catch (err) {
        setBusy(false);
        showError(`Could not render: ${err.message}`);
      }
    };
    slice();
  }

  function setBusy(on, progress) {
    els.panelAfter.classList.toggle('is-busy', on);
    if (!on) return;
    const pct = typeof progress === 'number' ? ` ${Math.round(progress * 100)}%` : '';
    els.afterMeta.textContent = `${config.busy || 'working'}…${pct}`;
  }

  function show(result, settings) {
    setBusy(false);
    if (isCanvas) {
      if (els.after.width !== result.width) els.after.width = result.width;
      if (els.after.height !== result.height) els.after.height = result.height;
      const ctx = els.after.getContext('2d');
      const pixels = result.rgba instanceof Uint8ClampedArray
        ? result.rgba
        : new Uint8ClampedArray(result.rgba.buffer, result.rgba.byteOffset, result.rgba.byteLength);
      ctx.putImageData(new ImageData(pixels, result.width, result.height), 0, 0);
    } else {
      const url = URL.createObjectURL(new Blob([result.bytes], { type: result.type }));
      const previous = state.afterUrl;
      state.afterUrl = url;
      els.after.src = url;
      if (previous) URL.revokeObjectURL(previous);
    }

    els.after.style.setProperty('--ar', result.width / result.height);
    els.after.hidden = false;
    els.placeholder.hidden = true;
    els.btnExport.disabled = false;
    if (els.btnReuse) els.btnReuse.disabled = false;
    state.result = result;
    state.resultName = exportName(settings, result);

    const parts = [`${result.width}×${result.height}`, ...(result.info || [])];
    if (result.bytes) parts.push(formatBytes(result.bytes.length));
    els.afterMeta.textContent = parts.join(' · ');
    els.afterMeta.title = result.title || '';
    applyZoom();
    if (config.shown) config.shown(result, tool);
  }

  function applyZoom() {
    const on = els.zoom.checked && state.result;
    els.afterSurface.classList.toggle('panel__surface--zoom', Boolean(on));
    els.after.style.width = on ? `${state.result.width}px` : '';
  }

  // ── Export and feeding back ─────────────────────────────────────────────────

  function exportName(settings, result) {
    // Results fed back in carry their history in the name; keep it a file name.
    const base = (state.fileName.replace(/\.[^.]+$/, '') || 'image').slice(0, 120);
    const parts = [base, config.slug, ...(config.nameParts ? config.nameParts(settings) : [])];
    return `${parts.filter(Boolean).join('_')}.${result.ext || 'png'}`;
  }

  function resultBlob() {
    const { result } = state;
    if (!result) return Promise.resolve(null);
    if (result.bytes) return Promise.resolve(new Blob([result.bytes], { type: result.type }));
    return new Promise(resolve => els.after.toBlob(resolve, 'image/png'));
  }

  async function exportResult() {
    const name = state.resultName;
    const blob = await resultBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function reuseResult() {
    const name = state.resultName;
    const blob = await resultBlob();
    if (!blob) return;
    loadFile(new File([blob], name, { type: blob.type }), { own: true });
  }

  // ── Start ───────────────────────────────────────────────────────────────────

  state.settings = readHash();
  syncControls();
  Handoff.load().then(file => {
    if (file && !state.source && !state.loadGen) loadFile(file, { own: true, quiet: true, restored: true });
  });

  return tool;
}

// ── Recording ─────────────────────────────────────────────────────────────────
//
// For the pages whose picture moves: records the result canvas as a video file
// while the page keeps drawing frames on it. `button` starts and stops, `label`
// is the element holding its text, `onStart` gets the picture moving.

function toolRecorder(tool, { button, label, onStart }) {
  const canvas = tool.els.after;
  let recorder = null;

  const available = () => Boolean(tool.result && window.MediaRecorder && canvas.captureStream);

  function start() {
    const type = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find(t => MediaRecorder.isTypeSupported(t));
    if (!type) return tool.showError('This browser cannot record video from a page.');
    const chunks = [];
    const name = tool.resultName.replace(/\.png$/, type.startsWith('video/mp4') ? '.mp4' : '.webm');
    recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 12_000_000 });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const url = URL.createObjectURL(new Blob(chunks, { type: type.split(';')[0] }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    };
    recorder.start();
    button.classList.add('is-recording');
    label.textContent = 'Stop and save';
    onStart();
  }

  function stop() {
    if (!recorder) return;
    recorder.stop();
    recorder = null;
    button.classList.remove('is-recording');
    label.textContent = 'Record';
  }

  button.addEventListener('click', () => {
    if (recorder) stop();
    else if (available()) start();
  });

  return { available, stop, get recording() { return Boolean(recorder); } };
}
