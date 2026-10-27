/* Road access over time, for a flood timeline: at each step, which roads are under water, how many buildings
 * are flooded, and how many are cut off (their nearest road no longer reaches the edge of the model by dry
 * roads, though it would if nothing were flooded). This prepares the road network and the buildings (routing.js:
 * the adjacency, the cells under each road, the nearest road node of each building) and hands the step loop to
 * Rust; the road closures and the summary are put together here. */

import { prepareGrid, buildingNodes, dryReachOf } from './routing.js';

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

/* Edges by cell (the inverse of edgeCells): which edges are closed when a cell is deep. */
function cellEdges(P, G, N) {
  if (G.cellEdges) return G.cellEdges;
  const ec = edgeCells(P, G), off = new Int32Array(N + 1);
  for (let p = 0; p < ec.cell.length; p++) off[ec.cell[p] + 1]++;
  for (let c = 0; c < N; c++) off[c + 1] += off[c];
  const at = off.slice(0, N), list = new Int32Array(ec.cell.length);
  for (let e = 0; e < P.nE; e++) for (let p = ec.off[e]; p < ec.off[e + 1]; p++) list[at[ec.cell[p]]++] = e;
  return (G.cellEdges = { off, list });
}

/* The buildings, against the grid and the network: each one's cell, how many buildings per cell, and the
 * buildings that have each road node as their nearest. */
function buildingsOn(P, G, d, W, H, geo, bNode) {
  const c = P.bstatic;
  if (c && c.bx === d.bx && c.by === d.by && c.G === G) return c;
  const nB = d.bx.length, bCell = new Int32Array(nB), count = new Int32Array(W * H), nodeOff = new Int32Array(P.nN + 1);
  for (let i = 0; i < nB; i++) {   // the same arithmetic as the page's cellOf
    const x = Math.floor(((d.bx[i] - geo.west) / (geo.east - geo.west)) * W), y = Math.floor(((geo.north - d.by[i]) / (geo.north - geo.south)) * H);
    const cell = x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x;
    bCell[i] = cell;
    if (cell >= 0) count[cell]++;
    if (bNode[i] >= 0) nodeOff[bNode[i] + 1]++;
  }
  for (let n = 0; n < P.nN; n++) nodeOff[n + 1] += nodeOff[n];
  const at = nodeOff.slice(0, P.nN), nodeList = new Int32Array(nodeOff[P.nN]);
  for (let i = 0; i < nB; i++) if (bNode[i] >= 0) nodeList[at[bNode[i]]++] = i;
  return (P.bstatic = { bx: d.bx, by: d.by, G, bCell, count, nodeOff, nodeList });
}

/* A closed road name at step k: extend its last closure if it was closed the step before, else start a new one. */
function closeRoad(roads, name, k) {
  const intervals = roads.get(name) || [], last = intervals[intervals.length - 1];
  if (last && last.to === k - 1) last.to = k;
  else intervals.push({ name, from: k, to: k });
  roads.set(name, intervals);
}

function summarise(tl, roads, { isoCount, floodCount, closedCount, isoSteps, firstIso, longest }) {
  const K = tl.steps;
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

/* The step loop is FloodCore.accessOverTime (rust/flood-core/src/access.rs); the flood timeline it analyses only
 * exists with the WebAssembly model, so there is no JavaScript copy of it. tests/access.test.js checks it against the
 * earlier per-step version. */
export function timelineAccess(tl, d, P, geo, W, H, accessOverTime) {
  const G = prepareGrid(P, geo, W, H), { off, to, edge } = P, nE = P.nE, K = tl.steps, wps = tl.wordsPerStep, N = W * H;
  const ce = cellEdges(P, G, N), net = P.net;
  const bNode = buildingNodes(P, d.bx, d.by), dryReach = dryReachOf(P);
  const B = buildingsOn(P, G, d, W, H, geo, bNode);
  // road names, by index: ids shared between roads of the same name; -1 for none
  const nameId = new Int32Array(d.roads.length).fill(-1), names = [], idOf = new Map();
  d.roads.forEach((r, i) => { if (r.name) { if (!idOf.has(r.name)) { idOf.set(r.name, names.length); names.push(r.name); } nameId[i] = idOf.get(r.name); } });
  const edgeName = new Int32Array(nE);
  for (let e = 0; e < nE; e++) edgeName[e] = nameId[net.edges[e][2]];

  const r = accessOverTime({
    steps: K, wps, cells: N, names: names.length, off, to, edge, nodeCell: G.node, exit: G.exit, dryReach,
    ceOff: ce.off, ceList: ce.list, edgeName, bCell: B.bCell, bCount: B.count, nodeOff: B.nodeOff, nodeList: B.nodeList,
    wet: tl.wetBits, deep: tl.deepBits,
  });
  const roads = new Map();
  for (let k = 0, at = 0; k < K; k++) for (let j = 0; j < r.nameCounts[k]; j++) closeRoad(roads, names[r.nameIds[at++]], k);
  return summarise(tl, roads, r);
}
