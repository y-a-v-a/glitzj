'use strict';

// ── Showcase: what is shown ───────────────────────────────────────────────────
//
// The showcase page has no pictures of its own. It holds recipes: a tool and
// the settings to give it. The page carries them out on one photo with the
// tools' own code, so every picture on it is one the tool pages make too, and
// each recipe can be opened in its tool as an address.
//
// This file is the recipes and how to write one as such an address. It touches
// no page, so the tests can load it.

// The GIF dither page keeps its defaults in its page script; these are the same
// (the tests compare them).
const SHOWCASE_GIF_DEFAULTS = {
  dither: 'floyd-steinberg',
  strength: 100,
  serpentine: true,
  seed: 1,
  palette: 'adaptive',
  colors: 16,
  dark: '#000000',
  light: '#ffffff',
  dot: 1,
  brightness: 0,
  contrast: 0,
  full: true,
};

const SHOWCASE_GLITCH_DEFAULTS = {
  fx: [],
  intensity: 50,
  seed: 1,
  filter: 'keep',
  png: false,
};

// Per tool: its page, the settings it starts from, and the short names its
// page uses for settings in the address (a setting not listed goes by its own
// name).
const SHOWCASE_TOOLS = {
  glitch:  { page: 'index.html',   title: 'Glitch',       defaults: () => SHOWCASE_GLITCH_DEFAULTS, keys: { intensity: 'i', seed: 's', filter: 'f' } },
  gif:     { page: 'gif.html',     title: 'GIF dither',   defaults: () => SHOWCASE_GIF_DEFAULTS,    keys: {} },
  crush:   { page: 'crush.html',   title: 'JPEG crush',   defaults: () => CRUSH_DEFAULTS,           keys: { quality: 'q', chroma: 'cq', subsampling: 'sub', generations: 'gen' } },
  surgery: { page: 'surgery.html', title: 'JPEG surgery', defaults: () => SURGERY_DEFAULTS,         keys: { quality: 'q', subsampling: 'sub', transpose: 'mirror', swapColors: 'swapc', seed: 's', declared: 'claim', sampling: 'claimsub', swapTables: 'swapt' } },
  split:   { page: 'split.html',   title: 'Split',        defaults: () => SPLIT_DEFAULTS,           keys: { model: 'm', offsets: 'o', seed: 's', wiring: 'w' } },
  sort:    { page: 'sort.html',    title: 'Sort',         defaults: () => SORT_DEFAULTS,            keys: { algorithm: 'a', progress: 'p', key: 'by', direction: 'dir', seed: 's' } },
  bend:    { page: 'bend.html',    title: 'Bend',         defaults: () => BEND_DEFAULTS,            keys: { backwards: 'rev' } },
  misread: { page: 'misread.html', title: 'Misread',      defaults: () => MISREAD_DEFAULTS,         keys: { written: 'w', editor: 'ed', read: 'r', width: 'dw', reverse: 'rev' } },
  signal:  { page: 'signal.html',  title: 'Signal',       defaults: () => SIGNAL_DEFAULTS,          keys: { decoder: 'set', seed: 's' } },
  mosh:    { page: 'mosh.html',    title: 'Mosh',         defaults: () => MOSH_DEFAULTS,            keys: { motion: 'm', direction: 'dir', correction: 'fix', seed: 's', frames: 'f' } },
};

// What a recipe changes: every setting that differs from where the tool
// starts, as [name, text] pairs in the tool's own order.
function showcaseChanges(tool, settings) {
  const start = SHOWCASE_TOOLS[tool].defaults();
  const changes = [];
  for (const key of Object.keys(start)) {
    if (!(key in settings)) continue;
    const value = settings[key], d = start[key];
    if (Array.isArray(d) ? value.join() === d.join() : value === d) continue;
    changes.push([key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value)]);
  }
  return changes;
}

// The settings as the tool's page writes them in its address.
function showcaseHash(tool, settings) {
  const { keys } = SHOWCASE_TOOLS[tool];
  return showcaseChanges(tool, settings)
    .map(([key, text]) => `${keys[key] || key}=${encodeURIComponent(text).replace(/%2C/g, ',')}`)
    .join('&');
}

function showcaseLink(tool, settings) {
  const hash = showcaseHash(tool, settings);
  return SHOWCASE_TOOLS[tool].page + (hash ? `#${hash}` : '');
}

// Bend starts with its echo pedal on; a look names the pedals it wants.
const PEDALS_OFF = { speed: false, drive: false, crush: false, filter: false, phaser: false, vibrato: false, echo: false, reverb: false };

// The ten tools, in the order of the menu. `how` is the mechanism and what is
// done wrong with it; every look is one result, with what to notice in it.
const SHOWCASE_EXHIBITS = [
  {
    tool: 'glitch',
    line: 'Damage the bytes, keep the file',
    how: 'A JPEG is a long run of compressed data, and every value in it leans on the ones before. Change a few bytes and the decoder carries the mistake along: colors slide, rows tear, bands repeat. The damage stays inside the picture data, so what comes out is still a JPEG that opens anywhere.',
    looks: [
      { name: 'Drift', note: 'A stretch of data moved forward. From there on the decoder is out of step: the rows below no longer line up, and a piece of the picture turns up where it does not belong.', settings: { fx: ['drift'], intensity: 15, seed: 8 } },
      { name: 'Static', note: 'A few bytes in every thousand replaced by noise. Every value in a JPEG leans on the one before, so each wrong byte colors the rest of its row.', settings: { fx: ['static'], intensity: 4, seed: 2 } },
      { name: 'As PNG, Paeth', note: 'The same photo stored as a PNG first. A PNG row is written as differences from the pixels around it, so one wrong byte spreads down and to the right as blocks.', settings: { fx: ['static'], intensity: 6, seed: 2, filter: 'paeth', png: true } },
      { name: 'As PNG, prism', note: 'Rows decoded with the wrong filter, and stored as differences to the left: streaks of shifted color, all the way to the edge.', settings: { fx: ['drift', 'prism'], intensity: 45, seed: 3, filter: 'sub', png: true } },
    ],
  },
  {
    tool: 'gif',
    line: 'Too few colors, on purpose',
    how: 'A GIF holds at most 256 colors, and nothing says you have to use them all. Give a photo four and the colors that are missing have to be faked with dots. The pattern of those dots is the picture now.',
    looks: [
      { name: 'Five colors, Atkinson', note: 'Five colors picked from the photo. Atkinson throws a quarter of every rounding error away, which keeps the dots open and the contrast hard.', settings: { dither: 'atkinson', colors: 5, dot: 3, contrast: 15 } },
      { name: 'Duotone, Bayer', note: 'Two inks and a fixed crosshatch. The pattern does not follow the picture at all; the picture only decides where it is switched on.', settings: { dither: 'bayer-8', palette: 'duotone', colors: 2, dark: '#1b0a3c', light: '#ffe45c', dot: 2 } },
      { name: 'Eight primaries', note: 'Black, white, red, green, blue, cyan, magenta and yellow, and nothing in between. Every other color is a mix of dots.', settings: { dither: 'floyd-steinberg', palette: 'rgb', dot: 2 } },
      { name: 'Noise, one bit', note: 'Black or white, decided by a coin that the picture has loaded. Dots of three by three pixels.', settings: { dither: 'noise', strength: 55, palette: 'grayscale', colors: 2, dot: 3, seed: 7 } },
    ],
  },
  {
    tool: 'crush',
    line: 'Quality zero, and then again',
    how: 'JPEG saves space by describing blocks of eight by eight pixels roughly. Most programs refuse to go below a certain roughness. This encoder goes to the bottom of the scale, where a block is one flat color or a single wave, and then it does it again.',
    looks: [
      { name: 'Quality 0', note: 'Every step size at 255, the most the format allows. Each block keeps its average and little else.', settings: { quality: 0 } },
      { name: 'Thirty generations', note: 'Compressed, opened and compressed again thirty times, moved three pixels in between so the blocks land somewhere new each time and the damage adds up.', settings: { quality: 6, generations: 30, shift: 3 } },
      { name: 'Color crushed, detail kept', note: 'Brightness at quality 70, color at 0 and one color sample for every four by two pixels: a sharp picture with paint poured over it.', settings: { quality: 70, split: true, chroma: 0, subsampling: '410' } },
      { name: 'Detail crushed, color kept', note: 'The other way around: brightness at 0, color at 90 and at full resolution.', settings: { quality: 0, split: true, chroma: 90, subsampling: '444' } },
    ],
  },
  {
    tool: 'surgery',
    line: 'Operate on the numbers, lie in the header',
    how: 'A JPEG does not store pixels. It stores, for every block, how much of 64 wave patterns the block holds, and its header says how to read those numbers. This tool cuts into the numbers, and writes things into the header that are not true. The decoder believes all of it.',
    looks: [
      { name: 'A lie about the quality', note: 'Compressed at quality 50, with a header that claims 5. The decoder multiplies every number by far too much.', settings: { quality: 50, lie: true, declared: 5 } },
      { name: 'No averages', note: 'Every block loses its first number, its average color. What is left is the detail, on gray.', settings: { quality: 60, lie: false, low: 1 } },
      { name: 'A lie about the width', note: 'The header claims two blocks more per row than there are. The decoder breaks every row in the wrong place and the picture leans over, in steps of whole blocks.', settings: { quality: 55, lie: false, widen: 2 } },
      { name: 'Drift', note: 'A block stores its average as the difference from the block before it. Change a few and everything after them shifts, until the next change.', settings: { quality: 70, lie: false, drift: 45, seed: 3 } },
    ],
  },
  {
    tool: 'split',
    line: 'One picture is several, held in register',
    how: 'A color picture is a stack of pictures: three lights on a screen, four inks on a press, a brightness and two color signals in video. It only looks like one while they lie exactly on top of each other. Here they are taken apart and put back carelessly.',
    looks: [
      { name: 'Four inks, out of register', note: 'Cyan, magenta, yellow and black, each printed a little off. Where an ink is missing you see paper.', settings: { model: 'cmyk', offsets: [-34, 10, 26, -12, 6, 30, 0, 0], edge: 'smear' } },
      { name: 'Cheap lens', note: 'Red a little smaller, blue a little larger, and each turned against the other. They agree in the middle and drift apart toward the edges.', settings: { model: 'rgb', zoom: 34, twist: 18, edge: 'smear' } },
      { name: 'Torn video', note: 'Brightness stays where it is. The two color signals are cut into bands and pushed sideways, so the color belongs to another part of the picture.', settings: { model: 'ycc', offsets: [0, 0, 36, 0, -28, 10, 0, 0], tear: 55, band: 22, seed: 4 } },
      { name: 'Crossed wires', note: 'Every plate inked with the next one\'s color, and printed out of register: the cyan picture in magenta, the magenta one in yellow.', settings: { model: 'cmyk', wiring: 'next', offsets: [-20, 8, 16, -8, 4, 18, 0, 0], edge: 'smear' } },
    ],
  },
  {
    tool: 'sort',
    line: 'Pull the plug on the algorithm',
    how: 'Sort the pixels of a row by brightness and a photo becomes streaks. A finished sort looks the same whichever algorithm did it. One that is stopped halfway does not: each algorithm leaves the mess of its own way of working.',
    looks: [
      { name: 'Bubble, by hue', note: 'Bubble sort carries one pixel at a time along the row. Stopped early, it has dragged whole patches of color sideways and left the rest where it was.', settings: { algorithm: 'bubble', progress: 34, key: 'hue', span: 'all' } },
      { name: 'Heap, halfway', note: 'Heap sort first lays the pixels out as a tree, each level twice as long as the one before. This is that tree, top down.', settings: { algorithm: 'heap', progress: 45, span: 'all', direction: 'down' } },
      { name: 'Merge, unmerged', note: 'Merge sort makes sorted runs of 2, 4, 8 pixels and joins them. Stopped before the joining is done, every run is a small gradient of its own.', settings: { algorithm: 'merge', progress: 55, key: 'hue', span: 'all', direction: 'down' } },
      { name: 'Quick, by saturation', note: 'Quick sort splits everything into less and more, again and again. Halfway, each part is in the right place and a jumble inside.', settings: { algorithm: 'quick', progress: 45, key: 'saturation', span: 'all' } },
    ],
  },
  {
    tool: 'bend',
    line: 'Play the picture as a tape',
    how: 'The oldest trick in databending: open a picture in a sound editor as if it were a recording, add effects, save it as a picture again. Here the picture becomes one long tape that runs through a pedalboard. An echo in the sound is a ghost in the picture.',
    looks: [
      { name: 'Echo', note: 'Red, green and blue lie in turn on one track, and the echo is not a whole number of pixels long. It lands on the wrong color, which is where the rainbows come from.', settings: { ...PEDALS_OFF, echo: true, echoA: 62, echoB: 55 } },
      { name: 'Reverb along a Hilbert curve', note: 'The tape winds through the picture along a curve that keeps near things near. The same reverb now spreads in blocks instead of to the right.', settings: { ...PEDALS_OFF, scan: 'hilbert', tracks: 'three', reverb: true, reverbA: 60, reverbB: 65 } },
      { name: 'Telephone and phaser', note: 'Imported as µ-law, the telephone encoding in which mid gray is the loudest sound there is. The same pedals do something else entirely.', settings: { ...PEDALS_OFF, codec: 'ulaw', phaser: true, phaserA: 55, phaserB: 80, drive: true, driveA: 25, driveB: 50 } },
      { name: 'A filter that rings', note: 'A resonant filter turned up until it rings after every edge, with a tape that runs a little fast and so tilts the frame.', settings: { ...PEDALS_OFF, tracks: 'three', filter: true, filterA: 30, filterB: 88, speed: true, speedA: 54, overflow: 'wrap' } },
    ],
  },
  {
    tool: 'misread',
    line: 'The right bytes, the wrong agreement',
    how: 'Without its header a picture is a row of bytes that mean nothing. How wide it is, which byte is red and how many bits make a pixel are an agreement between writer and reader. This tool writes the picture down correctly and then breaks the agreement. Nothing here is random.',
    looks: [
      { name: 'One pixel too wide', note: 'The reader thinks the picture is one pixel wider than it is. Every row starts one pixel later than the row above, and the picture leans.', settings: { width: 1 } },
      { name: 'Blue for red', note: 'Two pixels too wide, and the reader expects blue where red was written.', settings: { read: 'bgr24', width: 2 } },
      { name: 'Saved by a text editor', note: 'An editor wrote Windows line endings: it added a byte before every byte that happened to look like a line feed. Each one pushes the rest of the picture a byte along, and the colors turn.', settings: { editor: 'crlf', width: 0 } },
      { name: 'Planes read as pixels', note: 'Written as all the red, then all the green, then all the blue. Read as red, green and blue per pixel, that is nine small gray pictures.', settings: { written: 'planar', read: 'rgb24', width: 0 } },
    ],
  },
  {
    tool: 'signal',
    line: 'Send it as television, receive it badly',
    how: 'Analog color television put a whole picture on one wire as a single wavering voltage, with color riding on top as a small fast wave. The receiver has to pull the two apart again and never quite can. This tool builds that signal, damages it and receives it the way a television does.',
    looks: [
      { name: 'A weak signal', note: 'Snow, a faint second copy that arrived off a building, lines that do not start quite where they should, and a band of torn lines from a worn tape.', settings: { noise: 28, ghost: 35, jitter: 22, wobble: 28, tracking: 35, dropouts: 30, bleed: 60 } },
      { name: 'Ghost with the wrong colors', note: 'The late copy has other colors than the picture, because its color wave arrives shifted. A comb filter leaves dots hanging under every color edge.', settings: { decoder: 'comb', noise: 4, ghost: 70, hue: 45, bleed: 70, jitter: 0, wobble: 25, tracking: 0, dropouts: 0 } },
      { name: 'Lost its hold', note: 'Both hold knobs turned too far. The picture leans and rolls, and the gaps between lines and between frames show as dark bars.', settings: { noise: 8, ghost: 0, hhold: 38, vhold: 34, tracking: 40, dropouts: 30, seed: 5 } },
      { name: 'Color on a black and white set', note: 'A set that knows nothing of color shows the color wave as what it is: a fine pattern of dots wherever the picture is colorful.', settings: { decoder: 'mono', lines: '240', noise: 20, ghost: 25, jitter: 20, wobble: 30, tracking: 25 } },
    ],
  },
  {
    tool: 'mosh',
    line: 'Motion without a picture to move',
    how: 'Video is mostly instructions: take this block from where it was a moment ago. Remove the full pictures in between and the instructions are carried out on the wrong picture, over and over. A still has no motion, so this tool invents the next frame, searches for the motion as an encoder would, and then never stops applying it.',
    looks: [
      { name: 'Zoom, 24 frames', note: 'The camera moves in a little, once. The same instructions are then carried out 24 times, and whatever the search got wrong grows.', settings: { motion: 'zoom', strength: 40, frames: 24 } },
      { name: 'Fall', note: 'No search: the brighter a block, the further up it takes its pixels from. Bright things run down the picture.', settings: { motion: 'fall', strength: 55, direction: 90, block: '8', frames: 30 } },
      { name: 'Spin, with the correction left in', note: 'A codec adds a correction for what motion cannot explain. Here it is added again every frame, and burns in.', settings: { motion: 'spin', strength: 45, block: '16', correction: 22, frames: 18 } },
      { name: 'Scatter', note: 'Every block takes its pixels from somewhere nearby, in large blocks, twelve times.', settings: { motion: 'scatter', strength: 60, block: '32', frames: 12, seed: 9 } },
    ],
  },
];

// Results fed back in: every step works on what the step before it made.
const SHOWCASE_CHAINS = [
  {
    name: 'Sorted, broadcast, crushed',
    note: 'A heap sort stopped halfway, sent through a television with a ghost, and what arrived saved as a JPEG at the bottom of the scale.',
    steps: [
      { tool: 'sort', settings: { algorithm: 'heap', progress: 55, span: 'threshold', low: 20, high: 85, key: 'hue' } },
      { tool: 'signal', settings: { decoder: 'comb', color: 150, ghost: 45, hue: 30, noise: 6, wobble: 30, tracking: 20 } },
      { tool: 'crush', settings: { quality: 4, subsampling: '411' } },
    ],
  },
  {
    name: 'Printed, dotted, torn',
    note: 'Four inks out of register, redrawn in eight colors, and then the codes inside that GIF damaged so the rows shift sideways.',
    steps: [
      { tool: 'split', settings: { model: 'cmyk', offsets: [-30, 8, 22, -10, 6, 26, 0, 0], tear: 20, band: 40, seed: 3, edge: 'smear' } },
      { tool: 'gif', settings: { dither: 'atkinson', palette: 'rgb', dot: 2 } },
      { tool: 'glitch', settings: { fx: ['static', 'drift'], intensity: 35, seed: 2 } },
    ],
  },
  {
    name: 'Moved, misread, echoed',
    note: 'A fall of 20 frames, read back one pixel too wide and with blue for red, and then played through an echo along a Hilbert curve.',
    steps: [
      { tool: 'mosh', settings: { motion: 'fall', strength: 50, direction: 90, block: '16', frames: 20 } },
      { tool: 'misread', settings: { read: 'bgr24', width: 1 } },
      { tool: 'bend', settings: { ...PEDALS_OFF, scan: 'hilbert', echo: true, echoA: 40, echoB: 60 } },
    ],
  },
];

// A recipe in a few words, for under the picture.
function showcaseRecipe(tool, settings) {
  const words = showcaseChanges(tool, settings).map(([key, text]) => {
    if (text === '1') return key;
    if (text === '0') return `no ${key}`;
    return `${key} ${text.replace(/,/g, ' ')}`;
  });
  return words.length ? words.join(' · ') : 'as the tool starts';
}
