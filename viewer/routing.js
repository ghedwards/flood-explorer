/* The shortest dry route by road from a spot to the edge of the model and to the nearest dry evacuation
 * centre. The road network never changes within an area, so everything that depends only on it (a
 * flat adjacency list with the edge lengths, a grid index for nearest-node lookups, the centres' nodes)
 * is built once by prepareNet; everything that depends on the flood run (which edges and nodes are
 * under water) is built once per run by prepareRun; routeFrom is then only the search itself.
 * Results are identical to the earlier per-click version: same neighbour order, same tie-breaks. */

const EVAC = 'Evacuation centre';
const DEEP = 0.3, CENTRE_DEEP = 0.15;

const kmArc = (net, u, v) => Math.hypot((net.lon[v] - net.lon[u]) * 111.32 * Math.cos((net.lat[u] * Math.PI) / 180), (net.lat[v] - net.lat[u]) * 110.574);

/* Nearest node to a point under the metric dlat² + (kx·dlon)² (lowest index wins a tie), by searching
 * outwards ring by ring through a bucket grid. */
function buildIndex(net) {
  const nN = net.lat.length;
  let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
  for (let i = 0; i < nN; i++) {
    const la = net.lat[i], lo = net.lon[i];
    if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo;
  }
  const side = Math.max(1, Math.round(Math.sqrt(nN / 2)));
  const cLat = Math.max((n - s) / side, 1e-9), cLon = Math.max((e - w) / side, 1e-9);
  const gy = Math.floor((n - s) / cLat) + 1, gx = Math.floor((e - w) / cLon) + 1;
  const start = new Int32Array(gx * gy + 1), item = new Int32Array(nN), slot = new Int32Array(nN);
  for (let i = 0; i < nN; i++) {
    slot[i] = Math.floor((net.lat[i] - s) / cLat) * gx + Math.floor((net.lon[i] - w) / cLon);
    start[slot[i] + 1]++;
  }
  for (let i = 0; i < gx * gy; i++) start[i + 1] += start[i];
  const fill = start.slice(0, gx * gy);
  for (let i = 0; i < nN; i++) item[fill[slot[i]]++] = i;   // ascending node order inside each bucket
  return { s, w, cLat, cLon, gx, gy, start, item };
}

function nearest(net, ix, lat, lon, kx) {
  const { s, w, cLat, cLon, gx, gy, start, item } = ix;
  const cy = Math.max(0, Math.min(gy - 1, Math.floor((lat - s) / cLat)));
  const cx = Math.max(0, Math.min(gx - 1, Math.floor((lon - w) / cLon)));
  let best = Infinity, bi = -1;
  const scan = (x, y) => {
    const b = y * gx + x;
    for (let k = start[b]; k < start[b + 1]; k++) {
      const i = item[k], dd = (net.lat[i] - lat) ** 2 + ((net.lon[i] - lon) * kx) ** 2;
      if (dd < best || (dd === best && i < bi)) { best = dd; bi = i; }
    }
  };
  const maxR = Math.max(gx, gy);
  for (let r = 0; r <= maxR; r++) {
    // every node not yet scanned is at least (r - 1) cells away on some axis, and further once the point sits off its bucket
    if (bi >= 0) {
      // the point may lie outside the node bounding box; measure from the clamped cell's edges generously
      const reach = Math.min((r - 1) * cLat, (r - 1) * cLon * kx);
      if (reach > 0 && reach * reach > best) break;
    }
    if (r === 0) { scan(cx, cy); continue; }
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || x >= gx) continue;
      if (cy - r >= 0) scan(x, cy - r);
      if (cy + r < gy) scan(x, cy + r);
    }
    for (let y = cy - r + 1; y <= cy + r - 1; y++) {
      if (y < 0 || y >= gy) continue;
      if (cx - r >= 0) scan(cx - r, y);
      if (cx + r < gx) scan(cx + r, y);
    }
  }
  return { node: bi, dd: best };
}

export function prepareNet(d, MinHeap) {
  const net = d.net, nN = net.lat.length, nE = net.edges.length;
  const off = new Int32Array(nN + 1);
  for (const [u, v] of net.edges) { off[u + 1]++; off[v + 1]++; }
  for (let i = 0; i < nN; i++) off[i + 1] += off[i];
  const to = new Int32Array(2 * nE), road = new Int32Array(2 * nE), edge = new Int32Array(2 * nE), len = new Float64Array(2 * nE);
  const at = off.slice(0, nN);
  net.edges.forEach(([u, v, ri], k) => {   // edge order, u→v then v→u, as the old adjacency lists were built
    let p = at[u]++; to[p] = v; road[p] = ri; edge[p] = k; len[p] = kmArc(net, u, v);
    p = at[v]++; to[p] = u; road[p] = ri; edge[p] = k; len[p] = kmArc(net, v, u);
  });
  const index = buildIndex(net);
  const centres = (d.sites || []).filter((x) => x.kind === EVAC).map((x) => ({ ...x, node: nearest(net, index, x.lat, x.lon, 1).node }));
  return { d, net, nN, nE, off, to, road, edge, len, index, centres, heap: new MinHeap(2 * nE + 4), dist: new Float64Array(nN), prev: new Int32Array(nN), via: new Int32Array(nN), grid: null };
}

const cellAt = (geo, W, H, lat, lon) => {
  const x = Math.floor(((lon - geo.west) / (geo.east - geo.west)) * W), y = Math.floor(((geo.north - lat) / (geo.north - geo.south)) * H);
  return x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x;
};

/* What depends on the grid (not the run): the cells under the five samples along each edge, the cell of
 * each node and centre, and which nodes are on the edge of the model. */
export function prepareGrid(P, geo, W, H) {
  if (P.grid && P.grid.geo === geo && P.grid.W === W && P.grid.H === H) return P.grid;
  const net = P.net, nN = P.nN;
  const sample = new Int32Array(5 * P.nE), node = new Int32Array(nN), exit = new Uint8Array(nN);
  net.edges.forEach(([u, v], k) => {
    for (let t = 0; t <= 4; t++) {
      const f = t / 4;
      sample[5 * k + t] = cellAt(geo, W, H, net.lat[u] + (net.lat[v] - net.lat[u]) * f, net.lon[u] + (net.lon[v] - net.lon[u]) * f);
    }
  });
  const mx = ((geo.east - geo.west) / W) * 3, my = ((geo.north - geo.south) / H) * 3;
  for (let n = 0; n < nN; n++) {
    node[n] = cellAt(geo, W, H, net.lat[n], net.lon[n]);
    exit[n] = net.lat[n] < geo.south + my || net.lat[n] > geo.north - my || net.lon[n] < geo.west + mx || net.lon[n] > geo.east - mx ? 1 : 0;
  }
  const centreCell = P.centres.map((x) => cellAt(geo, W, H, x.lat, x.lon));
  return (P.grid = { geo, W, H, sample, node, exit, centreCell });
}

/* What depends on the run: edges and nodes under more than 0.3 m of water, and which centres are flooded. */
export function prepareRun(P, geo, W, H, run, ocean) {
  const G = prepareGrid(P, geo, W, H), dry = (c) => c >= 0 && run.wet[c] && !(ocean && ocean[c]);
  const closed = new Uint8Array(P.nE), wet = new Uint8Array(P.nN);
  for (let k = 0; k < P.nE; k++) {
    for (let t = 0; t < 5; t++) {
      const c = G.sample[5 * k + t];
      if (dry(c) && run.depth[c] >= DEEP) { closed[k] = 1; break; }
    }
  }
  for (let n = 0; n < P.nN; n++) { const c = G.node[n]; wet[n] = c >= 0 && run.wet[c] && run.depth[c] >= DEEP && !(ocean && ocean[c]) ? 1 : 0; }
  const flooded = P.centres.map((_, i) => { const c = G.centreCell[i]; return c >= 0 && run.wet[c] && run.depth[c] >= CENTRE_DEEP; });
  return { P, closed, wet, flooded };
}

export function routeFrom(R, lat, lon) {
  const { P, closed, wet, flooded } = R, { net, off, to, road, edge, len, heap, dist, prev, via } = P, G = P.grid, d = P.d;
  const { node: start, dd } = nearest(net, P.index, lat, lon, Math.cos((lat * Math.PI) / 180));
  const startKm = Math.sqrt(dd) * 111;
  if (start < 0 || startKm > 0.5) return { none: true };
  const centres = P.centres, centreAt = new Map();
  centres.forEach((x, i) => { if (!flooded[i] && x.node >= 0) centreAt.set(x.node, x); });
  dist.fill(Infinity); prev.fill(-1); via.fill(-1); heap.n = 0;
  if (!wet[start]) { dist[start] = 0; heap.push(0, start); }
  let exitNode = -1, centreNode = -1;
  while (heap.n) {
    const u = heap.pop();
    if (exitNode < 0 && G.exit[u]) exitNode = u;
    if (centreNode < 0 && centreAt.has(u)) centreNode = u;
    if (exitNode >= 0 && (centreNode >= 0 || !centreAt.size)) break;
    for (let p = off[u]; p < off[u + 1]; p++) {
      if (closed[edge[p]]) continue;
      const v = to[p];
      if (wet[v]) continue;
      const nd = dist[u] + len[p];
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; via[v] = road[p]; heap.push(nd, v); }
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
    centres: centres.length, centresFlooded: flooded.filter(Boolean).length };
}

/* ---- shared by the flood-impact sweep and the over-time access analysis ---- */

/* The nearest road node to each building: searched among the road nodes in the 3×3 buckets of 0.002° around it,
 * longitude scaled by 0.9; -1 where there is none. Depends only on the network and the buildings. */
export function buildingNodes(P, bx, by) {
  if (P.bnodes && P.bnodes.bx === bx && P.bnodes.by === by) return P.bnodes.v;
  const net = P.net, hs = 0.002, OFF = 4194304, SPAN = 8388608, key = (ky, kx) => (ky + OFF) * SPAN + (kx + OFF);
  const hash = new Map();
  for (let n = 0; n < P.nN; n++) {
    const k = key(Math.floor(net.lat[n] / hs), Math.floor(net.lon[n] / hs));
    let l = hash.get(k); if (!l) hash.set(k, (l = [])); l.push(n);
  }
  const nB = bx.length, v = new Int32Array(nB).fill(-1);
  for (let i = 0; i < nB; i++) {
    const ky = Math.floor(by[i] / hs), kx = Math.floor(bx[i] / hs);
    let bd = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const l = hash.get(key(ky + dy, kx + dx));
      if (l) for (const n of l) {
        const dd = (net.lat[n] - by[i]) ** 2 + ((net.lon[n] - bx[i]) * 0.9) ** 2;
        if (dd < bd) { bd = dd; v[i] = n; }
      }
    }
  }
  P.bnodes = { bx, by, v };
  return v;
}

/* Road nodes joined to the edge of the model by the whole network, flooded or not (roads that never reach it,
 * private roads or mapping gaps, aren't cut off by a flood). */
export function dryReachOf(P) {
  const G = P.grid;
  if (P.dryReach && P.dryReachGrid === G) return P.dryReach;
  const { off, to } = P, r = new Uint8Array(P.nN), q = new Int32Array(P.nN);
  let qt = 0;
  for (let n = 0; n < P.nN; n++) if (G.exit[n]) { r[n] = 1; q[qt++] = n; }
  for (let h = 0; h < qt; h++) { const u = q[h]; for (let p = off[u]; p < off[u + 1]; p++) if (!r[to[p]]) { r[to[p]] = 1; q[qt++] = to[p]; } }
  P.dryReach = r; P.dryReachGrid = G;
  return r;
}

/* Dry road nodes still joined to the edge of the model by dry roads. */
export function reachableFromEdge(R) {
  const { P, closed, wet } = R, { off, to, edge } = P, G = P.grid, r = new Uint8Array(P.nN), q = new Int32Array(P.nN);
  let qt = 0;
  for (let n = 0; n < P.nN; n++) if (G.exit[n] && !wet[n]) { r[n] = 1; q[qt++] = n; }
  for (let h = 0; h < qt; h++) {
    const u = q[h];
    for (let p = off[u]; p < off[u + 1]; p++) { const m = to[p]; if (!r[m] && !closed[edge[p]]) { r[m] = 1; q[qt++] = m; } }
  }
  return r;
}

/* The flood's effect on the roads: edges under water, edges left stranded, and the dry buildings whose
 * nearest road is cut off from the edge of the model. bFlood marks flooded buildings. */
export function roadImpact(R, bx, by, bFlood) {
  const { P, closed, wet } = R, net = P.net, reach = reachableFromEdge(R), dr = dryReachOf(P), bn = buildingNodes(P, bx, by);
  const cutEdges = [], islandEdges = [];
  for (let k = 0; k < P.nE; k++) {
    const [u, v] = net.edges[k];
    if (closed[k]) cutEdges.push([u, v]);
    else if (!reach[u] || !reach[v]) islandEdges.push([u, v]);
  }
  const nB = bx.length, iso = new Uint8Array(nB);
  let isolatedB = 0;
  for (let i = 0; i < nB; i++) {
    if (bFlood[i]) continue;
    const b = bn[i];
    if (b >= 0 && !wet[b] && !reach[b] && dr[b]) { iso[i] = 1; isolatedB++; }
  }
  return { cutEdges, islandEdges, isolatedB, iso };
}
