'use strict';

// ── Source view ───────────────────────────────────────────────────────────────
//
// What part of the opened image a page works on, and which way up: turned in
// steps of 90°, mirrored, and zoomed in on a part of it. The file itself is
// never changed; a view is a small description, and every page applies it to
// the pixels before it does anything else. So a tool that sorts rows sorts
// columns once the picture is turned, and a zoomed view is a crop: the tool
// gets the pixels inside it, at their own size, and nothing is resampled.
//
// A view is { turns, mirror, zoom, cx, cy }:
//
//   turns   quarter turns clockwise, 0 to 3
//   mirror  mirrored left to right, after turning
//   zoom    in percent, 100 (everything) to 800
//   cx, cy  the middle of the visible part, in thousandths of the turned
//           picture's width and height
//
// Turning and mirroring together give all eight ways a picture can lie flat,
// so "flip top to bottom" needs no field of its own: it is a mirror and a half
// turn.
//
// The first half of this file is plain arithmetic and is tested in Node. The
// second half builds the small toolbar on the Before panel.

const SourceView = (() => {
  const ZOOM_STEPS = [100, 150, 200, 300, 400, 600, 800];
  const MAX_ZOOM = 800;

  const identity = () => ({ turns: 0, mirror: false, zoom: 100, cx: 500, cy: 500 });

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function sanitize(view) {
    const v = view || {};
    const int = (n, fallback) => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : fallback);
    return {
      turns: ((int(v.turns, 0) % 4) + 4) % 4,
      mirror: Boolean(v.mirror),
      zoom: clamp(int(v.zoom, 100), 100, MAX_ZOOM),
      cx: clamp(int(v.cx, 500), 0, 1000),
      cy: clamp(int(v.cy, 500), 0, 1000),
    };
  }

  function isIdentity(view) {
    return !view || (view.turns === 0 && !view.mirror && view.zoom === 100);
  }

  // The changes below are all described as you see them on screen, whatever
  // was done before: "clockwise" turns what is shown clockwise, also when it
  // is mirrored, and the part you zoomed in on stays the part you look at.

  function rotate(view, clockwise = true) {
    const v = sanitize(view);
    const step = (clockwise ? 1 : 3) * (v.mirror ? 3 : 1);
    return {
      ...v,
      turns: (v.turns + step) % 4,
      cx: clockwise ? 1000 - v.cy : v.cy,
      cy: clockwise ? v.cx : 1000 - v.cx,
    };
  }

  function flip(view, horizontal = true) {
    const v = sanitize(view);
    if (horizontal) return { ...v, mirror: !v.mirror, cx: 1000 - v.cx };
    // Top to bottom is left to right and a half turn.
    return { ...v, mirror: !v.mirror, turns: (v.turns + 2) % 4, cy: 1000 - v.cy };
  }

  function zoomTo(view, zoom) {
    return sanitize({ ...sanitize(view), zoom });
  }

  function zoomStep(view, direction) {
    const v = sanitize(view);
    const next = direction > 0
      ? ZOOM_STEPS.find(z => z > v.zoom)
      : ZOOM_STEPS.slice().reverse().find(z => z < v.zoom);
    return next ? { ...v, zoom: next } : v;
  }

  // Moves the visible part by a share of its own size.
  function pan(view, dx, dy) {
    const v = sanitize(view);
    const span = 100000 / v.zoom;
    return sanitize({ ...v, cx: v.cx + dx * span, cy: v.cy + dy * span });
  }

  // ── As text, for the page address and the hand-off ─────────────────────────
  // "1" a quarter turn; "3m" three quarter turns, mirrored; "0@200,250,500"
  // zoomed to 200% around a point a quarter in from the left.

  function encode(view) {
    const v = sanitize(view);
    if (isIdentity(v)) return '';
    const zoomed = v.zoom === 100 ? '' : `@${v.zoom},${v.cx},${v.cy}`;
    return `${v.turns}${v.mirror ? 'm' : ''}${zoomed}`;
  }

  function decode(text) {
    const m = /^([0-3])(m?)(?:@(\d+),(\d+),(\d+))?$/.exec(String(text || ''));
    if (!m) return identity();
    return sanitize({
      turns: Number(m[1]),
      mirror: m[2] === 'm',
      zoom: m[3] === undefined ? 100 : Number(m[3]),
      cx: m[4] === undefined ? 500 : Number(m[4]),
      cy: m[5] === undefined ? 500 : Number(m[5]),
    });
  }

  // ── Applying a view ────────────────────────────────────────────────────────

  // The visible rectangle within the turned picture, in whole pixels.
  function rect(width, height, view) {
    const v = sanitize(view);
    const turned = v.turns % 2 === 1;
    const fullWidth = turned ? height : width, fullHeight = turned ? width : height;
    const w = Math.max(1, Math.round(fullWidth * 100 / v.zoom));
    const h = Math.max(1, Math.round(fullHeight * 100 / v.zoom));
    const x = clamp(Math.round(fullWidth * v.cx / 1000 - w / 2), 0, fullWidth - w);
    const y = clamp(Math.round(fullHeight * v.cy / 1000 - h / 2), 0, fullHeight - h);
    return { x, y, width: w, height: h, fullWidth, fullHeight };
  }

  // The pixels a page works on. An untouched view returns the pixels it was
  // given, not a copy.
  function pixels(rgba, width, height, view) {
    const v = sanitize(view);
    if (isIdentity(v)) return { rgba, width, height };

    const r = rect(width, height, v);
    const src = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
    const out = new Uint8ClampedArray(r.width * r.height * 4);
    const dst = new Uint32Array(out.buffer);

    // A step right or down in the result is a step of this many source pixels.
    // Position (ox, oy) of the turned, mirrored picture comes from the source
    // pixel found by undoing the mirror and then the turn.
    for (let y = 0; y < r.height; y++) {
      const oy = r.y + y;
      for (let x = 0; x < r.width; x++) {
        let ox = r.x + x;
        if (v.mirror) ox = r.fullWidth - 1 - ox;
        let sx, sy;
        if (v.turns === 0) { sx = ox; sy = oy; }
        else if (v.turns === 1) { sx = oy; sy = height - 1 - ox; }
        else if (v.turns === 2) { sx = width - 1 - ox; sy = height - 1 - oy; }
        else { sx = width - 1 - oy; sy = ox; }
        dst[y * r.width + x] = src[sy * width + sx];
      }
    }
    return { rgba: out, width: r.width, height: r.height };
  }

  function describe(view) {
    const v = sanitize(view);
    const parts = [];
    if (v.turns) parts.push(`turned ${v.turns * 90}°`);
    if (v.mirror) parts.push('mirrored');
    if (v.zoom !== 100) parts.push(`${v.zoom / 100}× zoom`);
    return parts.join(', ');
  }

  // ── The toolbar on the Before panel ────────────────────────────────────────
  //
  // attach({ surface, get, set, enabled }) adds the buttons to the Before
  // panel and lets the picture be dragged while it is zoomed in. `get` returns
  // the current view, or null while there is no image; `set` is called with
  // every new view; `enabled` (optional) says why the view cannot be changed
  // right now, or returns nothing if it can.

  const ICONS = {
    left:  '<path d="M4.5 3v3.5H8M4.7 6.3A5 5 0 1 1 3 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    right: '<path d="M11.5 3v3.5H8M11.3 6.3A5 5 0 1 0 13 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    flipH: '<path d="M8 1.5v13M6 4 2 8l4 4V4Zm4 0 4 4-4 4V4Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
    flipV: '<path d="M1.5 8h13M4 6l4-4 4 4H4Zm0 4 4 4 4-4H4Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
    out:   '<path d="M3 8h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    in:    '<path d="M3 8h10M8 3v10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    reset: '<path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  };

  function attach({ surface, get, set, enabled = () => '' }) {
    const bar = document.createElement('div');
    bar.className = 'source-bar';
    bar.hidden = true;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Turn, mirror and zoom the original');

    const buttons = {};
    const button = (key, title, action) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'source-bar__btn';
      el.title = title;
      el.setAttribute('aria-label', title.replace(/ \(.*\)$/, ''));
      el.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[key]}</svg>`;
      el.addEventListener('click', () => change(action));
      bar.append(el);
      buttons[key] = el;
    };

    button('left', 'Turn a quarter to the left ([)', v => rotate(v, false));
    button('right', 'Turn a quarter to the right (])', v => rotate(v, true));
    button('flipH', 'Mirror left to right (H)', v => flip(v, true));
    button('flipV', 'Flip top to bottom (V)', v => flip(v, false));
    button('out', 'Zoom out (−)', v => zoomStep(v, -1));
    const readout = document.createElement('span');
    readout.className = 'source-bar__zoom';
    bar.append(readout);
    button('in', 'Zoom in on the original; drag the picture to move around (+)', v => zoomStep(v, 1));
    button('reset', 'Back to the whole picture, the right way up', () => identity());

    // The panel opens a file when it is clicked or when Enter is pressed on
    // it; neither should happen for the toolbar inside it.
    for (const type of ['click', 'keydown', 'pointerdown']) bar.addEventListener(type, e => e.stopPropagation());
    surface.append(bar);

    function change(action) {
      const view = get();
      if (!view || enabled()) return;
      set(sanitize(action(view)));
      sync();
    }

    function sync() {
      const view = get();
      bar.hidden = !view;
      if (!view) return;
      const why = enabled();
      bar.classList.toggle('is-off', Boolean(why));
      bar.title = why || '';
      for (const el of Object.values(buttons)) el.disabled = Boolean(why);
      readout.textContent = `${view.zoom / 100}×`;
      if (!why) {
        buttons.out.disabled = view.zoom <= 100;
        buttons.in.disabled = view.zoom >= MAX_ZOOM;
      }
      buttons.reset.hidden = isIdentity(view);
      surface.classList.toggle('is-zoomed', view.zoom > 100 && !why);
    }

    // Dragging the zoomed picture moves the visible part. A drag must not
    // count as the click that opens a file.
    let drag = null, dragged = false;
    surface.addEventListener('pointerdown', e => {
      const view = get();
      if (e.button !== 0 || !view || view.zoom <= 100 || enabled()) return;
      const box = (surface.querySelector('.panel__image') || surface).getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, view, width: box.width || 1, height: box.height || 1, moved: false };
    });
    window.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      surface.classList.add('is-panning');
      set(pan(drag.view, -dx / drag.width, -dy / drag.height));
    });
    const release = () => {
      if (!drag) return;
      dragged = drag.moved;
      drag = null;
      surface.classList.remove('is-panning');
      if (dragged) setTimeout(() => { dragged = false; }, 0);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    surface.addEventListener('click', e => {
      if (!dragged) return;
      dragged = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    }, true);

    document.addEventListener('keydown', e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.closest('input:not([type="range"]):not([type="checkbox"]), select, textarea')) return;
      const actions = {
        '[': v => rotate(v, false),
        ']': v => rotate(v, true),
        h: v => flip(v, true),
        v: v => flip(v, false),
        '+': v => zoomStep(v, 1),
        '=': v => zoomStep(v, 1),
        '-': v => zoomStep(v, -1),
      };
      const action = actions[e.key.toLowerCase()];
      if (!action || !get() || enabled()) return;
      e.preventDefault();
      change(action);
    });

    return { sync };
  }

  // ── For the pages that work on pixels ──────────────────────────────────────
  //
  // manage({ surface, canvas, changed }) keeps the opened picture and its view
  // for a page: it draws what the view shows on the Before canvas, runs the
  // toolbar, stores the picture and the view for the next page, and calls
  // `changed(picture, view)` with the pixels to work on whenever either one
  // changes. The page hands over each picture it has decoded with open().

  function manage({ surface, canvas, changed }) {
    let file = null, name = '', original = null, view = identity(), pending = null, storeTimer = 0;

    function store() {
      clearTimeout(storeTimer);
      storeTimer = setTimeout(() => { if (file) Handoff.save(file, name, encode(view)); }, 300);
    }

    function apply() {
      const shown = pixels(original.rgba, original.width, original.height, view);
      canvas.width = shown.width;
      canvas.height = shown.height;
      canvas.getContext('2d').putImageData(new ImageData(shown.rgba, shown.width, shown.height), 0, 0);
      canvas.hidden = false;
      bar.sync();
      changed(shown, view);
    }

    const bar = attach({
      surface,
      get: () => (original ? view : null),
      set(next) {
        view = next;
        apply();
        store();
      },
    });

    return {
      // A newly decoded picture. It starts the right way up unless a view came
      // with it (from the page it was carried over from) or one was waiting
      // in the page address.
      open(newFile, newName, picture, { view: given = null, keep = true } = {}) {
        file = newFile;
        name = newName;
        original = picture;
        view = pending || (given ? decode(given) : identity());
        pending = null;
        apply();
        if (keep) store();
      },
      // A view from the page address: for the picture that is open, or else
      // for the first one that will be.
      fromParam(text) {
        const next = decode(text);
        if (!original) { pending = isIdentity(next) ? null : next; return; }
        if (encode(next) === encode(view)) return;
        view = next;
        apply();
        store();
      },
      param: () => encode(original ? view : pending),
      get view() { return view; },
      get original() { return original; },
    };
  }

  return {
    ZOOM_STEPS, identity, sanitize, isIdentity, rotate, flip, zoomTo, zoomStep, pan,
    encode, decode, rect, pixels, describe, attach, manage,
  };
})();
