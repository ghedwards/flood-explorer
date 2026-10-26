import '@fontsource-variable/archivo/standard.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import './tsunami.css';
import { estuaryIds, estuaryLocations, regionalIds } from './tsunami-locations.js';
import { parentSeconds, parseSeriesCsv, planCoupling, toParentCell } from './tsunami-coupling.js';
import referencePlaces from './public/tsunami-data/places.json';
import { terrainFor } from './tsunami-terrain.js';
import { tsunamiGrid, connectedWaterDepth } from './tsunami-grid.js';

const $ = id => document.getElementById(id);
const map = $('waveMap'), ctx = map.getContext('2d');
const traces = $('traces'), chart = traces.getContext('2d');
const pixels = document.createElement('canvas');
const pixelContext = pixels.getContext('2d');
const colours = ['#007e92', '#ac5528', '#7f60a0'];
let probes = [[65, 48], [105, 35], [122, 60]];
let source = [38, 48], grid, frame, worker, ready = false, busy = false, running = false;
let budget = 0, previousWall = 0, history = [];
let bathymetry = null, sceneVersion = 0, terrain, inspected = null;
// Regional grids used as offshore parents, and what the current nested run reports.
const parents = new Map();
let couplingInfo = null, uploaded = null;
const parentOf = id => estuaryLocations.find(location => location.id === id)?.parent;
const coupledOn = () => $('coupled').checked && !!parentOf($('preset').value);
const seriesOn = () => coupledOn() && $('incoming').value === 'series';
const localScene = () => $('preset').value === 'estuary' || estuaryIds.includes($('preset').value);
const nonlinear = () => grid?.method === 2;
const coastIds = regionalIds;
const options = () => ({ preset: $('preset').value, deep: +$('deep').value, amplitude: +$('amplitude').value,
  width: +$('width').value, source, absorbing: $('absorbing').checked, method: $('method').value, tide: +$('tide').value, roughness: +$('roughness').value, lakeLevel: +$('lakeLevel').value, coupled: coupledOn(), offshoreWidth: +$('offshoreWidth').value, incoming: $('incoming').value, tideRange: +$('tideRange').value });
const totalSeconds = () => +$('duration').value * 60;
const sample = (values, [x, y]) => (nonlinear() || grid.depth[y * grid.W + x] > 0) ? values[y * grid.W + x] : null;
const timeLabel = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function controls() {
  $('play').disabled = !ready;
  $('step').disabled = !ready || running || busy || frame.time >= totalSeconds();
  $('play').textContent = !ready ? 'Loading Rust…' : running ? 'Pause' : frame.time >= totalSeconds() ? 'Replay' : 'Play';
}

function labels() {
  $('deep').disabled = !!bathymetry || localScene();
  $('inundationControls').hidden = $('inundationMetrics').hidden = !localScene();
  $('lakeControl').hidden = $('preset').value !== 'estuary';
  const coupled = coupledOn();
  $('couplingControls').hidden = !parentOf($('preset').value);
  const series = seriesOn();
  $('offshoreWidthControl').hidden = !coupled || series;
  $('waveFileControl').hidden = !series;
  $('amplitude').parentElement.hidden = series;
  $('incoming').parentElement.hidden = !coupled;
  $('tideRange').parentElement.hidden = !coupled;
  $('tideRangeValue').textContent = `${(+$('tideRange').value).toFixed(2)} m`;
  $('offshoreWidthValue').textContent = `${$('offshoreWidth').value} km`;
  $('width').parentElement.hidden = coupled;
  $('absorbing').disabled = coupled;
  $('couplingMetrics').hidden = !coupled;
  if (coupled) {
    const parent = parentOf($('preset').value), c = couplingInfo;
    if (series) $('couplingSource').textContent = uploaded ? `${uploaded.name} · ${uploaded.times.length} rows · local seconds` : 'No file chosen';
    else $('couplingSource').textContent = `${parent.source[0].toFixed(2)}°E ${Math.abs(parent.source[1]).toFixed(2)}°S · ${(+$('amplitude').value).toFixed(2)} m nominal · ${$('offshoreWidth').value} km wide`;
    $('couplingArrival').textContent = !c ? (series ? 'Waiting for the series…' : 'Running the regional model…')
      : c.source === 'series' ? `${(c.arrival / 60).toFixed(1)} min into the local run`
      : `${(c.arrival / 60).toFixed(0)} min after the offshore source · local clock starts ${(c.offset / 60).toFixed(0)} min after it`;
    $('couplingPeak').textContent = c ? `${c.peak.toFixed(2)} m (${Object.entries(c.edges).map(([name, e]) => `${name} ${e.peak.toFixed(2)}`).join(', ')}) ${c.source === 'series' ? '' : ` · regional peak anywhere ${c.regionalPeak.toFixed(2)} m`}${c.tide ? ` · plus a ${c.tide.toFixed(2)} m rising tide` : ''}` : '—';
  }
  $('tideValue').textContent = `${(+$('tide').value).toFixed(2)} m`;
  $('roughnessValue').textContent = (+$('roughness').value).toFixed(3);
  $('lakeValue').textContent = `${(+$('lakeLevel').value).toFixed(2)} m`;
  $('deepValue').textContent = `${Math.round((bathymetry || localScene()) ? Math.max(...grid.depth) : +$('deep').value).toLocaleString('en-AU')} m`;
  $('couplingHint').textContent = series ? 'Uses your wave series as the incoming wave on every open edge: two columns, seconds from the start of the run and metres above the initial sea level. Nothing is scaled or checked against a datum; the file\'s author owns that.' : coupled ? 'The regional 1.5 km linear model runs first with the offshore source below; its wave at this scene\'s sea edges (scaled to local depth by Green\'s law) enters the nonlinear model as incoming-wave forcing. One-way: the local model does not feed back. Sheltered bays receive little because the regional grid barely resolves their entrances.' : 'Runs the 1.5 km regional model first, then feeds its wave in at this scene\'s open sea edges instead of the local pulse.';
  $('waveSettingsHint').textContent = series ? 'The wave comes from your series; source strength and width do not apply.' : coupled ? 'Offshore source: exaggerated demonstration pulse in the regional model, not a calibrated tsunami scenario. It is not a PTHA18 scenario.' : `${+$('amplitude').value >= 2 ? 'Exaggerated demonstration wave' : 'Hypothetical demonstration wave'}, not a calibrated tsunami scenario. ${localScene() ? 'Shallow water reduces the initial pulse; the actual maximum appears below.' : 'Source strength is displacement from still water, not crest-to-trough wave height.'}`;
  $('amplitudeValue').textContent = `${(+$('amplitude').value).toFixed(2)} m`;
  $('widthValue').textContent = `${(+$('width').value).toFixed(localScene() ? 2 : 0)} km`;
  const sourceDepth = grid.depth[source[1] * grid.W + source[0]];
  $('sourceValue').textContent = coupled ? (series ? 'Uploaded series (see below)' : 'Offshore (see below)') : bathymetry ? coordinates(source) : `${(source[0] * grid.cell / 1000).toFixed(2)} km E · ${(source[1] * grid.cell / 1000).toFixed(2)} km S`;
  $('waveSpeed').textContent = coupled ? '—' : `${(Math.sqrt(9.81 * sourceDepth) * 3.6).toFixed(0)} km/h`;
  $('scenarioName').textContent = $('preset').selectedOptions[0].textContent;
  $('tryDispersive').hidden = $('method').value === 'dispersive';
  $('methodHint').textContent = $('method').value === 'dispersive' ? `Experimental linear Boussinesq (Peregrine) waves: shorter wavelengths travel more slowly. ${$('preset').value === 'flat' ? 'Uniform depth' : 'Variable depth with reflecting land'}; no breaking or inundation. Source-scale depth/spread ratio: ${(Math.max(...grid.depth) / (+$('width').value * 1000)).toFixed(2)}${$('preset').value === 'flat' ? '' : ' at the deepest water; aim for about 1 or less'}. Weak-dispersion approximation, not a complete gravity-wave model.${$('preset').value === 'flat' ? '' : ' It solves a coupled system every step, so playback may run slower than selected.'}` : localScene() ? 'Nonlinear shallow-water flow with wetting/drying, bed slope, advection and Manning resistance. First-order numerical scheme; experimental local wave forcing.' : $('method').value === 'staggered'
    ? 'Staggered-grid propagation with low numerical damping. Both methods solve linear shallow-water equations; neither models onshore flooding.'
    : 'Finite-volume acoustic fluxes with RK2 time stepping. This first-order spatial method damps short waves more. It solves the same linear equations; it does not add inundation physics.';
  $('mapHint').textContent = `${grid.W * grid.cell / 1000} × ${grid.H * grid.cell / 1000} km ${bathymetry ? 'Australian coastal subset' : 'idealised basin'} · ${grid.cell / 1000} km cells · ${coupled ? 'The wave enters from the open sea edges; there is no local source to move.' : localScene() ? ($('preset').value === 'estuary' ? 'Click water to move the local source; the idealised lake can have its own wave.' : 'Click connected bay water to move the local wave source.') : 'Click the ocean to move the hypothetical source.'} Markers 1–3 are virtual gauges.`;
  $('seaHeightRange').textContent = `Bed below zero: ${terrain.low.toFixed(1)} to 0 m`;
  $('missingTerrainLegend').hidden = !bathymetry?.missing;
  $('missingTerrainLegend').textContent = bathymetry?.missing ? `Magenta hatch: ${bathymetry.missing} missing terrain cells` : '';
  $('terrainQualityControl').hidden = !bathymetry?.terrainSource;
  $('terrainSources').hidden = !bathymetry?.sourceCounts;
  $('terrainSources').textContent = bathymetry?.sourceCounts ? `Terrain provenance: ${bathymetry.sourceCounts.filter(s => s.cells).map(s => `${s.label} ${(100*s.cells/(grid.W*grid.H)).toFixed(1)}%`).join(' · ')}. Amber overlay marks interpolated, modelled creek or coarse base cells when enabled. Inspect a cell for its source.` : '';
  $('terrainCoverage').hidden = !bathymetry?.missing;
  $('terrainCoverage').textContent = bathymetry?.missing ? `${bathymetry.missing} terrain cells missing (${(100*bathymetry.missing/(grid.W*grid.H)).toFixed(2)}% of this grid). Magenta hatching marks cells excluded from water flow; source heights are unavailable.` : '';
  $('landHeightRange').textContent = terrain.high > 0 ? `Ground above zero: 0 to ${terrain.high.toFixed(1)} m` : 'Land heights unavailable in this scene';
  updatePlaceContext();
  $('boundaryHint').textContent = coupled ? 'Sea edges carry the incoming offshore wave and let outgoing waves leave (Flather-type radiation condition; no sponge). Any other edge is a reflecting wall.' : localScene() ? 'Outer edges are reflecting walls. The optional sponge relaxes initially wet edge cells towards their starting water levels; it is not an offshore tsunami boundary or a river inflow.' : 'Turn off absorption to compare reflections in a closed basin. The coastline always reflects; water does not move onto land.';
  $('dataNote').textContent = coupled ? `Real local terrain at ${grid.cell} m driven by ${series ? 'a wave series you supplied' : 'a hypothetical offshore pulse propagated through the 1.5 km regional model (GA bathymetry v4, coastal depths floored at 10 m)'}${+$('tideRange').value ? `, with a hypothetical ${(+$('tideRange').value).toFixed(2)} m rising tide (not a forecast)` : ''}. Vertical datums are unreconciled and the sea level is a hypothetical plane. Not a PTHA18 scenario, calibrated inundation or hazard prediction.` : localScene() ? ($('preset').value === 'estuary' ? 'Idealised 25 m terrain: ocean, low floodplain, a connected river and a lake starting at a separate water level. Includes flooding and drainage. Not a reconstruction of an Australian estuary.' : `Real local terrain resampled to ${grid.cell} m, with a hypothetical local wave. ${bathymetry?.terrainSource ? 'AVWS elevations; initial water level is hypothetical, not calibrated local mean sea level. Terrain includes interpolation and modelled creek depths.' : 'Source bathymetry coverage and vertical datum are unverified.'} Isolated inland depressions start dry because their water levels are unknown. Not a calibrated inundation or hazard model.`) : bathymetry
    ? 'Real coastal topography and bathymetry, with a hypothetical offshore pulse. This is not a historical earthquake reconstruction or a coastal hazard prediction. Land remains a reflecting wall: no river flow, run-up or inundation.'
    : 'Synthetic ocean depths and a prescribed uplift/subsidence pulse. This is not an earthquake scenario or a prediction for a real coast. It does not model wave breaking, shoreline run-up or inundation.';
  if ($('method').value === 'dispersive') $('dataNote').textContent = `${$('preset').value === 'flat' ? 'Uniform synthetic ocean' : bathymetry ? 'Real coastal bathymetry (coastal depths floored at 10 m)' : 'Synthetic bathymetry'} with linear Boussinesq/Peregrine dispersion. This is a numerical comparison, not a coastal inundation or earthquake scenario; the variable-depth form is checked against the uniform-depth solver and the long-wave limit only, not against field or benchmark data.`;
  $('dataCredit').hidden = !bathymetry;
  $('terrainTerms').hidden = !bathymetry?.licenseMetadataUrl;
  if (bathymetry?.licenseMetadataUrl) {
    $('terrainAcknowledgement').textContent = bathymetry.acknowledgement || `${bathymetry.license}. ${bathymetry.changes || ''}`;
    $('hydrographicNotice').textContent = bathymetry.hydrographicNotice || '';
    $('terrainLicence').href = bathymetry.licenseMetadataUrl;
  }
  map.setAttribute('aria-label', 'Coastal water model. Click open water to move the source; arrow keys move one grid cell; Enter plays or pauses.');
  if (bathymetry) {
    if (bathymetry.missing) $('dataNote').textContent += ` ${bathymetry.missing} hatched cells have no elevation data and are excluded from flow.`;
    $('dataCredit').replaceChildren(document.createTextNode(`${bathymetry.source}. ${localScene() ? `${bathymetry.sampling || `${grid.cell} m bilinear resampling; mixed source resolutions`}. ${bathymetry.verticalDatum}` : 'Resampled to 1.5 km; wet cells shallower than 10 m are floored to 10 m.'} ${bathymetry.attribution}. `));
    const link = document.createElement('a'); link.href = bathymetry.metadataUrl; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Dataset metadata ↗'; $('dataCredit').append(link);
  }
}

function coordinates([x, y]) {
  if (bathymetry.extent) return `${Math.round(bathymetry.extent[0] + (x + .5) * grid.cell)} E · ${Math.round(bathymetry.extent[3] - (y + .5) * grid.cell)} N (MGA56)`;
  const [west, south, east, north] = bathymetry.bounds;
  return `${Math.abs(north - (y + .5) / grid.H * (north - south)).toFixed(3)}° S · ${(west + (x + .5) / grid.W * (east - west)).toFixed(3)}° E`;
}

function waterPoint(elevation, target, minDepth) {
  let best = null, distance = Infinity;
  for (let i = 0; i < elevation.length; i++) if (elevation[i] < -minDepth) {
    const point = [i % 160, Math.floor(i / 160)];
    const d = Math.hypot(point[0] - target[0], point[1] - target[1]);
    if (d < distance) { distance = d; best = point; }
  }
  if (!best) throw new Error('No suitable ocean cells in this subset.');
  return best;
}

async function changeScene() {
  const version = ++sceneVersion, id = $('preset').value;
  const local = localScene();
  $('method').querySelector('[value="nonlinear"]').disabled = !local;
  for (const option of $('method').options) if (option.value !== 'nonlinear') option.disabled = local;
  if (local) $('method').value = 'nonlinear';
  else if ($('method').value === 'nonlinear') $('method').value = 'staggered';
  for (const id of ['depth', 'speed']) $('view').querySelector(`[value="${id}"]`).disabled = !local;
  if (!local && ['depth', 'speed'].includes($('view').value)) $('view').value = 'surface';
  const width = $('width');
  if (local && +width.min >= 5) { width.min = '.1'; width.max = '.8'; width.step = '.05'; width.value = '.45'; }
  if (!local && +width.min < 5) { width.max = '20'; width.min = '5'; width.step = '1'; width.value = '10'; }
  if (local) { $('speed').value = '5'; if (+$('duration').value > 30) $('duration').value = '10'; }
  if (id === 'estuary') { bathymetry = null; source = [38, 48]; probes = [[60, 48], [115, 55], [128, 22]]; reset(); return; }

  if (!coastIds.includes(id) && !estuaryIds.includes(id)) { bathymetry = null; source = [38, 48]; probes = [[65, 48], [105, 35], [122, 60]]; reset(); return; }
  ready = running = false; controls();
  if (worker) worker.terminate();
  $('status').textContent = 'Loading the prefetched Australian coastal grid…';
  try {
    const response = await fetch(new URL(`tsunami-data/${id}.json`, document.baseURI), { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Coastal grid: HTTP ${response.status}`);
    const data = await response.json();
    const referenceElevation = estuaryIds.includes(id) ? Array.from(connectedWaterDepth(data.elevation || [], 160, 96, +$('tide').value, data.seaEdges || ['east'], data.valid), depth => -depth) : data.elevation || [];
    const nextSource = waterPoint(referenceElevation, estuaryIds.includes(id) ? data.sourceTarget || [142, 48] : [120, 48], estuaryIds.includes(id) ? 3.1 : 500);
    // Validate the entire numeric grid before accepting it into the UI.
    tsunamiGrid({ ...options(), bathymetry: data, source: nextSource });
    if (version !== sceneVersion) return;
    bathymetry = data; source = nextSource;
    probes = estuaryIds.includes(id) ? [[130, 48], [85, 48], [40, 48]].map(point => waterPoint(referenceElevation, point, .5)) : [[62, 26], [62, 48], [62, 70]].map(point => waterPoint(data.elevation, point, 30));
    reset();
  } catch (error) {
    if (version === sceneVersion) $('status').textContent = `${error.message} The grid could not load. Reset to retry or choose an idealised scene.`;
  }
}

function scenePlaces() {
  if (bathymetry) return referencePlaces.scenes[bathymetry.id] || [];
  if ($('preset').value === 'estuary') return [
    { name: 'Ocean', u: .14, v: .18 }, { name: 'River channel', u: .68, v: .59 },
    { name: 'Lake', u: .8, v: .17 }, { name: 'Floodplain', u: .69, v: .83 },
  ];
  return [];
}
function updatePlaceContext() {
  const text = $('placeContext');
  text.hidden = !$('showPlaces').checked;
  if (!bathymetry) { text.textContent = $('preset').value === 'estuary' ? 'Idealised terrain: feature labels are illustrative; this map has no real city locations.' : ''; return; }
  const places = scenePlaces();
  const outside = places.filter(p => p.u < 0 || p.u > 1 || p.v < 0 || p.v > 1);
  text.replaceChildren(document.createTextNode(`Reference places: ${places.map(p => p.name + (outside.includes(p) ? ' (outside grid)' : '')).join(' · ')}. `));
  const link = document.createElement('a'); link.href = referencePlaces.sourceUrl; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Names: Composite Gazetteer of Australia / GA and state authorities ↗'; text.append(link);
}
function drawPlaces(screen) {
  if (!$('showPlaces').checked) return;
  ctx.save();
  ctx.font = `600 ${11 * screen}px system-ui`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const occupied = probes.map(([x, y]) => [(x + .5) / grid.W * map.width - 12 * screen, (y + .5) / grid.H * map.height - 12 * screen, 24 * screen, 24 * screen]);
  const intersects = ([x, y, w, h]) => occupied.some(([a, b, c, d]) => x < a + c && x + w > a && y < b + d && y + h > b);
  for (const p of scenePlaces()) {
    if (p.u < 0 || p.u >= 1 || p.v < 0 || p.v >= 1) continue;
    const x = p.u * map.width, y = p.v * map.height, w = ctx.measureText(p.name).width, h = 16 * screen;
    const candidate = [[x + 7 * screen, y - 10 * screen], [x + 7 * screen, y + 12 * screen], [x - w - 7 * screen, y - 10 * screen], [x - w - 7 * screen, y + 12 * screen]]
      .map(([a, b]) => [a - 3 * screen, b - h / 2, w + 6 * screen, h])
      .find(box => box[0] >= 2 * screen && box[1] >= 2 * screen && box[0] + box[2] <= map.width - 2 * screen && box[1] + box[3] <= map.height - 2 * screen && !intersects(box));
    if (!candidate) continue;
    occupied.push(candidate);
    ctx.beginPath(); ctx.arc(x, y, 2.5 * screen, 0, Math.PI * 2); ctx.fillStyle = '#173346'; ctx.fill(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = screen; ctx.stroke();
    const tx = candidate[0] + 3 * screen, ty = candidate[1] + h / 2;
    ctx.strokeStyle = '#ffffffed'; ctx.lineWidth = 3 * screen; ctx.strokeText(p.name, tx, ty);
    ctx.fillStyle = '#173346'; ctx.fillText(p.name, tx, ty);
  }
  ctx.restore();
}

function paint() {
  if (!frame || !grid) return;
  const peakView = $('view').value === 'peak';
  const terrainOnly = $('view').value === 'terrain';
  const terrainVisible = $('showTerrain').checked || terrainOnly;
  const quality = $('showTerrainQuality').checked ? bathymetry?.terrainSource : null;
  $('terrainKey').hidden = !terrainVisible;
  const view = $('view').value;
  const values = view === 'depth' ? frame.water : view === 'speed' ? frame.speed : peakView ? frame.peak : frame.eta;
  if (!values) return;
  const scale = view === 'depth' ? 5 : view === 'speed' ? 3 : +$('amplitude').value * 1.5;
  pixels.width = grid.W; pixels.height = grid.H;
  const image = pixelContext.createImageData(grid.W, grid.H);
  for (let i = 0; i < values.length; i++) {
    let rgb;
    if ((!nonlinear() && !grid.depth[i]) || (nonlinear() && frame.water[i] < .001 && !(peakView && frame.peak[i] > .01))) rgb = [77, 91, 79];
    else {
      const v = Math.max(-1, Math.min(1, values[i] / scale));
      const referenceDepth = bathymetry ? 5500 : +$('deep').value;
      const base = 220 + 25 * (1 - Math.min(1, grid.depth[i] / referenceDepth));
      const target = nonlinear() && (view === 'depth' || view === 'speed' || grid.depth[i] === 0) ? [0, 136, 154] : v < 0 ? [22, 113, 174] : [216, 80, 27];
      const intensity = nonlinear() && grid.depth[i] === 0 && values[i] > .01 ? Math.min(1, .3 + .7 * values[i]) : Math.abs(v);
      rgb = target.map(c => Math.round(base + (c - base) * intensity));
    }
    if (terrainVisible) {
      const base = terrain.colours.subarray(i * 3, i * 3 + 3);
      // Leave terrain visible where water is still; stronger wave values
      // increase overlay opacity. Dry land always retains its height colour.
      const dry = nonlinear() ? frame.water[i] < .001 : !grid.depth[i];
      const historicalFlood = peakView && grid.depth[i] === 0 && frame.peak[i] > .01;
      let opacity = terrainOnly || (dry && !historicalFlood) ? 0 : Math.min(.9, Math.abs(values[i]) / scale);
      if (!terrainOnly && nonlinear() && grid.depth[i] === 0 && values[i] > .01) opacity = Math.max(.55, opacity);
      if (!terrainOnly && ['depth', 'speed'].includes(view) && !dry) opacity = Math.max(.15, opacity);
      const tint = view === 'depth' || view === 'speed' || (nonlinear() && grid.depth[i] === 0) ? [0, 153, 182] : values[i] < 0 ? [20, 136, 236] : [246, 90, 28];
      rgb = base.map((c, k) => Math.round(c + (tint[k] - c) * opacity));
    }
    if (quality && (quality[i] === 0 || quality[i] >= 5)) rgb = rgb.map((c, k) => Math.round(.45*c + .55*[240, 167, 35][k]));
    if (grid.valid?.[i] === 0) rgb = [110, 119, 107];
    image.data.set([...rgb, 255], i * 4);
  }
  pixelContext.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(pixels, 0, 0, map.width, map.height);
  const sx = map.width / grid.W, sy = map.height / grid.H;
  const screen = map.width / Math.max(1, map.getBoundingClientRect().width);
  ctx.strokeStyle = '#35657855'; ctx.lineWidth = screen;
  for (let x = 20; x < grid.W; x += 20) { ctx.beginPath(); ctx.moveTo(x * sx, 0); ctx.lineTo(x * sx, map.height); ctx.stroke(); }
  for (let y = 20; y < grid.H; y += 20) { ctx.beginPath(); ctx.moveTo(0, y * sy); ctx.lineTo(map.width, y * sy); ctx.stroke(); }
  ctx.strokeStyle = '#172f3b'; ctx.lineWidth = 1.5 * screen;
  const px = (source[0] + .5) * sx, py = (source[1] + .5) * sy;
  if (!grid.coupled) { ctx.beginPath(); ctx.moveTo(px - 7 * screen, py); ctx.lineTo(px + 7 * screen, py); ctx.moveTo(px, py - 7 * screen); ctx.lineTo(px, py + 7 * screen); ctx.stroke(); }
  ctx.font = `bold ${12 * screen}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  probes.forEach(([x, y], n) => {
    ctx.beginPath(); ctx.arc((x + .5) * sx, (y + .5) * sy, 10 * screen, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.strokeStyle = colours[n]; ctx.stroke();
    ctx.fillStyle = colours[n]; ctx.fillText(String(n + 1), (x + .5) * sx, (y + .5) * sy);
  });
  // Missing data is a coverage overlay, independent of terrain/wave palette.
  if (grid.valid) {
    ctx.save(); ctx.strokeStyle = '#b00083'; ctx.fillStyle = '#f9d9f0'; ctx.lineWidth = 1.5*screen;
    for (let i = 0; i < grid.valid.length; i++) if (!grid.valid[i]) {
      const x = i % grid.W * sx, y = Math.floor(i / grid.W) * sy;
      ctx.fillRect(x, y, sx, sy); ctx.strokeRect(x, y, sx, sy);
      ctx.beginPath(); ctx.moveTo(x, y + sy); ctx.lineTo(x + sx, y); ctx.stroke();
      // A wider outline makes even a single coarse cell visible on phones.
      ctx.strokeRect(x - 2*screen, y - 2*screen, sx + 4*screen, sy + 4*screen);
    }
    ctx.restore();
  }
  drawPlaces(screen);
  $('clock').textContent = `${timeLabel(frame.time)} simulated${couplingInfo ? ` · +${Math.round(couplingInfo.offset / 60)} min after the offshore source` : ''}`;
  $('range').textContent = terrainOnly ? 'Terrain elevations (m)' : view === 'speed' ? `0 to ${scale.toFixed(1)} m/s` : view === 'depth' ? `0 to ${scale.toFixed(1)} m` : peakView ? `0 to ${scale.toFixed(2)} m` : `−${scale.toFixed(2)} to +${scale.toFixed(2)} m`;
  $('legend').textContent = terrainOnly ? 'Terrain only · wave model continues in the background' : view === 'depth' ? 'Teal: water depth · Green: dry ground' : view === 'speed' ? 'Teal: current speed · Green: dry ground' : peakView ? (nonlinear() ? 'Orange: maximum |wave| · Teal: maximum new flooding' : 'White: no displacement · Orange: maximum |wave|') : nonlinear() ? 'Blue: drawdown · Orange: crest · Teal: flooded ground · Green: dry' : 'Blue: drawdown · White: still water · Orange: crest';
  if (terrainVisible && !terrainOnly) {
    $('legend').textContent = view === 'depth' ? 'Water overlay: teal = water depth · Terrain beneath'
      : view === 'speed' ? 'Water overlay: teal = current speed · Terrain beneath'
      : peakView ? 'Water overlay: orange = maximum |wave| · Teal = new flooding'
      : 'Water overlay: bright blue = drawdown · Orange = crest · Teal = new flooding';
  }
  if (terrainVisible && !terrainOnly && !nonlinear()) $('legend').textContent = $('legend').textContent.replace(' · Teal = new flooding', '');
  inspectTerrain();
  if (nonlinear()) {
    let flooded = 0, maximum = 0;
    frame.water.forEach((h, i) => { if (grid.depth[i] === 0 && h > .01) { flooded++; maximum = Math.max(maximum, h); } });
    $('floodArea').textContent = `${(flooded * grid.cell ** 2 / 10000).toFixed(2)} ha (>1 cm)`;
    $('landDepth').textContent = `${maximum.toFixed(3)} m`;
    $('currentSpeed').textContent = `${Math.max(...frame.speed).toFixed(3)} m/s`;
    $('massError').textContent = `${frame.volumeError.toExponential(2)} m³ (edge exchange accounted)`;
  }
  $('peakValue').textContent = `${Math.max(...frame.peak).toFixed(2)} m`;
  $('gaugeValues').replaceChildren(...probes.map((point, i) => {
    const span = document.createElement('span');
    const value = sample(frame.eta, point);
    const name = $('preset').value === 'estuary' ? ['Offshore', 'River', 'Lake'][i] : `${i + 1}`;
    span.textContent = `${name}: ${value == null ? 'on land' : `${value >= 0 ? '+' : ''}${value.toFixed(3)} m`}`;
    span.style.color = colours[i];
    return span;
  }));
  paintTraces();
}

function paintTraces() {
  const W = Math.max(1, traces.getBoundingClientRect().width), H = 180, pad = 50;
  const ratio = window.devicePixelRatio || 1;
  traces.width = Math.round(W * ratio); traces.height = Math.round(H * ratio);
  chart.setTransform(ratio, 0, 0, ratio, 0, 0);
  const scale = Math.max(.1, ...history.flatMap(row => row.slice(1).filter(Number.isFinite).map(Math.abs))) * 1.2;
  chart.clearRect(0, 0, W, H);
  chart.fillStyle = '#526c7c'; chart.font = '12px system-ui'; chart.textAlign = 'left';
  chart.strokeStyle = '#d8e3e5'; chart.lineWidth = 1;
  for (const n of [-1, 0, 1]) {
    const y = H / 2 - n * (H / 2 - 25);
    chart.beginPath(); chart.moveTo(pad, y); chart.lineTo(W - 10, y); chart.stroke();
    chart.fillText(`${(n * scale).toFixed(2)} m`, 0, y - 5);
  }
  chart.fillText('0 min', pad, H - 2);
  chart.textAlign = 'right'; chart.fillText(`${$('duration').value} min`, W - 10, H - 2);
  for (let p = 0; p < probes.length; p++) {
    chart.beginPath(); chart.strokeStyle = colours[p]; chart.lineWidth = 2;
    let first = true;
    for (const row of history) {
      if (row[p + 1] == null) continue;
      const x = pad + row[0] / totalSeconds() * (W - pad - 10);
      const y = H / 2 - row[p + 1] / scale * (H / 2 - 25);
      if (first) chart.moveTo(x, y); else chart.lineTo(x, y);
      first = false;
    }
    chart.stroke();
  }
}

function fail(message) {
  ready = running = busy = false;
  if (worker) worker.terminate();
  controls();
  $('play').textContent = 'Unavailable';
  $('status').textContent = `${message} Reset to try again.`;
}

async function loadParent(id, play) {
  ready = running = false; controls();
  $('status').textContent = 'Loading the regional grid for the offshore wave…';
  try {
    const response = await fetch(new URL(`tsunami-data/${id}.json`, document.baseURI), { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Regional grid: HTTP ${response.status}`);
    parents.set(id, await response.json());
  } catch (error) { fail(`${error.message}.`); return; }
  reset(play);
}

// Regional run and handover points for the current local scene.
function buildCoupling(parent, fineGrid) {
  const parentData = parents.get(parent.id);
  const cell = toParentCell(parentData, ...parent.source).map(Math.floor);
  const parentGrid = tsunamiGrid({ preset: parent.id, bathymetry: parentData, source: cell, amplitude: +$('amplitude').value, width: +$('offshoreWidth').value, absorbing: true });
  const plan = planCoupling({ fine: bathymetry, fineGrid, parentData, parentGrid });
  const localSeconds = totalSeconds();
  return { plan, parentGrid, localSeconds, tide: +$('tideRange').value, seconds: parentSeconds({ plan, parentGrid, source: cell, localSeconds }) };
}

function reset(play = false) {
  const parent = coupledOn() ? parentOf($('preset').value) : null;
  if (parent && !seriesOn() && !parents.has(parent.id)) { loadParent(parent.id, play); return; }
  let next, coupling = null;
  try {
    next = tsunamiGrid({ ...options(), bathymetry });
    if (seriesOn()) {
      if (!uploaded) throw new Error('Choose a CSV file of incoming wave heights first.');
      coupling = { series: uploaded, scene: { fine: { seaEdges: bathymetry.seaEdges }, fineGrid: { W: next.W, H: next.H, depth: next.depth } }, localSeconds: totalSeconds(), tide: +$('tideRange').value };
    } else if (parent) coupling = buildCoupling(parent, next);
  } catch (error) { fail(error.message); return; }
  if (worker) worker.terminate();
  couplingInfo = null;
  grid = next; terrain = terrainFor(grid, bathymetry); inspected = null; frame = null; history = []; ready = running = busy = false; budget = 0;
  labels(); controls();
  $('status').textContent = coupling ? 'Running the regional offshore model, then starting the local simulation…' : 'Starting a fresh Rust wave simulation…';
  const current = worker = new Worker(new URL('./tsunami-worker.js', import.meta.url), { type: 'module' });
  current.onerror = () => { if (worker === current) fail('The wave worker could not start.'); };
  current.onmessage = ({ data }) => {
    if (worker !== current) return;
    if (data.error) { fail(data.error); return; }
    frame = data.frame; busy = false;
    if (data.coupling) { couplingInfo = data.coupling; labels(); }
    if (!ready) { ready = true; running = play; }
    if (!history.length || frame.time - history.at(-1)[0] >= 15)
      history.push([frame.time, ...probes.map(point => sample(frame.eta, point))]);
    if (frame.time >= totalSeconds()) running = false;
    $('status').textContent = frame.time >= totalSeconds() ? 'Simulation complete. Replay or adjust the source to explore another scenario.'
      : running ? 'Running in a Rust / WASM worker. Controls remain responsive.' : 'Paused. Press Play, Step, or move the source.';
    paint(); controls();
  };
  current.postMessage({ type: 'start', grid, coupling });
}

function advance(steps) {
  if (!ready || busy || frame.time >= totalSeconds()) return;
  busy = true;
  const remaining = Math.ceil((totalSeconds() - frame.time) / frame.dt);
  worker.postMessage({ type: 'step', steps: Math.min(grid.method === 3 ? 16 : 200, steps, remaining) });
  controls();
}

function animate(now) {
  const elapsed = Math.min(.1, Math.max(0, (now - previousWall) / 1000));
  previousWall = now;
  if (ready && running) {
    budget += elapsed * +$('speed').value * 60;
    const steps = Math.min(grid.method === 3 ? 16 : 200, Math.floor(budget / frame.dt));
    if (steps > 0 && !busy) { budget -= steps * frame.dt; advance(steps); }
  } else budget = 0;
  requestAnimationFrame(animate);
}

$('play').addEventListener('click', () => {
  if (frame.time >= totalSeconds()) { reset(true); return; }
  running = !running;
  $('status').textContent = running ? 'Running in a Rust / WASM worker.' : 'Paused.';
  controls();
});
$('step').addEventListener('click', () => advance(8));
$('reset').addEventListener('click', () => (coastIds.includes($('preset').value) || estuaryIds.includes($('preset').value)) && bathymetry?.id !== $('preset').value ? changeScene() : reset());
$('preset').addEventListener('change', changeScene);
$('tryDispersive').addEventListener('click', () => { $('preset').value = 'flat'; $('method').value = 'dispersive'; changeScene(); });
for (const id of ['deep', 'amplitude', 'width', 'absorbing', 'duration', 'method', 'tide', 'roughness', 'lakeLevel', 'coupled', 'offshoreWidth', 'incoming', 'tideRange']) $(id).addEventListener('change', () => reset());
for (const id of ['deep', 'amplitude', 'width', 'tide', 'roughness', 'lakeLevel', 'offshoreWidth', 'tideRange']) $(id).addEventListener('input', labels);
$('waveFile').addEventListener('change', async () => {
  const file = $('waveFile').files[0];
  if (!file) return;
  try {
    if (file.size > 8e6) throw new Error('The file is larger than 8 MB.');
    uploaded = { name: file.name, ...parseSeriesCsv(await file.text()) };
  } catch (error) { uploaded = null; $('waveFile').value = ''; fail(`${error.message}`); return; }
  reset();
});
$('view').addEventListener('change', paint);
$('showTerrain').addEventListener('change', paint);
$('showTerrainQuality').addEventListener('change', paint);
$('showPlaces').addEventListener('change', () => { updatePlaceContext(); paint(); });
function inspectTerrain() {
  if (!terrain || !frame || !inspected) { $('terrainReadout').textContent = 'Move over the map to inspect terrain and water depth. Touch a cell to inspect it; tapping wet cells also moves the source.'; return; }
  const [x, y] = inspected, i = y * grid.W + x, z = terrain.elevation[i];
  if (grid.valid?.[i] === 0) { $('terrainReadout').textContent = 'Elevation data unavailable: this cell is excluded from the flow model.'; return; }
  const height = Number.isFinite(z) ? `Terrain elevation ${z >= 0 ? '+' : ''}${z.toFixed(2)} m` : 'Land height unavailable (mask only)';
  const water = nonlinear() ? `Water depth now ${frame.water[i].toFixed(2)} m · Surface elevation ${(z + frame.water[i]).toFixed(2)} m` : `Wave change ${frame.eta[i].toFixed(2)} m`;
  $('terrainReadout').textContent = `${height}${bathymetry?.terrainSource ? ` · Source: ${bathymetry.sourceLabels[bathymetry.terrainSource[i]]}` : ''} · Initial model water depth ${grid.depth[i].toFixed(2)} m · ${water}`;
}
function inspectPointer(event) {
  if (!grid) return;
  const rect = map.getBoundingClientRect();
  inspected = [Math.max(0, Math.min(grid.W - 1, Math.floor((event.clientX - rect.left) / rect.width * grid.W))), Math.max(0, Math.min(grid.H - 1, Math.floor((event.clientY - rect.top) / rect.height * grid.H)))];
  inspectTerrain();
}
map.addEventListener('pointermove', inspectPointer);
map.addEventListener('pointerdown', inspectPointer);
map.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') { inspected = null; inspectTerrain(); } });
function moveSource(next) {
  if (!ready) return;
  if (grid.coupled) { $('status').textContent = 'The wave comes from the offshore source in the regional model. Untick “Drive from an offshore wave” to place a local pulse.'; return; }
  const x = Math.floor(next[0]), y = Math.floor(next[1]);
  if (x < 0 || y < 0 || x >= grid.W || y >= grid.H || !grid.depth[y * grid.W + x]) {
    $('status').textContent = 'Choose a source in water; dry ground cannot generate a wave.';
    return;
  }
  try { tsunamiGrid({ ...options(), bathymetry, source: [x, y] }); } catch (error) { $('status').textContent = error.message; return; }
  source = [x, y]; reset(); inspected = [x, y];
}
map.addEventListener('click', event => {
  const rect = map.getBoundingClientRect();
  moveSource([(event.clientX - rect.left) / rect.width * grid.W, (event.clientY - rect.top) / rect.height * grid.H]);
});
map.addEventListener('keydown', event => {
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (direction) { event.preventDefault(); moveSource([source[0] + direction[0], source[1] + direction[1]]); }
  if (event.key === 'Enter' && ready) { event.preventDefault(); $('play').click(); }
});
$('export').addEventListener('click', () => {
  const metadata = `# Hypothetical tsunami propagation; ${JSON.stringify({ ...options(), bathymetry: bathymetry ? { source: bathymetry.source, bounds: bathymetry.bounds, extent: bathymetry.extent, attribution: bathymetry.attribution, license: bathymetry.license, licenseMetadataUrl: bathymetry.licenseMetadataUrl, acknowledgement: bathymetry.acknowledgement, hydrographicNotice: bathymetry.hydrographicNotice, verticalDatum: bathymetry.verticalDatum, cell: grid.cell } : 'synthetic', coupling: couplingInfo })}\n`;
  const csv = metadata + 'seconds,gauge_1_m,gauge_2_m,gauge_3_m\n' + history.map(row => row.map(v => v == null ? '' : v).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const link = document.createElement('a'); link.href = url; link.download = 'tsunami-lab-gauges.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.__tsunamiStatus = () => ({ coupled: !!grid?.coupled, couplingSource: couplingInfo?.source ?? null, couplingTide: couplingInfo?.tide ?? 0, couplingArrival: couplingInfo?.arrival ?? null, ready, running, time: frame?.time || 0, engine: 'rust-wasm', method: $('method').value, coast: bathymetry?.id || null, source: [...source], samples: history.length, peak: frame ? Math.max(...frame.peak) : 0, flooded: frame?.water ? frame.water.reduce((n, h, i) => n + (grid.depth[i] === 0 && h > .01 ? 1 : 0), 0) : 0, maxSpeed: frame?.speed ? Math.max(...frame.speed) : 0, volumeError: frame?.volumeError || 0 });
window.addEventListener('pagehide', () => { if (worker) worker.terminate(); });
window.addEventListener('resize', paint);
const initialScene = new URLSearchParams(location.search).get('scene');
if (new URLSearchParams(location.search).get('coupled') === '1') $('coupled').checked = true;
if (new URLSearchParams(location.search).get('method') === 'dispersive') $('method').value = 'dispersive';
if (initialScene && [...$('preset').options].some(option => option.value === initialScene)) { $('preset').value = initialScene; changeScene(); }
else reset();
requestAnimationFrame(animate);
