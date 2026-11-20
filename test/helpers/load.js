// Loads webapp scripts into the test's global scope, the way a page's script
// tags do, and makes a few test pictures.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(...files) {
  for (const file of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'webapp', file), 'utf8');
    vm.runInThisContext(src, { filename: file });
  }
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
}

// Every pixel a different random color: any pixel that moves is noticed.
function noisePicture(width, height, seed = 1) {
  const rand = lcg(seed);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = rand() * 256;
    rgba[i + 1] = rand() * 256;
    rgba[i + 2] = rand() * 256;
    rgba[i + 3] = 255;
  }
  return { rgba, width, height };
}

// Soft gradients, as a photo out of focus.
function smoothPicture(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      rgba[o] = 128 + 90 * Math.sin(x / width * 5 + y / height * 2);
      rgba[o + 1] = 128 + 90 * Math.cos(y / height * 4);
      rgba[o + 2] = 128 + 90 * Math.sin((x + y) / (width + height) * 6 + 1);
      rgba[o + 3] = 255;
    }
  }
  return { rgba, width, height };
}

function run(steps) {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

module.exports = { load, lcg, noisePicture, smoothPicture, run };
