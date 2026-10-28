/* Tsunami on the main map. Wave pins mark the four modelled places; tapping one opens a small card to pick one of its PTHA18 earthquake scenarios
 * and a tide, and runs it in the lab's Rust/WebAssembly worker. The run plays on the map with a floating bar (play, time, speed, and a
 * Now | Maximum | Arrival-time view). The side panel (panel-tsunami) steps through the three questions the layers answer. DOM ids are in
 * index.html; nothing is fetched until a pin or the panel is first used. */
import { estuaryLocations } from './tsunami-locations.js';
import { placeBounds } from './tsunami-extents.js';
import { TIDE_STATION, modelTide, tideLevels, loadScenarios, loadPlace, loadSeries, prepareRun, runInWorker, floodSummary } from './tsunami-session.js';
import { makeLiveLayer, deriveRun, cellIndex, maxPixels, arrivalPixels, viewLegend, ARRIVAL_TEXT, arrivalClass } from './tsunami-live.js';

const clock = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const ha = (value) => value < 0.05 ? 'none' : `${value.toFixed(value < 10 ? 1 : 0)} ha`;
const minutesText = (seconds) => seconds < 90 ? 'under a minute' : `${Math.round(seconds / 60)} minutes`;
const rateText = (rate) => { if (!(rate > 0)) return 'unknown'; const years = 1 / rate; return years >= 1e6 ? `about 1 in ${(years / 1e6).toFixed(1)} million years` : `about 1 in ${Math.round(years).toLocaleString('en-AU')} years`; };
export const TIDE_STEPS = [['Low', 'MLWS'], ['Mid', 'MSL'], ['High', 'MHWS'], ['Highest', 'HAT']];
const CACHE_RUNS = 4, MEMORY_KEY = 'flood-tsunami-last', PIN_ZOOM = 8, HINT_ZOOM = 9;
const WAVE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M2 15c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3 2.5 3 5 3M2 19.5c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3 2.5 3 5 3M3 9c2-4 5-6 9-6 0 3-1.5 5-4 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function initTsunamiPanel({ L, map, canvasOverlay, baseUrl, layers = {}, onLegend = () => {}, onRunStart = () => {}, onLayerChange = () => {}, onHint = () => {}, doc = document }) {
  const $ = (id) => doc.getElementById(id);
  const live = makeLiveLayer(L, { canvasOverlay });
  const info = { state: 'idle', place: null, scenario: null, tide: 'MSL', error: null, frames: 0, summary: null, view: 'now', cached: false };
  const sel = { place: null, scenario: null, tide: 'MSL', minutes: 60 };
  let scenarios = null, loading = null, run = null, active = null, playing = false, index = 0, clockSeconds = 0, last = 0, raf = 0, view = 'now', hinted = false;
  const planes = new Map(), terrain = new Map(), cache = new Map(), pins = new Map();
  try { const m = JSON.parse(localStorage.getItem(MEMORY_KEY) || 'null'); if (m && TIDE_STEPS.some(([, s]) => s === m.tide)) sel.tide = m.tide; if (m && typeof m.place === 'string') sel.place = m.place; } catch (error) { /* storage blocked */ }

  const places = Object.keys(TIDE_STATION);
  const placeName = (id) => (estuaryLocations.find((l) => l.id === id)?.name || id).replace(/ · terrain test$/, '');
  const shortName = (id) => placeName(id).split(/[,/]/)[0].trim();
  const scenariosOf = (place) => (scenarios || []).filter((s) => s.place === place);
  const current = () => (scenarios || []).find((s) => s.place === sel.place && s.id === sel.scenario);
  const status = (text) => { if ($('tsStatus')) $('tsStatus').textContent = text; if ($('tsBarStatus')) $('tsBarStatus').textContent = text; };
  const tideAt = (place, state) => modelTide((planes.get(TIDE_STATION[place]) || []).find((l) => l.state === state)?.aboveMsl || 0);
  const remember = () => { try { localStorage.setItem(MEMORY_KEY, JSON.stringify({ place: sel.place, tide: sel.tide })); } catch (error) { /* storage blocked */ } };

  async function ensureLoaded() {
    if (scenarios || loading) return loading;
    info.state = 'loading';
    loading = loadScenarios(baseUrl).then((all) => {
      scenarios = all;
      const have = [...new Set(all.map((s) => s.place))];
      if ($('tsPlace')) $('tsPlace').innerHTML = have.map((p) => `<option value="${p}">${placeName(p)}</option>`).join('');
      if (!have.includes(sel.place)) sel.place = have[0];
      pick({ place: sel.place });
      info.state = 'idle'; status('Pick a place on the map, then a scenario. A run takes a few seconds.');
    }).catch((error) => { loading = null; info.state = 'error'; info.error = String(error.message || error); status(`Could not load the scenarios (${info.error}).`); });
    return loading;
  }
  async function ensureTides(place) {
    const station = TIDE_STATION[place];
    if (planes.has(station)) return;
    try {
      const r = await fetch(new URL(`tsunami-data/${station}-tidal-planes.json`, baseUrl).href);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      planes.set(station, tideLevels(await r.json()));
    } catch (error) { planes.set(station, tideLevels({ planes: { LAT: 0, MLWS: 0, MLWN: 0, MSL: 0, MHWN: 0, MHWS: 0, HAT: 0 } })); status(`The tide levels could not be loaded (${error.message}); runs start at mean sea level.`); }
  }

  // ---- selection (the card, the side panel's selects and the chips all follow `sel`) ----
  function pick(patch) {
    Object.assign(sel, patch);
    const list = scenariosOf(sel.place);
    if (list.length && !list.some((s) => s.id === sel.scenario)) sel.scenario = list[0].id;
    const s = current();
    if ($('tsPlace')) {
      $('tsPlace').value = sel.place || '';
      $('tsScenario').innerHTML = list.map((x) => `<option value="${x.id}">${x.label}</option>`).join('');
      $('tsScenario').value = sel.scenario || '';
      $('tsScenarioNote').textContent = s ? `Magnitude ${s.mw} earthquake, ${s.zone.replace(/\d+$/, '')} source zone (PTHA18 scenario ${s.row}). Its wave is ${s.offshorePeakM.toFixed(2)} m high at a point ${s.depthM} m deep offshore. The earthquake itself has an annual rate of ${s.annualRate.toExponential(1)} (${rateText(s.annualRate)}): that is how rare the earthquake is, not how often this wave size happens.` : '';
      fillTide();
    }
    refreshCards();
  }
  function fillTide() {
    const levels = planes.get(TIDE_STATION[sel.place]);
    if (!levels || !$('tsTide')) return;
    $('tsTide').innerHTML = levels.map((l) => `<option value="${l.state}">${l.state} (${l.aboveMsl >= 0 ? '+' : ''}${l.aboveMsl.toFixed(2)} m${modelTide(l.aboveMsl) !== l.aboveMsl ? `, run at ${modelTide(l.aboveMsl).toFixed(2)} m` : ''})</option>`).join('');
    $('tsTide').value = sel.tide;
    $('tsTideNote').textContent = 'Height above mean sea level, held for the whole run. Mean sea level is taken as the terrain’s zero.';
  }

  // ---- pins and their card ----
  const cards = new Set();
  function buildCard(place) {
    const el = doc.createElement('div');
    el.className = 'ts-card'; el.dataset.place = place;
    el.innerHTML = `<strong>${placeName(place)}</strong><p class="hint">Run a modelled earthquake wave here, in your browser. Experimental; not a forecast.</p>
      <div class="ts-chips" role="group" aria-label="Earthquake scenario"></div>
      <div class="ts-card-tide"><span class="label">Tide when it arrives</span><div class="ts-seg" role="group" aria-label="Tide"></div></div>
      <p class="hint ts-card-note" role="status"></p>`;
    el.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-scenario]'), step = event.target.closest('[data-tide]');
      if (chip) { pick({ place, scenario: chip.dataset.scenario }); start(); }
      if (step) { pick({ place, tide: step.dataset.tide }); remember(); if (active && active.place === place) start(); }
    });
    cards.add(el); fillCard(el);
    return el;
  }
  function fillCard(el) {
    const place = el.dataset.place, list = scenariosOf(place), note = el.querySelector('.ts-card-note');
    el.querySelector('.ts-chips').innerHTML = list.length ? list.map((s) => `<button type="button" class="ts-chip" data-scenario="${s.id}" aria-pressed="${sel.place === place && sel.scenario === s.id && active?.key.startsWith(place) ? 'true' : 'false'}" title="Magnitude ${s.mw}, wave ${s.offshorePeakM.toFixed(1)} m offshore">${s.label}</button>`).join('') : '<span class="hint">Loading…</span>';
    el.querySelector('.ts-seg').innerHTML = TIDE_STEPS.map(([name, state]) => `<button type="button" data-tide="${state}" aria-pressed="${sel.tide === state}" title="${state}">${name}</button>`).join('');
    note.textContent = list.length ? 'Tap a scenario to run it.' : '';
  }
  const refreshCards = () => { for (const el of [...cards]) { if (!el.isConnected && el.dataset.seen) { cards.delete(el); continue; } el.dataset.seen = '1'; fillCard(el); } };

  function makePins() {
    for (const id of places) {
      const loc = estuaryLocations.find((l) => l.id === id);
      if (!loc) continue;
      const [[s, w], [n, e]] = placeBounds(loc);
      const marker = L.marker([(s + n) / 2, (w + e) / 2], {
        icon: L.divIcon({ className: 'ts-pin', html: `<span title="Tsunami scenarios: ${placeName(id)}">${WAVE}</span>`, iconSize: [36, 36], iconAnchor: [18, 18] }),
        keyboard: true, title: `Tsunami scenarios: ${placeName(id)}`, alt: `Tsunami scenarios: ${placeName(id)}`, riseOnHover: true,
      });
      marker.bindPopup(() => { ensureLoaded().then(() => refreshCards()); ensureTides(id).then(fillTide); pick({ place: id }); return buildCard(id); }, { maxWidth: 300, className: 'ts-popup' });
      pins.set(id, marker);
    }
    map.on('zoomend moveend', syncPins);
    syncPins();
  }
  function syncPins() {
    const show = map.getZoom() >= PIN_ZOOM;
    for (const marker of pins.values()) { if (show && !map.hasLayer(marker)) marker.addTo(map); else if (!show && map.hasLayer(marker)) map.removeLayer(marker); }
    if (show && !hinted && !active && map.getZoom() >= HINT_ZOOM && [...pins.values()].some((m) => map.getBounds().contains(m.getLatLng()))) {
      hinted = true; onHint('Tsunami scenarios can be run here: tap the wave pin.');
    }
  }
  function openCard(place) {
    const marker = pins.get(place);
    if (!marker) return;
    if (map.getZoom() < PIN_ZOOM) map.setView(marker.getLatLng(), 11, { animate: false }); else map.panTo(marker.getLatLng(), { animate: false });
    if (!map.hasLayer(marker)) marker.addTo(map);
    marker.openPopup();
  }

  // ---- playback ----
  function summaryAt(i) { return active.derived.summaries[i]; }
  function paintView() {
    const { prepared, derived, result } = active;
    if (view === 'now') live.paint(result.frames[index], prepared.land);
    else if (view === 'max') live.paintWith((cells, px) => maxPixels(cells, prepared.land, derived.peak, px));
    else live.paintWith((cells, px) => arrivalPixels(cells, prepared.land, derived.arrival, px));
  }
  function show(i) {
    const { result, prepared } = active;
    index = Math.max(0, Math.min(result.frames.length - 1, i));
    const frame = result.frames[index], summary = summaryAt(index);
    paintView();
    clockSeconds = frame.time;
    $('tsScrub').value = index; $('tsClock').textContent = `${clock(frame.time)} of ${clock(prepared.seconds)}`;
    $('tsNow').textContent = ha(summary.floodedNowHectares); $('tsMax').textContent = ha(summary.floodedHectares);
    $('tsDepth').textContent = summary.maxLandDepth > 0.01 ? `${summary.maxLandDepth.toFixed(2)} m` : 'none';
    info.summary = summary; info.frameIndex = index;
    if (index >= result.frames.length - 1) {
      setPlaying(false);
      status(`Run complete: the wave floods up to ${ha(summary.floodedHectares)} of land, as deep as ${summary.maxLandDepth.toFixed(2)} m (the ground dry at mean sea level; the tide's own cover counts).`);
    }
  }
  function setPlaying(on) {
    playing = on; $('tsPlay').textContent = on ? 'Pause' : (active && index >= active.result.frames.length - 1 ? 'Replay' : 'Play');
    if (on) { last = performance.now(); raf = requestAnimationFrame(tick); } else cancelAnimationFrame(raf);
  }
  function tick(now) {
    if (!playing) return;
    clockSeconds += Math.min(0.1, (now - last) / 1000) * Number($('tsSpeed').value) * 60; last = now;
    const next = Math.min(active.result.frames.length - 1, Math.floor(clockSeconds / active.result.interval + 1e-9));
    if (next !== index) show(next);
    if (playing) raf = requestAnimationFrame(tick);
  }
  function setView(next) {
    view = next; info.view = next;
    for (const b of doc.querySelectorAll('#tsViews [data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
    if (!active) return;
    if (view !== 'now') setPlaying(false);
    paintView();
    $('tsKey').innerHTML = viewLegend(view).join('');
    onLegend();
  }

  // ---- running ----
  const key = (scenario) => `${scenario.place}|${scenario.id}|${sel.tide}|${sel.minutes}`;
  const busy = (on) => { for (const id of ['tsPlace', 'tsScenario', 'tsTide', 'tsDuration', 'tsRun']) if ($(id)) $(id).disabled = on; for (const b of doc.querySelectorAll('.ts-chip, .ts-seg button')) b.disabled = on; };
  function barMode(mode) {   // 'running' shows the progress, 'ready' the playback controls
    $('tsBar').hidden = false; $('tsBar').dataset.mode = mode;
    $('tsProgress').hidden = mode !== 'running'; $('tsControls').hidden = mode !== 'ready';
  }

  async function compute(scenario, id) {
    if (!terrain.has(scenario.place)) terrain.set(scenario.place, await loadPlace(baseUrl, scenario.place));
    const bathymetry = terrain.get(scenario.place), series = await loadSeries(baseUrl, scenario);
    const prepared = prepareRun({ place: scenario.place, bathymetry, series, tide: tideAt(scenario.place, sel.tide), seconds: sel.minutes * 60, frames: 120 });
    status('Running the model in a Rust / WebAssembly worker…');
    run = runInWorker(prepared, { onProgress: (p) => { if (p.stage === 'local' || p.fraction != null) { $('tsProgress').value = p.fraction || 0; status(`Running the model: ${Math.round((p.fraction || 0) * 100)}% (${clock(p.seconds || 0)} of ${clock(prepared.seconds)} simulated)`); } } });
    const result = await run.promise; run = null;
    const derived = deriveRun(prepared, result.frames, { summarise: floodSummary, waveAt: result.coupling?.arrival ?? 0 });
    // only the last frame's whole-run arrays are needed now; drop the rest to keep a few runs in memory
    result.frames.forEach((f, k) => { if (k < result.frames.length - 1) { delete f.peak; delete f.speed; } });
    return { key: id, place: scenario.place, scenario, tide: sel.tide, prepared, result, derived, bathymetry };
  }

  async function start() {
    await ensureLoaded();
    const scenario = current();
    if (!scenario) return null;
    await ensureTides(scenario.place);
    setPlaying(false); if (run) run.cancel();
    const id = key(scenario);
    info.state = 'running'; info.place = scenario.place; info.scenario = scenario.id; info.tide = sel.tide; info.error = null; info.cached = cache.has(id);
    onRunStart();
    busy(true); remember();
    $('tsBarTitle').textContent = `${scenarioBanner(scenario)}`;
    try {
      let entry = cache.get(id);
      if (entry) { cache.delete(id); } else {
        barMode('running'); $('tsProgress').removeAttribute('value'); status('Loading the terrain and the wave…');
        entry = await compute(scenario, id);
      }
      cache.set(id, entry);
      while (cache.size > CACHE_RUNS) cache.delete(cache.keys().next().value);
      display(entry);
      info.final = entry.derived.summaries.at(-1);
      return info.final;
    } catch (error) {
      if (error.message === 'cancelled') return null;
      info.state = 'error'; info.error = String(error.message || error); status(`The run failed (${info.error}).`); barMode('running'); $('tsProgress').hidden = true;
      return null;
    } finally { busy(false); refreshCards(); }
  }
  function scenarioBanner(scenario) {
    const step = TIDE_STEPS.find(([, s]) => s === sel.tide);
    return `Scenario: ${scenario.label} · ${step ? step[0].toLowerCase() : sel.tide} tide · not a forecast`;
  }
  function display(entry) {
    active = entry; const { bathymetry, result } = entry;
    const bounds = live.show(bathymetry);
    if (!map.hasLayer(live)) live.addTo(map);
    barMode('ready');
    $('tsScrub').max = result.frames.length - 1;
    info.state = 'ready'; info.frames = result.frames.length;
    const phone = window.matchMedia('(max-width: 760px)').matches;
    map.closePopup();
    map.fitBounds(bounds, phone ? { paddingTopLeft: [16, 16], paddingBottomRight: [16, 190], maxZoom: 14, animate: false } : { paddingTopLeft: [40, 110], paddingBottomRight: [40, 40], maxZoom: 14, animate: false });
    $('tsClear').hidden = false;
    view = 'now'; info.view = 'now'; setView('now');
    index = 0; clockSeconds = 0; show(0);
    setPlaying(true); status('Playing the run over the map. Drag the time bar to look at any moment.');
  }
  function clear() {
    setPlaying(false); if (run) run.cancel();
    live.clear(); if (map.hasLayer(live)) map.removeLayer(live);
    active = null; $('tsBar').hidden = true; $('tsClear').hidden = true; info.state = 'idle'; info.frames = 0; map.closePopup(); onLegend(); refreshCards();
    status('Pick a place on the map, then a scenario.');
  }

  // A tap on the map inside the place being shown: say when the water arrives and how deep it gets there. Returns true when it handled the tap.
  function handleTap(latlng) {
    if (!active || !map.hasLayer(live)) return false;
    const { bathymetry, prepared, derived } = active, i = cellIndex(bathymetry, latlng.lat, latlng.lng);
    if (i < 0) return false;
    let text;
    if (prepared.land[i]) {
      const depth = derived.peak[i], arrival = derived.arrival[i];
      text = Number.isNaN(arrival)
        ? (depth > 0.02 ? `Under water to about ${depth.toFixed(1)} m from the tide, but the wave adds little here in this run.` : 'Stays dry in this run.')
        : `Water arrives about ${minutesText(arrival)} after the wave reaches the model’s edge (${ARRIVAL_TEXT[arrivalClass(arrival)]}), and peaks at ${depth.toFixed(1)} m about ${minutesText(derived.peakAt[i])} into the run.`;
    } else text = derived.peak[i] > 0.03 ? `At sea: the highest wave is ${derived.peak[i].toFixed(1)} m above the tide here.` : 'At sea: little wave here.';
    L.popup({ className: 'ts-popup', maxWidth: 260 }).setLatLng(latlng).setContent(`<div class="ts-tap">${text}<p class="hint">Modelled, experimental. ${active.scenario.label}, ${info.tide} tide.</p></div>`).openOn(map);
    return true;
  }

  // ---- the side panel ----
  function wirePanel() {
    $('tsPlace').addEventListener('change', () => { pick({ place: $('tsPlace').value }); ensureTides(sel.place).then(fillTide); });
    $('tsScenario').addEventListener('change', () => pick({ scenario: $('tsScenario').value }));
    $('tsTide').addEventListener('change', () => { pick({ tide: $('tsTide').value }); remember(); });
    $('tsDuration').addEventListener('change', () => { sel.minutes = Number($('tsDuration').value); });
    $('tsRun').addEventListener('click', start);
    for (const [id, layer] of [['tsHazardOn', layers.hazard], ['tsExtentsOn', layers.extents]]) {
      if (!layer || !$(id)) continue;
      $(id).checked = map.hasLayer(layer);
      $(id).addEventListener('change', () => {
        layer.userOn = $(id).checked;
        if ($(id).checked) layer.addTo(map); else if (map.hasLayer(layer)) map.removeLayer(layer);
        onLayerChange();
      });
      map.on('layeradd layerremove', () => { $(id).checked = map.hasLayer(layer); });
    }
    if (layers.hazard && $('tsHazardPick')) $('tsHazardPick').appendChild(layers.hazard.periodPicker());
    if (layers.extents && $('tsExtentsPick')) $('tsExtentsPick').appendChild(layers.extents.depthPicker());
    const list = $('tsPlaces');
    if (list) {
      list.innerHTML = places.map((p) => `<button type="button" class="btn" data-place="${p}">${shortName(p)}</button>`).join('');
      list.addEventListener('click', (event) => {
        const b = event.target.closest('[data-place]');
        if (b) { ensureLoaded(); openCard(b.dataset.place); onRunStart(); }
      });
    }
  }
  wirePanel();
  $('tsClear').addEventListener('click', clear);
  $('tsBarClose').addEventListener('click', clear);
  $('tsPlay').addEventListener('click', () => { if (!active) return; if (view !== 'now') setView('now'); if (!playing && index >= active.result.frames.length - 1) { clockSeconds = 0; show(0); } setPlaying(!playing); });
  $('tsScrub').addEventListener('input', () => { if (!active) return; setPlaying(false); if (view !== 'now') setView('now'); show(Number($('tsScrub').value)); });
  $('tsViews').addEventListener('click', (event) => { const b = event.target.closest('[data-view]'); if (b && active) setView(b.dataset.view); });
  makePins();

  return {
    info, layer: live, ensureLoaded, handleTap, openCard,
    // the run's key is in the bar, so the page's own Key card leaves it out
    legendParts: () => [],
    // for tests: run a scenario by label and tide state, and give back the final summary
    async runWith({ place, label, tide = 'MSL', minutes = 60 }) {
      await ensureLoaded();
      if (place) pick({ place });
      await ensureTides(sel.place);
      const match = scenarios.find((s) => s.place === sel.place && new RegExp(label || '.').test(s.label));
      if (!match) throw new Error('No such scenario');
      pick({ scenario: match.id, tide }); sel.minutes = minutes;
      if ($('tsDuration')) $('tsDuration').value = String(minutes);
      return start();
    },
  };
}
