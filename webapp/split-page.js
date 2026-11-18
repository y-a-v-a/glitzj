'use strict';

const PLANE_INKS = {
  R: '#ff3b30', G: '#34c759', B: '#2f6bff',
  C: '#00b7eb', M: '#ff2e88', Y: '#f5c400', K: '#111111',
  Cb: 'linear-gradient(90deg, #d9c400, #2f6bff)', Cr: 'linear-gradient(90deg, #00b7a0, #ff3b30)',
};
const PLANE_TITLES = {
  R: 'Red', G: 'Green', B: 'Blue', C: 'Cyan', M: 'Magenta', Y: 'Yellow', K: 'Black',
  Cb: 'Blue against yellow', Cr: 'Red against cyan',
};
const MAX_OFFSET = 4000;

let activePlane = 0;

const planesEl = document.getElementById('planes');

const tool = createTool({
  slug: 'split',
  busy: 'splitting',
  settings: {
    model:   { default: SPLIT_DEFAULTS.model, choices: Object.keys(SPLIT_MODELS), hash: 'm' },
    offsets: { default: SPLIT_DEFAULTS.offsets, min: -MAX_OFFSET, max: MAX_OFFSET, hash: 'o' },
    zoom:    { default: SPLIT_DEFAULTS.zoom, min: -100, max: 100 },
    twist:   { default: SPLIT_DEFAULTS.twist, min: -100, max: 100 },
    tear:    { default: SPLIT_DEFAULTS.tear, min: 0, max: 100 },
    band:    { default: SPLIT_DEFAULTS.band, min: 1, max: 100 },
    seed:    { default: SPLIT_DEFAULTS.seed, min: 0, max: 2 ** 31 - 1, hash: 's' },
    edge:    { default: SPLIT_DEFAULTS.edge, choices: SPLIT_EDGES },
    wiring:  { default: SPLIT_DEFAULTS.wiring, choices: SPLIT_WIRINGS, hash: 'w' },
  },
  steps: splitSteps,
  sync: syncPlanes,
  nameParts(s) {
    const names = SPLIT_MODELS[s.model].planes;
    const parts = [s.model];
    names.forEach((name, p) => {
      const dx = s.offsets[p * 2], dy = s.offsets[p * 2 + 1];
      if (dx || dy) parts.push(`${name.toLowerCase()}${dx}x${dy}`);
    });
    if (s.zoom) parts.push(`zoom${s.zoom}`);
    if (s.twist) parts.push(`twist${s.twist}`);
    if (s.tear) parts.push(`tear${s.tear}`, `band${s.band}`, `s${s.seed}`);
    if (s.wiring !== 'straight') parts.push(s.wiring);
    if (s.edge !== 'wrap') parts.push(s.edge);
    return parts;
  },
  surprise({ pick, between, chance, seed }, t) {
    const model = pick(Object.keys(SPLIT_MODELS));
    const count = SPLIT_MODELS[model].planes.length;
    const reach = Math.max(4, Math.round((t.source ? t.source.width : 800) * 0.04));
    return {
      model,
      offsets: t.defaults.offsets.map((_, i) => (i < count * 2 && chance(0.7) ? between(-reach, reach) : 0)),
      zoom: chance(0.35) ? between(-50, 50) : 0,
      twist: chance(0.3) ? between(-40, 40) : 0,
      tear: chance(0.5) ? between(10, 60) : 0,
      band: between(5, 60),
      seed: seed(),
      edge: pick(SPLIT_EDGES),
      wiring: chance(0.25) ? pick(SPLIT_WIRINGS) : 'straight',
    };
  },
  keys(e) {
    const key = e.key.toLowerCase();
    if (key === 's') return scatter(), true;
    if (key === 'a') return align(), true;
    const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
    if (!arrows[key] || e.target.closest('input, select')) return false;
    const step = e.shiftKey ? 10 : 1;
    movePlane(arrows[key][0] * step, arrows[key][1] * step);
    return true;
  },
});

// ── Plane chips ───────────────────────────────────────────────────────────────

function signed(n) {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
}

function syncPlanes(s) {
  const names = SPLIT_MODELS[s.model].planes;
  if (activePlane >= names.length) activePlane = 0;

  if (planesEl.dataset.model !== s.model) {
    planesEl.dataset.model = s.model;
    planesEl.replaceChildren(...names.map((name, p) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'plane';
      const luma = s.model === 'ycc' && name === 'Y';
      btn.style.setProperty('--ink', luma ? 'linear-gradient(90deg, #111, #eee)' : PLANE_INKS[name]);
      btn.title = `${luma ? 'Brightness' : PLANE_TITLES[name]}: click to pick it, double-click to put it back`;
      btn.innerHTML = '<span class="plane__swatch" aria-hidden="true"></span><span class="plane__name"></span><span class="plane__offset"></span>';
      btn.querySelector('.plane__name').textContent = name;
      btn.addEventListener('click', () => { activePlane = p; syncPlanes(tool.settings); });
      btn.addEventListener('dblclick', () => setOffset(p, 0, 0));
      return btn;
    }));
  }

  Array.from(planesEl.children).forEach((btn, p) => {
    const on = p === activePlane;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.querySelector('.plane__offset').textContent = `${signed(s.offsets[p * 2])}, ${signed(s.offsets[p * 2 + 1])}`;
  });

  document.getElementById('band-group').style.opacity = s.tear ? '' : '0.4';
}

function setOffset(plane, dx, dy) {
  const offsets = tool.settings.offsets.slice();
  offsets[plane * 2] = dx;
  offsets[plane * 2 + 1] = dy;
  tool.update({ offsets });
}

function movePlane(dx, dy) {
  const o = tool.settings.offsets;
  setOffset(activePlane, o[activePlane * 2] + dx, o[activePlane * 2 + 1] + dy);
}

function scatter() {
  const count = SPLIT_MODELS[tool.settings.model].planes.length;
  const reach = Math.max(4, Math.round((tool.source ? tool.source.width : 800) * 0.03));
  const offsets = tool.defaults.offsets.map((_, i) => (i < count * 2 ? Math.round((Math.random() * 2 - 1) * reach) : 0));
  tool.update({ offsets });
}

function align() {
  tool.update({ offsets: tool.defaults.offsets.slice() });
}

document.getElementById('btn-scatter').addEventListener('click', scatter);
document.getElementById('btn-align').addEventListener('click', align);

// ── Dragging a plane ──────────────────────────────────────────────────────────

let drag = null;
const canvas = tool.els.after;

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !tool.source) return;
  const o = tool.settings.offsets;
  const scale = canvas.width / canvas.getBoundingClientRect().width;
  drag = { x: e.clientX, y: e.clientY, dx: o[activePlane * 2], dy: o[activePlane * 2 + 1], scale };
  canvas.setPointerCapture(e.pointerId);
  tool.els.afterSurface.classList.add('is-dragging');
  e.preventDefault();
});

canvas.addEventListener('pointermove', e => {
  if (!drag) return;
  setOffset(
    activePlane,
    drag.dx + Math.round((e.clientX - drag.x) * drag.scale),
    drag.dy + Math.round((e.clientY - drag.y) * drag.scale),
  );
});

for (const type of ['pointerup', 'pointercancel']) {
  canvas.addEventListener(type, () => {
    drag = null;
    tool.els.afterSurface.classList.remove('is-dragging');
  });
}
