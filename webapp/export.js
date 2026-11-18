'use strict';

// ── Export ────────────────────────────────────────────────────────────────────
//
// Every page makes a result: a file (a glitched JPEG, a dithered GIF) or
// pixels on a canvas. Export saves it. By default that is the result as made,
// the file itself, byte for byte. The options next to the button save a
// rendered copy instead: the picture as this browser shows it, at another
// size, in another format, on the clipboard, or handed to another app.
//
//   size      a share of the result's own size, or a width in pixels
//   scaling   sharp keeps every pixel a hard-edged square, which is what a
//             glitch wants when it is enlarged; smooth blends them
//   format    as made, or PNG, JPEG or WebP
//
// A rendered copy of a damaged file is worth having for its own sake: viewers
// disagree about broken JPEGs and GIFs, and a PNG of what you saw is the same
// everywhere.
//
// The options are remembered in this browser. The first half of this file is
// arithmetic and is tested in Node; the second half is the menu.

const Exporter = (() => {
  const SIZES = ['25', '50', '100', '200', '300', '400', 'custom'];
  const FORMATS = {
    made: null,
    png:  { type: 'image/png', ext: 'png', label: 'PNG' },
    jpeg: { type: 'image/jpeg', ext: 'jpg', label: 'JPEG' },
    webp: { type: 'image/webp', ext: 'webp', label: 'WebP' },
  };
  const MAX_SIDE = 16384;            // what browsers will make a canvas of
  const MAX_AREA = 120_000_000;
  const STORE = 'glitzj-export';

  const defaults = () => ({ size: '100', width: 1920, sharp: true, format: 'made', quality: 92 });

  function sanitize(raw) {
    const o = { ...defaults(), ...(raw && typeof raw === 'object' ? raw : {}) };
    const int = (v, lo, hi, fallback) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
    };
    return {
      size: SIZES.includes(String(o.size)) ? String(o.size) : '100',
      width: int(o.width, 1, MAX_SIDE, 1920),
      sharp: o.sharp !== false,
      format: Object.hasOwn(FORMATS, o.format) ? o.format : 'made',
      quality: int(o.quality, 1, 100, 92),
    };
  }

  // What will be saved for a result of this size and kind: how large, in what
  // format, and whether that takes a rendered copy.
  function plan(result, options) {
    const o = sanitize(options);
    let width = o.size === 'custom' ? o.width : Math.round(result.width * Number(o.size) / 100);
    width = Math.max(1, width);
    let height = Math.max(1, Math.round(width * result.height / result.width));

    let limited = false;
    const shrink = Math.min(1, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height)));
    if (shrink < 1) {
      limited = true;
      width = Math.max(1, Math.floor(width * shrink));
      height = Math.max(1, Math.floor(height * shrink));
    }

    const resized = width !== result.width || height !== result.height;
    const format = FORMATS[o.format];
    // Asking for the format the result already has is not a reason to render.
    const sameFormat = !format || format.ext === result.ext;
    return {
      width,
      height,
      resized,
      limited,
      render: resized || !sameFormat,
      type: sameFormat && !resized ? null : (format || FORMATS[result.ext === 'jpg' ? 'jpeg' : 'png']).type,
      ext: sameFormat && !resized ? result.ext : (format || FORMATS[result.ext === 'jpg' ? 'jpeg' : 'png']).ext,
      sharp: o.sharp,
      quality: o.quality,
    };
  }

  // A resized copy says so in its name, so it never overwrites the original
  // export in a downloads folder.
  function fileName(name, planned) {
    const base = String(name || 'image').replace(/\.[^.]+$/, '') || 'image';
    return `${base}${planned.resized ? `_${planned.width}x${planned.height}` : ''}.${planned.ext}`;
  }

  // A short note for the button: "2×", "50% · JPEG", "1920 px".
  function summary(options) {
    const o = sanitize(options);
    const parts = [];
    if (o.size === 'custom') parts.push(`${o.width} px`);
    else if (o.size !== '100') parts.push(Number(o.size) >= 100 ? `${Number(o.size) / 100}×` : `${o.size}%`);
    if (o.format !== 'made') parts.push(FORMATS[o.format].label);
    return parts.join(' · ');
  }

  const kind = ext => (ext === 'jpg' ? 'JPEG' : ext === 'webp' ? 'WebP' : String(ext).toUpperCase());

  // ── The menu ───────────────────────────────────────────────────────────────
  //
  // create({ button, result }) takes over the page's Export button. `result`
  // returns what is on screen, or null:
  //
  //   { name, width, height, ext,
  //     file: () => Promise<Blob>,     the result as made
  //     image,                         optional: a canvas that already holds it
  //     animated }                     optional: a copy would be one frame only

  function load() {
    try { return sanitize(JSON.parse(localStorage.getItem(STORE))); } catch { return defaults(); }
  }

  function save(options) {
    try { localStorage.setItem(STORE, JSON.stringify(options)); } catch {}
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function drawable(result) {
    if (result.image) return { image: result.image, done() {} };
    const url = URL.createObjectURL(await result.file());
    const img = new Image();
    try {
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('The browser could not draw this result.'));
        img.src = url;
      });
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    return { image: img, done: () => URL.revokeObjectURL(url) };
  }

  // The result drawn at the planned size, as a file of the given type.
  async function render(result, planned, type) {
    const { image, done } = await drawable(result);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = planned.width;
      canvas.height = planned.height;
      const ctx = canvas.getContext('2d');
      if (type === 'image/jpeg') {
        ctx.fillStyle = '#fff';                     // JPEG has no transparency
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.imageSmoothingEnabled = !planned.sharp;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, type, planned.quality / 100));
      if (!blob) throw new Error('The browser could not make a picture this large.');
      return blob;
    } finally {
      done();
    }
  }

  function create({ button, result }) {
    let options = load();

    const wrap = document.createElement('div');
    wrap.className = 'export';
    button.before(wrap);
    wrap.append(button);

    const badge = document.createElement('span');
    badge.className = 'export__badge';
    const key = button.querySelector('.kbd');
    if (key) key.before(badge); else button.append(badge);

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn btn--primary export__more';
    more.title = 'Size, format and clipboard';
    more.setAttribute('aria-label', 'Export options');
    more.setAttribute('aria-expanded', 'false');
    more.innerHTML = '<svg class="btn__icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    wrap.append(more);

    const panel = document.createElement('div');
    panel.className = 'export-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'Export options');
    panel.innerHTML = `
      <div class="export-panel__row">
        <label class="control-label" for="export-size">Size</label>
        <select class="control-input control-select" id="export-size">
          <option value="25">25%</option>
          <option value="50">50%</option>
          <option value="100">As made</option>
          <option value="200">2×</option>
          <option value="300">3×</option>
          <option value="400">4×</option>
          <option value="custom">A width in pixels</option>
        </select>
        <input class="control-input" type="number" id="export-width" min="1" max="${MAX_SIDE}" aria-label="Width in pixels" hidden>
      </div>
      <div class="export-panel__row">
        <label class="control-label" for="export-scaling" title="How pixels are enlarged or shrunk. Sharp keeps every pixel a hard-edged square; smooth blends neighbors">Scaling</label>
        <select class="control-input control-select" id="export-scaling">
          <option value="sharp">Sharp pixels</option>
          <option value="smooth">Smooth</option>
        </select>
      </div>
      <div class="export-panel__row">
        <label class="control-label" for="export-format" title="As made saves the result itself. The others save a copy of the picture as this browser shows it">Format</label>
        <select class="control-input control-select" id="export-format">
          <option value="made">As made</option>
          <option value="png">PNG</option>
          <option value="jpeg">JPEG</option>
          <option value="webp">WebP</option>
        </select>
      </div>
      <div class="export-panel__row" id="export-quality-row">
        <label class="control-label" for="export-quality">Quality</label>
        <input class="control-range" type="range" id="export-quality" min="1" max="100">
        <span class="control-value" id="export-quality-value"></span>
      </div>
      <p class="export-panel__note" id="export-note" aria-live="polite"></p>
      <div class="export-panel__buttons">
        <button class="btn btn--secondary" type="button" id="export-share" title="Hand the file to another app" hidden>Share</button>
        <button class="btn btn--secondary" type="button" id="export-copy" title="Put the picture on the clipboard, as a PNG at the chosen size">Copy</button>
        <button class="btn btn--primary" type="button" id="export-save">Download</button>
      </div>`;
    wrap.append(panel);

    const $ = id => panel.querySelector(`#${id}`);
    const ui = {
      size: $('export-size'), width: $('export-width'), scaling: $('export-scaling'), format: $('export-format'),
      quality: $('export-quality'), qualityValue: $('export-quality-value'), qualityRow: $('export-quality-row'),
      note: $('export-note'), copy: $('export-copy'), share: $('export-share'), save: $('export-save'),
    };

    let message = '';

    function sync() {
      ui.size.value = options.size;
      ui.width.hidden = options.size !== 'custom';
      if (document.activeElement !== ui.width) ui.width.value = options.width;
      ui.scaling.value = options.sharp ? 'sharp' : 'smooth';
      ui.format.value = options.format;
      ui.quality.value = options.quality;
      ui.quality.style.setProperty('--fill', `${options.quality - 1}%`);
      ui.qualityValue.textContent = options.quality;
      badge.textContent = summary(options);
      badge.hidden = !badge.textContent;

      const current = result();
      const planned = current ? plan(current, options) : null;
      ui.qualityRow.hidden = !planned || !/jpeg|webp/.test(planned.type || '');
      ui.format.options[0].textContent = current ? `As made (${kind(current.ext)})` : 'As made';
      ui.save.disabled = ui.copy.disabled = ui.share.disabled = !current;

      const notes = [];
      if (planned) {
        notes.push(`${planned.width} × ${planned.height} px, ${kind(planned.ext)}`);
        if (!planned.render) notes.push('the result itself, byte for byte');
        else if (current.animated) notes.push('a still of the first frame');
        if (planned.limited) notes.push('as large as a browser can make it');
      }
      if (message) notes.push(message);
      ui.note.textContent = notes.join(' · ');
    }

    function change(changes) {
      options = sanitize({ ...options, ...changes });
      message = '';
      save(options);
      sync();
    }

    ui.size.addEventListener('change', () => {
      const current = result();
      // Start a custom width from the size the result has now.
      change(ui.size.value === 'custom' && current ? { size: 'custom', width: plan(current, options).width } : { size: ui.size.value });
      if (ui.size.value === 'custom') ui.width.focus();
    });
    ui.width.addEventListener('input', () => { if (ui.width.value) change({ width: ui.width.value }); });
    ui.width.addEventListener('blur', sync);
    ui.scaling.addEventListener('change', () => change({ sharp: ui.scaling.value === 'sharp' }));
    ui.format.addEventListener('change', () => change({ format: ui.format.value }));
    ui.quality.addEventListener('input', () => change({ quality: ui.quality.value }));

    async function make(forClipboard) {
      const current = result();
      if (!current) return null;
      const planned = plan(current, forClipboard ? { ...options, format: 'png' } : options);
      if (forClipboard) return { blob: await render(current, planned, 'image/png'), planned, current };
      if (!planned.render) return { blob: await current.file(), planned, current };
      const blob = await render(current, planned, planned.type);
      // A browser that cannot write the format asked for writes a PNG instead.
      if (blob.type && blob.type !== planned.type) planned.ext = 'png';
      return { blob, planned, current };
    }

    async function run(action) {
      if (button.disabled || button.getAttribute('aria-busy') === 'true') return;
      button.setAttribute('aria-busy', 'true');
      message = '';
      try {
        await action();
      } catch (err) {
        message = err.message || 'That did not work.';
        setOpen(true);
      } finally {
        button.removeAttribute('aria-busy');
        sync();
      }
    }

    const exportNow = () => run(async () => {
      const made = await make(false);
      if (made) download(made.blob, fileName(made.current.name, made.planned));
    });

    ui.save.addEventListener('click', exportNow);
    button.addEventListener('click', exportNow);

    ui.copy.addEventListener('click', () => run(async () => {
      if (!navigator.clipboard || !window.ClipboardItem) throw new Error('This browser cannot put pictures on the clipboard.');
      // The picture is handed over as a promise, so the browser still counts
      // this as the direct result of the click.
      const blob = make(true).then(made => made.blob);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      message = 'copied';
    }));

    // Sharing exists where the system has a share sheet: phones, mostly.
    const probe = new File([new Uint8Array(1)], 'a.png', { type: 'image/png' });
    ui.share.hidden = !(navigator.canShare && navigator.canShare({ files: [probe] }));
    ui.share.addEventListener('click', () => run(async () => {
      const made = await make(false);
      if (!made) return;
      const file = new File([made.blob], fileName(made.current.name, made.planned), { type: made.blob.type });
      try {
        await navigator.share({ files: [file] });
      } catch (err) {
        if (err.name !== 'AbortError') throw new Error('Sharing did not work here; Download does.');
      }
    }));

    function setOpen(open) {
      panel.hidden = !open;
      more.setAttribute('aria-expanded', String(open));
      if (open) sync();
    }

    more.addEventListener('click', () => setOpen(panel.hidden));
    document.addEventListener('pointerdown', e => { if (!panel.hidden && !wrap.contains(e.target)) setOpen(false); });
    panel.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      more.focus();
    });

    // The page enables and disables its Export button; the arrow follows.
    const follow = () => { more.disabled = button.disabled; if (button.disabled) setOpen(false); };
    new MutationObserver(follow).observe(button, { attributes: true, attributeFilter: ['disabled'] });
    follow();
    sync();

    return { export: exportNow, sync };
  }

  return { SIZES, FORMATS, MAX_SIDE, MAX_AREA, defaults, sanitize, plan, fileName, summary, create };
})();
