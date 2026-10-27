// The flood-impact sweep as it was before it moved to Rust (viewer/impact.js, rust/flood-core/src/impact.rs): the
// reference tests/impact.test.js holds the Rust version to. Copied from viewer/app.js as it stood then; the page does
// not use it. Free variables are passed in.
'use strict';

module.exports = function makeReference({ state, $, cellOf, drawRings, ringsKm2, damageShare }) {
  function computeImpact(d, useCache) {
    const a = state.a, run = state.run;
    if (!a || !run || !d) return null;
    // Everything but the floor-height numbers depends only on the impact
    // data and the model run, so memoise the heavy sweep on d. Runs and
    // area objects are replaced per scenario, invalidating naturally (like
    // state.hazard); draw and per-call work beyond one floor loop goes away.
    if (!useCache || !d.cache || d.cache.a !== a || d.cache.run !== run) {
      const ts = Date.now();   // (Date, not performance: tests run this outside a browser)
      d.cache = { a, run, base: computeScenarioImpact(d, a, run) };
      d.cache.sweepMs = Date.now() - ts;
    }
    const base = d.cache.base;
    const noFloor = $('floorUnknown') && $('floorUnknown').checked;
    const floorH = noFloor ? null : parseFloat($('floorHeight').value);
    const nB = d.bx.length;
    let overFloor = null, damage = null;
    if (floorH != null) {
      overFloor = 0; damage = 0;
      for (let i = 0; i < nB; i++) {
        const z = base.bDepth[i];
        if (z > floorH && z > 0) { overFloor++; damage += damageShare(z - floorH); }
      }
      damage *= Math.max(0, parseFloat($('bldValue').value) || 0);
    }
    return Object.assign({}, base, { overFloor, floorH, damage });
    // The heavy sweep: buildings, roads and isolation (BFS over dry roads),
    // people (SA1), workers (SA2), road lengths and key sites. Rebuilt only
    // when the impact data or the run changes.
    function computeScenarioImpact(d, a, run) {
    const depthAt = (c) => (c >= 0 && run.wet[c] && !(a.ocean && a.ocean[c]) ? run.depth[c] : 0);
    // buildings
    const nB = d.bx.length;
    let bWet = 0, bDeep = 0, hWet = 0, workWet = 0;
    const bCell = new Int32Array(nB), bFlood = new Uint8Array(nB), bDepth = new Float32Array(nB);
    for (let i = 0; i < nB; i++) {
      const c = cellOf(d.by[i], d.bx[i]);
      bCell[i] = c;
      const z = bDepth[i] = depthAt(c);
      if (z >= 0.15) {
        bWet++; bFlood[i] = 1;
        if (d.isHome[i]) hWet++;
        if (d.isWork[i]) workWet++;
        if (z >= 0.5) bDeep++;
      }
    }
    // evacuation: dry roads still joined to the edge of the model area by
    // dry roads; dry buildings whose nearest road is cut off are isolated
    const net = d.net;
    let isolatedB = 0, isolatedPeopleW = null, cutEdges = [], islandEdges = [];
    if (net && net.lat.length) {
      const nN = net.lat.length, g = state.geo;
      const dryNode = new Uint8Array(nN);
      for (let n = 0; n < nN; n++) dryNode[n] = depthAt(cellOf(net.lat[n], net.lon[n])) < 0.3 ? 1 : 0;
      const adj = Array.from({ length: nN }, () => []);
      const edgeDry = net.edges.map(([u, v]) => {
        let ok = dryNode[u] && dryNode[v];
        if (ok) for (let t = 1; t < 4 && ok; t++) { const f = t / 4; if (depthAt(cellOf(net.lat[u] + (net.lat[v] - net.lat[u]) * f, net.lon[u] + (net.lon[v] - net.lon[u]) * f)) >= 0.3) ok = 0; }
        return ok;
      });
      net.edges.forEach(([u, v], k) => { if (edgeDry[k]) { adj[u].push(v); adj[v].push(u); } });
      const mx = ((g.east - g.west) / a.W) * 3, my = ((g.north - g.south) / a.H) * 3;
      const reach = new Uint8Array(nN), q = [];
      for (let n = 0; n < nN; n++) {
        const edge = net.lat[n] < g.south + my || net.lat[n] > g.north - my || net.lon[n] < g.west + mx || net.lon[n] > g.east - mx;
        if (edge && dryNode[n]) { reach[n] = 1; q.push(n); }
      }
      for (let h = 0; h < q.length; h++) for (const m of adj[q[h]]) if (!reach[m]) { reach[m] = 1; q.push(m); }
      // roads that don't join the edge even when everything is dry (private
      // roads, mapping gaps) aren't cut off by the flood
      if (!net.dryReach) {
        const all = Array.from({ length: nN }, () => []);
        net.edges.forEach(([u, v]) => { all[u].push(v); all[v].push(u); });
        const dr = new Uint8Array(nN), q2 = [];
        for (let n = 0; n < nN; n++) if (net.lat[n] < g.south + my || net.lat[n] > g.north - my || net.lon[n] < g.west + mx || net.lon[n] > g.east - mx) { dr[n] = 1; q2.push(n); }
        for (let h = 0; h < q2.length; h++) for (const m of all[q2[h]]) if (!dr[m]) { dr[m] = 1; q2.push(m); }
        net.dryReach = dr;
      }
      net.edges.forEach(([u, v, ri], k) => {
        if (!edgeDry[k]) cutEdges.push([u, v]);
        else if (!reach[u] || !reach[v]) islandEdges.push([u, v]);
      });
      // nearest road node for each dry building (grid hash ~ 200 m)
      const hs = 0.002, hash = new Map();
      for (let n = 0; n < nN; n++) { const k = `${Math.floor(net.lat[n] / hs)},${Math.floor(net.lon[n] / hs)}`; let l = hash.get(k); if (!l) hash.set(k, (l = [])); l.push(n); }
      const isoB = new Uint8Array(nB);
      for (let i = 0; i < nB; i++) {
        if (bFlood[i]) continue;
        const ky = Math.floor(d.by[i] / hs), kx = Math.floor(d.bx[i] / hs);
        let best = -1, bd = Infinity;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const n of hash.get(`${ky + dy},${kx + dx}`) || []) {
          const dd = (net.lat[n] - d.by[i]) ** 2 + ((net.lon[n] - d.bx[i]) * 0.9) ** 2;
          if (dd < bd) { bd = dd; best = n; }
        }
        if (best >= 0 && dryNode[best] && !reach[best] && net.dryReach[best]) { isoB[i] = 1; isolatedB++; }
      }
      isolatedPeopleW = isoB;
    }
    // people: each SA1's population spread over its buildings (or its land)
    let people = null, peopleIsolated = null;
    if (d.sa1) {
      if (!d.sa1Grid || d.sa1Key !== state.areaKey + a.W) {
        const px = drawRings(d.sa1.feats, state.geo, a.W, a.H, (f, i) => `rgb(${(i + 1) >> 16 & 255},${(i + 1) >> 8 & 255},${(i + 1) & 255})`);
        const idg = new Int32Array(a.N).fill(-1);
        for (let c = 0; c < a.N; c++) { const v = (px[4 * c] << 16) | (px[4 * c + 1] << 8) | px[4 * c + 2]; if (px[4 * c + 3] > 250 && v > 0 && v <= d.sa1.feats.length) idg[c] = v - 1; }
        d.sa1Grid = idg; d.sa1Key = state.areaKey + a.W;
      }
      const nS = d.sa1.pop.length, tot = new Float64Array(nS), hit = new Float64Array(nS), land = new Float64Array(nS), wetL = new Float64Array(nS), inside = new Float64Array(nS);
      for (let i = 0; i < nB; i++) { const s = bCell[i] >= 0 ? d.sa1Grid[bCell[i]] : -1; if (s >= 0) { tot[s]++; if (bFlood[i]) hit[s]++; } }
      for (let c = 0; c < a.N; c++) { const s = d.sa1Grid[c]; if (s >= 0) inside[s] += (a.cell * a.cell) / 1e6; }
      for (let c = 0; c < a.N; c++) { const s = d.sa1Grid[c]; if (s >= 0 && !(a.ocean && a.ocean[c])) { land[s]++; if (depthAt(c) >= 0.15) wetL[s]++; } }
      // Buildings are fetched only inside the model. Allocate only the
      // covered share of each SA1's population, as for SA2 workers below.
      const pop = d.sa1.pop.map((p, s) => {
        const km2 = d.sa1.km2 ? d.sa1.km2[s] : ringsKm2(d.sa1.feats[s].geometry?.rings);
        return p * (km2 > 0 ? Math.min(1, inside[s] / km2) : 0);
      });
      people = 0;
      for (let s = 0; s < nS; s++) people += pop[s] * (tot[s] > 0 ? hit[s] / tot[s] : (land[s] ? wetL[s] / land[s] : 0));
      if (isolatedPeopleW) {
        const iso = new Float64Array(nS);
        for (let i = 0; i < nB; i++) { const s0 = bCell[i] >= 0 ? d.sa1Grid[bCell[i]] : -1; if (s0 >= 0 && isolatedPeopleW[i]) iso[s0]++; }
        peopleIsolated = 0;
        for (let s = 0; s < nS; s++) if (tot[s] > 0) peopleIsolated += pop[s] * (iso[s] / tot[s]);
      }
    }
    // workers: each SA2's workers (by place of work) spread over its mapped
    // workplaces (or all its buildings if none are mapped by type), scaled
    // by how much of the SA2 lies inside the model
    let workers = null, workersAll = null;
    if (d.sa2) {
      if (!d.sa2Grid || d.sa2Key !== state.areaKey + a.W) {
        const px = drawRings(d.sa2.feats, state.geo, a.W, a.H, (f, i) => `rgb(${(i + 1) >> 16 & 255},${(i + 1) >> 8 & 255},${(i + 1) & 255})`);
        const idg = new Int32Array(a.N).fill(-1);
        for (let c = 0; c < a.N; c++) { const v = (px[4 * c] << 16) | (px[4 * c + 1] << 8) | px[4 * c + 2]; if (px[4 * c + 3] > 250 && v > 0 && v <= d.sa2.feats.length) idg[c] = v - 1; }
        d.sa2Grid = idg; d.sa2Key = state.areaKey + a.W;
      }
      const nS = d.sa2.workers.length, wT = new Float64Array(nS), wH = new Float64Array(nS), bT = new Float64Array(nS), bH = new Float64Array(nS), inside = new Float64Array(nS);
      for (let i = 0; i < nB; i++) {
        const s = bCell[i] >= 0 ? d.sa2Grid[bCell[i]] : -1;
        if (s < 0) continue;
        bT[s]++; if (bFlood[i]) bH[s]++;
        if (d.isWork[i]) { wT[s]++; if (bFlood[i]) wH[s]++; }
      }
      const cellKm2 = (a.cell * a.cell) / 1e6;
      for (let c = 0; c < a.N; c++) { const s = d.sa2Grid[c]; if (s >= 0) inside[s] += cellKm2; }
      workers = 0; workersAll = 0;
      for (let s = 0; s < nS; s++) {
        const frac = d.sa2.km2[s] > 0 ? Math.min(1, inside[s] / d.sa2.km2[s]) : 0, W = d.sa2.workers[s] * frac;
        workersAll += W;
        workers += W * (wT[s] >= 3 ? wH[s] / wT[s] : bT[s] > 0 ? bH[s] / bT[s] : 0);
      }
    }
    // roads: length under more than 0.3 m of water (impassable to cars)
    const cutBy = new Map();
    let cutKm = 0, roadKm = 0;
    for (const rd of d.roads) {
      let cut = 0;
      for (let k = 1; k < rd.pts.length; k++) {
        const p0 = rd.pts[k - 1], p1 = rd.pts[k];
        const len = Math.hypot((p1.lon - p0.lon) * Math.cos((p0.lat * Math.PI) / 180), p1.lat - p0.lat) * 111.32;
        roadKm += len;
        const steps = Math.max(1, Math.ceil((len * 1000) / a.cell));
        let wetSteps = 0;
        for (let t = 0; t < steps; t++) {
          const f = (t + 0.5) / steps;
          if (depthAt(cellOf(p0.lat + (p1.lat - p0.lat) * f, p0.lon + (p1.lon - p0.lon) * f)) >= 0.3) wetSteps++;
        }
        cut += (len * wetSteps) / steps;
      }
      if (cut > 0) { cutKm += cut; const key = rd.name || `(unnamed ${rd.type})`; cutBy.set(key, (cutBy.get(key) || 0) + cut); }
    }
    const worstRoads = Array.from(cutBy.entries()).filter(([n]) => !n.startsWith('(unnamed')).sort((x, y) => y[1] - x[1]).slice(0, 8);
    // key sites
    const sitesHit = d.sites.map((s) => ({ ...s, depth: depthAt(cellOf(s.lat, s.lon)) })).filter((s) => s.depth >= 0.15).sort((x, y) => y.depth - x.depth);
    return {
      buildings: nB, bWet, bDeep, hWet, workers, workersAll, homesTagged: d.isHome.reduce((x, y) => x + y, 0), workWet, workTagged: d.isWork.reduce((x, y) => x + y, 0),
      bDepth, isolatedB, peopleIsolated, cutEdges, islandEdges, people, cutKm, roadKm, worstRoads, sites: d.sites.length, sitesHit,
    };
    }
  }
  return computeImpact;
};
