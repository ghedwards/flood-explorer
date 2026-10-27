/* The page's side of an area's road network, which the module holds (rust/flood-core/src/net.rs,
 * FloodCore.net*): the roads are sent once, then the grid, the buildings, the census areas and each run's water
 * are given as they change, and the route, the flood-impact sweep and the road access timeline are asked for
 * with nothing but the question. Each set* call does nothing when what it is given is what it already has. */

const EVAC = 'Evacuation centre';
const NONE_U8 = new Uint8Array(0);
const nets = new WeakMap();

/* The network of an impact record d ({ net: { lat, lon, edges: [[u, v, road]] }, roads, sites, ... }). */
export function roadNet(d, F) {
  let P = nets.get(d);
  if (!P) {
    const net = d.net, edges = net.edges || [], nE = edges.length, eu = new Int32Array(nE), ev = new Int32Array(nE), road = new Int32Array(nE);
    edges.forEach(([u, v, r], k) => { eu[k] = u; ev[k] = v; road[k] = r; });
    const centres = (d.sites || []).filter((x) => x.kind === EVAC);
    nets.set(d, P = {
      d, F, eu, ev, road, centres, grid: null, buildings: null, census: null, run: null,
      n: F.netLoad({ lat: Float64Array.from(net.lat || []), lon: Float64Array.from(net.lon || []), eu, ev, eroad: road, centreLat: Float64Array.from(centres, (c) => c.lat), centreLon: Float64Array.from(centres, (c) => c.lon) }),
    });
  }
  return P;
}

export function setGrid(P, geo, W, H) {
  if (P.grid && P.grid.geo === geo && P.grid.W === W && P.grid.H === H) return;
  P.F.netGrid(P.n, { west: geo.west, east: geo.east, south: geo.south, north: geo.north, W, H });
  P.grid = { geo, W, H };
  P.buildings = P.census = P.run = null;   // the module drops what depended on the old grid
}

export function setBuildings(P, d) {
  if (P.buildings && P.buildings.bx === d.bx && P.buildings.by === d.by) return;
  const flags = (v) => (v ? Uint8Array.from(v) : new Uint8Array(d.bx.length));
  P.F.netBuildings(P.n, { bx: d.bx, by: d.by, isHome: flags(d.isHome), isWork: flags(d.isWork) });
  P.buildings = { bx: d.bx, by: d.by };
}

/* The census areas painted on the grid (d.sa1Grid, d.sa2Grid) and the roads' points. */
export function setCensus(P, d, a) {
  const c = P.census;
  if (c && c.sa1Grid === d.sa1Grid && c.sa2Grid === d.sa2Grid && c.roads === d.roads && c.ocean === a.ocean) return;
  const lat = [], lon = [], off = [0];
  for (const rd of d.roads) { for (const p of rd.pts) { lat.push(p.lat); lon.push(p.lon); } off.push(lat.length); }
  P.F.netCensus(P.n, {
    sa1Grid: d.sa1 ? d.sa1Grid : null, nSa1: d.sa1 ? d.sa1.pop.length : 0, sa2Grid: d.sa2 ? d.sa2Grid : null, nSa2: d.sa2 ? d.sa2.workers.length : 0,
    ocean: a.ocean || NONE_U8, cellKm2: (a.cell * a.cell) / 1e6, roadLat: Float64Array.from(lat), roadLon: Float64Array.from(lon), roadOff: Int32Array.from(off),
  });
  P.census = { sa1Grid: d.sa1Grid, sa2Grid: d.sa2Grid, roads: d.roads, ocean: a.ocean };
}

export function setRun(P, run, ocean) {
  if (P.run === run) return;
  P.F.netRun(P.n, { wet: run.wet, depth: run.depth, ocean: ocean || NONE_U8 });
  P.run = run;
}

/* The shortest dry route by road from a spot to the edge of the model and to the nearest dry evacuation
 * centre, for the network's current run: { none } if no road is within 0.5 km, else { startKm, toExit,
 * toCentre, centres, centresFlooded } with each route { km, pts: [[lat, lon]...], via: [road names] }. */
export function routeFrom(P, lat, lon) {
  const o = P.F.netRoute(P.n, lat, lon);
  if (o.none) return { none: true };
  const { net, roads } = P.d;
  const path = (p) => {
    if (!p) return null;
    const pts = [], names = [];
    p.nodes.forEach((n, i) => {   // from the end back to the start
      pts.push([net.lat[n], net.lon[n]]);
      const nm = p.vias[i] >= 0 && roads[p.vias[i]] ? roads[p.vias[i]].name : '';
      if (nm && names[names.length - 1] !== nm) names.push(nm);
    });
    return { km: p.km, pts: pts.reverse(), via: names.reverse().slice(0, 4) };
  };
  return {
    startKm: o.startKm, toExit: path(o.toExit), toCentre: o.toCentre ? Object.assign(path(o.toCentre), { name: P.centres[o.centre].name }) : null,
    centres: o.centres, centresFlooded: o.centresFlooded,
  };
}
