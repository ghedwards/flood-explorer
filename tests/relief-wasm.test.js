// The Rust/WASM shaded relief must match the JavaScript reference (viewer/relief.js) to within a colour step.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');

(async () => {
  const { terrainRGBA, HYPSO } = await import('../viewer/relief.js');
  const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  // hills with a coast, no-data holes, a sea mask or not
  function area(seed, W, H, cell, withOcean) {
    const r = rng(seed), N = W * H, dem = new Float32Array(N), valid = new Uint8Array(N).fill(1), ocean = new Uint8Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      dem[i] = x < W * 0.2 ? -3 : 5 + 40 * Math.sin(x / 9) * Math.cos(y / 7) + 0.2 * x + r() * 0.5;
      if (dem[i] < -1) ocean[i] = 1;
      if (r() < 0.01) valid[i] = 0;
    }
    return { W, H, N, cell, dem, valid, ocean: withOcean ? ocean : undefined };
  }

  test('the WASM relief matches the JavaScript one: same alpha and sea exactly, colours within one step in all but a few pixels', () => {
    assert.equal(typeof F.terrainRGBA, 'function');
    let channels = 0, off = 0, worst = 0;
    for (const [seed, W, H, cell, withOcean] of [[1, 60, 40, 30, true], [2, 150, 90, 30, false], [3, 223, 131, 60, true], [4, 37, 211, 12, true]]) {
      const a = area(seed, W, H, cell, withOcean);
      const js = terrainRGBA(a), rust = F.terrainRGBA(a, HYPSO);
      assert.ok(rust instanceof Uint8ClampedArray);
      assert.equal(rust.length, js.length);
      for (let i = 0; i < a.N; i++) {
        const o = i * 4;
        assert.equal(rust[o + 3], js[o + 3], `alpha at ${i}`);
        if (a.dem[i] < -1 || !a.valid[i]) { for (let k = 0; k < 3; k++) assert.equal(rust[o + k], js[o + k], `sea or no data at ${i}`); continue; }
        for (let k = 0; k < 3; k++) {
          const d = Math.abs(rust[o + k] - js[o + k]);
          channels++;
          if (d) { off++; worst = Math.max(worst, d); }
        }
      }
    }
    assert.ok(worst <= 1, `worst difference ${worst}`);
    assert.ok(off / channels < 0.002, `${off} of ${channels} channels differ`);
    console.log(`relief: ${off} of ${channels} colour channels differ, by at most ${worst}`);
  });

  test('the WASM relief takes the tint from the stops it is given and rejects inconsistent input', () => {
    const a = area(5, 30, 30, 30, true);
    const red = [[0, [255, 0, 0]], [1, [255, 0, 0]]];
    const px = F.terrainRGBA(a, red);
    let seen = false;
    for (let i = 0; i < a.N; i++) if (a.valid[i] && a.dem[i] >= -1) { assert.ok(px[i * 4] > 0 && px[i * 4 + 1] === 0 && px[i * 4 + 2] === 0, `pixel ${i}`); seen = true; }
    assert.ok(seen);
    assert.throws(() => F.terrainRGBA({ ...a, dem: a.dem.slice(0, 10) }, HYPSO), /inconsistent sizes/);
    assert.throws(() => F.terrainRGBA(a, [[0, [1, 2, 3]]]), /inconsistent sizes/);
  });
})();
