// The flood-impact sweep (viewer/impact.js with the Rust sweep) must give what the earlier JavaScript sweep gave
// (tests/impact-reference.js): counts, depths, edges and isolation exactly; lengths and shares to rounding.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');
const makeReference = require('./impact-reference.js');

const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const near = (x, y, what) => assert.ok(Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)), `${what}: ${x} vs ${y}`);

(async () => {
  const { prepareNet, prepareRun } = await import('../viewer/routing.js');
  const { scenarioImpact } = await import('../viewer/impact.js');
  const geo = { west: 153.0, east: 153.06, south: -27.5, north: -27.44 };
  const W = 120, H = 100, N = W * H;
  const cellOf = (lat, lon) => {
    const x = Math.floor(((lon - geo.west) / (geo.east - geo.west)) * W), y = Math.floor(((geo.north - lat) / (geo.north - geo.south)) * H);
    return x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x;
  };

  function area(seed, { net, sa1, sa2 }) {
    const r = rng(seed), side = 30, nB = 4000, lat = [], lon = [], edges = [], roads = [];
    const dy = (geo.north - geo.south) / (side + 1), dx = (geo.east - geo.west) / (side + 1);
    for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) { lat.push(geo.south + dy * (j + 0.5 + (r() - 0.5) * 0.6)); lon.push(geo.west + dx * (i + 0.5 + (r() - 0.5) * 0.6)); }
    for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
      if (i + 1 < side && r() < 0.9) edges.push([j * side + i, j * side + i + 1, (j + i) % 6]);
      if (j + 1 < side && r() < 0.9) edges.push([j * side + i, (j + 1) * side + i, (j * 3 + i) % 6]);
    }
    for (let k = 0; k < 6; k++) {
      const pts = []; let la = geo.south + (geo.north - geo.south) * r(), lo = geo.west + (geo.east - geo.west) * r();
      for (let t = 0; t < 60; t++) { la += (r() - 0.5) * 0.004; lo += (r() - 0.5) * 0.004; pts.push({ lat: la, lon: lo }); }
      roads.push({ name: k % 3 === 2 ? '' : `Road ${k % 4}`, type: 'residential', pts });
    }
    const bx = new Float64Array(nB), by = new Float64Array(nB), isHome = new Uint8Array(nB), isWork = new Uint8Array(nB);
    for (let i = 0; i < nB; i++) { bx[i] = geo.west + (geo.east - geo.west) * (r() * 1.04 - 0.02); by[i] = geo.south + (geo.north - geo.south) * (r() * 1.04 - 0.02); isHome[i] = r() < 0.7 ? 1 : 0; isWork[i] = r() < 0.2 ? 1 : 0; }
    const grid = (n) => { const g = new Int32Array(N); for (let c = 0; c < N; c++) g[c] = r() < 0.05 ? -1 : (Math.floor(((c % W) / W) * Math.sqrt(n)) + Math.floor((Math.floor(c / W) / H) * Math.sqrt(n)) * Math.floor(Math.sqrt(n))); return g; };
    const d = { bx, by, isHome, isWork, roads, sites: [{ lat: geo.south + 0.01, lon: geo.west + 0.01, kind: 'x' }], net: net ? { lat: Float64Array.from(lat), lon: Float64Array.from(lon), edges } : { lat: new Float64Array(0), lon: new Float64Array(0), edges: [] } };
    if (sa1) { d.sa1 = { feats: new Array(16).fill({ geometry: { rings: [] } }), pop: Array.from({ length: 16 }, (_, s) => 300 + 40 * s), km2: Array.from({ length: 16 }, (_, s) => (s % 5 === 4 ? 0 : 0.8 + 0.1 * s)) }; d.sa1Grid = grid(16); d.sa1Key = 'kA' + W; }
    if (sa2) { d.sa2 = { feats: new Array(9).fill(0), workers: Array.from({ length: 9 }, (_, s) => 500 + 90 * s), km2: Array.from({ length: 9 }, (_, s) => 1.5 + 0.2 * s) }; d.sa2Grid = grid(9); d.sa2Key = 'kA' + W; }
    return d;
  }

  function runWith(seed, a, blobs) {
    const r = rng(seed), wet = new Uint8Array(N), depth = new Float32Array(N);
    for (let b = 0; b < blobs; b++) {
      const cx = r() * W, cy = r() * H, rad = 5 + r() * 25;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < rad * rad) { const i = y * W + x; wet[i] = 1; depth[i] = Math.max(depth[i], r() * 1.6); }
    }
    return { wet, depth };
  }

  test('the Rust impact sweep matches the earlier JavaScript sweep', () => {
    let exercised = { cut: 0, island: 0, isolated: 0, people: 0, workers: 0, worst: 0 };
    for (const [seed, variant] of [[1, { net: true, sa1: true, sa2: true }], [2, { net: true, sa1: true, sa2: false }], [3, { net: false, sa1: true, sa2: true }], [4, { net: true, sa1: false, sa2: true }]]) {
      const d = area(seed, variant), ocean = new Uint8Array(N);
      for (let y = 0; y < H; y++) for (let x = 0; x < 8; x++) ocean[y * W + x] = 1;
      const a = { W, H, N, cell: 40, ocean }, hasNet = variant.net;
      const P = hasNet ? prepareNet(d, F._internal.MinHeap) : null;
      for (let k = 0; k < 4; k++) {
        const run = runWith(seed * 10 + k, a, 1 + k * 2);
        const state = { a, run, geo, areaKey: 'kA' };
        // the reference keeps its own copy of the area so its caches do not meet ours
        const ref = makeReference({ state, $: (id) => (id === 'floorUnknown' ? { checked: true } : { value: '0' }), cellOf, drawRings: () => { throw new Error('grids are prepared'); }, ringsKm2: () => 1, damageShare: () => 0 })(structuredCloneArea(d), false);
        const R = hasNet ? prepareRun(P, geo, W, H, run, ocean, F.prepareRoadsRun) : null;
        const got = scenarioImpact({ d, a, run, geo, P, R, sweep: F.impactSweep, ringsKm2: () => 1 });
        for (const k2 of ['buildings', 'bWet', 'bDeep', 'hWet', 'homesTagged', 'workWet', 'workTagged', 'isolatedB', 'sites']) assert.equal(got[k2], ref[k2], k2);
        assert.deepEqual(Array.from(got.bDepth), Array.from(ref.bDepth), 'building depths');
        assert.deepEqual(got.cutEdges, ref.cutEdges, 'cut edges');
        assert.deepEqual(got.islandEdges, ref.islandEdges, 'stranded edges');
        for (const k2 of ['people', 'peopleIsolated', 'workers', 'workersAll']) {
          if (ref[k2] == null) assert.equal(got[k2], null, k2); else near(got[k2], ref[k2], k2);
        }
        near(got.cutKm, ref.cutKm, 'cutKm'); near(got.roadKm, ref.roadKm, 'roadKm');
        assert.deepEqual(got.worstRoads.map(([n]) => n), ref.worstRoads.map(([n]) => n), 'worst road names');
        got.worstRoads.forEach(([, v], i) => near(v, ref.worstRoads[i][1], 'worst road km'));
        exercised.cut += ref.cutEdges.length; exercised.island += ref.islandEdges.length; exercised.isolated += ref.isolatedB;
        exercised.people += ref.people || 0; exercised.workers += ref.workers || 0; exercised.worst += ref.worstRoads.length;
      }
    }
    assert.ok(exercised.cut > 100 && exercised.island > 5 && exercised.isolated > 5 && exercised.people > 100 && exercised.workers > 100 && exercised.worst > 3, JSON.stringify(exercised));
  });

  // the reference caches on the area (net.dryReach), so give it its own copy
  function structuredCloneArea(d) {
    return { ...d, net: { lat: d.net.lat, lon: d.net.lon, edges: d.net.edges }, sa1: d.sa1, sa2: d.sa2 };
  }
})();
