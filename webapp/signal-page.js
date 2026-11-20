'use strict';

const FRAME_MS = 1000 / 30;

const btnLive = document.getElementById('btn-live');
const btnRecord = document.getElementById('btn-record');
const recordLabel = document.getElementById('record-label');

let live = false;
let lastFrame = 0;
let frameTimer = 0;

const percent = { min: 0, max: 100 };
const D = SIGNAL_DEFAULTS;

const tool = createTool({
  slug: 'signal',
  busy: 'tuning',
  settings: {
    lines:    { default: D.lines, choices: SIGNAL_LINES },
    decoder:  { default: D.decoder, choices: SIGNAL_DECODERS, hash: 'set' },
    color:    { default: D.color, min: 0, max: 200 },
    tint:     { default: D.tint, min: -180, max: 180, format: v => `${v}°` },
    noise:    { default: D.noise, ...percent },
    ghost:    { default: D.ghost, ...percent },
    hue:      { default: D.hue, ...percent },
    bleed:    { default: D.bleed, ...percent },
    soft:     { default: D.soft, ...percent },
    jitter:   { default: D.jitter, ...percent },
    wobble:   { default: D.wobble, ...percent },
    hhold:    { default: D.hhold, min: -100, max: 100 },
    vhold:    { default: D.vhold, ...percent },
    tracking: { default: D.tracking, ...percent },
    dropouts: { default: D.dropouts, ...percent },
    seed:     { default: D.seed, min: 0, max: 2 ** 31 - 1, hash: 's' },
  },
  *steps(source, settings, t) {
    const result = yield* signalSteps(source, settings, live ? t.extra.frame : 0);
    result.info = [settings.decoder === 'mono' ? 'black and white' : 'NTSC'];
    return result;
  },
  sync(s) {
    const mono = s.decoder === 'mono';
    for (const key of ['color', 'tint', 'hue', 'bleed']) {
      const group = document.getElementById(`${key}-group`);
      group.style.opacity = mono ? '0.4' : '';
      group.title = mono ? 'A black and white set has no use for this' : '';
    }
  },
  nameParts(s) {
    const parts = [`${s.lines}lines`, s.decoder];
    for (const key of ['noise', 'ghost', 'hue', 'bleed', 'soft', 'jitter', 'wobble', 'hhold', 'vhold', 'tracking', 'dropouts']) {
      if (s[key]) parts.push(`${key}${s[key]}`);
    }
    if (s.color !== 100) parts.push(`color${s.color}`);
    if (s.tint) parts.push(`tint${s.tint}`);
    parts.push(`s${s.seed}`);
    return parts;
  },
  surprise({ pick, between, chance, seed }) {
    return {
      lines: pick(['240', '480', '480']),
      decoder: chance(0.6) ? 'notch' : chance(0.6) ? 'comb' : 'mono',
      color: between(70, 160),
      tint: chance(0.3) ? between(-60, 60) : 0,
      noise: between(0, 45),
      ghost: chance(0.5) ? between(10, 60) : 0,
      hue: between(0, 40),
      bleed: between(10, 90),
      soft: between(0, 60),
      jitter: chance(0.5) ? between(5, 60) : 0,
      wobble: between(0, 50),
      hhold: chance(0.15) ? between(-50, 50) : 0,
      vhold: chance(0.2) ? between(3, 60) : 0,
      tracking: chance(0.5) ? between(10, 70) : 0,
      dropouts: between(0, 50),
      seed: seed(),
    };
  },
  keys(e) {
    if (e.key.toLowerCase() !== 'l') return false;
    setLive(!live);
    return true;
  },
  // While live, every received frame asks for the next, no faster than a
  // television would show them.
  shown() {
    btnRecord.disabled = !recording.available();
    if (!live) return;
    const wait = Math.max(0, FRAME_MS - (performance.now() - lastFrame));
    clearTimeout(frameTimer);
    frameTimer = setTimeout(nextFrame, wait);
  },
});

tool.extra.frame = 0;

function nextFrame() {
  if (!live) return;
  lastFrame = performance.now();
  tool.extra.frame++;
  tool.render();
}

function setLive(on) {
  if (on === live) return;
  if (!on) recording.stop();
  live = on;
  btnLive.setAttribute('aria-pressed', String(on));
  tool.els.panelAfter.classList.toggle('is-live', on);
  if (on) nextFrame();
  else tool.render();
}

btnLive.addEventListener('click', () => setLive(!live));
document.addEventListener('visibilitychange', () => { if (document.hidden) setLive(false); });

// ── Recording ─────────────────────────────────────────────────────────────────

const recording = toolRecorder(tool, { button: btnRecord, label: recordLabel, onStart: () => setLive(true) });
