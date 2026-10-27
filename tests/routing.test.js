// The prepared-network router (viewer/routing.js) must give exactly the routes the earlier per-click
// version did. The reference below is that version, kept as it was.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');

const EVAC = 'Evacuation centre';

function referenceRoute(d, geo, a, run, lat, lon) {
  const cellOf = (la, lo) => {
    const x = Math.floor(((lo - geo.west) / (geo.east - geo.west)) * a.W), y = Math.floor(((geo.north - la) / (geo.north - geo.south)) * a.H);
    return x < 0 || y < 0 || x >= a.W || y >= a.H ? -1 : y * a.W + x;
  };
  const net = d.net, nN = net.lat.length, g = geo;
  const closed = new Uint8Array(net.edges.length);
  const deep = (c) => c >= 0 && run.wet[c] && !(a.ocean && a.ocean[c]) && run.depth[c] >= 0.3;
  net.edges.forEach(([u, v], k) => {
    for (let t = 0; t <= 4 && !closed[k]; t++) {
      const f = t / 4;
      if (deep(cellOf(net.lat[u] + (net.lat[v] - net.lat[u]) * f, net.lon[u] + (net.lon[v] - net.lon[u]) * f))) closed[k] = 1;
    }
  });
  const nodeWet = (n) => { const c = cellOf(net.lat[n], net.lon[n]); return c >= 0 && run.wet[c] && run.depth[c] >= 0.3 && !(a.ocean && a.ocean[c]); };
  const km = (u, v) => Math.hypot((net.lon[v] - net.lon[u]) * 111.32 * Math.cos((net.lat[u] * Math.PI) / 180), (net.lat[v] - net.lat[u]) * 110.574);
  let start = -1, best = Infinity;
  for (let n = 0; n < nN; n++) {
    const dd = (net.lat[n] - lat) ** 2 + ((net.lon[n] - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
    if (dd < best) { best = dd; start = n; }
  }
  const startKm = Math.sqrt(best) * 111;
  if (start < 0 || startKm > 0.5) return { none: true };
  const adj = Array.from({ length: nN }, () => []);
  net.edges.forEach(([u, v, ri], k) => { if (!closed[k]) { adj[u].push([v, ri]); adj[v].push([u, ri]); } });
  const mx = ((g.east - g.west) / a.W) * 3, my = ((g.north - g.south) / a.H) * 3;
  const isExit = (n) => net.lat[n] < g.south + my || net.lat[n] > g.north - my || net.lon[n] < g.west + mx || net.lon[n] > g.east - mx;
  const centres = d.sites.filter((x) => x.kind === EVAC).map((x) => {
    let nb = -1, bd = Infinity;
    for (let n = 0; n < nN; n++) { const dd = (net.lat[n] - x.lat) ** 2 + (net.lon[n] - x.lon) ** 2; if (dd < bd) { bd = dd; nb = n; } }
    return { ...x, node: nb, flooded: (() => { const c = cellOf(x.lat, x.lon); return c >= 0 && run.wet[c] && run.depth[c] >= 0.15; })() };
  });
  const centreAt = new Map(centres.filter((x) => !x.flooded && x.node >= 0).map((x) => [x.node, x]));
  const dist = new Float64Array(nN).fill(Infinity), prev = new Int32Array(nN).fill(-1), via = new Int32Array(nN).fill(-1);
  const heap = new F._internal.MinHeap(net.edges.length * 2 + 4);
  if (!nodeWet(start)) { dist[start] = 0; heap.push(0, start); }
  let exitNode = -1, centreNode = -1;
  while (heap.n) {
    const u = heap.pop();
    if (exitNode < 0 && isExit(u)) exitNode = u;
    if (centreNode < 0 && centreAt.has(u)) centreNode = u;
    if (exitNode >= 0 && (centreNode >= 0 || !centreAt.size)) break;
    for (const [v, ri] of adj[u]) {
      if (nodeWet(v)) continue;
      const nd = dist[u] + km(u, v);
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; via[v] = ri; heap.push(nd, v); }
    }
  }
  const path = (t) => {
    if (t < 0) return null;
    const pts = [], names = [];
    for (let n = t; n >= 0; n = prev[n]) {
      pts.push([net.lat[n], net.lon[n]]);
      const nm = via[n] >= 0 && d.roads[via[n]] ? d.roads[via[n]].name : '';
      if (nm && names[names.length - 1] !== nm) names.push(nm);
    }
    return { km: dist[t], pts: pts.reverse(), via: names.reverse().slice(0, 4) };
  };
  return { startKm, toExit: path(exitNode), toCentre: centreNode >= 0 ? Object.assign(path(centreNode), { name: centreAt.get(centreNode).name }) : null,
    centres: centres.length, centresFlooded: centres.filter((x) => x.flooded).length };
}

const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// A jittered street grid with diagonals, dead-end spurs and a few duplicate-position nodes
function town(seed, side, geo) {
  const r = rng(seed), lat = [], lon = [], edges = [], roads = [];
  const dy = (geo.north - geo.south) / (side + 1), dx = (geo.east - geo.west) / (side + 1);
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
    lat.push(geo.south + dy * (j + 0.5 + (r() - 0.5) * 0.6));
    lon.push(geo.west + dx * (i + 0.5 + (r() - 0.5) * 0.6));
  }
  const id = (i, j) => j * side + i, road = (n) => { roads.push({ name: `Road ${n}` }); return roads.length - 1; };
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
    if (i + 1 < side && r() < 0.9) edges.push([id(i, j), id(i + 1, j), road(j)]);
    if (j + 1 < side && r() < 0.9) edges.push([id(i, j), id(i, j + 1), road(100 + i)]);
    if (i + 1 < side && j + 1 < side && r() < 0.15) edges.push([id(i, j), id(i + 1, j + 1), road(200)]);
  }
  const sites = [];
  for (let k = 0; k < 6; k++) sites.push({ kind: k % 3 ? EVAC : 'School', name: `Site ${k}`, lat: geo.south + (geo.north - geo.south) * r(), lon: geo.west + (geo.east - geo.west) * r() });
  return { net: { lat: Float64Array.from(lat), lon: Float64Array.from(lon), edges }, roads, sites };
}

function runWith(seed, a, blobs) {
  const r = rng(seed), wet = new Uint8Array(a.N), depth = new Float32Array(a.N);
  for (let b = 0; b < blobs; b++) {
    const cx = r() * a.W, cy = r() * a.H, rad = 3 + r() * a.W * 0.15;
    for (let y = 0; y < a.H; y++) for (let x = 0; x < a.W; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < rad * rad) { const i = y * a.W + x; wet[i] = 1; depth[i] = Math.max(depth[i], r() * 1.2); }
  }
  return { wet, depth };
}

(async () => {
  const { prepareNet, prepareRun, routeFrom } = await import('../viewer/routing.js');
  const geo = { west: 153.0, east: 153.06, south: -27.5, north: -27.44 };
  const W = 90, H = 90, a = { W, H, N: W * H, ocean: new Uint8Array(W * H) };
  for (let y = 0; y < H; y++) for (let x = 0; x < 8; x++) a.ocean[y * W + x] = 1;

  test('the prepared router returns the same routes as the earlier per-click search', () => {
    let routed = 0, withCentre = 0, none = 0;
    for (const [seed, side] of [[1, 12], [2, 25], [3, 40]]) {
      const d = town(seed, side, geo), P = prepareNet(d, F._internal.MinHeap);
      for (let k = 0; k < 4; k++) {
        const run = runWith(seed * 10 + k, a, k * 2), R = prepareRun(P, geo, a.W, a.H, run, a.ocean, F.prepareRoadsRun), r = rng(seed * 100 + k);
        for (let q = 0; q < 40; q++) {
          const lat = geo.south + (geo.north - geo.south) * r(), lon = geo.west + (geo.east - geo.west) * r();
          const want = referenceRoute(d, geo, a, run, lat, lon), got = routeFrom(R, lat, lon);
          assert.deepEqual(got, want, `seed ${seed} run ${k} query ${q}`);
          if (want.none) none++; else { routed++; if (want.toCentre) withCentre++; }
        }
      }
    }
    assert.ok(routed > 100 && withCentre > 20 && none > 0, `exercised ${routed} routes, ${withCentre} to a centre, ${none} out of range`);
  });

  test('the nearest-node index agrees with a linear scan, including ties and far-off points', () => {
    const d = town(7, 30, geo);
    // two nodes at the same spot: the lower index wins
    d.net.lat[500] = d.net.lat[300]; d.net.lon[500] = d.net.lon[300];
    const P = prepareNet(d, F._internal.MinHeap), r = rng(9), run = { wet: new Uint8Array(a.N), depth: new Float32Array(a.N) };
    const R = prepareRun(P, geo, a.W, a.H, run, null, F.prepareRoadsRun);
    for (let q = 0; q < 200; q++) {
      const lat = geo.south - 0.02 + (geo.north - geo.south + 0.04) * r(), lon = geo.west - 0.02 + (geo.east - geo.west + 0.04) * r();
      assert.deepEqual(routeFrom(R, lat, lon), referenceRoute(d, geo, a, run, lat, lon));
    }
    const here = routeFrom(R, d.net.lat[300], d.net.lon[300]);
    assert.equal(here.startKm, 0);
  });
})();
