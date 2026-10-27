// The Rust/WASM gap classifier must match the JavaScript reference exactly.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');

(async () => {
  const { classifyDemGaps } = require('./dem-voids-reference.js');
  const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  // A DEM with a coast on a random side, lakes of no data, speckle holes, big inland holes
  // and holes touching the window edge.
  function demFor(seed, W, H) {
    const r = rng(seed), dem = new Float32Array(W * H);
    const coast = Math.floor(r() * 4), shore = 2 + r() * 40, width = Math.floor(W * (0.1 + r() * 0.3));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const d = [x, W - 1 - x, y, H - 1 - y][coast];
      dem[y * W + x] = d < width ? NaN : shore + (d - width) * 0.3 + r() * 3;
    }
    for (let k = 0; k < 6; k++) {   // blobs
      const cx = r() * W, cy = r() * H, rad = 1 + r() * Math.min(W, H) * 0.2;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.hypot(x - cx, y - cy) < rad) dem[y * W + x] = NaN;
    }
    for (let k = 0; k < W * H * 0.01; k++) dem[Math.floor(r() * W * H)] = NaN;
    return dem;
  }
  const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]) || (Number.isNaN(v) && Number.isNaN(b[i])));

  test('the WASM classification matches the JavaScript one exactly, in cells, sea mask and filled values', () => {
    assert.equal(typeof F.classifyDemGaps, 'function');
    let filled = 0, sea = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const W = 30 + (seed * 7) % 90, H = 25 + (seed * 11) % 80;
      const a = demFor(seed, W, H), b = a.slice();
      const js = classifyDemGaps(a, W, H), rust = F.classifyDemGaps(b, W, H);
      assert.deepEqual({ ...rust, sea: undefined }, { ...js, sea: undefined }, `counts, seed ${seed}`);
      assert.ok(same(rust.sea, js.sea), `sea mask, seed ${seed}`);
      assert.ok(same(b, a), `elevations, seed ${seed}`);
      filled += js.filledCells; sea += js.seaCells;
    }
    assert.ok(filled > 500 && sea > 500, `the cases exercise both branches (${filled} filled, ${sea} sea)`);
  });

  test('the WASM classification handles the same edge cases', () => {
    for (const make of [
      () => new Float32Array(12).fill(NaN),                 // all no data
      () => new Float32Array(12).fill(5),                   // no gaps
      () => Float32Array.from({ length: 12 }, (_, i) => (i === 5 ? NaN : 3)),   // one hole
    ]) {
      const a = make(), b = make();
      const js = classifyDemGaps(a, 4, 3), rust = F.classifyDemGaps(b, 4, 3);
      assert.equal(rust.seaCells, js.seaCells);
      assert.equal(rust.filledCells, js.filledCells);
      assert.equal(rust.gaps, js.gaps);
      assert.ok(same(b, a));
    }
    // a different shore limit changes which gaps are sea, the same way in both
    const W = 20, H = 20, make = () => Float32Array.from({ length: W * H }, (_, i) => (i % W < 6 ? NaN : 30 + (i % W)));
    const a = make(), b = make();
    assert.equal(F.classifyDemGaps(b, W, H, 100).seaCells, classifyDemGaps(a, W, H, 100).seaCells);
    assert.throws(() => F.classifyDemGaps(new Float32Array(10), 4, 3), /does not match/);
  });

  test('a large gap is quick in WASM', () => {
    const W = 2000, H = 2000, dem = new Float32Array(W * H).fill(300);
    for (let y = 0; y < 1800; y++) for (let x = 0; x < 1800; x++) dem[y * W + x] = NaN;
    const t0 = Date.now();
    const r = F.classifyDemGaps(dem, W, H);
    assert.equal(r.filledCells, 1800 * 1800);
    assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
    assert.ok(Math.abs(dem[0] - 300) < 1e-3);
  });
})();
