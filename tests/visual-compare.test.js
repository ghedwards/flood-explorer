const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');
const { compareVisual } = require('./visual-compare.js');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flood-visual-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const baselineDir = path.join(dir, 'baseline'), outputDir = path.join(dir, 'output');
  fs.mkdirSync(baselineDir);
  const png = new PNG({ width: 64, height: 64 });
  png.data.fill(255);
  const expected = PNG.sync.write(png);
  return { baselineDir, outputDir, expected, png };
}

test('a missing visual baseline fails and cannot silently seed an expectation', t => {
  const f = fixture(t);
  assert.throws(() => compareVisual('scene', f.expected, f), /Missing baseline/);
  assert.equal(fs.existsSync(path.join(f.baselineDir, 'scene.png')), false);
  assert.ok(fs.existsSync(path.join(f.outputDir, 'scene.actual.png')));
});

test('an unchanged scene passes and a missing visible region produces review artifacts', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.baselineDir, 'scene.png'), f.expected);
  assert.equal(compareVisual('scene', f.expected, f).fraction, 0);
  for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) {
    const i = (y * 64 + x) * 4;
    f.png.data[i] = 0; f.png.data[i + 1] = 80; f.png.data[i + 2] = 160;
  }
  assert.throws(() => compareVisual('scene', PNG.sync.write(f.png), f), /pixels changed/);
  for (const kind of ['actual', 'expected', 'diff']) assert.ok(fs.existsSync(path.join(f.outputDir, `scene.${kind}.png`)));
  assert.ok(fs.readFileSync(path.join(f.baselineDir, 'scene.png')).equals(f.expected));
});

test('viewport changes fail instead of comparing unlike image sizes', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.baselineDir, 'scene.png'), f.expected);
  const resized = PNG.sync.write(new PNG({ width: 32, height: 32 }));
  assert.throws(() => compareVisual('scene', resized, f), /image size changed/);
});

test('CI cannot update baselines even when update is requested explicitly', t => {
  const f = fixture(t), before = process.env.CI;
  t.after(() => { if (before === undefined) delete process.env.CI; else process.env.CI = before; });
  process.env.CI = 'true';
  assert.throws(() => compareVisual('scene', f.expected, { ...f, update: true }), /disabled in CI/);
  assert.equal(fs.existsSync(path.join(f.baselineDir, 'scene.png')), false);
});
