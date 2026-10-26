// Running a local model to completion, and a bounded sensitivity ensemble
// around it. Pure functions over a FloodCore-like object `F`, shared by the
// worker and the tests.
//
// An ensemble here is a deliberate, small set of runs: a baseline, each uncertain
// input pushed low and high on its own, and two combined cases (all inputs
// pushed towards more flooding, and towards less). It brackets the model's
// response to those inputs. It is not a sample from probability distributions,
// so its ranges are not confidence intervals or hazard probabilities.
import { forcingFromRecording, forcingFromSeries, levelSeries } from './tsunami-coupling.js';

// Start a run, first computing any nested forcing. `cache` keeps regional
// recordings so members that differ only in local settings share one regional
// run. Returns what the page shows about the coupling, or null.
export function startRun(F, data, report = () => {}, cache = new Map()) {
  let grid = data.grid, coupling = null;
  if (data.coupling) {
    const { plan, parentGrid, seconds, localSeconds, series, scene, tide, cacheKey } = data.coupling;
    let forcing;
    if (series) {
      // A supplied wave series replaces the regional model.
      forcing = forcingFromSeries(scene, series, { maxLocalSeconds: localSeconds });
      coupling = { source: 'series', arrival: forcing.arrival, offset: 0, peak: forcing.peak, edges: forcing.edges, rows: series.times.length };
    } else {
      // Regional run first (about a second), then the local model starts
      // with its recorded wave as boundary forcing.
      report({ stage: 'regional' });
      let recording = cacheKey && cache.get(cacheKey);
      if (!recording) {
        recording = F.tsunamiParent(parentGrid, plan.points, seconds);
        if (cacheKey) cache.set(cacheKey, recording);
      }
      forcing = forcingFromRecording(plan, recording, { maxLocalSeconds: localSeconds });
      coupling = { source: 'regional', arrival: forcing.arrival, offset: forcing.offset, peak: forcing.peak, edges: forcing.edges, regionalSeconds: seconds, regionalPeak: Math.max(...recording.peak) };
    }
    grid = { ...grid, ...Object.fromEntries(Object.entries(forcing).filter(([key]) => key.startsWith('force'))), ...levelSeries(localSeconds, tide) };
    coupling.tide = tide || 0;
  }
  F.tsunamiStart(grid);
  return { coupling, batch: grid.method === 3 ? 16 : 200 };
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// The runs of an ensemble. `base` holds the current settings; `spread` how far
// each is pushed. Terrain is a uniform vertical shift of the bed in metres
// (negative lowers the ground, which floods more). Duplicates caused by
// clamping are dropped.
export function ensemblePlan(base, spread = {}, { terrain = true, amplitude = true } = {}) {
  const { amplitudePercent = 50, tideMetres = .5, roughnessPercent = 50, terrainMetres = .5 } = spread;
  const mid = { amplitude: base.amplitude, tide: base.tide, roughness: base.roughness, terrain: 0 };
  const range = {
    amplitude: amplitude ? [clamp(base.amplitude * (1 - amplitudePercent / 100), .05, 3), clamp(base.amplitude * (1 + amplitudePercent / 100), .05, 3)] : [base.amplitude, base.amplitude],
    tide: [clamp(base.tide - tideMetres, -1, 2), clamp(base.tide + tideMetres, -1, 2)],
    roughness: [clamp(base.roughness * (1 - roughnessPercent / 100), 0, .2), clamp(base.roughness * (1 + roughnessPercent / 100), 0, .2)],
    terrain: terrain ? [-terrainMetres, terrainMetres] : [0, 0],
  };
  const members = [{ id: 'base', label: 'Baseline', group: 'base', factors: mid }];
  const seen = new Set([JSON.stringify(mid)]);
  const add = (id, label, group, change) => {
    const factors = { ...mid, ...change }, key = JSON.stringify(factors);
    if (seen.has(key)) return;
    seen.add(key);
    members.push({ id, label, group, factors });
  };
  const text = {
    amplitude: v => `Source strength ${v.toFixed(2)} m`,
    tide: v => `Initial sea level ${v.toFixed(2)} m`,
    roughness: v => `Manning n ${v.toFixed(3)}`,
    terrain: v => `Terrain ${v > 0 ? '+' : ''}${v.toFixed(2)} m`,
  };
  for (const key of ['amplitude', 'tide', 'roughness', 'terrain']) {
    add(`${key}-low`, `${text[key](range[key][0])}`, key, { [key]: range[key][0] });
    add(`${key}-high`, `${text[key](range[key][1])}`, key, { [key]: range[key][1] });
  }
  // Inputs together: towards more flooding (stronger source, higher sea,
  // smoother ground, lower terrain) and towards less.
  add('severe', 'All towards more flooding', 'combined', { amplitude: range.amplitude[1], tide: range.tide[1], roughness: range.roughness[0], terrain: range.terrain[0] });
  add('mild', 'All towards less flooding', 'combined', { amplitude: range.amplitude[0], tide: range.tide[0], roughness: range.roughness[1], terrain: range.terrain[1] });
  return members;
}

// Run one member to `seconds` and measure it. `probes` are gauge cell indices.
// Arrival is the first time (to the sampling step) a gauge differs from its
// initial level by more than `threshold`; the current speed is likewise
// sampled at the end of each step batch, so it is a lower bound on the
// instantaneous maximum.
export function runMember(F, member, { seconds, probes, threshold = .05, step = 20, cache, onProgress = () => {} }) {
  startRun(F, member, report => onProgress({ ...report, fraction: 0 }), cache);
  const { depth, valid } = member.grid;
  let frame = F.tsunamiStep(0);
  const arrival = probes.map(() => null);
  let maxSpeed = 0;
  while (frame.time < seconds) {
    frame = F.tsunamiStep(Math.max(1, Math.min(step, Math.ceil((seconds - frame.time) / frame.dt))));
    probes.forEach((index, k) => { if (arrival[k] == null && Math.abs(frame.eta[index]) > threshold) arrival[k] = frame.time; });
    for (const v of frame.speed) if (v > maxSpeed) maxSpeed = v;
    onProgress({ stage: 'local', fraction: Math.min(1, frame.time / seconds), seconds: frame.time });
  }
  let landDepth = 0, flooded = 0;
  for (let i = 0; i < depth.length; i++) {
    if (depth[i] !== 0 || valid?.[i] === 0) continue;
    if (frame.peak[i] > landDepth) landDepth = frame.peak[i];
    if (frame.peak[i] > .01) flooded++;
  }
  return {
    arrival, gaugePeak: probes.map(index => frame.peak[index]), landDepth,
    floodedHectares: flooded * member.grid.cell ** 2 / 10000, maxSpeed, volumeError: frame.volumeError, simulated: frame.time,
  };
}

// Minimum and maximum of each measure over all members (null arrivals are
// counted separately: that gauge was not reached in that run).
export function summarise(results) {
  const span = values => {
    const finite = values.filter(v => Number.isFinite(v));
    return { min: finite.length ? Math.min(...finite) : null, max: finite.length ? Math.max(...finite) : null, missing: values.length - finite.length };
  };
  const gauges = results[0]?.arrival.length ?? 0;
  return {
    arrival: Array.from({ length: gauges }, (_, k) => span(results.map(r => r.arrival[k]))),
    gaugePeak: Array.from({ length: gauges }, (_, k) => span(results.map(r => r.gaugePeak[k]))),
    landDepth: span(results.map(r => r.landDepth)),
    floodedHectares: span(results.map(r => r.floodedHectares)),
    maxSpeed: span(results.map(r => r.maxSpeed)),
  };
}
