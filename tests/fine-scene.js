// A random scene for the 5 m picture tests: a 60 x 50 model over a small box with land, water, ocean,
// invalid cells, a normal-river baseline, hazard speeds and LiDAR holes, and a 90 x 70 pixel picture.
// `fine` is { fineWindow, cropGrid } from viewer/fine-raster.js (an ES module, so passed in).
'use strict';

const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const common = {
  depthStops: [[0.5, [10, 20, 30]], [1, [40, 50, 60]], [2, [70, 80, 90]], [4, [100, 110, 120]], [Infinity, [130, 140, 300]]], depthAlpha0: 178.4,
  water: [9, 8, 7], channelAlpha: 90, hazardColors: [[253, 231, 37], [122, 209, 81], [34, 168, 132], [42, 120, 142], [65, 68, 135], [68, 1, 84]],
  hazardLimits: [[0.3, 2.0, 0.3], [0.5, 2.0, 0.6], [1.2, 2.0, 0.6], [2.0, 2.0, 1.0], [4.0, 4.0, 4.0]],
};

// A random 60 x 50 model over a small box, with a mix of land, water, ocean, invalid
// cells, a normal-river baseline, hazard speeds and LiDAR holes.
function scene(seed, { fineWindow, cropGrid }, { hazard, baseline, level, window }) {
  const r = rng(seed), aW = 60, aH = 50, N = aW * aH;
  const g = { west: 151.2, east: 151.2 + 0.012, south: -27.55 - 0.01, north: -27.55 };
  const dem = new Float32Array(N), valid = new Uint8Array(N), ocean = new Uint8Array(N), wet = new Uint8Array(N), depth = new Float32Array(N);
  const baseWet = new Uint8Array(N), baseDepth = new Float32Array(N), hzCls = new Uint8Array(N), hzVel = new Float32Array(N), lv = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    dem[i] = 1 + r() * 4;
    valid[i] = r() < 0.97 ? 1 : 0;
    ocean[i] = r() < 0.08 ? 1 : 0;
    wet[i] = r() < 0.5 ? 1 : 0;
    depth[i] = wet[i] ? r() * 3 : 0;
    baseWet[i] = r() < 0.2 ? 1 : 0;
    baseDepth[i] = baseWet[i] ? r() * 0.8 : 0;
    hzCls[i] = r() < 0.7 ? 1 : 0;
    hzVel[i] = r() * 3;
    lv[i] = r() < 0.15 ? NaN : dem[i] + depth[i] + r() * 0.3;
  }
  const coarse = new Uint8ClampedArray(N * 4).map(() => Math.floor(r() * 256));
  const box = [151.2 + 0.002, -27.56 + 0.002, 151.2 + 0.01, -27.55 - 0.001];
  const W = 90, H = 70, lidar = new Float32Array(W * H);
  for (let i = 0; i < lidar.length; i++) lidar[i] = r() < 0.05 ? -9999 : r() < 0.02 ? NaN : r() < 0.02 ? 12000 : 0.5 + r() * 5;
  const win = window ? fineWindow(box, g, aW, aH) : { x0: 0, y0: 0, ww: aW, wh: aH };
  return {
    W, H, box, g, aW, aH, ...win, lidar, nd: -9999, ...common,
    dem: cropGrid(dem, aW, win), valid: cropGrid(valid, aW, win), ocean: cropGrid(ocean, aW, win), wet: cropGrid(wet, aW, win), depth: cropGrid(depth, aW, win),
    level: level ? cropGrid(lv, aW, win) : null,
    baseWet: baseline ? cropGrid(baseWet, aW, win) : null, baseDepth: baseline ? cropGrid(baseDepth, aW, win) : null,
    hzCls: hazard ? cropGrid(hzCls, aW, win) : null, hzVel: hazard ? cropGrid(hzVel, aW, win) : null,
    coarse: cropGrid(coarse, aW, win, 4),
  };
}

module.exports = { scene, rng };
