/* Painting a live tsunami run on the main map: each frame of a run on a modelled place's grid as one canvas over the place, placed by the
 * place's MGA extent (tsunami-extents.js). Land under water is coloured by its depth; the sea by the wave's height (orange crest, blue
 * drawdown). The pixel functions are pure so tests can check them without a map. */
import { placeBounds, toMga } from './tsunami-extents.js';

export const DEPTH_EDGES = [0.5, 1, 2, 4];
export const DEPTH_COLOURS = ['#3f9ae0', '#2b7fd0', '#1f67bb', '#17509c', '#0c3470'];
export const CREST = [242, 142, 43], DRAWDOWN = [76, 120, 168];
export const MIN_DEPTH = 0.02, MIN_WAVE = 0.03;

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

export function legendParts() {
  const label = (i) => i === 0 ? `&lt;${DEPTH_EDGES[0]} m` : i === DEPTH_COLOURS.length - 1 ? `&gt;${DEPTH_EDGES[i - 1]} m` : `${DEPTH_EDGES[i - 1]}–${DEPTH_EDGES[i]}`;
  return ['<span>Tsunami run: water on land (modelled, experimental):</span>', ...DEPTH_COLOURS.map((c, i) => `<span><i style="background:${c}"></i>${label(i)}</span>`),
    `<span><i style="background:rgb(${CREST.join()})"></i>wave crest at sea</span>`, `<span><i style="background:rgb(${DRAWDOWN.join()})"></i>drawdown</span>`];
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
  group.clear = () => { if (overlay) group.removeLayer(overlay); overlay = shown = null; };
  group.place = () => shown;
  return group;
}
