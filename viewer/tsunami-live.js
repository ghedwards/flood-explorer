/* Painting a live tsunami run on the main map: each frame of a run on a modelled place's grid as one canvas over the place, placed by the
 * place's MGA extent (tsunami-extents.js). Land under water is coloured by its depth; the sea by the wave's height (orange crest, blue
 * drawdown). The pixel functions are pure so tests can check them without a map. */
import { placeBounds, toMga } from './tsunami-extents.js';

export const DEPTH_EDGES = [0.5, 1, 2, 4];
export const DEPTH_COLOURS = ['#3f9ae0', '#2b7fd0', '#1f67bb', '#17509c', '#0c3470'];
export const CREST = [242, 142, 43], DRAWDOWN = [76, 120, 168];
export const MIN_DEPTH = 0.02, MIN_WAVE = 0.03;

// Arrival is measured from when the wave reaches the model's edge, in six bands (the colours are the flash-flood arrival colours: earliest darkest).
export const ARRIVAL_EDGES = [300, 600, 1200, 2400, 3600];
export const ARRIVAL_COLOURS = [[128, 0, 38], [189, 0, 38], [227, 26, 28], [252, 78, 42], [253, 141, 60], [254, 217, 118]];
export const ARRIVAL_TEXT = ['within 5 min', '5–10 min', '10–20 min', '20–40 min', '40–60 min', 'later'];
export const ARRIVAL_DEPTH = 0.1;   // the wave has arrived where it adds this much water
// Flood hazard class H1 to H6 from depth (m) and speed (m/s): Australian Disaster Resilience Guideline 7-3, the same limits as the Rust solver's `hazard_class`.
const HAZARD_LIMITS = [[0.3, 2, 0.3], [0.5, 2, 0.6], [1.2, 2, 0.6], [2, 2, 1], [4, 4, 4]];
export function hazardClass(depth, speed) {
  for (let k = 0; k < HAZARD_LIMITS.length; k++) { const [d, v, dv] = HAZARD_LIMITS[k]; if (depth <= d && speed <= v && depth * speed <= dv) return k + 1; }
  return 6;
}
export const arrivalClass = (seconds) => { let c = 0; while (c < ARRIVAL_EDGES.length && seconds > ARRIVAL_EDGES[c]) c++; return c; };

export const depthClass = (depth) => { let c = 0; while (c < DEPTH_EDGES.length && depth >= DEPTH_EDGES[c]) c++; return c; };
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// The canvas size for a place: four pixels per cell across, the height from the bounds' shape on the ground.
export function canvasSize(place, bounds = placeBounds(place)) {
  const width = place.W * 4, mid = (bounds[0][0] + bounds[1][0]) / 2;
  const height = Math.round(width * (bounds[1][0] - bounds[0][0]) / ((bounds[1][1] - bounds[0][1]) * Math.cos(mid * Math.PI / 180)));
  return { width, height };
}

// For each pixel (row 0 the north edge), the index of the grid cell under it, or -1 outside the place. Computed once per place.
export function pixelMap(place, width, height, bounds = placeBounds(place)) {
  const [e0, n0, e1, n1] = place.extent, zone = place.zone || 56, [[south, west], [north, east]] = bounds, out = new Int32Array(width * height).fill(-1);
  for (let py = 0; py < height; py++) {
    const lat = north - (py + 0.5) / height * (north - south);
    for (let px = 0; px < width; px++) {
      const [e, n] = toMga(lat, west + (px + 0.5) / width * (east - west), zone);
      if (e < e0 || e >= e1 || n < n0 || n >= n1) continue;
      out[py * width + px] = Math.floor((n1 - n) / (n1 - n0) * place.H) * place.W + Math.floor((e - e0) / (e1 - e0) * place.W);
    }
  }
  return out;
}

/* RGBA for one frame. `land[c]` is 1 where the ground is dry at mean sea level; those cells are coloured by `frame.water[c]` (water depth now)
 * when it passes MIN_DEPTH, the rest by `frame.eta[c]` (surface change) when it passes MIN_WAVE. */
export function framePixels(map, land, frame, out = new Uint8ClampedArray(map.length * 4)) {
  const colours = DEPTH_COLOURS.map(hex);
  out.fill(0);
  for (let p = 0; p < map.length; p++) {
    const c = map[p];
    if (c < 0) continue;
    const k = p * 4;
    if (land[c]) {
      const depth = frame.water[c];
      if (!(depth > MIN_DEPTH)) continue;
      const col = colours[depthClass(depth)];
      out[k] = col[0]; out[k + 1] = col[1]; out[k + 2] = col[2]; out[k + 3] = 225;
    } else {
      const eta = frame.eta[c];
      if (!(Math.abs(eta) > MIN_WAVE)) continue;
      const col = eta > 0 ? CREST : DRAWDOWN;
      out[k] = col[0]; out[k + 1] = col[1]; out[k + 2] = col[2]; out[k + 3] = Math.round(70 + 150 * Math.min(1, Math.abs(eta) / 0.5));
    }
  }
  return out;
}

/* What a whole run tells you, worked out once from its frames. For each cell: `peak`, the deepest water it held (on ground that is dry at MSL, including
 * the tide's own cover; at sea, the highest wave), `arrival`, seconds from when the wave reached the model's edge (`waveAt`) until the wave first added
 * `depth` of water (NaN if it never did; the tide's own cover is not an arrival), and `peakAt`, the time of the deepest water. `peakClass` and
 * `peakSpeed` are the worst hazard class (0 dry, 1 to 6) and the highest water speed any frame showed on that cell, from the frames' own speeds: they
 * are sampled every frame, so they can miss a faster moment between frames. `summaries[k]` is
 * `summarise(prepared, frames[k])` (flooded so far, now and deepest) for each frame. Frames are 30 s apart in a one-hour run, so times are to that resolution. */
export function deriveRun(prepared, frames, { summarise, depth = ARRIVAL_DEPTH, waveAt = 0 } = {}) {
  const { grid, land } = prepared, n = land.length, last = frames[frames.length - 1];
  const peakClass = new Uint8Array(n), peakSpeed = new Float32Array(n), peak = new Float32Array(n), arrival = new Float32Array(n).fill(NaN), peakAt = new Float32Array(n).fill(NaN), deepest = new Float32Array(n);
  const start = Number.isFinite(waveAt) ? waveAt : 0;
  for (const frame of frames) {
    for (let i = 0; i < n; i++) {
      if (!land[i]) continue;
      const w = frame.water[i];
      if (w > deepest[i]) { deepest[i] = w; peakAt[i] = frame.time; }
      if (w >= 0.01 && frame.speed) {
        const v = frame.speed[i], c = hazardClass(w, v);
        if (c > peakClass[i]) peakClass[i] = c;
        if (v > peakSpeed[i]) peakSpeed[i] = v;
      }
      if (Number.isNaN(arrival[i]) && w - grid.depth[i] >= depth) arrival[i] = Math.max(0, frame.time - start);
    }
  }
  for (let i = 0; i < n; i++) peak[i] = land[i] ? grid.depth[i] + last.peak[i] : last.peak[i];
  return { peak, arrival, peakAt, peakClass, peakSpeed, summaries: summarise ? frames.map((f) => summarise(prepared, f)) : [] };
}

// The grid cell index under a lat/lon for a place (its MGA extent and W x H), or -1 outside it.
export function cellIndex(place, lat, lon) {
  const [e0, n0, e1, n1] = place.extent, [e, n] = toMga(lat, lon, place.zone || 56);
  if (e < e0 || e >= e1 || n < n0 || n >= n1) return -1;
  return Math.floor((n1 - n) / (n1 - n0) * place.H) * place.W + Math.floor((e - e0) / (e1 - e0) * place.W);
}

/* RGBA for the whole run's deepest water: land by depth class, the sea by the highest wave (orange, stronger when higher). */
export function maxPixels(map, land, peak, out = new Uint8ClampedArray(map.length * 4)) {
  const colours = DEPTH_COLOURS.map(hex);
  out.fill(0);
  for (let p = 0; p < map.length; p++) {
    const c = map[p];
    if (c < 0) continue;
    const k = p * 4, v = peak[c];
    if (land[c]) {
      if (!(v > MIN_DEPTH)) continue;
      const col = colours[depthClass(v)];
      out[k] = col[0]; out[k + 1] = col[1]; out[k + 2] = col[2]; out[k + 3] = 225;
    } else if (v > MIN_WAVE) {
      out[k] = CREST[0]; out[k + 1] = CREST[1]; out[k + 2] = CREST[2]; out[k + 3] = Math.round(70 + 150 * Math.min(1, v / 0.5));
    }
  }
  return out;
}

// RGBA for the arrival-time view: land the wave reached, coloured by how long after it reached the model's edge.
export function arrivalPixels(map, land, arrival, out = new Uint8ClampedArray(map.length * 4)) {
  out.fill(0);
  for (let p = 0; p < map.length; p++) {
    const c = map[p];
    if (c < 0 || !land[c] || !(arrival[c] >= 0)) continue;
    const col = ARRIVAL_COLOURS[arrivalClass(arrival[c])], k = p * 4;
    out[k] = col[0]; out[k + 1] = col[1]; out[k + 2] = col[2]; out[k + 3] = 225;
  }
  return out;
}

// The key for a view ('now', 'max' or 'arrival') as HTML spans.
export function viewLegend(view) {
  if (view === 'arrival') return [`<span>Time until the wave floods the land, after it reaches the model's edge:</span>`, ...ARRIVAL_COLOURS.map((c, i) => `<span><i style="background:rgb(${c.join()})"></i>${ARRIVAL_TEXT[i]}</span>`)];
  return legendParts(view === 'max' ? 'max' : 'now');
}

export function legendParts(view = 'now') {
  const label = (i) => i === 0 ? `&lt;${DEPTH_EDGES[0]} m` : i === DEPTH_COLOURS.length - 1 ? `&gt;${DEPTH_EDGES[i - 1]} m` : `${DEPTH_EDGES[i - 1]}–${DEPTH_EDGES[i]}`;
  return [`<span>${view === 'max' ? 'Deepest water over the whole run' : 'Water on land now'} (modelled, experimental):</span>`, ...DEPTH_COLOURS.map((c, i) => `<span><i style="background:${c}"></i>${label(i)}</span>`),
    `<span><i style="background:rgb(${CREST.join()})"></i>${view === 'max' ? 'highest wave at sea' : 'wave crest at sea'}</span>`, ...(view === 'max' ? [] : [`<span><i style="background:rgb(${DRAWDOWN.join()})"></i>drawdown</span>`])];
}

/* The layer: show(place) makes the picture for a place, paint(frame, land) draws a frame on it, clear() removes it.
 * `canvasOverlay(bounds, options)` makes an image overlay with a `setPixels(rgba, w, h)` method (the page's own). */
export function makeLiveLayer(L, { canvasOverlay }) {
  const group = L.layerGroup([], { attribution: 'Tsunami run: PTHA18 &copy; Geoscience Australia (CC BY 4.0), terrain per place' });
  let overlay = null, shown = null, size = null, cells = null, pixels = null;
  group.show = (place) => {
    group.clear();
    const bounds = placeBounds(place);
    size = canvasSize(place, bounds); cells = pixelMap(place, size.width, size.height, bounds); pixels = new Uint8ClampedArray(size.width * size.height * 4);
    overlay = canvasOverlay(bounds, { opacity: 1, interactive: false, className: 'flood-layer tsunami-live', zIndex: 6 });
    group.addLayer(overlay); shown = place;
    return bounds;
  };
  group.paint = (frame, land) => { if (overlay) overlay.setPixels(framePixels(cells, land, frame, pixels), size.width, size.height); };
  // draw any view: fn(cells, pixels) returns the RGBA (maxPixels or arrivalPixels with the run's data bound)
  group.paintWith = (fn) => { if (overlay) overlay.setPixels(fn(cells, pixels), size.width, size.height); };
  group.clear = () => { if (overlay) group.removeLayer(overlay); overlay = shown = null; };
  group.place = () => shown;
  return group;
}
