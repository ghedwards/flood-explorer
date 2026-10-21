// Gaps in an elevation window: sea at the coast, filled holes inland
// (viewer/dem-voids.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

(async () => {
  const { classifyDemGaps } = await import('../viewer/dem-voids.js');

  test('an inland gap is filled from the land around it, not made a pit', () => {
    const W = 20, H = 20, dem = new Float32Array(W * H).fill(170);
    for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) dem[y * W + x] = NaN;
    const r = classifyDemGaps(dem, W, H);
    assert.equal(r.seaCells, 0);
    assert.equal(r.filledCells, 16);
    for (let i = 0; i < W * H; i++) assert.ok(Math.abs(dem[i] - 170) < 1e-3, `cell ${i} is ${dem[i]}`);
  });

  test('no data along a low coast is sea', () => {
    const W = 20, H = 20, dem = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) dem[y * W + x] = x < 6 ? NaN : (x - 5) * 1.5;
    const r = classifyDemGaps(dem, W, H);
    assert.equal(r.seaCells, 6 * H);
    assert.equal(r.filledCells, 0);
    assert.equal(r.sea[0], 1);
    assert.ok(Number.isNaN(dem[0]), 'sea is left for the caller to set');
  });

  test('a gap at the window edge among high ground is a hole, not sea', () => {
    const W = 20, H = 20, dem = new Float32Array(W * H).fill(210);
    for (let y = 0; y < 3; y++) for (let x = 5; x < 9; x++) dem[y * W + x] = NaN;
    const r = classifyDemGaps(dem, W, H);
    assert.equal(r.seaCells, 0);
    assert.equal(r.filledCells, 12);
    assert.ok(Math.abs(dem[5] - 210) < 1e-3);
  });

  test('a filled gap blends the slope across it', () => {
    const W = 11, H = 3, dem = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) dem[y * W + x] = 100 + x * 10;
    for (let x = 3; x < 8; x++) dem[1 * W + x] = NaN;
    classifyDemGaps(dem, W, H);
    for (let x = 3; x < 8; x++) {
      const v = dem[1 * W + x];
      assert.ok(v > 125 && v < 185, `x=${x}: ${v}`);
    }
  });

  test('a very large gap fills in one pass (well under a second)', () => {
    const W = 1000, H = 1000, dem = new Float32Array(W * H).fill(300);
    for (let y = 0; y < 900; y++) for (let x = 0; x < 900; x++) dem[y * W + x] = NaN;
    const t0 = Date.now();
    const r = classifyDemGaps(dem, W, H);
    assert.equal(r.filledCells, 810000);
    assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
    assert.ok(Math.abs(dem[0] - 300) < 1e-3);
  });
})();
