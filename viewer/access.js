/* Road access over time, for a flood timeline: at each step, which roads are under water, how many buildings
 * are flooded, and how many are cut off (their nearest road no longer reaches the edge of the model by dry
 * roads, though it would if nothing were flooded). Built on the prepared road network (routing.js), so the
 * adjacency, the cells under each road, and the nearest road node of each building are worked out once, not
 * once per step. */

import { prepareGrid, buildingNodes, dryReachOf } from './routing.js';

const DEEP_BIT = (bits, base, c) => c >= 0 && (bits[base + (c >>> 5)] & (1 << (c & 31))) !== 0;

/* The distinct cells under the samples along each edge (a road can reopen between peaks, so it is tested at
 * each step); kept with the grid. */
function edgeCells(P, G) {
  if (G.edgeCells) return G.edgeCells;
  const off = new Int32Array(P.nE + 1), cells = [];
  for (let e = 0; e < P.nE; e++) {
    const from = cells.length;
    for (let t = 0; t < 5; t++) {
      const c = G.sample[5 * e + t];
      if (c >= 0 && !cells.includes(c, from)) cells.push(c);
    }
    off[e + 1] = cells.length;
  }
  return (G.edgeCells = { off, cell: Int32Array.from(cells) });
}

export function timelineAccess(tl, d, P, geo, W, H) {
  const G = prepareGrid(P, geo, W, H), { off, to, edge } = P, nN = P.nN, nE = P.nE, K = tl.steps, wps = tl.wordsPerStep;
  const ec = edgeCells(P, G), net = P.net, nB = d.bx.length;
  const bNode = buildingNodes(P, d.bx, d.by), dryReach = dryReachOf(P);
  const bCell = new Int32Array(nB);
  for (let i = 0; i < nB; i++) {   // the same arithmetic as the page's cellOf
    const x = Math.floor(((d.bx[i] - geo.west) / (geo.east - geo.west)) * W), y = Math.floor(((geo.north - d.by[i]) / (geo.north - geo.south)) * H);
    bCell[i] = x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x;
  }
  // road names, by index: ids shared between roads of the same name; -1 for none
  const nameId = new Int32Array(d.roads.length).fill(-1), names = [], idOf = new Map();
  d.roads.forEach((r, i) => { if (r.name) { if (!idOf.has(r.name)) { idOf.set(r.name, names.length); names.push(r.name); } nameId[i] = idOf.get(r.name); } });
  const edgeName = new Int32Array(nE);
  for (let e = 0; e < nE; e++) edgeName[e] = nameId[net.edges[e][2]];

  const roads = new Map(), edgeClosed = new Uint8Array(nE), seen = new Int32Array(names.length);
  const isoSteps = new Int16Array(nB), firstIso = new Int16Array(nB).fill(-1), isoRun = new Int16Array(nB);
  const isoCount = new Int32Array(K), floodCount = new Int32Array(K), closedCount = new Int32Array(K);
  const reach = new Uint8Array(nN), q = new Int32Array(nN);
  let longest = 0;
  for (let k = 0; k < K; k++) {
    const base = k * wps;
    reach.fill(0);
    const closedNames = [];
    let closed = 0;
    for (let e = 0; e < nE; e++) {
      let c = 0;
      for (let p = ec.off[e]; p < ec.off[e + 1]; p++) if (DEEP_BIT(tl.deepBits, base, ec.cell[p])) { c = 1; break; }
      edgeClosed[e] = c;
      if (!c) continue;
      closed++;
      const nm = edgeName[e];
      if (nm >= 0 && seen[nm] !== k + 1) { seen[nm] = k + 1; closedNames.push(nm); }
    }
    closedCount[k] = closed;
    for (const nm of closedNames) {
      const name = names[nm], intervals = roads.get(name) || [], last = intervals[intervals.length - 1];
      if (last && last.to === k - 1) last.to = k;
      else intervals.push({ name, from: k, to: k });
      roads.set(name, intervals);
    }
    let qt = 0;
    for (let n = 0; n < nN; n++) if (G.exit[n] && !DEEP_BIT(tl.deepBits, base, G.node[n])) { reach[n] = 1; q[qt++] = n; }
    for (let h = 0; h < qt; h++) {
      const u = q[h];
      for (let p = off[u]; p < off[u + 1]; p++) {
        const m = to[p];
        if (reach[m] || edgeClosed[edge[p]] || DEEP_BIT(tl.deepBits, base, G.node[m])) continue;
        reach[m] = 1; q[qt++] = m;
      }
    }
    for (let i = 0; i < nB; i++) {
      if (DEEP_BIT(tl.wetBits, base, bCell[i])) { floodCount[k]++; isoRun[i] = 0; continue; }
      const b = bNode[i];
      if (b >= 0 && !reach[b] && dryReach[b]) {
        isoCount[k]++; isoSteps[i]++; isoRun[i]++;
        if (isoRun[i] > longest) longest = isoRun[i];
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
