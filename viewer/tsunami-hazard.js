/* The map's "Tsunami hazard" layer: PTHA18's offshore wave heights around Australia (Geoscience Australia, CC BY 4.0),
 * as coloured points at a chosen return period. The data are built by scripts/prepare-tsunami-hazard.js into
 * tsunami-data/ptha18-hazard.json (about 2,000 hazard points at roughly 100 m depth). These are heights offshore on a
 * coarse model, without tide; they say how big the wave is at sea, not where the land floods. */

// Class edges (m) and colours, lightest to darkest: pale to deep purple, so the order reads without relying on hue.
export const BREAKS = [0.25, 0.5, 1, 2, 4];
export const COLOURS = ['#ffe9a8', '#fdbf6f', '#f28e2b', '#d1495b', '#8e2c6f', '#3b1a5a'];
export const DEFAULT_PERIOD = 500;
const PERIOD_KEY = 'flood-tsunami-hazard-period';

export const classOf = (stage) => BREAKS.findIndex((edge) => stage < edge) < 0 ? BREAKS.length : BREAKS.findIndex((edge) => stage < edge);
export const colourFor = (stage) => COLOURS[classOf(stage)];

// "0.71 m", "under 0.02 m", "20 m or more"
export function stageText(stage) {
  if (!Number.isFinite(stage)) return 'not available';
  if (stage <= 0) return 'under 0.02 m';
  if (stage >= 20) return '20 m or more';
  return `${stage.toFixed(stage < 10 ? 2 : 1)} m`;
}

// The file's rows as points: { lon, lat, depth, id, stage: {period: m}, band: {period: [low, high]} }
export function parseHazard(file) {
  const cols = file.columns, at = (name) => cols.indexOf(name);
  for (const need of ['lon', 'lat', 'depth_m', 'gaugeID', ...file.returnPeriodsYears.map((p) => `stage_${p}`)]) {
    if (at(need) < 0) throw new Error(`The tsunami hazard file has no ${need} column.`);
  }
  return file.points.map((row) => ({
    lon: row[at('lon')], lat: row[at('lat')], depth: row[at('depth_m')], id: row[at('gaugeID')], coarse: at('coarse') < 0 || row[at('coarse')] === 1,
    stage: Object.fromEntries(file.returnPeriodsYears.map((p) => [p, row[at(`stage_${p}`)]])),
    band: Object.fromEntries(file.bandReturnPeriodsYears.filter((p) => at(`stage_${p}_p16`) >= 0).map((p) => [p, [row[at(`stage_${p}_p16`)], row[at(`stage_${p}_p84`)]]])),
  }));
}

export const periodText = (period) => `1 in ${period} years (${+(100 / period).toFixed(2)}% a year)`;

// The popup for one point, as HTML. Every inserted value is a number or a fixed string.
export function popupHtml(point, periods) {
  const rows = periods.map((p) => {
    const range = point.band[p] ? `${stageText(point.band[p][0])} to ${stageText(point.band[p][1])}` : '';
    return `<tr><th scope="row">1 in ${p} years</th><td>${stageText(point.stage[p])}</td><td>${range}</td></tr>`;
  }).join('');
  return `<div class="tsunami-pop"><strong>Offshore tsunami hazard</strong>
    <p class="hint">PTHA18 hazard point ${point.id} · ${point.depth} m deep · ${Math.abs(point.lat).toFixed(2)}°${point.lat < 0 ? 'S' : 'N'} ${point.lon.toFixed(2)}°E</p>
    <table><thead><tr><th>Return period</th><th>Wave height</th><th>Range</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="hint">Height of the largest wave at sea above mean sea level, without tide: the average of PTHA18's hazard curves. The range is the 16th to 84th percentile of PTHA18's own uncertainty. This is not a flooding estimate: how far and deep the water reaches on land depends on the coast and the tide.
    <a href="./tsunami.html">Open the tsunami lab</a></p></div>`;
}

export function legendParts(period) {
  const edge = (i) => i === 0 ? `&lt;${BREAKS[0]} m` : i === BREAKS.length ? `&gt;${BREAKS[i - 1]} m` : `${BREAKS[i - 1]}–${BREAKS[i]}`;
  return [`<span>Tsunami wave height offshore, ${periodText(period)}:</span>`,
    ...COLOURS.map((c, i) => `<span><i class="dot" style="background:${c};border:1px solid #6b5b4b"></i>${edge(i)}</span>`)];
}

// zoomed out, only the coarse set is drawn (about a third of the points), so the shelf seas do not show as solid blocks
export const showAll = (zoom) => zoom >= 7;
const radiusFor = (zoom) => zoom < 5 ? 3 : zoom < 7 ? 5 : zoom < 9 ? 7 : 9;

/* The layer: a layer group that loads the data when first added. `periodPicker()` gives a return-period choice for the Layers list
 * (every picker made stays in step with the choice). `onChange` is called when the choice or the load state changes, so the
 * page can redraw its legend. */
export function makeTsunamiHazardLayer(L, { url, onChange = () => {} }) {
  const group = L.layerGroup([], { attribution: 'Tsunami hazard: PTHA18 &copy; Geoscience Australia, CC BY 4.0' });
  const info = { period: DEFAULT_PERIOD, state: 'idle', points: 0, shown: 0, error: null, periods: [100, 250, 500, 1000, 2500] };
  let points = null, markers = [], renderer = null, loading = null, map = null;
  const pickers = new Set();
  try { const saved = Number(localStorage.getItem(PERIOD_KEY)); if (saved) info.period = saved; } catch (error) { /* storage blocked */ }
  group.info = info;

  const restyle = () => markers.forEach((marker, i) => marker.setStyle({ fillColor: colourFor(points[i].stage[info.period]) }));
  // draw the markers that belong at this zoom: all of them close in, the coarse set further out
  function refresh() {
    if (!map || !points || !map.hasLayer(group)) return;
    const radius = radiusFor(map.getZoom()), all = showAll(map.getZoom());
    let shown = 0;
    markers.forEach((marker, i) => {
      const want = all || points[i].coarse;
      if (want && !group.hasLayer(marker)) group.addLayer(marker); else if (!want && group.hasLayer(marker)) group.removeLayer(marker);
      if (want) { marker.setRadius(radius); shown++; }
    });
    info.shown = shown;
  }

  async function load() {
    if (points) return;
    if (!loading) {
      info.state = 'loading'; sync();
      loading = fetch(url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then((file) => {
        points = parseHazard(file);
        info.periods = file.returnPeriodsYears.slice(); info.points = points.length;
        if (!info.periods.includes(info.period)) info.period = DEFAULT_PERIOD;
        renderer = L.canvas({ padding: 0.5 });
        markers = points.map((p) => L.circleMarker([p.lat, p.lon], { renderer, radius: 4, weight: 1, color: '#ffffff', opacity: 0.9, fillOpacity: 0.85, fillColor: colourFor(p.stage[info.period]) })
          .bindPopup(() => popupHtml(p, info.periods), { maxWidth: 340 }));
        info.state = 'ready';
      }).catch((error) => { loading = null; info.state = 'error'; info.error = String(error.message || error); });
    }
    await loading;
    sync();
  }

  // bring every picker and the page into line with the choice and load state
  function sync() {
    for (const el of [...pickers]) {
      if (!el.isConnected && el.dataset.seen) { pickers.delete(el); continue; }
      el.dataset.seen = '1';
      const select = el.querySelector('select');
      select.value = String(info.period);
      el.querySelector('small').textContent = info.state === 'loading' ? 'Loading…' : info.state === 'error' ? `Could not load the hazard data (${info.error})` : 'Mean of PTHA18’s hazard curves, no tide';
    }
    onChange();
  }
  function setPeriod(period) {
    info.period = period;
    try { localStorage.setItem(PERIOD_KEY, String(period)); } catch (error) { /* storage blocked */ }
    if (points) restyle();
    sync();
  }
  group.setPeriod = setPeriod;
  group.legendParts = () => legendParts(info.period);
  group.periodPicker = () => {
    const el = document.createElement('label');
    el.className = 'tsunami-pick';
    el.innerHTML = `<span>Return period</span><select aria-label="Tsunami hazard return period">${info.periods.map((p) => `<option value="${p}">${periodText(p)}</option>`).join('')}</select><small></small>`;
    el.querySelector('select').addEventListener('change', (event) => setPeriod(Number(event.target.value)));
    pickers.add(el);
    el.querySelector('select').value = String(info.period);
    return el;
  };

  group.on('add', () => {
    map = group._map;
    map.on('zoomend', refresh);
    load().then(refresh);
  });
  group.on('remove', () => {
    if (map) map.off('zoomend', refresh);
    group.clearLayers(); map = null;
  });
  return group;
}
