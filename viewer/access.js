/* Road access over time, for a flood timeline: at each step, which roads are under water, how many buildings
 * are flooded, and how many are cut off (their nearest road no longer reaches the edge of the model by dry
 * roads, though it would if nothing were flooded). The module holds the road network and the buildings
 * (roadnet.js) and runs the step loop (rust/flood-core/src/access.rs, FloodCore.netAccess); the road closures
 * and the summary are put together here. The flood timeline only exists with the WebAssembly model, so there
 * is no JavaScript copy of the loop; tests/access.test.js checks it against the earlier per-step version. */

import { setGrid, setBuildings } from './roadnet.js';

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

export function timelineAccess(tl, d, P, geo, W, H) {
  setGrid(P, geo, W, H);
  setBuildings(P, d);
  // road names, by index: ids shared between roads of the same name; -1 for none
  const nameId = new Int32Array(d.roads.length).fill(-1), names = [], idOf = new Map();
  d.roads.forEach((r, i) => { if (r.name) { if (!idOf.has(r.name)) { idOf.set(r.name, names.length); names.push(r.name); } nameId[i] = idOf.get(r.name); } });
  const edgeName = Int32Array.from(P.road, (r) => nameId[r]);
  const K = tl.steps, r = P.F.netAccess(P.n, { steps: K, wps: tl.wordsPerStep, names: names.length, edgeName, wet: tl.wetBits, deep: tl.deepBits });
  const roads = new Map();
  for (let k = 0, at = 0; k < K; k++) for (let j = 0; j < r.nameCounts[k]; j++) closeRoad(roads, names[r.nameIds[at++]], k);
  return summarise(tl, roads, r);
}
