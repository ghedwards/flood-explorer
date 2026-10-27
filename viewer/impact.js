/* The flood's effect on buildings, people, workers and roads for one model run. The module holds the area's
 * road network, buildings and census areas (roadnet.js); the sweep that changes with the run is Rust
 * (rust/flood-core/src/impact.rs, FloodCore.netImpact). tests/impact.test.js holds it to the earlier
 * JavaScript sweep (tests/impact-reference.js). */

import { setGrid, setBuildings, setCensus, setRun } from './roadnet.js';

/* The figures the impact panel shows, less the key sites (the page works those out). P is the area's road
 * network (roadNet, which may have no roads); the census areas must be painted on d.sa1Grid / d.sa2Grid. */
export function scenarioImpact({ d, a, run, geo, P, ringsKm2 }) {
  setGrid(P, geo, a.W, a.H);
  setBuildings(P, d);
  setCensus(P, d, a);
  setRun(P, run, a.ocean);
  const km2 = (s) => s.km2 || s.feats.map((f) => ringsKm2(f.geometry?.rings));
  const r = P.F.netImpact(P.n, {
    cellM: a.cell,
    sa1Pop: d.sa1 ? Float64Array.from(d.sa1.pop) : null, sa1Km2: d.sa1 ? Float64Array.from(km2(d.sa1)) : null,
    sa2Workers: d.sa2 ? Float64Array.from(d.sa2.workers) : null, sa2Km2: d.sa2 ? Float64Array.from(d.sa2.km2) : null,
  });
  const hasNet = d.net.lat.length > 0, net = d.net;
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
    buildings: d.bx.length, bWet: r.bWet, bDeep: r.bDeep, hWet: r.hWet, workers: d.sa2 ? r.workers : null, workersAll: d.sa2 ? r.workersAll : null,
    homesTagged: d.isHome.reduce((x, y) => x + y, 0), workWet: r.workWet, workTagged: d.isWork.reduce((x, y) => x + y, 0),
    bDepth: r.bDepth, isolatedB: hasNet ? r.isolatedB : 0, peopleIsolated: d.sa1 && hasNet ? r.peopleIsolated : null,
    cutEdges: hasNet ? Array.from(r.cutEdges, pair) : [], islandEdges: hasNet ? Array.from(r.islandEdges, pair) : [],
    people: d.sa1 ? r.people : null, cutKm, roadKm: r.roadKm, worstRoads, sites: d.sites.length,
  };
}
