/* Running the tsunami model live for the main map: load a curated PTHA18 scenario, prepare the local grid and its forcing, and run
 * it to completion in the lab's Rust/WASM worker (tsunami-worker.js), keeping evenly spaced frames to play back. DOM-free so tests can
 * prepare a run and start it on the same FloodCore the worker uses. */
import { tsunamiGrid } from './tsunami-grid.js';
import { parseSeriesCsv } from './tsunami-coupling.js';
import { startRun } from './tsunami-runner.js';

// Which tide gauge's planes describe each modelled place (the gauge files are in tsunami-data/).
export const TIDE_STATION = { 'gold-coast-seaway': 'gold-coast-seaway', currumbin: 'gold-coast-seaway', 'pine-estuary': 'brisbane-bar', 'brisbane-mouth': 'brisbane-bar' };
export const TIDE_STATES = ['LAT', 'MLWS', 'MLWN', 'MSL', 'MHWN', 'MHWS', 'HAT'];

// The model starts no lower than this (m above the terrain's zero); a lower tide state, such as Brisbane Bar's LAT, is run here instead.
export const MIN_TIDE = -1;
export const modelTide = (aboveMsl) => Math.max(MIN_TIDE, aboveMsl);

// Tide state levels above MSL (m) from a tidal-planes file, in the order of TIDE_STATES.
export function tideLevels(planesFile) {
  const planes = planesFile?.planes;
  if (!planes || !TIDE_STATES.every(name => Number.isFinite(planes[name]))) throw new Error('The tidal planes are incomplete.');
  return TIDE_STATES.map(state => ({ state, aboveMsl: +(planes[state] - planes.MSL).toFixed(3) }));
}

const json = async (url, what) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${what}: HTTP ${response.status}`);
  return response.json();
};

// Every scenario the map can run: [{ ...scenario, place, manifest }] for each place a manifest lists, from tsunami-data/scenarios/index.json.
export async function loadScenarios(baseUrl) {
  const index = await json(new URL('tsunami-data/scenarios/index.json', baseUrl).href, 'Scenario list');
  const out = [];
  for (const file of index.manifests) {
    const manifest = await json(new URL(`tsunami-data/scenarios/${file}`, baseUrl).href, 'Scenario manifest');
    for (const place of manifest.places) for (const scenario of manifest.scenarios) out.push({ ...scenario, place, gaugeID: manifest.gaugeID, depthM: manifest.depthM, source: manifest.source });
  }
  return out;
}

export async function loadPlace(baseUrl, id) { return json(new URL(`tsunami-data/${id}.json`, baseUrl).href, 'Terrain'); }
export async function loadSeries(baseUrl, scenario) {
  const response = await fetch(new URL(`tsunami-data/scenarios/${scenario.file}`, baseUrl).href);
  if (!response.ok) throw new Error(`Wave series: HTTP ${response.status}`);
  return parseSeriesCsv(await response.text());
}

/* Everything the worker needs, plus the dry-land mask. `tide` is the sea level to start at (m above MSL, which is taken as the terrain's
 * zero), `seconds` the run length and `frames` how many evenly spaced frames to keep. */
export function prepareRun({ place, bathymetry, series, tide = 0, roughness = 0.025, seconds = 3600, frames = 120 }) {
  if (!(seconds >= 300 && seconds <= 7200)) throw new Error('A run is 5 minutes to 2 hours.');
  if (!(tide >= -1 && tide <= 2)) throw new Error('The sea level is between -1 and 2 m.');
  const options = { preset: place, bathymetry, amplitude: 0, absorbing: true, width: 0.45, coupled: true, roughness };
  const grid = tsunamiGrid({ ...options, tide }), dry = tide === 0 ? grid : tsunamiGrid({ ...options, tide: 0 });
  const land = Uint8Array.from(dry.depth, d => d === 0 ? 1 : 0);
  return {
    grid, land, seconds, frames, place, tide,
    coupling: { series, seaEdges: bathymetry.seaEdges, localSeconds: seconds, tide: 0 },
  };
}

/* Run in the lab's worker. Returns { promise, cancel }; the promise resolves to { frames, interval, coupling, extremes }. Each frame carries `summary` (what the run has flooded so far:
 * floodedHectares, maxLandDepth, floodedNowHectares), and `extremes` is what the run saw at its worst, kept by the solver every step: peakValue (deepest water on land, highest wave at sea),
 * peakTime, peakSpeed, peakClass and arrival (seconds from the wave reaching the model's edge until 10 cm of water, -1 where it never came).
 * `onProgress({ fraction, seconds })` is called while it runs. */
export function runInWorker(prepared, { onProgress = () => {}, createWorker = () => new Worker(new URL('./tsunami-worker.js', import.meta.url), { type: 'module' }) } = {}) {
  const worker = createWorker();
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
    worker.onerror = () => { worker.terminate(); reject(new Error('The wave worker could not start.')); };
    worker.onmessage = ({ data }) => {
      if (data.error) { worker.terminate(); reject(new Error(data.error)); return; }
      if (data.progress) { onProgress(data.progress); return; }
      if (data.frames) { worker.terminate(); resolve({ frames: data.frames, interval: data.interval, coupling: data.coupling, extremes: data.extremes }); }
    };
  });
  worker.postMessage({ type: 'precompute', grid: prepared.grid, coupling: prepared.coupling, land: prepared.land, seconds: prepared.seconds, frames: prepared.frames });
  return { promise, cancel: () => { worker.terminate(); settle.reject(new Error('cancelled')); } };
}

// The same run on a FloodCore-like `F` in this thread (tests, scripts): frames kept at the same spacing as the worker's.
export function runHere(F, prepared) {
  startRun(F, prepared);
  const frames = [F.tsunamiStep(0)], interval = prepared.seconds / prepared.frames;
  let current = frames[0], next = interval;
  while (current.time < prepared.seconds) {
    const steps = Math.max(1, Math.min(200, Math.ceil((Math.min(next, prepared.seconds) - current.time) / current.dt)));
    current = F.tsunamiStep(steps);
    if (current.time >= Math.min(next, prepared.seconds) - 1e-9) { frames.push(current); while (next <= current.time) next += interval; }
  }
  if (frames.at(-1) !== current) frames.push(current);
  const { peakValue, peakTime, peakSpeed, peakClass, arrival } = F.tsunamiStep(0, true);
  return { frames, interval, extremes: { peakValue, peakTime, peakSpeed, peakClass, arrival } };
}
