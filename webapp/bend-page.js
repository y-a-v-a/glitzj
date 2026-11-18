'use strict';

const SAMPLE_RATE = 44100;
const VOLUME = 0.2;

const knob = { min: 0, max: 100 };
const pedalSettings = {};
for (const name of BEND_PEDALS) {
  pedalSettings[name] = { default: BEND_DEFAULTS[name] };
  for (const suffix of ['A', 'B']) {
    const key = `${name}${suffix}`;
    if (BEND_DEFAULTS[key] !== undefined) pedalSettings[key] = { default: BEND_DEFAULTS[key], ...knob };
  }
}

// What the knobs that stand for something measurable are set to.
pedalSettings.speedA.format = v => `×${bendSpeedFactor(v).toFixed(3)}`;
pedalSettings.echoA.format = (v, s, t) => {
  if (!t.source) return v;
  const line = bendLine(t.source.width, t.source.height, s);
  const lines = bendEchoDelay(v, line) / line;
  if (lines >= 1) return `${lines.toFixed(1)} ${s.scan === 'columns' ? 'col' : 'rows'}`;
  return `${Math.round(lines * (s.scan === 'columns' ? t.source.height : t.source.width))} px`;
};
pedalSettings.crushA.format = v => `${(8 - v / 100 * 7).toFixed(1)} bit`;

const tool = createTool({
  slug: 'bend',
  busy: 'bending',
  settings: {
    scan:      { default: BEND_DEFAULTS.scan, choices: BEND_SCANS },
    tracks:    { default: BEND_DEFAULTS.tracks, choices: BEND_TRACKS },
    codec:     { default: BEND_DEFAULTS.codec, choices: BEND_CODECS },
    overflow:  { default: BEND_DEFAULTS.overflow, choices: BEND_OVERFLOWS },
    backwards: { default: BEND_DEFAULTS.backwards, hash: 'rev' },
    ...pedalSettings,
    filterType: { default: BEND_DEFAULTS.filterType, choices: BEND_FILTERS },
  },
  *steps(source, settings) {
    const result = yield* bendSteps(source, settings);
    const samples = result.tracks.reduce((sum, t) => sum + t.length, 0);
    const seconds = Math.round(samples / SAMPLE_RATE);
    result.info = [`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} of tape`];
    return result;
  },
  nameParts(s) {
    const parts = [s.scan, s.tracks === 'one' ? '1track' : '3tracks'];
    if (s.codec !== 'linear') parts.push(s.codec);
    if (s.overflow !== 'clip') parts.push(s.overflow);
    if (s.backwards) parts.push('backwards');
    for (const name of BEND_PEDALS) {
      if (!s[name]) continue;
      const b = s[`${name}B`];
      parts.push(`${name}${s[`${name}A`]}${b === undefined ? '' : `-${b}`}${name === 'filter' ? s.filterType : ''}`);
    }
    return parts;
  },
  keys(e) {
    if (e.key.toLowerCase() !== 'l') return false;
    toggleListen();
    return true;
  },
  shown() {
    btnListen.disabled = false;
    btnWav.disabled = false;
  },
});

// ── Listening ─────────────────────────────────────────────────────────────────
// The tape is far too long to hand to the sound card in one piece, so it is
// queued a quarter of a second at a time. Each piece is cut from the result
// that is on screen at that moment, so turning a knob is heard right away.

const btnListen = document.getElementById('btn-listen');
const btnWav = document.getElementById('btn-wav');
const listenLabel = document.getElementById('listen-label');
const playhead = document.getElementById('playhead');

const player = { ctx: null, gain: null, timer: 0, frame: 0, position: 0, nextTime: 0, startTime: 0, startPosition: 0 };

function tapeLength(result) {
  return result.tracks.reduce((sum, t) => sum + t.length, 0);
}

function tapeSlice(result, from, length) {
  const out = new Float32Array(length);
  let offset = 0, filled = 0;
  for (const track of result.tracks) {
    const start = Math.max(0, from - offset), end = Math.min(track.length, from + length - offset);
    if (end > start) {
      for (let i = start; i < end; i++) {
        const v = track[i];
        out[offset + i - from] = v < -1 ? -1 : v > 1 ? 1 : v;
      }
      filled += end - start;
    }
    offset += track.length;
  }
  return filled ? out : null;
}

function queueSound() {
  const { ctx } = player;
  const result = tool.result;
  if (!ctx || !result) return;
  const piece = Math.round(SAMPLE_RATE / 4);
  while (player.nextTime < ctx.currentTime + 0.5) {
    const samples = tapeSlice(result, player.position, piece);
    if (!samples) return stopListen();
    const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(player.gain);
    node.start(player.nextTime);
    player.nextTime += samples.length / SAMPLE_RATE;
    player.position += samples.length;
  }
}

function movePlayhead() {
  player.frame = requestAnimationFrame(movePlayhead);
  const result = tool.result;
  if (!player.ctx || !result) return;
  const sample = player.startPosition + Math.max(0, player.ctx.currentTime - player.startTime) * SAMPLE_RATE;
  const total = tapeLength(result);
  if (sample >= total) return;

  const pixels = result.width * result.height;
  const k = Math.min(pixels - 1, Math.floor(result.tracks.length === 1 ? sample / 3 : sample % pixels));
  const index = result.order ? result.order[k] : k;
  const x = (index % result.width + 0.5) / result.width;
  const y = (Math.floor(index / result.width) + 0.5) / result.height;
  const scan = tool.settings.scan;
  playhead.className = scan === 'hilbert' ? 'playhead' : scan === 'columns' ? 'playhead playhead--column' : 'playhead playhead--row';
  playhead.style.left = scan === 'rows' || scan === 'serpentine' ? '0' : `${x * 100}%`;
  playhead.style.top = scan === 'columns' ? '0' : `${y * 100}%`;
  playhead.hidden = false;
}

function startListen() {
  if (!tool.result) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return tool.showError('This browser cannot play sound from a page.');
  const ctx = new Ctx();
  player.ctx = ctx;
  player.gain = ctx.createGain();
  player.gain.gain.value = VOLUME;
  player.gain.connect(ctx.destination);
  player.position = player.startPosition = 0;
  player.startTime = player.nextTime = ctx.currentTime + 0.05;
  queueSound();
  player.timer = setInterval(queueSound, 100);
  player.frame = requestAnimationFrame(movePlayhead);
  listenLabel.textContent = 'Stop';
}

function stopListen() {
  clearInterval(player.timer);
  cancelAnimationFrame(player.frame);
  if (player.ctx) player.ctx.close();
  player.ctx = null;
  playhead.hidden = true;
  listenLabel.textContent = 'Listen';
}

function toggleListen() {
  if (player.ctx) stopListen();
  else startListen();
}

btnListen.addEventListener('click', toggleListen);
window.addEventListener('pagehide', stopListen);

btnWav.addEventListener('click', () => {
  if (!tool.result) return;
  const url = URL.createObjectURL(new Blob([bendWav(tool.result.tracks, SAMPLE_RATE)], { type: 'audio/wav' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = tool.resultName.replace(/\.png$/, '.wav');
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
});
