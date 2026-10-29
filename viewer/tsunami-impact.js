/* A tsunami run as a flood run on one of the map's area models, so the impact, roads, routes and property tools can use it. Pure: the
 * area model `a` ({ W, H, cell, dem, valid, ocean }) and its `geo` ({ west, south, east, north }) come from the page. The run's deepest water
 * on land (the tide's own cover included, as in the run's summary) is carried over cell by cell; the sea stays dry, as the tools expect. */
import { placeBounds } from './tsunami-extents.js';
import { cellIndex } from './tsunami-live.js';

/* `entry` is { bathymetry (the place: extent, W, H), prepared ({ land }), derived ({ peak, arrival }) } from the panel. Returns the same shape as the 2D
 * solver's expanded run (depth, wet, level, wse, onPath, vx, vy, arrival), plus `covered`, the number of area cells inside the modelled place. */
export function tsunamiRunOnArea(a, geo, entry) {
  const { bathymetry: place, prepared, derived } = entry, n = a.W * a.H;
  const depth = new Float32Array(n), wet = new Uint8Array(n), level = new Float32Array(n).fill(NaN), arrival = new Float32Array(n).fill(NaN);
  const [[south, west], [north, east]] = placeBounds(place);
  // only the area cells that can be inside the place are looked up
  const x0 = Math.max(0, Math.floor((west - geo.west) / (geo.east - geo.west) * a.W)), x1 = Math.min(a.W - 1, Math.ceil((east - geo.west) / (geo.east - geo.west) * a.W));
  const y0 = Math.max(0, Math.floor((geo.north - north) / (geo.north - geo.south) * a.H)), y1 = Math.min(a.H - 1, Math.ceil((geo.north - south) / (geo.north - geo.south) * a.H));
  let covered = 0;
  for (let y = y0; y <= y1; y++) {
    const lat = geo.north - (y + 0.5) / a.H * (geo.north - geo.south);
    for (let x = x0; x <= x1; x++) {
      const i = y * a.W + x;
      if ((a.valid && !a.valid[i]) || (a.ocean && a.ocean[i])) continue;
      const c = cellIndex(place, lat, geo.west + (x + 0.5) / a.W * (geo.east - geo.west));
      if (c < 0) continue;
      covered++;
      if (!prepared.land[c]) continue;
      const d = derived.peak[c];
      if (!(d > 0)) continue;
      depth[i] = d; wet[i] = d >= 0.01 ? 1 : 0; level[i] = a.dem[i] + d;
      if (derived.arrival[c] >= 0) arrival[i] = derived.arrival[c];
    }
  }
  return { depth, wet, level, wse: Float64Array.from(level), onPath: new Uint8Array(n), vx: new Float64Array(n), vy: new Float64Array(n), arrival, covered, tsunami: true };
}
