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
