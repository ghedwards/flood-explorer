/* Painting a live tsunami run on the main map: each frame of a run on a modelled place's grid as one canvas over the place, placed by the
 * place's MGA extent (tsunami-extents.js). Land under water is coloured by its depth; the sea by the wave's height (orange crest, blue
 * drawdown). The pixel functions are pure so tests can check them without a map. Where a pixel falls and what a run reached are worked out in Rust
 * (rust/flood-core/src/place.rs, and the solver's own extremes); this file only colours. */
import { placeBounds } from './tsunami-extents.js';

export const DEPTH_EDGES = [0.5, 1, 2, 4];
export const DEPTH_COLOURS = ['#3f9ae0', '#2b7fd0', '#1f67bb', '#17509c', '#0c3470'];
export const CREST = [242, 142, 43], DRAWDOWN = [76, 120, 168];
export const MIN_DEPTH = 0.02, MIN_WAVE = 0.03;

// Arrival is measured from when the wave reaches the model's edge, in six bands (the colours are the flash-flood arrival colours: earliest darkest).
export const ARRIVAL_EDGES = [300, 600, 1200, 2400, 3600];
export const ARRIVAL_COLOURS = [[128, 0, 38], [189, 0, 38], [227, 26, 28], [252, 78, 42], [253, 141, 60], [254, 217, 118]];
export const ARRIVAL_TEXT = ['within 5 min', '5–10 min', '10–20 min', '20–40 min', '40–60 min', 'later'];
export const arrivalClass = (seconds) => { let c = 0; while (c < ARRIVAL_EDGES.length && seconds > ARRIVAL_EDGES[c]) c++; return c; };

export const depthClass = (depth) => { let c = 0; while (c < DEPTH_EDGES.length && depth >= DEPTH_EDGES[c]) c++; return c; };
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// The canvas size for a place: four pixels per cell across, the height from the bounds' shape on the ground.
export function canvasSize(place, bounds = placeBounds(place)) {
  const width = place.W * 4, mid = (bounds[0][0] + bounds[1][0]) / 2;
  const height = Math.round(width * (bounds[1][0] - bounds[0][0]) / ((bounds[1][1] - bounds[0][1]) * Math.cos(mid * Math.PI / 180)));
  return { width, height };
}

// For each pixel (row 0 the north edge), the index of the grid cell under it, or -1 outside the place: worked out in Rust (FloodCore.tsunamiPixelMap) once per place.
export const pixelMap = (F, place, width, height, bounds = placeBounds(place)) => F.tsunamiPixelMap(place, [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]], width, height);

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
export function makeLiveLayer(L, { canvasOverlay, F }) {
  const group = L.layerGroup([], { attribution: 'Tsunami run: PTHA18 &copy; Geoscience Australia (CC BY 4.0), terrain per place' });
  let overlay = null, shown = null, size = null, cells = null, pixels = null;
  group.show = (place) => {
    group.clear();
    const bounds = placeBounds(place);
    size = canvasSize(place, bounds); cells = pixelMap(F, place, size.width, size.height, bounds); pixels = new Uint8ClampedArray(size.width * size.height * 4);
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
