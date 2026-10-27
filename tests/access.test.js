// The prepared-network access analysis (viewer/access.js with the Rust step loop) must give exactly what the earlier
// per-step version did. The reference below is that version, kept as it was.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');

const cellOfFor = (g, W, H) => (lat, lon) => {
  const x = Math.floor(((lon - g.west) / (g.east - g.west)) * W), y = Math.floor(((g.north - lat) / (g.north - g.south)) * H);
  return x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x;
};

function referenceAccess(tl, d, g, W, H) {
  const cellOf = cellOfFor(g, W, H), net = d.net, nN = net.lat.length, K = tl.steps;
  const at = (bits, c, k) => c >= 0 && !!(bits[k * tl.wordsPerStep + (c >>> 5)] & (1 << (c & 31)));
  const deepAt = (c, k) => at(tl.deepBits, c, k);
  const wetAt = (c, k) => at(tl.wetBits, c, k);
  const nodeCell = new Int32Array(nN);
  for (let n = 0; n < nN; n++) nodeCell[n] = cellOf(net.lat[n], net.lon[n]);
  const edgeCells = net.edges.map(([u, v]) => {
    const cells = new Set();
    for (let t = 0; t <= 4; t++) {
      const f = t / 4;
      const c = cellOf(net.lat[u] + (net.lat[v] - net.lat[u]) * f, net.lon[u] + (net.lon[v] - net.lon[u]) * f);
      if (c >= 0) cells.add(c);
    }
    return Array.from(cells);
  });
  const edgeClosed = new Uint8Array(net.edges.length), roads = new Map();
  const mx = ((g.east - g.west) / W) * 3, my = ((g.north - g.south) / H) * 3;
  const exit = new Uint8Array(nN);
  for (let n = 0; n < nN; n++) exit[n] = net.lat[n] < g.south + my || net.lat[n] > g.north - my || net.lon[n] < g.west + mx || net.lon[n] > g.east - mx ? 1 : 0;
  const adj = Array.from({ length: nN }, () => []);
  net.edges.forEach(([u, v], k) => { adj[u].push([v, k]); adj[v].push([u, k]); });
  const hs = 0.002, hash = new Map();
  for (let n = 0; n < nN; n++) { const key = `${Math.floor(net.lat[n] / hs)},${Math.floor(net.lon[n] / hs)}`; (hash.get(key) || hash.set(key, []).get(key)).push(n); }
  const nB = d.bx.length, bNode = new Int32Array(nB).fill(-1), bCell = new Int32Array(nB);
  for (let i = 0; i < nB; i++) {
    bCell[i] = cellOf(d.by[i], d.bx[i]);
    const ky = Math.floor(d.by[i] / hs), kx = Math.floor(d.bx[i] / hs);
    let bd = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const n of hash.get(`${ky + dy},${kx + dx}`) || []) {
      const dd = (net.lat[n] - d.by[i]) ** 2 + ((net.lon[n] - d.bx[i]) * 0.9) ** 2;
      if (dd < bd) { bd = dd; bNode[i] = n; }
    }
  }
  const dryReach = new Uint8Array(nN), q0 = [];
  for (let n = 0; n < nN; n++) if (exit[n]) { dryReach[n] = 1; q0.push(n); }
  for (let h = 0; h < q0.length; h++) for (const [m] of adj[q0[h]]) if (!dryReach[m]) { dryReach[m] = 1; q0.push(m); }
  const isoSteps = new Int16Array(nB), firstIso = new Int16Array(nB).fill(-1);
  const isoRun = new Int16Array(nB);
  let longest = 0;
  const isoCount = new Int32Array(K), floodCount = new Int32Array(K), closedCount = new Int32Array(K);
  const reach = new Uint8Array(nN), q = new Int32Array(nN);
  for (let k = 0; k < K; k++) {
    reach.fill(0);
    const closedNames = new Set();
    let closed = 0;
    for (let e = 0; e < net.edges.length; e++) {
      edgeClosed[e] = edgeCells[e].some((c) => deepAt(c, k)) ? 1 : 0;
      if (!edgeClosed[e]) continue;
      closed++;
      const name = d.roads[net.edges[e][2]].name;
      if (name) closedNames.add(name);
    }
    closedCount[k] = closed;
    for (const name of closedNames) {
      const intervals = roads.get(name) || [];
      const last = intervals[intervals.length - 1];
      if (last && last.to === k - 1) last.to = k;
      else intervals.push({ name, from: k, to: k });
      roads.set(name, intervals);
    }
    let qt = 0;
    for (let n = 0; n < nN; n++) if (exit[n] && !deepAt(nodeCell[n], k)) { reach[n] = 1; q[qt++] = n; }
    for (let h = 0; h < qt; h++) for (const [m, e] of adj[q[h]]) {
      if (reach[m] || edgeClosed[e] || deepAt(nodeCell[m], k)) continue;
      reach[m] = 1; q[qt++] = m;
    }
    for (let i = 0; i < nB; i++) {
      if (wetAt(bCell[i], k)) { floodCount[k]++; isoRun[i] = 0; continue; }
      if (bNode[i] >= 0 && !reach[bNode[i]] && dryReach[bNode[i]]) {
        isoCount[k]++; isoSteps[i]++; isoRun[i]++;
        longest = Math.max(longest, isoRun[i]);
        if (firstIso[i] < 0) firstIso[i] = k;
      } else isoRun[i] = 0;
    }
  }
  const toH = (k) => Math.round(tl.t0 + k * tl.step);
  let maxIso = 0, maxIsoAt = 0;
  for (let k = 0; k < K; k++) if (isoCount[k] > maxIso) { maxIso = isoCount[k]; maxIsoAt = k; }
  const roadList = Array.from(roads.values()).flat().sort((x, y) => x.from - y.from);
  return {
    roads: roadList.map((r) => ({ name: r.name, closes: toH(r.from), reopens: toH(r.to + 1) })),
    firstClose: roadList.length ? toH(roadList[0].from) : null,
    maxIso, maxIsoAt: toH(maxIsoAt), longest: Math.round(longest * tl.step),
    isoCount, floodCount, closedCount, isoSteps, firstIso,
  };
}

const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

function town(seed, side, nB, g) {
  const r = rng(seed), lat = [], lon = [], edges = [], roads = [{ name: 'A St' }, { name: 'B Rd' }, { name: '' }, { name: 'A St' }, { name: 'C Ave' }];
  const dy = (g.north - g.south) / (side + 1), dx = (g.east - g.west) / (side + 1);
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) { lat.push(g.south + dy * (j + 0.5 + (r() - 0.5) * 0.6)); lon.push(g.west + dx * (i + 0.5 + (r() - 0.5) * 0.6)); }
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
    if (i + 1 < side && r() < 0.9) edges.push([j * side + i, j * side + i + 1, (j + i) % 5]);
    if (j + 1 < side && r() < 0.9) edges.push([j * side + i, (j + 1) * side + i, (j * 3 + i) % 5]);
  }
  const bx = new Float64Array(nB), by = new Float64Array(nB);
  for (let i = 0; i < nB; i++) { bx[i] = g.west + (g.east - g.west) * (r() * 1.04 - 0.02); by[i] = g.south + (g.north - g.south) * (r() * 1.04 - 0.02); }
  return { net: { lat: Float64Array.from(lat), lon: Float64Array.from(lon), edges }, roads, bx, by, sites: [] };
}

(async () => {
  const { prepareNet } = await import('../viewer/routing.js');
  const { timelineAccess } = await import('../viewer/access.js');
  const g = { west: 153.0, east: 153.05, south: -27.5, north: -27.46 };
  const W = 80, H = 70, N = W * H;

  test('the access analysis over time matches the earlier per-step version', async () => {
    const d = town(4, 30, 3000, g), K = 20, words = Math.ceil(N / 32), r = rng(8);
    const bitsFor = (p) => {
      const b = new Uint32Array(K * words);
      for (let k = 0; k < K; k++) {
        const cx = r() * W, cy = r() * H, rad = 5 + k * 1.5;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < rad * rad && r() < p) { const c = y * W + x; b[k * words + (c >>> 5)] |= 1 << (c & 31); }
      }
      return b;
    };
    const tl = { steps: K, wordsPerStep: words, wetBits: bitsFor(0.9), deepBits: bitsFor(0.5), t0: 6, step: 3 };
    const want = referenceAccess(tl, d, g, W, H);
    const got = timelineAccess(tl, d, prepareNet(d, F._internal.MinHeap, F), g, W, H, F.accessOverTime);
    assert.deepEqual(got, want);
    assert.ok(want.maxIso > 0 && want.roads.length > 2 && want.longest > 0, 'the case exercises closures and cut-off buildings');
  });
})();

(async () => {
  const { prepareNet } = await import('../viewer/routing.js');
  const { timelineAccess } = await import('../viewer/access.js');
  test('the Rust step loop matches the earlier per-step version on denser and sparser floods', () => {
    assert.equal(typeof F.accessOverTime, 'function');
    const g = { west: 153.0, east: 153.05, south: -27.5, north: -27.46 }, W = 80, H = 70, N = W * H;
    for (const [seed, density] of [[3, 0.9], [9, 0.3], [12, 1]]) {
      const d = town(seed, 30, 3000, g), K = 24, words = Math.ceil(N / 32), r = rng(seed);
      const bitsFor = (p, grow) => {
        const b = new Uint32Array(K * words);
        for (let k = 0; k < K; k++) {
          const cx = r() * W, cy = r() * H, rad = 3 + k * grow;
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < rad * rad && r() < p) { const c = y * W + x; b[k * words + (c >>> 5)] |= 1 << (c & 31); }
        }
        return b;
      };
      const tl = { steps: K, wordsPerStep: words, wetBits: bitsFor(density, 1.4), deepBits: bitsFor(density / 2, 1.1), t0: 6, step: 3 };
      const P = prepareNet(d, F._internal.MinHeap, F);
      const got = timelineAccess(tl, d, P, g, W, H, F.accessOverTime);
      assert.deepEqual(got, referenceAccess(tl, d, g, W, H), `seed ${seed}`);
      assert.ok(got.maxIso > 0 && got.roads.length > 0, 'the case exercises closures and cut-off buildings');
    }
  });
})();
