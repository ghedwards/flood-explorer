// Mesh helpers for the experimental 3D view (viewer/terrain3d.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

(async () => {
  const t3d = await import('../viewer/terrain3d.js');

// A tiny synthetic analysis grid: land sloping up from the west, a river
// bed along x=20..30, ocean at y<2, NoData at x>=W-2.
function makeGrid(W = 40, H = 30, cell = 10) {
  const N = W * H;
  const dem = new Float32Array(N);
  const valid = new Uint8Array(N).fill(1);
  const ocean = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    dem[i] = 2 + 0.05 * x;
    if (y < 2) { ocean[i] = 1; dem[i] = 0; }
    if (x >= W - 2) valid[i] = 0;
  }
  return { W, H, N, cell, dem, valid, ocean };
}

test('decimateStep caps the sample grid and stays even', () => {
  assert.equal(t3d.decimateStep(100, 80), 2);
  assert.equal(t3d.decimateStep(100, 79), 2);   // even-ified from 3
  const big = t3d.decimateStep(4000, 4000);
  assert.ok(big % 2 === 0);
  assert.ok(Math.ceil(4000 / big) <= t3d.MAX_SIDE);
  assert.equal(t3d.decimateStep(10, 10), 2);
});

test('terrainMesh skips invalid cells and keeps AHD heights', () => {
  const a = makeGrid();
  // colour a sampled land cell: y=2, x=4 (even rows/cols are sampled at skip 2)
  const pick = 2 * a.W + 4;
  const rgba = new Uint8ClampedArray(a.N * 4);
  rgba[pick * 4] = 250; rgba[pick * 4 + 1] = 100; rgba[pick * 4 + 2] = 50; rgba[pick * 4 + 3] = 255;
  const m = t3d.terrainMesh(a, rgba, 2);
  const cols = Math.floor((a.W - 1) / 2) + 1, rows = Math.floor((a.H - 1) / 2) + 1;
  assert.equal(m.cols, cols);
  assert.equal(m.rows, rows);
  assert.ok(m.indices.length > 0);
  // no vertex sits on an invalid column (x >= 38 → gx = 19 unusable)
  const maxVertexX = Math.max(...m.positions.filter((v, k) => k % 3 === 0));
  assert.equal(maxVertexX, (cols - 2) * 2 * a.cell);
  // the picked cell's vertex carries its colour and its AHD height
  const k = m.positions.findIndex((v, j) => j % 3 === 0 && v === 4 * a.cell && m.positions[j + 2] === 2 * a.cell) / 3;
  assert.ok(k >= 0);
  assert.equal(m.positions[k * 3 + 1], a.dem[pick]);
  assert.equal(Math.round(m.colors[k * 4] * 255), 250);   // RGBA vertex colours
});

test('waterMesh emits vertices only for wet cells with the right band colour', () => {
  const a = makeGrid();
  const N = a.N;
  const wse = new Float64Array(N), depth = new Float32Array(N), wet = new Uint8Array(N);
  for (let x = 20; x <= 30; x++) {
    const i = 15 * a.W + x;
    wet[i] = 1; depth[i] = 1.4; wse[i] = a.dem[i] + 1.4;
  }
  const m = t3d.waterMesh(a, wse, depth, wet, 1);
  // a single wet row can't make quads — the builder needs 2 wet rows
  assert.equal(m, null);
  for (let y = 14; y <= 16; y++) for (let x = 20; x <= 30; x++) {
    const i = y * a.W + x;
    wet[i] = 1; depth[i] = y === 15 ? 1.4 : 2.4; wse[i] = a.dem[i] + depth[i];
  }
  const m2 = t3d.waterMesh(a, wse, depth, wet, 1);
  assert.ok(m2);
  // depth 1.4 → the 1–2 m band #3786c9: find the (x=20, y=15) vertex
  const k = m2.positions.findIndex((v, j) => j % 3 === 0 && v === 20 * a.cell && m2.positions[j + 2] === 15 * a.cell) / 3;
  assert.ok(k >= 0);
  // Float32 storage + RGBA vertex colours: compare within 1e-6
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(m2.colors[k * 4 + c] - [0x37, 0x86, 0xc9][c] / 255) < 1e-6);
});

test('waterFromFrame matches showTimeStep decode arithmetic', () => {
  const a = makeGrid();
  const frame = new Uint8Array(a.N);
  // a 2-row wet patch so the decimated mesh has quads (skip 2 → even rows)
  for (const y of [10, 12]) for (let x = 10; x <= 12; x++) {
    frame[y * a.W + x] = x === 12 ? 128 : 255;
  }
  const maxD = 2.0;
  const { wse, depth, wet, mesh } = t3d.waterFromFrame(a, frame, maxD, 2);
  assert.equal(depth[10 * a.W + 10], 2.0);
  assert.equal(wet[10 * a.W + 10], 1);
  assert.equal(wse[10 * a.W + 10], a.dem[10 * a.W + 10] + 2.0);
  assert.ok(Math.abs(depth[10 * a.W + 12] - (128 / 255) * 2.0) < 1e-6);   // Float32
  assert.equal(wet[10 * a.W + 14], 0);
  // every mesh vertex is a wet cell with finite height
  assert.ok(mesh);
  for (let k = 1; k < mesh.positions.length; k += 3) assert.ok(Number.isFinite(mesh.positions[k]));
});

test('depthColor follows the 2D legend band boundaries', () => {
  assert.deepEqual(t3d.depthColor(0.0), [0xc9, 0xe7, 0xf7]);
  assert.deepEqual(t3d.depthColor(0.49), [0xc9, 0xe7, 0xf7]);
  assert.deepEqual(t3d.depthColor(0.5), [0x79, 0xbf, 0xe8]);
  assert.deepEqual(t3d.depthColor(1.9), [0x37, 0x86, 0xc9]);
  assert.deepEqual(t3d.depthColor(4.5), [0x0c, 0x34, 0x70]);
});

test('mercatorTiles + tileBounds round-trip a box to tiles and back', () => {
  // Brisbane-ish box, z12
  const z = 12;
  const r = t3d.mercatorTiles(-27.55, 152.9, -27.35, 153.15, z);
  assert.ok(r.x1 >= r.x0 && r.y1 >= r.y0);
  assert.ok(r.x1 - r.x0 <= 3 && r.y1 - r.y0 <= 3, 'a 20km box is a few tiles at z12');
  // every tile's bounds intersects the box, and the union covers its centre
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
    const [w2, s2, e2, n2] = t3d.tileBounds(z, x, y);
    assert.ok(e2 > 152.9 && w2 < 153.15 && n2 > -27.55 && s2 < -27.35);
  }
  const [w2, , e2] = t3d.tileBounds(z, r.x0, r.y0);
  assert.ok(Math.abs((e2 - w2) - 360 / (1 << z)) < 1e-9);
});

test('streamZoom pairs a view width with a zoom band and cell size', () => {
  // ~8.7km view at Brisbane's latitude → z13 (finer), 30 m cells
  assert.equal(t3d.streamZoom(8700, -27.5), 13);
  assert.equal(t3d.streamCell(13), 30);
  // ~35km view → z11, 90 m cells (clamped floor)
  assert.equal(t3d.streamZoom(35000, -27.5), 11);
  assert.equal(t3d.streamCell(11), 90);
  // a huge view still clamps to z11
  assert.equal(t3d.streamZoom(200000, -27.5), 11);
});
})();
