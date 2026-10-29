/* The map's "Tsunami flood hazard" layer for the places the tsunami lab models locally: for each 25 to 50 m cell, how often the
 * sampled PTHA18 tsunami scenarios, weighted over the tide states, put at least a chosen depth of water on it. The rates are
 * built by scripts/ensemble-ptha.js and scripts/prepare-tsunami-extents.js into tsunami-data/extents/<place>.json. They are a
 * lower bound from a sample of scenarios at mean sea level terrain (see docs/tsunami-prototype.md), not a hazard assessment. */

// Where a place sits (its MGA extent and grid): the lat/lon bounds, the cell under a point and the cell under every pixel of a canvas laid over it are worked out in Rust
// (rust/flood-core/src/place.rs and geo.rs, through FloodCore); this file keeps the stored-rate codec, the classes and colours, and the layer.
const rad = (d) => d * Math.PI / 180;

// ---- the stored rates: one byte per cell, 0 = never, else log10(rate per year) = code / 40 - 6; encoded, decoded and classed in Rust (rust/flood-core/src/codec.rs) ----
export const encodeRate = (rate, F = globalThis.FloodCore) => F.encodeRates([rate])[0];
export const decodeRate = (code, F = globalThis.FloodCore) => F.decodeRates([code]).rates[0];

// Classes by how often (years between): rarest first. A cell never reached by the sampled scenarios, or reached less often than
// the last class, is not drawn.
export const CLASS_YEARS = [2500, 1000, 500, 250, 100];
export const CLASS_COLOURS = ['#fde0ef', '#f9b8d9', '#f08cc0', '#d6559f', '#a92d7d', '#6e1b57'];
export const classOfRate = (rate, F = globalThis.FloodCore) => F.classOfRates([rate])[0];   // 0: rarer than 1 in 2,500 ... 5: more often than 1 in 100; -1: not drawn
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
export function placeBounds(F, place) {
  const [south, west, north, east] = F.tsunamiBounds(place);
  return [[south, west], [north, east]];
}

// RGBA pixels (`width` x `height`, row 0 the north edge) of one depth's rates over the lat/lon bounds, each pixel looked up in
// the place's MGA grid (row 0 of the grid is its north edge). Pixels outside the grid or never reached stay transparent.
export function extentPixels(F, place, codes, width, height, bounds = placeBounds(F, place), alpha = 215) {
  const cells = F.tsunamiPixelMap(place, [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]], width, height), out = new Uint8ClampedArray(width * height * 4);
  const colours = CLASS_COLOURS.map((hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]);
  const classes = F.decodeRates(codes).classes;
  for (let p = 0; p < cells.length; p++) {
    if (cells[p] < 0) continue;
    const c = classes[cells[p]];
    if (c < 0) continue;
    const k = p * 4;
    out[k] = colours[c][0]; out[k + 1] = colours[c][1]; out[k + 2] = colours[c][2]; out[k + 3] = alpha;
  }
  return out;
}

// The rate (per year) for the cell under a lat/lon, or null outside the place.
export function rateAt(F, place, codes, lat, lon) {
  const cell = F.tsunamiCell(place, lat, lon);
  return cell < 0 ? null : decodeRate(codes[cell], F);
}

const DEPTH_KEY = 'flood-tsunami-extent-depth';

/* The layer: a layer group of one image per place, loaded when first added. `depthPicker()` gives the depth choice for the
 * Layers list. `onChange` is called when the choice or the load state changes, so the page can redraw its legend. */
export function makeTsunamiExtentsLayer(L, { F, indexUrl, onChange = () => {} }) {
  const group = L.layerGroup([], { attribution: 'Tsunami flood hazard: PTHA18 &copy; Geoscience Australia (CC BY 4.0); terrain: CSIRO (CC BY 4.0) and Queensland QldDem (CC BY-SA)' });
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
      const bounds = placeBounds(F, place), canvas = document.createElement('canvas'), midLat = (bounds[0][0] + bounds[1][0]) / 2;
      canvas.width = place.W * 4;
      canvas.height = Math.round(canvas.width * (bounds[1][0] - bounds[0][0]) / ((bounds[1][1] - bounds[0][1]) * Math.cos(rad(midLat))));
      const pixels = extentPixels(F, place, place.codesByDepth[k], canvas.width, canvas.height, bounds);
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
