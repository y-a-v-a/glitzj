'use strict';

const FORMAT_KEYS = Object.keys(MISREAD_FORMATS);

const tool = createTool({
  slug: 'misread',
  busy: 'misreading',
  settings: {
    written: { default: MISREAD_DEFAULTS.written, choices: FORMAT_KEYS, hash: 'w' },
    editor:  { default: MISREAD_DEFAULTS.editor, choices: MISREAD_EDITORS, hash: 'ed' },
    read:    { default: MISREAD_DEFAULTS.read, choices: FORMAT_KEYS, hash: 'r' },
    width:   {
      default: MISREAD_DEFAULTS.width, min: -400, max: 400, hash: 'dw',
      format: (v, s, t) => (t.source ? `${Math.max(1, Math.min(MISREAD_MAX_HEIGHT, t.source.width + v))} px` : (v > 0 ? `+${v}` : String(v))),
    },
    skip:    { default: MISREAD_DEFAULTS.skip, min: 0, max: 16 },
    bits:    { default: MISREAD_DEFAULTS.bits, min: 0, max: 7 },
    reverse: { default: MISREAD_DEFAULTS.reverse, hash: 'rev' },
    swap:    { default: MISREAD_DEFAULTS.swap },
  },
  *steps(source, settings) {
    const result = yield* misreadSteps(source, settings);
    result.info = [`${result.written.toLocaleString('en')} bytes`];
    return result;
  },
  nameParts(s) {
    const parts = [s.written === s.read ? s.read : `${s.written}-as-${s.read}`];
    if (s.width) parts.push(`w${s.width > 0 ? '+' : ''}${s.width}`);
    if (s.editor !== 'none') parts.push(s.editor);
    if (s.skip) parts.push(`skip${s.skip}`);
    if (s.bits) parts.push(`bits${s.bits}`);
    if (s.reverse) parts.push('reversed');
    if (s.swap) parts.push('swapped');
    return parts;
  },
  surprise({ pick, between, chance }) {
    const written = pick(FORMAT_KEYS);
    const sameFormat = chance(0.5);
    return {
      written,
      read: sameFormat ? written : pick(FORMAT_KEYS),
      width: sameFormat || chance(0.3) ? between(-40, 40) : 0,
      editor: chance(0.35) ? pick(MISREAD_EDITORS) : 'none',
      skip: chance(0.2) ? between(1, 3) : 0,
      bits: chance(0.15) ? between(1, 7) : 0,
      reverse: chance(0.1),
      swap: chance(0.1),
    };
  },
  keys(e, t) {
    if (e.target.closest('input, select')) return false;
    if (e.key === 'ArrowLeft') return t.update({ width: t.settings.width - (e.shiftKey ? 10 : 1) }), true;
    if (e.key === 'ArrowRight') return t.update({ width: t.settings.width + (e.shiftKey ? 10 : 1) }), true;
    if (e.key === '0') return t.update({ width: 0 }), true;
    return false;
  },
});
