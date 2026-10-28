/* The map's "Tsunami flood hazard" layer for the places the tsunami lab models locally: for each 25 to 50 m cell, how often the
 * sampled PTHA18 tsunami scenarios, weighted over the tide states, put at least a chosen depth of water on it. The rates are
 * built by scripts/ensemble-ptha.js and scripts/prepare-tsunami-extents.js into tsunami-data/extents/<place>.json. They are a
 * lower bound from a sample of scenarios at mean sea level terrain (see docs/tsunami-prototype.md), not a hazard assessment. */

// ---- MGA (GDA2020 / GDA94 UTM) transform: Kruger series on the GRS80 ellipsoid, accurate to a millimetre inside a zone ----
const A = 6378137, FLAT = 1 / 298.257222101, K0 = 0.9996, FALSE_E = 500000, FALSE_N = 10000000;
const N3 = FLAT / (2 - FLAT);
const R = A / (1 + N3) * (1 + N3 ** 2 / 4 + N3 ** 4 / 64);
const ALPHA = [N3 / 2 - 2 * N3 ** 2 / 3 + 5 * N3 ** 3 / 16, 13 * N3 ** 2 / 48 - 3 * N3 ** 3 / 5, 61 * N3 ** 3 / 240];
const BETA = [N3 / 2 - 2 * N3 ** 2 / 3 + 37 * N3 ** 3 / 96, N3 ** 2 / 48 + N3 ** 3 / 15, 17 * N3 ** 3 / 480];
const DELTA = [2 * N3 - 2 * N3 ** 2 / 3 - 2 * N3 ** 3, 7 * N3 ** 2 / 3 - 8 * N3 ** 3 / 5, 56 * N3 ** 3 / 15];
const rad = (d) => d * Math.PI / 180;
export const centralMeridian = (zone) => zone * 6 - 183;

// Latitude and longitude (degrees, southern hemisphere) to easting and northing (m) in an MGA zone (54 to 56 for the east coast).
export function toMga(lat, lon, zone = 56) {
  const phi = rad(lat), lam = rad(lon - centralMeridian(zone)), e = 2 * Math.sqrt(N3) / (1 + N3);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.hypot(1, t));
  let x = xi, y = eta;
  ALPHA.forEach((a, i) => { const j = 2 * (i + 1); x += a * Math.sin(j * xi) * Math.cosh(j * eta); y += a * Math.cos(j * xi) * Math.sinh(j * eta); });
  return [FALSE_E + K0 * R * y, FALSE_N + K0 * R * x];
}

// The inverse: easting and northing to [latitude, longitude] in degrees.
export function fromMga(easting, northing, zone = 56) {
  const xi = (northing - FALSE_N) / (K0 * R), eta = (easting - FALSE_E) / (K0 * R);
  let xi1 = xi, eta1 = eta;
  BETA.forEach((b, i) => { const j = 2 * (i + 1); xi1 -= b * Math.sin(j * xi) * Math.cosh(j * eta); eta1 -= b * Math.cos(j * xi) * Math.sinh(j * eta); });
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  let phi = chi;
  DELTA.forEach((d, i) => { phi += d * Math.sin(2 * (i + 1) * chi); });
  return [phi * 180 / Math.PI, centralMeridian(zone) + Math.atan2(Math.sinh(eta1), Math.cos(xi1)) * 180 / Math.PI];
}

// ---- the stored rates: one byte per cell, 0 = never, else log10(rate per year) = code / 40 - 6 ----
export const CODE_SCALE = 40, CODE_OFFSET = 6;
export function encodeRate(rate) {
  if (!(rate > 0)) return 0;
  return Math.max(1, Math.min(255, Math.round((Math.log10(rate) + CODE_OFFSET) * CODE_SCALE)));
}
export const decodeRate = (code) => code ? 10 ** (code / CODE_SCALE - CODE_OFFSET) : 0;

// Classes by how often (years between): rarest first. A cell never reached by the sampled scenarios, or reached less often than
// the last class, is not drawn.
export const CLASS_YEARS = [2500, 1000, 500, 250, 100];
export const CLASS_COLOURS = ['#fde0ef', '#f9b8d9', '#f08cc0', '#d6559f', '#a92d7d', '#6e1b57'];
export function classOfRate(rate) {
  if (!(rate > 0) || rate < 1 / CLASS_YEARS[0] / 4) return -1;      // rarer than 1 in 10,000 years: not drawn
  let c = 0;
  while (c < CLASS_YEARS.length && rate >= 1 / CLASS_YEARS[c]) c++;
  return c;                                                          // 0: rarer than 1 in 2,500 ... 5: more often than 1 in 100
}
export const yearsText = (rate) => rate > 0 ? `1 in ${rate >= 1 ? (1 / rate).toFixed(1) : Math.round(1 / rate).toLocaleString('en-AU')} years` : 'not reached by the sampled scenarios';

export function legendParts(depth) {
  const text = (i) => i === 0 ? `rarer than 1 in ${CLASS_YEARS[0]}` : i === CLASS_COLOURS.length - 1 ? `more often than 1 in ${CLASS_YEARS[CLASS_YEARS.length - 1]}` : `1 in ${CLASS_YEARS[i]} to ${CLASS_YEARS[i - 1]}`;
  return [`<span>Tsunami flood hazard, ≥${depth} m of water added (modelled areas):</span>`,
    ...CLASS_COLOURS.map((c, i) => `<span><i style="background:${c};opacity:.85"></i>${text(i)} years</span>`)];
}

// Decode a base64 string of bytes.
export function decodeBytes(base64) {
  const text = atob(base64), bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

// The place's lat/lon bounds [[south, west], [north, east]] from its MGA extent [minE, minN, maxE, maxN].
export function placeBounds(place) {
  const [e0, n0, e1, n1] = place.extent, zone = place.zone || 56;
  const corners = [[e0, n0], [e1, n0], [e0, n1], [e1, n1]].map(([e, n]) => fromMga(e, n, zone));
  const lats = corners.map((c) => c[0]), lons = corners.map((c) => c[1]);
  return [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]];
}

// RGBA pixels (`width` x `height`, row 0 the north edge) of one depth's rates over the lat/lon bounds, each pixel looked up in
// the place's MGA grid (row 0 of the grid is its north edge). Pixels outside the grid or never reached stay transparent.
export function extentPixels(place, codes, width, height, bounds = placeBounds(place), alpha = 215) {
  const [e0, n0, e1, n1] = place.extent, zone = place.zone || 56, W = place.W, H = place.H;
  const [[south, west], [north, east]] = bounds, out = new Uint8ClampedArray(width * height * 4);
  for (let py = 0; py < height; py++) {
    const lat = north - (py + 0.5) / height * (north - south);
    for (let px = 0; px < width; px++) {
      const lon = west + (px + 0.5) / width * (east - west);
      const [e, n] = toMga(lat, lon, zone);
      if (e < e0 || e >= e1 || n < n0 || n >= n1) continue;
      const cx = Math.floor((e - e0) / (e1 - e0) * W), cy = Math.floor((n1 - n) / (n1 - n0) * H);
      const c = classOfRate(decodeRate(codes[cy * W + cx]));
      if (c < 0) continue;
      const hex = CLASS_COLOURS[c], k = (py * width + px) * 4;
      out[k] = parseInt(hex.slice(1, 3), 16); out[k + 1] = parseInt(hex.slice(3, 5), 16); out[k + 2] = parseInt(hex.slice(5, 7), 16); out[k + 3] = alpha;
    }
  }
  return out;
}

// The rate (per year) for the cell under a lat/lon, or null outside the place.
export function rateAt(place, codes, lat, lon) {
  const [e0, n0, e1, n1] = place.extent, [e, n] = toMga(lat, lon, place.zone || 56);
  if (e < e0 || e >= e1 || n < n0 || n >= n1) return null;
  return decodeRate(codes[Math.floor((n1 - n) / (n1 - n0) * place.H) * place.W + Math.floor((e - e0) / (e1 - e0) * place.W)]);
}

const DEPTH_KEY = 'flood-tsunami-extent-depth';

/* The layer: a layer group of one image per place, loaded when first added. `depthPicker()` gives the depth choice for the
 * Layers list. `onChange` is called when the choice or the load state changes, so the page can redraw its legend. */
export function makeTsunamiExtentsLayer(L, { indexUrl, onChange = () => {} }) {
  const group = L.layerGroup([], { attribution: 'Tsunami flood hazard: PTHA18 &copy; Geoscience Australia (CC BY 4.0); terrain CSIRO (CC BY 4.0)' });
  const info = { depth: 0.3, depths: [0.1, 0.3, 1], state: 'idle', places: 0, drawn: 0, error: null };
  let places = null, loading = null, map = null;
  const images = new Map(), pickers = new Set();
  try { const saved = Number(localStorage.getItem(DEPTH_KEY)); if (saved) info.depth = saved; } catch (error) { /* storage blocked */ }
  group.info = info; group.zoomNote = { min: 10, text: 'modelled estuaries and coasts' };

  async function load() {
    if (places) return;
    if (!loading) {
      info.state = 'loading'; sync();
      loading = (async () => {
        const index = await (await fetch(indexUrl)).json();
        places = [];
        for (const file of index.places) {
          const response = await fetch(new URL(file, indexUrl).href);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const place = await response.json();
          place.codesByDepth = place.codes.map(decodeBytes);
          places.push(place);
        }
        info.places = places.length;
        if (places.length) info.depths = places[0].depths.slice();
        if (!info.depths.includes(info.depth)) info.depth = info.depths.includes(0.3) ? 0.3 : info.depths[0];
        info.state = 'ready';
      })().catch((error) => { loading = null; info.state = 'error'; info.error = String(error.message || error); });
    }
    await loading;
    sync();
  }

  function draw() {
    for (const image of images.values()) group.removeLayer(image);
    images.clear();
    if (!places || !map || !map.hasLayer(group)) return;
    const k = Math.max(0, info.depths.indexOf(info.depth));
    for (const place of places) {
      const bounds = placeBounds(place), canvas = document.createElement('canvas'), midLat = (bounds[0][0] + bounds[1][0]) / 2;
      canvas.width = place.W * 4;
      canvas.height = Math.round(canvas.width * (bounds[1][0] - bounds[0][0]) / ((bounds[1][1] - bounds[0][1]) * Math.cos(rad(midLat))));
      const pixels = extentPixels(place, place.codesByDepth[k], canvas.width, canvas.height, bounds);
      canvas.getContext('2d').putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
      const image = L.imageOverlay(canvas.toDataURL('image/png'), bounds, { opacity: 1, interactive: false, className: 'flood-layer tsunami-extent', zIndex: 5 });
      images.set(place.id, image); group.addLayer(image);
    }
    info.drawn = images.size;
  }

  function sync() {
    for (const el of [...pickers]) {
      if (!el.isConnected && el.dataset.seen) { pickers.delete(el); continue; }
      el.dataset.seen = '1';
      el.querySelector('select').value = String(info.depth);
      el.querySelector('small').textContent = info.state === 'loading' ? 'Loading…' : info.state === 'error' ? `Could not load the hazard maps (${info.error})`
        : `${info.places} modelled area${info.places === 1 ? '' : 's'}: how often the sampled tsunamis add this much water`;
    }
    onChange();
  }
  function setDepth(depth) {
    info.depth = depth;
    try { localStorage.setItem(DEPTH_KEY, String(depth)); } catch (error) { /* storage blocked */ }
    draw(); sync();
  }
  group.setDepth = setDepth;
  group.legendParts = () => legendParts(info.depth);
  group.depthPicker = () => {
    const el = document.createElement('label');
    el.className = 'tsunami-pick';
    el.innerHTML = `<span>Water added by the wave</span><select aria-label="Tsunami flood depth">${info.depths.map((d) => `<option value="${d}">at least ${d} m</option>`).join('')}</select><small></small>`;
    el.querySelector('select').addEventListener('change', (event) => setDepth(Number(event.target.value)));
    pickers.add(el);
    el.querySelector('select').value = String(info.depth);
    return el;
  };
  group.places = () => places || [];

  group.on('add', () => { map = group._map; load().then(draw); });
  group.on('remove', () => { for (const image of images.values()) group.removeLayer(image); images.clear(); map = null; });
  return group;
}
