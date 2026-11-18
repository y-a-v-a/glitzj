'use strict';

const playButton = document.getElementById('btn-play');
const playLabel = document.getElementById('play-label');
let playing = false;

const usesSeed = s => s.span === 'chunks' || s.algorithm === 'bogo' || s.jitter > 0;

const tool = createTool({
  slug: 'sort',
  busy: 'sorting',
  settings: {
    algorithm: { default: SORT_DEFAULTS.algorithm, choices: SORT_ALGORITHMS, hash: 'a' },
    progress:  { default: SORT_DEFAULTS.progress, min: 0, max: 100, hash: 'p', format: v => `${v}%` },
    jitter:    { default: SORT_DEFAULTS.jitter, min: 0, max: 100 },
    key:       { default: SORT_DEFAULTS.key, choices: SORT_KEYS, hash: 'by' },
    direction: { default: SORT_DEFAULTS.direction, choices: SORT_DIRECTIONS, hash: 'dir' },
    span:      { default: SORT_DEFAULTS.span, choices: SORT_SPANS },
    low:       { default: SORT_DEFAULTS.low, min: 0, max: 100 },
    high:      { default: SORT_DEFAULTS.high, min: 0, max: 100 },
    size:      { default: SORT_DEFAULTS.size, min: 1, max: 100 },
    seed:      { default: SORT_DEFAULTS.seed, min: 0, max: 2 ** 31 - 1, hash: 's' },
  },
  *steps(source, settings) {
    const result = yield* sortSteps(source, settings);
    const share = result.sorted / (result.width * result.height);
    result.info = [`${Math.round(share * 100)}% of the pixels in a sorted span`];
    return result;
  },
  sync(s) {
    const show = (id, on) => { document.getElementById(id).hidden = !on; };
    show('low-group', s.span === 'threshold');
    show('high-group', s.span === 'threshold');
    show('size-group', s.span === 'chunks');
    show('seed-group', usesSeed(s));
  },
  nameParts(s) {
    const parts = [s.algorithm, `p${s.progress}`, s.key, s.direction];
    if (s.span === 'threshold') parts.push(`${Math.min(s.low, s.high)}-${Math.max(s.low, s.high)}`);
    if (s.span === 'chunks') parts.push(`chunks${s.size}`);
    if (s.span === 'all') parts.push('all');
    if (s.jitter) parts.push(`uneven${s.jitter}`);
    if (usesSeed(s)) parts.push(`s${s.seed}`);
    return parts;
  },
  keys(e) {
    if (e.key.toLowerCase() !== 'p') return false;
    togglePlay();
    return true;
  },
  // While playing, every finished picture asks for the next one, so the sort
  // runs as fast as the pictures can be made and never faster.
  shown() {
    if (!playing) return;
    if (tool.settings.progress >= 100) return stopPlay();
    setTimeout(() => { if (playing) tool.update({ progress: tool.settings.progress + 1 }); }, 30);
  },
});

function stopPlay() {
  playing = false;
  playLabel.textContent = 'Play';
}

function togglePlay() {
  if (playing) return stopPlay();
  if (!tool.source) return;
  playing = true;
  playLabel.textContent = 'Stop';
  tool.update({ progress: tool.settings.progress >= 100 ? 0 : tool.settings.progress + 1 });
}

playButton.addEventListener('click', togglePlay);
document.getElementById('progress').addEventListener('pointerdown', stopPlay);
