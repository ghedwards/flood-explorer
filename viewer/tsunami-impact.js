/* A tsunami run as a flood run on one of the map's area models, so the impact, roads, routes and property tools can use it. The mapping is done in Rust
 * (FloodCore.tsunamiToArea, rust/flood-core/src/place.rs): each land cell's deepest water (the tide's own cover included, as in the run's summary), worst hazard class,
 * fastest speed and arrival are carried onto the area's cells; the sea stays dry, as the tools expect. This only hands over the arrays and shapes the answer. */
import { floodRun } from './dam-break.js';

/* `a` is the area model ({ W, H, cell, dem, valid, ocean }), `geo` its { west, south, east, north } and `entry` the panel's run: { bathymetry (the place: extent, W, H),
 * prepared ({ land }), derived ({ peak, arrival, peakClass, peakSpeed }) }. Returns the same shape as the 2D solver's expanded run (depth, wet, level, wse, onPath, vx, vy,
 * arrival, peakHazard), plus `covered`, the number of area cells inside the modelled place. */
export function tsunamiRun(F, a, geo, entry) {
  const { bathymetry: place, prepared, derived } = entry;
  const area = { W: a.W, H: a.H, cell: a.cell, dem: a.dem, valid: a.valid, ocean: a.ocean || new Uint8Array(a.W * a.H) };
  const out = F.tsunamiToArea(area, [geo.west, geo.south, geo.east, geo.north], place, { land: prepared.land, peak: derived.peak, arrival: derived.arrival, cls: derived.peakClass, vel: derived.peakSpeed });
  const run = floodRun({ ...out, edge: false });
  delete run.dam;
  return { ...run, tsunami: true };
}
