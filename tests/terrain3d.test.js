// Mesh helpers for the experimental 3D view (viewer/terrain3d.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');
const ref = require('./water-mesh-reference.js');   // the JavaScript mesh the Rust one is held to

(async () => {
  const t3d = await import('../viewer/terrain3d.js');
  const rustMesh = F.waterMesh;
  const bytes = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);   // the view's own bytes (the Rust mesh shares a buffer)

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

test('waterMesh emits vertices only for wet cells with the right band colour', () => {
  const a = makeGrid();
  const N = a.N;
  const wse = new Float64Array(N), depth = new Float32Array(N), wet = new Uint8Array(N);
  for (let x = 20; x <= 30; x++) {
    const i = 15 * a.W + x;
    wet[i] = 1; depth[i] = 1.4; wse[i] = a.dem[i] + 1.4;
  }
  const m = t3d.waterMesh(a, wse, depth, wet, 1, {}, rustMesh);
  // a single wet row can't make quads — the builder needs 2 wet rows
  assert.equal(m, null);
  for (let y = 14; y <= 16; y++) for (let x = 20; x <= 30; x++) {
    const i = y * a.W + x;
    wet[i] = 1; depth[i] = y === 15 ? 1.4 : 2.4; wse[i] = a.dem[i] + depth[i];
  }
  const m2 = t3d.waterMesh(a, wse, depth, wet, 1, {}, rustMesh);
  assert.ok(m2);
  // depth 1.4 → the 1–2 m band #3786c9: find the (x=20, y=15) vertex
  const k = m2.positions.findIndex((v, j) => j % 3 === 0 && v === 20 * a.cell && m2.positions[j + 2] === 15 * a.cell) / 3;
  assert.ok(k >= 0);
  // Float32 storage + RGBA vertex colours: compare within 1e-6
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(m2.colors[k * 4 + c] - [0x1f, 0x67, 0xbb][c] / 255) < 1e-6);
});

test('waterFromFrame matches showTimeStep decode arithmetic', () => {
  const a = makeGrid();
  const frame = new Uint8Array(a.N);
  // a 2-row wet patch so the decimated mesh has quads (skip 2 → even rows)
  for (const y of [10, 12]) for (let x = 10; x <= 12; x++) {
    frame[y * a.W + x] = x === 12 ? 128 : 255;
  }
  const maxD = 2.0;
  const { wse, depth, wet, mesh } = ref.waterFromFrame(a, frame, maxD, 2);
  assert.equal(depth[10 * a.W + 10], 2.0);
  assert.equal(wet[10 * a.W + 10], 1);
  assert.equal(wse[10 * a.W + 10], a.dem[10 * a.W + 10] + 2.0);
  assert.ok(Math.abs(depth[10 * a.W + 12] - (128 / 255) * 2.0) < 1e-6);   // Float32
  assert.equal(wet[10 * a.W + 14], 0);
  // every mesh vertex is a wet cell with finite height
  assert.ok(mesh);
  for (let k = 1; k < mesh.positions.length; k += 3) assert.ok(Number.isFinite(mesh.positions[k]));
});

test('the Rust mesh is the JavaScript one byte for byte, from a frame or a run, soft or hard, with or without scene coordinates', () => {
  const a = makeGrid(90, 70, 10);
  let seed = 7;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const colX = Float64Array.from({ length: a.W }, (_, x) => 500 + x * 10 + 0.37), rowZ = Float64Array.from({ length: a.H }, (_, y) => -200 + y * 10 - 0.11);
  for (const skip of [2, 4]) for (const soft of [false, true]) for (const scene of [false, true]) for (const maxD of [0, 0.7, 5.5]) {
    const frame = new Uint8Array(a.N);
    for (let y = 0; y < a.H; y++) for (let x = 0; x < a.W; x++) if (rand() < 0.55 && x > 10 && x < 70 && y > 5 && y < 60 && !a.ocean[y * a.W + x]) frame[y * a.W + x] = 1 + Math.floor(rand() * 254);
    const opts = { soft, lift: 0.05, ...(scene ? { colX, rowZ } : {}) };
    const full = ref.waterFromFrame(a, frame, maxD, skip, opts).mesh;
    const lean = t3d.waterMeshFromFrame(a, frame, maxD, skip, opts, rustMesh);
    // the same cells as a run (what waterFromFrame decodes) give the same mesh
    const dec = ref.waterFromFrame(a, frame, maxD, skip, opts);
    const fromRun = t3d.waterMesh(a, dec.wse, dec.depth, dec.wet, skip, opts, rustMesh);
    assert.equal(fromRun === null, full === null);
    if (full) for (const key of ['positions', 'colors', 'uvs', 'indices']) assert.ok(bytes(fromRun[key]).equals(bytes(full[key])), `${key} differs from a run`);
    assert.equal(lean === null, full === null);
    if (!full) continue;
    for (const key of ['positions', 'colors', 'uvs', 'indices']) {
      assert.equal(lean[key].length, full[key].length, key);
      assert.ok(bytes(lean[key]).equals(bytes(full[key])), `${key} differs (skip ${skip}, soft ${soft}, scene ${scene}, maxD ${maxD})`);
    }
    assert.deepEqual([lean.cols, lean.rows, lean.skip, lean.wM, lean.hM], [full.cols, full.rows, full.skip, full.wM, full.hM]);
  }
});

test('soft water adds a transparent ring at the neighbours\' level and 3D shades step at the legend boundaries', () => {
  const a = makeGrid(), N = a.N;
  const wse = new Float64Array(N), depth = new Float32Array(N), wet = new Uint8Array(N);
  for (let y = 14; y <= 16; y++) for (let x = 20; x <= 24; x++) { const i = y * a.W + x; wet[i] = 1; depth[i] = 1.2; wse[i] = 7; }
  const hard = t3d.waterMesh(a, wse, depth, wet, 1, {}, rustMesh), soft = t3d.waterMesh(a, wse, depth, wet, 1, { soft: true }, rustMesh);
  assert.ok(soft.positions.length > hard.positions.length);
  const alphas = []; for (let k = 3; k < soft.colors.length; k += 4) alphas.push(soft.colors[k]);
  assert.ok(alphas.some((v) => v === 0) && alphas.some((v) => v > 0.5));
  for (let k = 1; k < soft.positions.length; k += 3) assert.equal(soft.positions[k], 7);   // ring sits at the wet level
  assert.deepEqual(t3d.depthColor3d(0.49), t3d.BANDS3D[0][1]);
  assert.deepEqual(t3d.depthColor3d(0.5), t3d.BANDS3D[1][1]);
  assert.deepEqual(t3d.depthColor3d(4), t3d.BANDS3D[4][1]);
  assert.ok(t3d.depthAlpha3d(0.2) < t3d.depthAlpha3d(0.8) && t3d.depthAlpha3d(10) <= 0.88);
});

test('depthColor follows the 2D legend band boundaries and the 3D colours', () => {
  assert.deepEqual(ref.depthColor(0.0), [0x3f, 0x9a, 0xe0]);
  assert.deepEqual(ref.depthColor(0.49), [0x3f, 0x9a, 0xe0]);
  assert.deepEqual(ref.depthColor(0.5), [0x2b, 0x7f, 0xd0]);
  assert.deepEqual(ref.depthColor(1.9), [0x1f, 0x67, 0xbb]);
  assert.deepEqual(ref.depthColor(4.5), [0x0c, 0x34, 0x70]);
  for (const [lo, c] of t3d.BANDS3D) assert.deepEqual(ref.depthColor(lo), c);   // one palette for 2D and 3D
});

/* ---------- v4 ---------- */

const proj = () => t3d.makeProjection(150.5, -23.4);

test('projection round-trips lon/lat and is metric at the origin', () => {
  const p = proj();
  const [x, z] = p.toScene(150.5, -23.4);
  assert.ok(Math.abs(x) < 1e-6 && Math.abs(z) < 1e-6);
  const [lon, lat] = p.fromScene(...p.toScene(151.2, -22.9));
  assert.ok(Math.abs(lon - 151.2) < 1e-9 && Math.abs(lat + 22.9) < 1e-9);
  // 0.01 deg of latitude north of the origin is ~1.1 km, -z (north is -z)
  const [, zn] = p.toScene(150.5, -23.39);
  assert.ok(zn < 0 && Math.abs(-zn - 1105) < 15);
  assert.ok(Math.abs(p.xOfLon(150.7) - p.toScene(150.7, -10)[0]) < 1e-6);
  assert.ok(Math.abs(p.zOfLat(-22.0) - p.toScene(0, -22.0)[1]) < 1e-6);
});

test('adjacent tiles share bit-identical edges, at every zoom', () => {
  const p = proj();
  for (const z of [6, 11, 14]) {
    const [tx, ty] = t3d.tileAt(p, z, 1234, -5678);
    const a = t3d.tileToScene(p, z, tx, ty), e = t3d.tileToScene(p, z, tx + 1, ty), s = t3d.tileToScene(p, z, tx, ty + 1);
    assert.equal(a.x1, e.x0);
    assert.equal(a.z1, s.z0);
    assert.equal(a.z0, e.z0);
    assert.ok(a.x1 > a.x0 && a.z1 > a.z0);
    // the tile containing a point contains it
    assert.ok(1234 >= a.x0 && 1234 <= a.x1 && -5678 >= a.z0 && -5678 <= a.z1);
  }
  // children tile their parent exactly
  const par = t3d.tileToScene(p, 10, 100, 200), c0 = t3d.tileToScene(p, 11, 200, 400), c3 = t3d.tileToScene(p, 11, 201, 401);
  assert.ok(Math.abs(par.x0 - c0.x0) < 1e-6 && Math.abs(par.z1 - c3.z1) < 1e-6 && Math.abs(par.x1 - c3.x1) < 1e-6);
});

test('tile meshes of neighbours put their shared edge vertices at the same scene positions', () => {
  const p = proj(), z = 12, [tx, ty] = t3d.tileAt(p, z, 0, 0), segs = 8, m = segs + 1;
  const flat = new Float32Array(m * m).fill(10);
  const a = t3d.tileMesh(p, z, tx, ty, flat, segs), b = t3d.tileMesh(p, z, tx + 1, ty, flat, segs);
  for (let j = 0; j < m; j++) {
    const va = j * m + segs, vb = j * m;   // a's east column, b's west column
    assert.ok(Math.abs(a.origin[0] + a.positions[va * 3] - (b.origin[0] + b.positions[vb * 3])) < 1e-3);
    assert.ok(Math.abs(a.origin[1] + a.positions[va * 3 + 2] - (b.origin[1] + b.positions[vb * 3 + 2])) < 1e-3);
  }
});

test('terrarium decode: known RGB to metres, sea clamped', () => {
  assert.equal(t3d.terrariumHeight(128, 0, 0), 0);
  assert.equal(t3d.terrariumHeight(128, 10, 128), 10.5);
  assert.equal(t3d.terrariumHeight(127, 255, 0), -1);
  const px = new Uint8ClampedArray([128, 100, 0, 255, 100, 0, 0, 255, 130, 5, 64, 255, 128, 0, 0, 255]);
  const d = t3d.decodeTerrarium(px, 2);
  assert.equal(d[0], 100);
  assert.equal(d[1], t3d.SEA_LEVEL);   // deep bathymetry flattened to sea level
  assert.equal(d[2], 517.25);
  assert.equal(d[3], 0);
});

test('sampleRaster is bilinear with pixel-centre convention', () => {
  const r = new Float32Array([0, 10, 20, 30]);   // 2x2
  assert.equal(t3d.sampleRaster(r, 2, 0.25, 0.25), 0);
  assert.equal(t3d.sampleRaster(r, 2, 0.75, 0.25), 10);
  assert.equal(t3d.sampleRaster(r, 2, 0.5, 0.5), 15);
  assert.equal(t3d.sampleRaster(r, 2, 0, 1), 20);   // clamped to the edge pixel
});

test('tile skirts copy edge normals and UVs; mesh heights and ground sampling agree', () => {
  const p = proj(), segs = 4, m = segs + 1, h = new Float32Array(m * m);
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) h[j * m + i] = 20 * i + 5 * j;
  const t = t3d.tileMesh(p, 10, 100, 500, h, segs);
  const nVert = m * m;
  assert.equal(t.positions.length / 3, nVert + 4 * m);
  for (let e = 0; e < 4; e++) for (let k = 0; k < m; k++) {
    const dst = nVert + e * m + k, src = [k, (m - 1) * m + k, k * m, k * m + m - 1][e];
    for (let c = 0; c < 3; c++) assert.equal(t.normals[dst * 3 + c], t.normals[src * 3 + c]);
    assert.equal(t.uvs[dst * 2], t.uvs[src * 2]);
    assert.equal(t.uvs[dst * 2 + 1], t.uvs[src * 2 + 1]);
    assert.ok(t.positions[dst * 3 + 1] < t.hmin);
    assert.equal(t.positions[dst * 3], t.positions[src * 3]);
  }
  // normals are unit and tilt away from the uphill (+x, +z) direction
  for (let v = 0; v < nVert; v++) assert.ok(Math.abs(Math.hypot(t.normals[v * 3], t.normals[v * 3 + 1], t.normals[v * 3 + 2]) - 1) < 1e-5);
  assert.ok(t.normals[0] < 0 && t.normals[2] < 0 && t.normals[1] > 0);
  // ground height at the tile centre equals the centre vertex
  const sc = t3d.tileToScene(p, 10, 100, 500);
  assert.ok(Math.abs(t3d.tileGroundAt(p, 10, 100, 500, h, (sc.x0 + sc.x1) / 2, (sc.z0 + sc.z1) / 2, segs) - h[2 * m + 2]) < 1e-3);
  assert.equal(t3d.tileGroundAt(p, 10, 100, 500, h, sc.x1 + 10, sc.z0, segs), null);
  assert.equal(t.indices.length, segs * segs * 6 + 4 * segs * 6);
  for (const i of t.indices) assert.ok(i < t.positions.length / 3);
});

test('selectTiles refines near the camera, coarsens far, respects the cap and the frustum', () => {
  const p = proj();
  const view = { cam: [0, 3000, 8000], proj: p, focalPx: 864, exag: 1.5, minZ: 6, maxZ: 14, maxDist: 300000, cap: 400, thresholdPx: 384 };
  const keys = t3d.selectTiles(view);
  assert.ok(keys.length > 4 && keys.length <= 400);
  const zs = keys.map((k) => t3d.parseKey(k)[0]);
  const near = keys.filter((k) => { const [z, x, y] = t3d.parseKey(k); const t = t3d.tileToScene(p, z, x, y); return Math.abs((t.x0 + t.x1) / 2) < 5000 && Math.abs((t.z0 + t.z1) / 2 - 8000) < 5000; });
  const far = keys.filter((k) => { const [z, x, y] = t3d.parseKey(k); const t = t3d.tileToScene(p, z, x, y); return Math.hypot((t.x0 + t.x1) / 2, (t.z0 + t.z1) / 2) > 150000; });
  assert.ok(near.length && far.length);
  assert.ok(Math.min(...near.map((k) => t3d.parseKey(k)[0])) > Math.max(...far.map((k) => t3d.parseKey(k)[0])) - 1, 'finer near than far');
  assert.ok(Math.max(...zs) <= 14 && Math.min(...zs) >= 6);
  // a tight cap raises the threshold instead of exceeding it
  assert.ok(t3d.selectTiles({ ...view, cap: 30 }).length <= 30);
  // looking away: a frustum whose only plane faces -z (camera at +z looking south = +z) drops everything north
  const south = t3d.selectTiles({ ...view, frustum: [[0, 0, 1, -8000]] });   // keep z >= 8000
  assert.ok(south.length > 0 && south.length < keys.length);
  for (const k of south) { const [z, x, y] = t3d.parseKey(k); assert.ok(t3d.tileToScene(p, z, x, y).z1 >= 8000); }
  // the horizon cull drops what is out of range
  const small = t3d.selectTiles({ ...view, maxDist: 20000 });
  assert.ok(small.length < keys.length);
});

test('resolveDraw shows the nearest built ancestor until all children are built', () => {
  const built = new Set(['10/5/5', '11/10/10', '11/11/10']);
  const ready = (k) => built.has(k);
  // wanted: the four children of 10/5/5 at z11 (two are built)
  const wanted = ['11/10/10', '11/11/10', '11/10/11', '11/11/11'];
  assert.deepEqual([...t3d.resolveDraw(wanted, ready)], ['10/5/5']);
  built.add('11/10/11'); built.add('11/11/11');
  assert.deepEqual([...t3d.resolveDraw(wanted, ready)].sort(), wanted.slice().sort());
  // zooming out: the coarse tile isn't built but its children are
  const only = new Set(['11/10/10', '11/11/11']);
  assert.deepEqual([...t3d.resolveDraw(['10/5/5'], (k) => only.has(k))].sort(), ['11/10/10', '11/11/11']);
  // nothing built anywhere: nothing to draw
  assert.equal(t3d.resolveDraw(['12/1/1'], () => false).size, 0);
});

test('height override returns the model DEM inside the area, the source outside, and blends at the border', () => {
  const W = 20, H = 20, dem = new Float32Array(W * H).fill(50), valid = new Uint8Array(W * H).fill(1);
  const area = { bounds: [150, -24, 151, -23], a: { W, H, dem, valid } };
  assert.equal(t3d.areaHeight(area, 152, -23.5), null);
  const mid = t3d.areaHeight(area, 150.5, -23.5);
  assert.equal(mid.h, 50);
  assert.equal(mid.w, 1);
  assert.equal(t3d.overrideHeight(10, [area], 150.5, -23.5), 50);
  assert.equal(t3d.overrideHeight(10, [area], 152, -23.5), 10);
  const edge = t3d.areaHeight(area, 150.001, -23.5);
  assert.ok(edge.w < 0.2);
  const b = t3d.overrideHeight(10, [area], 150.001, -23.5);
  assert.ok(b > 10 && b < 50);
  // invalid model cells fall back to the source
  valid.fill(0);
  assert.equal(t3d.overrideHeight(10, [area], 150.5, -23.5), 10);
  assert.ok(t3d.boxesOverlap([150, -24, 151, -23], [150.9, -23.5, 152, -22]));
  assert.ok(!t3d.boxesOverlap([150, -24, 151, -23], [151.1, -23.5, 152, -22]));
});

test('water meshes can take scene coordinates from the shared projection', () => {
  const a = makeGrid(), N = a.N;
  const wse = new Float64Array(N), depth = new Float32Array(N), wet = new Uint8Array(N);
  for (let y = 14; y <= 16; y++) for (let x = 20; x <= 30; x++) { const i = y * a.W + x; wet[i] = 1; depth[i] = 1; wse[i] = a.dem[i] + 1; }
  const colX = Float64Array.from({ length: a.W }, (_, x) => 1000 + x * 7), rowZ = Float64Array.from({ length: a.H }, (_, y) => -500 + y * 7);
  const m = t3d.waterMesh(a, wse, depth, wet, 1, { colX, rowZ, lift: 0.05 }, rustMesh);
  const k = m.positions.findIndex((v, j) => j % 3 === 0 && Math.abs(v - (1000 + 20 * 7)) < 1e-3 && Math.abs(m.positions[j + 2] - (-500 + 15 * 7)) < 1e-3) / 3;
  assert.ok(k >= 0);
  assert.ok(Math.abs(m.positions[k * 3 + 1] - (a.dem[15 * a.W + 20] + 1.05)) < 1e-4);
});

})();
