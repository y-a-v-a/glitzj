'use strict';

const D = MOSH_DEFAULTS;
const MAX_FRAMES = 120;

const btnPlay = document.getElementById('btn-play');
const playLabel = document.getElementById('play-label');
const btnDonor = document.getElementById('btn-donor');
const donorInput = document.getElementById('donor-input');

let playing = false;
let donor = null;
let donorCount = 0;

const tool = createTool({
  slug: 'mosh',
  busy: 'moshing',
  settings: {
    motion:     { default: D.motion, choices: MOSH_MOTIONS, hash: 'm' },
    strength:   { default: D.strength, min: -100, max: 100 },
    direction:  { default: D.direction, min: 0, max: 359, hash: 'dir', format: v => `${v}°` },
    block:      { default: D.block, choices: MOSH_BLOCKS },
    size:       { default: D.size, choices: MOSH_SIZES },
    correction: { default: D.correction, min: 0, max: 100, hash: 'fix' },
    seed:       { default: D.seed, min: 0, max: 2 ** 31 - 1, hash: 's' },
    frames:     { default: D.frames, min: 0, max: MAX_FRAMES, hash: 'f' },
  },
  *steps(source, settings) {
    const result = yield* moshSteps(source, settings, donor);
    const { vx, vy } = result.vectors;
    let still = 0;
    for (let i = 0; i < vx.length; i++) if (!vx[i] && !vy[i]) still++;
    result.info = [`${vx.length} blocks, ${vx.length - still} moving`];
    return result;
  },
  sync(s) {
    const show = (id, on) => { document.getElementById(id).hidden = !on; };
    show('direction-group', s.motion === 'pan' || s.motion === 'fall');
    show('strength-group', s.motion !== 'donor');
    show('seed-group', s.motion === 'scatter');
    btnDonor.hidden = s.motion !== 'donor';
    btnDonor.textContent = donor ? `Other picture: ${donor.name}` : 'Choose the other picture…';
    const searched = s.motion !== 'fall' && s.motion !== 'scatter';
    const group = document.getElementById('correction-group');
    group.style.opacity = searched ? '' : '0.4';
    group.title = searched ? '' : 'There is no next frame here, so there is nothing to correct';
  },
  nameParts(s) {
    const parts = [s.motion];
    if (s.motion !== 'donor') parts.push(`${s.strength}`);
    if (s.motion === 'pan' || s.motion === 'fall') parts.push(`dir${s.direction}`);
    parts.push(`b${s.block}`, `f${s.frames}`);
    if (s.correction) parts.push(`fix${s.correction}`);
    if (s.motion === 'scatter') parts.push(`s${s.seed}`);
    return parts;
  },
  surprise({ pick, between, chance, seed }) {
    const motion = pick(MOSH_MOTIONS.filter(m => m !== 'donor' || donor));
    return {
      motion,
      strength: (chance(0.5) ? 1 : -1) * between(20, 80),
      direction: between(0, 359),
      block: pick(MOSH_BLOCKS),
      correction: chance(0.2) ? between(5, 30) : 0,
      seed: seed(),
      frames: between(6, 60),
      size: tool.settings.size,
    };
  },
  keys(e) {
    if (e.key.toLowerCase() !== 'p') return false;
    togglePlay();
    return true;
  },
  // While playing, every finished frame asks for the next one. The run is
  // continued, not recomputed, so each step costs one frame of work.
  shown() {
    btnRecord.disabled = !recording.available();
    if (!playing) return;
    if (tool.settings.frames >= MAX_FRAMES) return stopPlay();
    setTimeout(() => { if (playing) tool.update({ frames: tool.settings.frames + 1 }); }, 33);
  },
});

// ── Play and record ───────────────────────────────────────────────────────────

const btnRecord = document.getElementById('btn-record');
const recording = toolRecorder(tool, {
  button: btnRecord,
  label: document.getElementById('record-label'),
  onStart: () => startPlay(0),
});

function startPlay(from) {
  if (!tool.source) return;
  playing = true;
  playLabel.textContent = 'Stop';
  tool.update({ frames: from });
}

function stopPlay() {
  playing = false;
  playLabel.textContent = 'Play';
  recording.stop();
}

function togglePlay() {
  if (playing) return stopPlay();
  startPlay(tool.settings.frames >= MAX_FRAMES ? 0 : tool.settings.frames + 1);
}

btnPlay.addEventListener('click', togglePlay);
document.getElementById('frames').addEventListener('pointerdown', stopPlay);

// ── The other picture ─────────────────────────────────────────────────────────

function loadDonor(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const width = Math.min(img.naturalWidth, 4000), height = Math.min(img.naturalHeight, 4000);
    URL.revokeObjectURL(url);
    if (!width || !height) return tool.showError('The other picture has no size the browser can draw.');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, width, height);
    donor = { rgba: ctx.getImageData(0, 0, width, height).data, width, height, id: ++donorCount, name: file.name || 'picture' };
    tool.update({ motion: 'donor' });
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    tool.showError('Could not decode the other picture.');
  };
  img.src = url;
}

btnDonor.addEventListener('click', () => donorInput.click());
donorInput.addEventListener('change', () => {
  if (donorInput.files[0]) loadDonor(donorInput.files[0]);
  donorInput.value = '';
});

// Picking "Another picture" before there is one opens the file dialog.
document.querySelector('[data-choice="motion"][data-value="donor"]').addEventListener('click', () => {
  if (!donor) donorInput.click();
});
