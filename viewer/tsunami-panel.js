/* The "Tsunami run" panel of the main map: pick a modelled place, one of its curated PTHA18 earthquake scenarios and a tide state, run it in the
 * lab's Rust/WebAssembly worker and play the frames over the map. The DOM ids are in index.html (panel-tsunami). Nothing is fetched until the
 * panel is first opened. */
import { estuaryLocations } from './tsunami-locations.js';
import { TIDE_STATION, tideLevels, loadScenarios, loadPlace, loadSeries, prepareRun, runInWorker, floodSummary } from './tsunami-session.js';
import { makeLiveLayer, legendParts } from './tsunami-live.js';

const clock = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const ha = (value) => value < 0.05 ? 'none' : `${value.toFixed(value < 10 ? 1 : 0)} ha`;
const rateText = (rate) => { if (!(rate > 0)) return 'unknown'; const years = 1 / rate; return years >= 1e6 ? `about 1 in ${(years / 1e6).toFixed(1)} million years` : `about 1 in ${Math.round(years).toLocaleString('en-AU')} years`; };

export function initTsunamiPanel({ L, map, canvasOverlay, baseUrl, onLegend = () => {}, doc = document }) {
  const $ = (id) => doc.getElementById(id);
  const live = makeLiveLayer(L, { canvasOverlay });
  const info = { state: 'idle', place: null, scenario: null, tide: 'MSL', error: null, frames: 0, summary: null };
  let scenarios = null, loading = null, planes = new Map(), terrain = new Map(), run = null, result = null, prepared = null;
  let playing = false, index = 0, clockSeconds = 0, last = 0, raf = 0;

  const placeName = (id) => (estuaryLocations.find((l) => l.id === id)?.name || id).replace(/ · terrain test$/, '');
  const current = () => scenarios.find((s) => s.place === $('tsPlace').value && s.id === $('tsScenario').value);
  const status = (text) => { $('tsStatus').textContent = text; };
  const busy = (on) => { for (const id of ['tsPlace', 'tsScenario', 'tsTide', 'tsDuration', 'tsRun']) $(id).disabled = on; };

  async function ensureLoaded() {
    if (scenarios || loading) return loading;
    info.state = 'loading';
    loading = loadScenarios(baseUrl).then((all) => {
      scenarios = all;
      const places = [...new Set(all.map((s) => s.place))];
      $('tsPlace').innerHTML = places.map((p) => `<option value="${p}">${placeName(p)}</option>`).join('');
      fillScenarios(); fillTide();
      info.state = 'idle'; status('Choose a scenario and press Run. A run takes a few seconds.');
    }).catch((error) => { loading = null; info.state = 'error'; info.error = String(error.message || error); status(`Could not load the scenarios (${info.error}).`); });
    return loading;
  }

  function fillScenarios() {
    const list = scenarios.filter((s) => s.place === $('tsPlace').value);
    $('tsScenario').innerHTML = list.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
    describe();
  }
  function describe() {
    const s = current();
    $('tsScenarioNote').textContent = s ? `Magnitude ${s.mw} earthquake, ${s.zone.replace(/\d+$/, '')} source zone (PTHA18 scenario ${s.row}). Its wave is ${s.offshorePeakM.toFixed(2)} m high at a point ${s.depthM} m deep offshore. The earthquake itself has an annual rate of ${s.annualRate.toExponential(1)} (${rateText(s.annualRate)}): that is how rare the earthquake is, not how often this wave size happens.` : '';
  }
  async function fillTide() {
    const station = TIDE_STATION[$('tsPlace').value];
    try {
      if (!planes.has(station)) { const r = await fetch(new URL(`tsunami-data/${station}-tidal-planes.json`, baseUrl).href); if (!r.ok) throw new Error(`HTTP ${r.status}`); planes.set(station, tideLevels(await r.json())); }
      const levels = planes.get(station), keep = $('tsTide').value || 'MSL';
      $('tsTide').innerHTML = levels.map((l) => `<option value="${l.state}">${l.state} (${l.aboveMsl >= 0 ? '+' : ''}${l.aboveMsl.toFixed(2)} m)</option>`).join('');
      $('tsTide').value = levels.some((l) => l.state === keep) ? keep : 'MSL';
      $('tsTideNote').textContent = 'Height above mean sea level, held for the whole run. Mean sea level is taken as the terrain’s zero.';
    } catch (error) {
      $('tsTide').innerHTML = '<option value="MSL">Mean sea level</option>';
      $('tsTideNote').textContent = `The tide levels could not be loaded (${error.message}); the run starts at mean sea level.`;
    }
  }
  const tideLevel = () => (planes.get(TIDE_STATION[$('tsPlace').value]) || []).find((l) => l.state === $('tsTide').value)?.aboveMsl || 0;

  // ---- playback ----
  function show(i) {
    index = Math.max(0, Math.min(result.frames.length - 1, i));
    const frame = result.frames[index];
    live.paint(frame, prepared.land);
    const summary = floodSummary(prepared, frame);
    clockSeconds = frame.time;
    $('tsScrub').value = index; $('tsClock').textContent = `${clock(frame.time)} of ${clock(prepared.seconds)}`;
    $('tsNow').textContent = ha(summary.floodedNowHectares); $('tsMax').textContent = ha(summary.floodedHectares);
    $('tsDepth').textContent = summary.maxLandDepth > 0.01 ? `${summary.maxLandDepth.toFixed(2)} m` : 'none';
    info.summary = summary; info.frameIndex = index;
    if (index >= result.frames.length - 1) { setPlaying(false); status(`Run complete: the wave floods up to ${ha(summary.floodedHectares)} of land, as deep as ${summary.maxLandDepth.toFixed(2)} m (the ground dry at mean sea level; the tide's own cover counts).`); }
  }
  function setPlaying(on) {
    playing = on; $('tsPlay').textContent = on ? 'Pause' : (result && index >= result.frames.length - 1 ? 'Replay' : 'Play');
    if (on) { last = performance.now(); raf = requestAnimationFrame(tick); } else cancelAnimationFrame(raf);
  }
  function tick(now) {
    if (!playing) return;
    clockSeconds += Math.min(0.1, (now - last) / 1000) * Number($('tsSpeed').value) * 60; last = now;
    const next = Math.min(result.frames.length - 1, Math.floor(clockSeconds / result.interval + 1e-9));
    if (next !== index) show(next);
    if (playing) raf = requestAnimationFrame(tick);
  }

  // ---- running ----
  async function start() {
    await ensureLoaded();
    const scenario = current();
    if (!scenario) return null;
    setPlaying(false); if (run) run.cancel();
    busy(true); info.state = 'running'; info.place = scenario.place; info.scenario = scenario.id; info.tide = $('tsTide').value; info.error = null;
    $('tsProgress').hidden = false; $('tsProgress').removeAttribute('value'); status('Loading the terrain and the wave…');
    try {
      if (!terrain.has(scenario.place)) terrain.set(scenario.place, await loadPlace(baseUrl, scenario.place));
      const bathymetry = terrain.get(scenario.place), series = await loadSeries(baseUrl, scenario);
      prepared = prepareRun({ place: scenario.place, bathymetry, series, tide: tideLevel(), seconds: Number($('tsDuration').value) * 60, frames: 120 });
      status('Running the model in a Rust / WebAssembly worker…');
      run = runInWorker(prepared, { onProgress: (p) => { if (p.stage === 'local' || p.fraction != null) { $('tsProgress').value = p.fraction || 0; status(`Running the model: ${Math.round((p.fraction || 0) * 100)}% (${clock(p.seconds || 0)} of ${clock(prepared.seconds)} simulated)`); } } });
      result = await run.promise; run = null;
      const bounds = live.show(bathymetry);
      if (!map.hasLayer(live)) live.addTo(map);
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14, animate: false });
      $('tsPlayback').hidden = false; $('tsClear').hidden = false; $('tsScrub').max = result.frames.length - 1;
      info.state = 'ready'; info.frames = result.frames.length;
      onLegend();
      index = 0; clockSeconds = 0; show(0);
      info.final = floodSummary(prepared, result.frames.at(-1));
      setPlaying(true); status('Playing the run over the map. Drag the time bar to look at any moment.');
      return info.final;
    } catch (error) {
      if (error.message === 'cancelled') return null;
      info.state = 'error'; info.error = String(error.message || error); status(`The run failed (${info.error}).`);
      return null;
    } finally { $('tsProgress').hidden = true; busy(false); }
  }
  function clear() {
    setPlaying(false); if (run) run.cancel();
    live.clear(); if (map.hasLayer(live)) map.removeLayer(live);
    result = null; $('tsPlayback').hidden = true; $('tsClear').hidden = true; info.state = 'idle'; info.frames = 0; onLegend();
    status('Choose a scenario and press Run.');
  }

  $('tsPlace').addEventListener('change', () => { fillScenarios(); fillTide(); });
  $('tsScenario').addEventListener('change', describe);
  $('tsRun').addEventListener('click', start);
  $('tsClear').addEventListener('click', clear);
  $('tsPlay').addEventListener('click', () => { if (!result) return; if (!playing && index >= result.frames.length - 1) { clockSeconds = 0; show(0); } setPlaying(!playing); });
  $('tsScrub').addEventListener('input', () => { if (!result) return; setPlaying(false); show(Number($('tsScrub').value)); });

  return {
    info, layer: live, ensureLoaded,
    legendParts: () => (result && map.hasLayer(live) ? legendParts() : []),
    // for tests: run a scenario by label and tide state, and give back the final summary
    async runWith({ place, label, tide = 'MSL', minutes = 60 }) {
      await ensureLoaded();
      if (place) { $('tsPlace').value = place; fillScenarios(); await fillTide(); }
      const match = scenarios.find((s) => s.place === $('tsPlace').value && new RegExp(label || '.').test(s.label));
      if (!match) throw new Error('No such scenario');
      $('tsScenario').value = match.id; describe(); $('tsTide').value = tide; $('tsDuration').value = String(minutes);
      return start();
    },
  };
}
