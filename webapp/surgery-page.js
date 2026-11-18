'use strict';

const D = SURGERY_DEFAULTS;

const tool = createTool({
  slug: 'surgery',
  busy: 'operating',
  settings: {
    quality:     { default: D.quality, min: 1, max: 100, hash: 'q' },
    subsampling: { default: D.subsampling, choices: Object.keys(SUBSAMPLING), hash: 'sub' },
    low:         { default: D.low, min: 0, max: 63 },
    high:        { default: D.high, min: 0, max: 63 },
    shift:       { default: D.shift, min: 0, max: 62 },
    transplant:  { default: D.transplant, min: 0, max: 100, format: v => `${v}%` },
    drift:       { default: D.drift, min: 0, max: 100 },
    transpose:   { default: D.transpose, hash: 'mirror' },
    negate:      { default: D.negate },
    swapColors:  { default: D.swapColors, hash: 'swapc' },
    seed:        { default: D.seed, min: 0, max: 2 ** 31 - 1, hash: 's' },
    lie:         { default: D.lie },
    declared:    { default: D.declared, min: 1, max: 100, hash: 'claim' },
    widen:       { default: D.widen, min: -16, max: 16, format: v => (v > 0 ? `+${v}` : String(v)) },
    sampling:    { default: D.sampling, choices: SURGERY_SAMPLINGS, hash: 'claimsub' },
    swapTables:  { default: D.swapTables, hash: 'swapt' },
  },
  *steps(source, settings) {
    const result = yield* surgerySteps(source, settings);
    result.info = [result.honest ? 'honest header' : 'the header lies'];
    return result;
  },
  sync(s) {
    document.getElementById('declared-group').style.opacity = s.lie ? '' : '0.4';
    document.getElementById('seed-group').hidden = !(s.transplant || s.drift);
  },
  surprise({ pick, between, chance, seed }) {
    const quality = between(25, 80);
    return {
      quality,
      subsampling: pick(Object.keys(SUBSAMPLING)),
      low: chance(0.08) ? 1 : 0,
      high: chance(0.15) ? between(2, 12) : 63,
      shift: chance(0.2) ? between(1, 20) : 0,
      transplant: chance(0.25) ? between(10, 70) : 0,
      drift: chance(0.35) ? between(10, 60) : 0,
      transpose: chance(0.3),
      negate: chance(0.15),
      swapColors: chance(0.2),
      seed: seed(),
      lie: chance(0.6),
      declared: chance(0.75) ? between(3, quality) : between(quality, 100),
      widen: chance(0.25) ? between(-4, 4) : 0,
      sampling: chance(0.15) ? pick(SURGERY_SAMPLINGS) : 'honest',
      swapTables: chance(0.15),
    };
  },
  nameParts(s) {
    const parts = [`q${s.quality}`, s.subsampling];
    if (s.low !== 0 || s.high !== 63) parts.push(`band${Math.min(s.low, s.high)}-${Math.max(s.low, s.high)}`);
    if (s.shift) parts.push(`shift${s.shift}`);
    if (s.transplant) parts.push(`transplant${s.transplant}`);
    if (s.drift) parts.push(`drift${s.drift}`);
    if (s.transpose) parts.push('mirror');
    if (s.negate) parts.push('inverted');
    if (s.swapColors) parts.push('swapcolors');
    if (s.transplant || s.drift) parts.push(`s${s.seed}`);
    if (s.lie) parts.push(`claims-q${s.declared}`);
    if (s.widen) parts.push(`claims-w${s.widen > 0 ? '+' : ''}${s.widen}`);
    if (s.sampling !== 'honest' && s.sampling !== s.subsampling) parts.push(`claims-${s.sampling}`);
    if (s.swapTables) parts.push('swaptables');
    return parts;
  },
});
