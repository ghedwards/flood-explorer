/* The flood's effect on buildings, people, workers and roads for one model run. What depends only on the area
 * and the grid (the cell under each building, the road network as flat arrays, each census area's share inside
 * the model, the road geometry) is prepared once; the sweep that changes with the run is Rust
 * (rust/flood-core/src/impact.rs, FloodCore.impactSweep). tests/impact.test.js holds the two to the earlier
 * JavaScript sweep (tests/impact-reference.js). */

import { prepareGrid, buildingNodes, dryReachOf } from './routing.js';

const NONE_I32 = new Int32Array(0), NONE_U8 = new Uint8Array(0), NONE_F64 = new Float64Array(0);

function buildStatic(d, a, geo, P) {
  const nB = d.bx.length, W = a.W, H = a.H, N = a.N, hasNet = Boolean(P);
  const S = { a, geo, sa1Grid: d.sa1Grid, sa2Grid: d.sa2Grid, bx: d.bx, by: d.by, isHome: d.isHome, isWork: d.isWork, roads: d.roads, net: d.net };
  S.bCell = new Int32Array(nB);
  for (let i = 0; i < nB; i++) {   // the same arithmetic as the page's cellOf
    const x = Math.floor(((d.bx[i] - geo.west) / (geo.east - geo.west)) * W), y = Math.floor(((geo.north - d.by[i]) / (geo.north - geo.south)) * H);
    S.bCell[i] = x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x;
  }
  S.homeFlags = Uint8Array.from(d.isHome);
  S.workFlags = Uint8Array.from(d.isWork);
  if (hasNet) {
    const G = prepareGrid(P, geo, W, H), net = P.net;
    S.bNode = buildingNodes(P, d.bx, d.by);
    S.edgeU = new Int32Array(P.nE); S.edgeV = new Int32Array(P.nE);
    for (let k = 0; k < P.nE; k++) { S.edgeU[k] = net.edges[k][0]; S.edgeV[k] = net.edges[k][1]; }
    S.exit = G.exit; S.dryReach = dryReachOf(P);
  }
  const cellKm2 = (a.cell * a.cell) / 1e6;
  S.sa1Inside = NONE_F64; S.sa1Land = NONE_F64; S.sa2Inside = NONE_F64;
  if (d.sa1) {   // each SA1's area inside the model, and its land cells
    const nS = d.sa1.pop.length, inside = new Float64Array(nS), land = new Float64Array(nS);
    for (let c = 0; c < N; c++) { const s = d.sa1Grid[c]; if (s >= 0) { inside[s] += cellKm2; if (!(a.ocean && a.ocean[c])) land[s]++; } }
    S.sa1Inside = inside; S.sa1Land = land;
  }
  if (d.sa2) {   // each SA2's area inside the model
    const inside = new Float64Array(d.sa2.workers.length);
    for (let c = 0; c < N; c++) { const s = d.sa2Grid[c]; if (s >= 0) inside[s] += cellKm2; }
    S.sa2Inside = inside;
  }
  const lat = [], lon = [], off = [0];
  for (const rd of d.roads) { for (const p of rd.pts) { lat.push(p.lat); lon.push(p.lon); } off.push(lat.length); }
  S.roadLat = Float64Array.from(lat); S.roadLon = Float64Array.from(lon); S.roadOff = Int32Array.from(off);
  return S;
}

/* The sweep for one run. P is the prepared road network (routing.js) and R this run's flooded roads
 * (prepareRun), both null without a road network. Returns the figures the impact panel shows, less the
 * key sites (the page works those out). */
export function scenarioImpact({ d, a, run, geo, P, R, sweep, ringsKm2 }) {
  let S = d.impactStatic;
  if (!S || S.a !== a || S.geo !== geo || S.sa1Grid !== d.sa1Grid || S.sa2Grid !== d.sa2Grid || S.bx !== d.bx || S.by !== d.by || S.isHome !== d.isHome || S.isWork !== d.isWork || S.roads !== d.roads || S.net !== d.net) S = d.impactStatic = buildStatic(d, a, geo, P);
  // each census area's share inside the model (a handful of numbers, so worked out every time)
  const sa1Pop = d.sa1 ? Float64Array.from(d.sa1.pop, (p, s) => {
    const km2 = d.sa1.km2 ? d.sa1.km2[s] : ringsKm2(d.sa1.feats[s].geometry?.rings);
    return p * (km2 > 0 ? Math.min(1, S.sa1Inside[s] / km2) : 0);
  }) : NONE_F64;
  const sa2Workers = d.sa2 ? Float64Array.from(d.sa2.workers, (w, s) => w * (d.sa2.km2[s] > 0 ? Math.min(1, S.sa2Inside[s] / d.sa2.km2[s]) : 0)) : NONE_F64;
  const nB = d.bx.length, hasNet = Boolean(P && R), net = d.net;
  const r = sweep({
    west: geo.west, east: geo.east, south: geo.south, north: geo.north, W: a.W, H: a.H, cellM: a.cell,
    wet: run.wet, depth: run.depth, ocean: a.ocean || NONE_U8,
    bCell: S.bCell, isHome: S.homeFlags, isWork: S.workFlags, bNode: hasNet ? S.bNode : new Int32Array(nB).fill(-1),
    off: hasNet ? P.off : NONE_I32, to: hasNet ? P.to : NONE_I32, edge: hasNet ? P.edge : NONE_I32,
    edgeU: hasNet ? S.edgeU : NONE_I32, edgeV: hasNet ? S.edgeV : NONE_I32,
    exit: hasNet ? S.exit : NONE_U8, dryReach: hasNet ? S.dryReach : NONE_U8,
    closed: hasNet ? R.closed : NONE_U8, roadWet: hasNet ? R.wet : NONE_U8,
    sa1Grid: d.sa1 ? d.sa1Grid : NONE_I32, sa1Pop, sa1Land: S.sa1Land,
    sa2Grid: d.sa2 ? d.sa2Grid : NONE_I32, sa2Workers,
    roadLat: S.roadLat, roadLon: S.roadLon, roadOff: S.roadOff,
  });
  const pair = (k) => [net.edges[k][0], net.edges[k][1]];
  // roads: length under more than 0.3 m of water, and the worst-hit named roads
  const cutBy = new Map();
  let cutKm = 0;
  d.roads.forEach((rd, i) => {
    const cut = r.roadCutKm[i];
    if (cut > 0) { cutKm += cut; const key = rd.name || `(unnamed ${rd.type})`; cutBy.set(key, (cutBy.get(key) || 0) + cut); }
  });
  const worstRoads = Array.from(cutBy.entries()).filter(([n]) => !n.startsWith('(unnamed')).sort((x, y) => y[1] - x[1]).slice(0, 8);
  return {
    buildings: nB, bWet: r.bWet, bDeep: r.bDeep, hWet: r.hWet, workers: d.sa2 ? r.workers : null, workersAll: d.sa2 ? r.workersAll : null,
    homesTagged: d.isHome.reduce((x, y) => x + y, 0), workWet: r.workWet, workTagged: d.isWork.reduce((x, y) => x + y, 0),
    bDepth: r.bDepth, isolatedB: hasNet ? r.isolatedB : 0, peopleIsolated: d.sa1 && hasNet ? r.peopleIsolated : null,
    cutEdges: hasNet ? Array.from(r.cutEdges, pair) : [], islandEdges: hasNet ? Array.from(r.islandEdges, pair) : [],
    people: d.sa1 ? r.people : null, cutKm, roadKm: r.roadKm, worstRoads, sites: d.sites.length,
  };
}
