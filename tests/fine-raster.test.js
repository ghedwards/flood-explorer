// The 5 m flood picture from LiDAR (viewer/fine-raster.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

(async () => {
  const { fineRaster, fineWindow, cropGrid } = await import('../viewer/fine-raster.js');

  // A 40×40 model (~28 m cells) over a 0.01° square: flat ground at 1 m,
  // water level 2 m in the west half (wet), dry in the east half.
  const aW = 40, aH = 40, N = aW * aH;
  const g = { west: 150, east: 150.01, south: -23.01, north: -23 };
  const dem = new Float32Array(N).fill(1), valid = new Uint8Array(N).fill(1), ocean = new Uint8Array(N);
  const wet = new Uint8Array(N), depth = new Float32Array(N);
  for (let y = 0; y < aH; y++) for (let x = 0; x < 20; x++) { wet[y * aW + x] = 1; depth[y * aW + x] = 1; }
  const coarse = new Uint8ClampedArray(N * 4);   // the model's own picture: transparent
  const common = {
    depthStops: [[0.5, [1, 1, 1]], [1, [2, 2, 2]], [2, [3, 3, 3]], [4, [4, 4, 4]], [Infinity, [5, 5, 5]]], depthAlpha0: 178,
    water: [9, 9, 9], channelAlpha: 90, hazardColors: [[11, 0, 0], [12, 0, 0], [13, 0, 0], [14, 0, 0], [15, 0, 0], [16, 0, 0]],
    hazardLimits: [[0.3, 2.0, 0.3], [0.5, 2.0, 0.6], [1.2, 2.0, 0.6], [2.0, 2.0, 1.0], [4.0, 4.0, 4.0]],
  };
  // 5 m output over the middle of the model, LiDAR ground 1 m with a 3 m mound
  const box = [150.002, -23.008, 150.008, -23.002];
  const W = 60, H = 60, lidar = new Float32Array(W * H).fill(1);
  for (let y = 20; y < 30; y++) for (let x = 5; x < 15; x++) lidar[y * W + x] = 3;   // the mound, in the wet half
  lidar[0] = -9999;   // one pixel without LiDAR
  const full = { x0: 0, y0: 0, ww: aW, wh: aH };
  const params = (win) => ({
    W, H, box, g, aW, aH, ...win, lidar, nd: -9999, ...common,
    dem: cropGrid(dem, aW, win), valid: cropGrid(valid, aW, win), ocean: cropGrid(ocean, aW, win),
    wet: cropGrid(wet, aW, win), depth: cropGrid(depth, aW, win), baseWet: null, baseDepth: null, hzCls: null, hzVel: null,
    coarse: cropGrid(coarse, aW, win, 4),
  });

  test('a window of the model gives the same picture as the whole grid', () => {
    const win = fineWindow(box, g, aW, aH);
    assert.ok(win.ww < aW || win.wh < aH, 'the window is smaller than the grid');
    const a = fineRaster(params(full)), b = fineRaster(params(win));
    assert.equal(a.have, b.have);
    assert.deepEqual(Buffer.from(a.rgba), Buffer.from(b.rgba));
  });

  test('ground above the water level stays dry at 5 m; wet ground gets its depth colour', () => {
    const { rgba, have } = fineRaster(params(full));
    assert.equal(have, W * H - 1, 'every pixel but the no-data one has LiDAR');
    const px = (x, y) => Array.from(rgba.slice((y * W + x) * 4, (y * W + x) * 4 + 4));
    assert.deepEqual(px(8, 25), [0, 0, 0, 0], 'the 3 m mound is above the 2 m water level');
    assert.deepEqual(px(2, 40), [3, 3, 3, 255], '1 m deep: the 1–2 m band, opaque');
    assert.equal(px(55, 40)[3], 0, 'the dry east half stays clear');
  });

  test('hazard: 5 m depth with the speed around, AIDR 7-3 limits', () => {
    const hzCls = new Uint8Array(N), hzVel = new Float32Array(N);
    for (let i = 0; i < N; i++) if (wet[i]) { hzCls[i] = 3; hzVel[i] = 1.5; }
    const p = params(full);
    p.hzCls = hzCls; p.hzVel = hzVel;
    const { rgba } = fineRaster(p);
    // 1 m deep at 1.5 m/s: d·v 1.5 > 1.0 → H5 (d ≤ 4, v ≤ 4, d·v ≤ 4)
    assert.deepEqual(Array.from(rgba.slice((40 * W + 2) * 4, (40 * W + 2) * 4 + 4)), [15, 0, 0, 255]);
  });
})();
