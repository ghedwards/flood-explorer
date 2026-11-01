// Strict baseline comparison: a normal test run never writes expected images.
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch').default;

function compareVisual(name, actual, { baselineDir, outputDir, update = false, maxFraction = 0.005 }) {
  const baseline = path.join(baselineDir, `${name}.png`);
  if (update) {
    if (process.env.CI) throw new Error('Baseline updates are disabled in CI');
    fs.mkdirSync(baselineDir, { recursive: true });
    fs.writeFileSync(baseline, actual);
    return { updated: true, fraction: 0 };
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const actualFile = path.join(outputDir, `${name}.actual.png`);
  fs.writeFileSync(actualFile, actual);
  if (!fs.existsSync(baseline)) throw new Error(`Missing baseline ${baseline}; review and generate it with npm run test:visual:update`);
  const expected = PNG.sync.read(fs.readFileSync(baseline));
  const current = PNG.sync.read(actual);
  fs.copyFileSync(baseline, path.join(outputDir, `${name}.expected.png`));
  if (expected.width !== current.width || expected.height !== current.height) {
    throw new Error(`${name}: image size changed from ${expected.width}x${expected.height} to ${current.width}x${current.height}`);
  }
  const diff = new PNG({ width: current.width, height: current.height });
  // Ignore antialiased edge pixels; the cap still catches missing layers/tiles.
  const changed = pixelmatch(expected.data, current.data, diff.data, current.width, current.height, { threshold: 0.1, includeAA: false });
  const fraction = changed / (current.width * current.height);
  fs.writeFileSync(path.join(outputDir, `${name}.diff.png`), PNG.sync.write(diff));
  if (fraction > maxFraction) throw new Error(`${name}: ${(fraction * 100).toFixed(3)}% of pixels changed (limit ${maxFraction * 100}%); see ${outputDir}`);
  return { fraction };
}
module.exports = { compareVisual };
