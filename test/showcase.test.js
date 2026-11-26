const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, noisePicture, smoothPicture, run } = require('./helpers/load.js');

load('pixels.js', 'jpeg.js', 'png.js', 'gif.js', 'strategies.js', 'dither.js', 'crush.js', 'surgery.js',
  'split.js', 'sort.js', 'bend.js', 'misread.js', 'signal.js', 'mosh.js', 'showcase-data.js');

const page = file => fs.readFileSync(path.join(__dirname, '..', 'webapp', file), 'utf8');

const recipes = [
  ...SHOWCASE_EXHIBITS.flatMap(exhibit => exhibit.looks.map(look => ({ tool: exhibit.tool, settings: look.settings, name: `${exhibit.tool}: ${look.name}` }))),
  ...SHOWCASE_CHAINS.flatMap(chain => chain.steps.map(step => ({ tool: step.tool, settings: step.settings, name: `${chain.name}: ${step.tool}` }))),
];

test('there is an exhibit for every tool page, in the order of the menu', () => {
  const menu = [...page('showcase.html').matchAll(/class="site-nav__link" href="([a-z]+\.html)"/g)].map(m => m[1]);
  assert.deepEqual(SHOWCASE_EXHIBITS.map(exhibit => SHOWCASE_TOOLS[exhibit.tool].page), menu);
});

test('every page of the app links to the showcase', () => {
  for (const { page: file } of Object.values(SHOWCASE_TOOLS)) {
    assert.match(page(file), /href="showcase\.html"/, file);
  }
});

test('the short names in an address are the ones the tool pages use', () => {
  // The pages built on tool.js name them in their settings: `key: { …, hash: 'x' }`.
  for (const tool of ['surgery', 'split', 'sort', 'bend', 'misread', 'signal', 'mosh']) {
    const found = {};
    for (const m of page(`${tool}-page.js`).matchAll(/(\w+):\s*\{[^{}]*?\bhash: '(\w+)'/g)) found[m[1]] = m[2];
    assert.deepEqual(SHOWCASE_TOOLS[tool].keys, found, tool);
  }

  const crush = Function(`return ${page('crush-page.js').match(/const HASH_KEYS = (\{[^}]+\})/)[1]}`)();
  for (const [key, short] of Object.entries(crush)) {
    assert.equal(SHOWCASE_TOOLS.crush.keys[key] || key, short, `crush ${key}`);
  }

  const glitch = page('main.js');
  for (const short of ['fx', 'i', 's', 'f', 'png']) assert.ok(glitch.includes(`p.set('${short}'`), `glitch ${short}`);
});

test('the GIF dither defaults are those of its page', () => {
  const defaults = Function(`return ${page('gif-page.js').match(/const DEFAULTS = (\{[^}]+\})/)[1]}`)();
  assert.deepEqual(SHOWCASE_GIF_DEFAULTS, defaults);
});

test('a recipe only names settings its tool has', () => {
  for (const { tool, settings, name } of recipes) {
    const known = Object.keys(SHOWCASE_TOOLS[tool].defaults());
    for (const key of Object.keys(settings)) assert.ok(known.includes(key), `${name}: ${key}`);
  }
});

test('a recipe only names choices its tool offers', () => {
  const choices = {
    glitch: { filter: ['keep', ...PNG_FILTER_TYPES] },
    gif: { dither: DITHER_METHODS, palette: PALETTE_KINDS },
    crush: { subsampling: Object.keys(SUBSAMPLING) },
    surgery: { subsampling: Object.keys(SUBSAMPLING), sampling: SURGERY_SAMPLINGS },
    split: { model: Object.keys(SPLIT_MODELS), edge: SPLIT_EDGES, wiring: SPLIT_WIRINGS },
    sort: { algorithm: SORT_ALGORITHMS, key: SORT_KEYS, direction: SORT_DIRECTIONS, span: SORT_SPANS },
    bend: { scan: BEND_SCANS, tracks: BEND_TRACKS, codec: BEND_CODECS, overflow: BEND_OVERFLOWS, filterType: BEND_FILTERS },
    misread: { written: Object.keys(MISREAD_FORMATS), read: Object.keys(MISREAD_FORMATS), editor: MISREAD_EDITORS },
    signal: { lines: SIGNAL_LINES, decoder: SIGNAL_DECODERS },
    mosh: { motion: MOSH_MOTIONS.filter(m => m !== 'donor'), block: MOSH_BLOCKS, size: MOSH_SIZES },
  };
  const strategies = [...Object.keys(STRATEGY_FNS), ...Object.keys(PNG_STRATEGY_FNS), ...Object.keys(GIF_STRATEGY_FNS)];
  for (const { tool, settings, name } of recipes) {
    for (const [key, allowed] of Object.entries(choices[tool])) {
      if (key in settings) assert.ok(allowed.includes(settings[key]), `${name}: ${key} ${settings[key]}`);
    }
    if (tool === 'glitch') {
      assert.ok(settings.fx.length > 0, name);
      for (const fx of settings.fx) assert.ok(strategies.includes(fx), `${name}: ${fx}`);
    }
  }
});

test('an address holds only what differs from where the tool starts', () => {
  assert.equal(showcaseHash('sort', {}), '');
  assert.equal(showcaseHash('sort', { ...SORT_DEFAULTS }), '');
  assert.equal(showcaseHash('sort', { algorithm: 'heap', progress: 45, span: 'all', direction: 'down' }), 'a=heap&p=45&dir=down&span=all');
  assert.equal(showcaseHash('split', { model: 'cmyk', offsets: [-3, 0, 4, 0, 0, 0, 0, 0] }), 'm=cmyk&o=-3,0,4,0,0,0,0,0');
  assert.equal(showcaseHash('bend', { echo: false, reverb: true }), 'echo=0&reverb=1');
  assert.equal(showcaseHash('gif', { palette: 'duotone', dark: '#1b0a3c' }), 'palette=duotone&dark=%231b0a3c');
  assert.equal(showcaseHash('glitch', { fx: ['drift', 'smear'], intensity: 30, seed: 1 }), 'fx=drift,smear&i=30');
  assert.equal(showcaseLink('misread', { width: 1 }), 'misread.html');
  assert.equal(showcaseLink('crush', { quality: 6, generations: 30, shift: 3 }), 'crush.html#q=6&gen=30&shift=3');
});

test('a recipe in words uses the names of the settings', () => {
  assert.equal(showcaseRecipe('misread', { width: 1 }), 'as the tool starts');
  assert.equal(showcaseRecipe('bend', { echo: false, reverb: true, reverbA: 60 }), 'no echo · reverb · reverbA 60');
  assert.equal(showcaseRecipe('glitch', { fx: ['drift', 'prism'], png: true }), 'fx drift prism · png');
});

test('every recipe of a tool that works on pixels can be carried out, and changes the picture', () => {
  const steps = {
    surgery: surgerySteps, split: splitSteps, sort: sortSteps, bend: bendSteps,
    misread: misreadSteps, signal: signalSteps, mosh: moshSteps,
  };
  // Noise: every byte value occurs, so a recipe that looks for certain bytes finds them.
  const picture = noisePicture(96, 64);
  for (const { tool, settings, name } of recipes) {
    let made;
    if (steps[tool]) made = run(steps[tool]({ ...picture, cache: {} }, settings));
    else if (tool === 'crush') made = run(crushSteps(picture.rgba, picture.width, picture.height, settings));
    else if (tool === 'gif') made = renderDither(picture.rgba, picture.width, picture.height, { ...SHOWCASE_GIF_DEFAULTS, ...settings });
    else continue;
    const out = made.rgba || made.bytes;
    assert.ok(out.length > 0, name);
    if (made.rgba) assert.notDeepEqual(made.rgba, picture.rgba, name);
  }
});

test('the glitch recipes leave a JPEG that still parses', () => {
  const picture = smoothPicture(96, 64);
  const jpeg = crushJpeg(picture.rgba, picture.width, picture.height, { quality: 90, subsampling: '420' }).bytes;
  const scan = parseJpeg(jpeg);
  for (const { tool, settings, name } of recipes) {
    if (tool !== 'glitch' || settings.png) continue;
    const names = settings.fx.filter(fx => fx in STRATEGY_FNS);
    const buf = new Uint8Array(jpeg);
    runPipeline(buf, scan, new Set(names), settings.intensity, settings.seed);
    protectMarkers(buf, scan);
    assert.equal(buf.length, jpeg.length, name);
    assert.doesNotThrow(() => parseJpeg(buf), name);
  }
});
