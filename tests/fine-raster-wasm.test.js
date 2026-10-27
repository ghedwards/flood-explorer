// The Rust/WASM 5 m flood picture must match the JavaScript reference byte for byte.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');

(async () => {
  const { fineRaster, fineWindow, cropGrid } = await import('../viewer/fine-raster.js');

  const { scene } = require('./fine-scene.js');
  const fine = { fineWindow, cropGrid };

  test('the WASM picture matches the JavaScript one byte for byte, with every option on and off', () => {
    assert.equal(typeof F.fineRaster, 'function');
    let seed = 1, compared = 0, drawn = 0;
    for (const hazard of [false, true]) for (const baseline of [false, true]) for (const level of [false, true]) for (const window of [false, true]) {
      const p = scene(seed++, fine, { hazard, baseline, level, window });
      const js = fineRaster(p), rust = F.fineRaster(p);
      assert.equal(rust.have, js.have, `have, seed ${seed - 1}`);
      assert.equal(rust.rgba.length, js.rgba.length);
      assert.ok(rust.rgba instanceof Uint8ClampedArray);
      const a = Buffer.from(js.rgba.buffer, js.rgba.byteOffset, js.rgba.length), b = Buffer.from(rust.rgba.buffer, rust.rgba.byteOffset, rust.rgba.length);
      assert.ok(a.equals(b), `pixels differ for hazard=${hazard} baseline=${baseline} level=${level} window=${window}`);
      compared++;
      drawn += js.rgba.reduce((n, v, i) => n + (i % 4 === 3 && v > 0 ? 1 : 0), 0);
    }
    assert.equal(compared, 16);
    assert.ok(drawn > 16 * 1000, 'the scenes exercise the colour branches');
  });

  test('the WASM picture rejects inconsistent inputs instead of crashing', () => {
    const p = scene(99, fine, { hazard: false, baseline: false, level: false, window: false });
    assert.throws(() => F.fineRaster({ ...p, lidar: p.lidar.slice(0, 10) }), /inconsistent sizes/);
    assert.throws(() => F.fineRaster({ ...p, wet: p.wet.slice(0, 10) }), /differ in size/);
    assert.throws(() => F.fineRaster({ ...p, depthStops: [] }), /bad colour tables/);
    assert.throws(() => F.fineRaster({ ...p, hazardLimits: [[1, 2, 3]] }), /bad colour tables/);
    assert.throws(() => F.fineRaster({ ...p, ww: 0 }), /whole number|inconsistent/);
  });
})();
