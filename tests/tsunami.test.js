const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');
const fs = require('node:fs');
const path = require('node:path');
const gridModule = import('../viewer/tsunami-grid.js');

test('synthetic tsunami scenarios contain ocean and a signed source, with fixed dry land', async () => {
  const { tsunamiGrid } = await gridModule;
  for (const preset of ['flat', 'shelf', 'island']) {
    const grid = tsunamiGrid({ preset });
    assert.ok(grid.depth.some(d => d > 0));
    assert.equal(grid.depth.some(d => d === 0), preset !== 'flat');
    assert.ok(grid.eta.some(e => e > .9));
    assert.ok(grid.eta.some(e => e < -.9));
    assert.ok(grid.eta.every((e, i) => grid.depth[i] > 0 || e === 0));
  }
  assert.throws(() => tsunamiGrid({ source: [150, 48] }), /ocean/);
  assert.throws(() => tsunamiGrid({ source: [NaN, 48] }), /Invalid/);
  assert.throws(() => tsunamiGrid({ deep: -1 }), /Invalid/);
});

test('the WASM bridge propagates finite waves and conserves closed-basin displacement', async () => {
  const { tsunamiGrid } = await gridModule;
  for (const method of ['staggered', 'finite-volume']) for (const preset of ['flat', 'shelf', 'island']) {
    const grid = tsunamiGrid({ preset, absorbing: false, method });
    const initial = grid.eta.reduce((sum, e) => sum + e, 0) * grid.cell ** 2;
    const { dt } = F.tsunamiStart(grid);
    assert.ok(dt > 0 && dt < 10);
    let frame;
    for (let i = 0; i < 5; i++) frame = F.tsunamiStep(200);
    assert.ok(frame.eta.every(Number.isFinite));
    assert.ok(frame.peak.every((e, i) => e + 1e-6 >= Math.abs(frame.eta[i])));
    assert.ok(frame.eta.every((e, i) => grid.depth[i] > 0 || e === 0));
    assert.ok(Math.abs(frame.volume - initial) < .001, `${preset}: ${frame.volume - initial}`);
    assert.ok(Math.abs(frame.time - dt * 1000) < 1e-6);
  }
  assert.throws(() => F.tsunamiStep(201), /step count/);
});

test('zero displacement stays at rest through the WASM solver', async () => {
  const { tsunamiGrid } = await gridModule;
  F.tsunamiStart(tsunamiGrid({ amplitude: 0 }));
  const result = F.tsunamiStep(200);
  assert.ok(result.eta.every(e => e === 0));
  assert.equal(result.volume, 0);
});

test('prefetched Australian coastal terrain runs with both methods', async () => {
  const { tsunamiGrid } = await gridModule;
  for (const id of ['moreton', 'gold-coast', 'coffs', 'newcastle', 'sydney']) {
    const bathymetry = JSON.parse(fs.readFileSync(path.join(__dirname, '../viewer/public/tsunami-data', `${id}.json`)));
    assert.match(bathymetry.source, /Geoscience Australia/);
    assert.match(bathymetry.sourceUrl, /^https:\/\/services\.ga\.gov\.au\//);
    assert.ok(bathymetry.elevation.some(z => z > 0));
    assert.ok(bathymetry.elevation.some(z => z < -1000));
    const sourceIndex = bathymetry.elevation.findIndex((z, i) => z < -500 && i % 160 > 90 && Math.floor(i / 160) === 48);
    assert.ok(sourceIndex > 0);
    for (const method of ['staggered', 'finite-volume']) {
      const grid = tsunamiGrid({ preset: id, bathymetry, source: [sourceIndex % 160, 48], method });
      assert.ok(grid.depth.every((d, i) => bathymetry.elevation[i] < 0 ? d >= 10 : d === 0));
      F.tsunamiStart(grid);
      const result = F.tsunamiStep(100);
      assert.ok(result.eta.every(Number.isFinite));
      assert.ok(result.eta.every((e, i) => grid.depth[i] > 0 || e === 0));
    }
    assert.throws(() => tsunamiGrid({ preset: id, bathymetry: { ...bathymetry, elevation: [] } }), /Invalid/);
  }
});
