// Running a local model to completion, and a bounded sensitivity ensemble
// around it. Pure functions over a FloodCore-like object `F`, shared by the
// worker and the tests.
//
// An ensemble here is a deliberate, small set of runs: a baseline, each uncertain
// input pushed low and high on its own, and two combined cases (all inputs
// pushed towards more flooding, and towards less). It brackets the model's
// response to those inputs. It is not a sample from probability distributions,
// so its ranges are not confidence intervals or hazard probabilities.
const EDGE_CODES = { north: 0, east: 1, south: 2, west: 3 }, EDGE_NAMES = ['north', 'east', 'south', 'west'];

/* Start a run. The grid is the local model's; `data.coupling`, when there is one, says how its open edges are driven, and everything that follows is Rust (see
 * rust/flood-core/src/coupling.rs and nest.rs): a regional offshore run recorded at handover points (`parentGrid`, `bounds`, `extent`, `zone`, `source`, optionally `seconds`
 * and a `cacheKey` so runs that differ only in local settings share one regional run), a supplied `series`, or two-way nesting (`twoWay: { strength }`), with an optional
 * rising `tide` over `localSeconds`. `seaEdges` are the local scene's open-sea edge names. `data.land` (1 where the ground is dry at mean sea level) lets the solver report what a
 * run has flooded and its extremes (see tsunamiStep). Returns what the page shows about the coupling, or null, and how many steps to take at once. */
export function startRun(F, data, report = () => {}) {
  const c = data.coupling, withLand = (g) => ({ ...g, ...(data.land && { land: data.land }), ...(data.probes && { probes: Float64Array.from(data.probes), probeThreshold: data.probeThreshold }) });
  if (!c) { F.tsunamiStart(withLand(data.grid)); return { coupling: null, batch: data.grid.method === 3 ? 16 : 200 }; }
  const sea = Float64Array.from((c.seaEdges || []).map(name => EDGE_CODES[name]));
  const parent = c.parentGrid && { nestW: c.parentGrid.W, nestH: c.parentGrid.H, nestCell: c.parentGrid.cell, nestDepth: c.parentGrid.depth, nestEta: c.parentGrid.eta, nestAbsorbing: c.parentGrid.absorbing ? 1 : 0, nestMethod: c.parentGrid.method, nestBounds: Float64Array.from(c.bounds), nestExtent: Float64Array.from(c.extent), nestZone: c.zone ?? 56 };
  let mode;
  if (c.series) mode = { couple: 2, seriesTimes: c.series.times, seriesValues: c.series.values };
  else if (c.twoWay) mode = { nest: 1, ...parent, nestStrength: c.twoWay.strength ?? 0.25 };
  else mode = { couple: 1, ...parent, coupleSource: Float64Array.from(c.source), ...(c.seconds && { coupleSeconds: c.seconds }), ...(c.cacheKey && { cacheKey: new TextEncoder().encode(c.cacheKey) }) };
  if (!c.series) report({ stage: 'regional' });
  const started = F.tsunamiStart(withLand({ ...data.grid, ...mode, nestEdges: sea, coupleLocalSeconds: c.localSeconds, tideRange: c.tide || 0 }));
  const tide = c.tide || 0;
  if (c.twoWay && !c.series) {
    const n = started.nest;
    return { coupling: { source: 'regional-two-way', arrival: n.offset, offset: n.offset, peak: null, edges: {}, regionalPeak: null, handovers: n.handovers, snapped: n.snapped, strength: c.twoWay.strength ?? 0.25, tide }, batch: 200 };
  }
  const k = started.coupled, edges = Object.fromEntries(k.edgeCodes.map((code, i) => [EDGE_NAMES[code], { points: k.edgePoints[i], peak: k.edgePeak[i], snapped: k.edgeSnapped[i] }]));
  const coupling = c.series
    ? { source: 'series', arrival: k.arrival, offset: 0, peak: k.peak, edges, rows: k.rows, tide }
    : { source: 'regional', arrival: k.arrival, offset: k.offset, peak: k.peak, edges, regionalSeconds: k.regionalSeconds, regionalPeak: k.regionalPeak, regionalCached: k.regionalCached, tide };
  return { coupling, batch: data.grid.method === 3 ? 16 : 200 };
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

// Run one member to `seconds` and measure it. `probes` are gauge cell indices. Arrival is the first time (kept by the solver every step) a gauge differs from its initial
// level by more than `threshold`; the speed is the fastest any cell reached in any step. The flooded area and depth are over the ground that is dry at the member's starting
// level, as the solver's own summary counts them.
export function runMember(F, member, { seconds, probes, threshold = .05, step = 20, onProgress = () => {} }) {
  const { depth, valid } = member.grid;
  const land = Uint8Array.from(depth, (d, i) => (d === 0 && valid?.[i] !== 0 ? 1 : 0));
  startRun(F, { ...member, land, probes, probeThreshold: threshold }, report => onProgress({ ...report, fraction: 0 }));
  let frame = F.tsunamiStep(0);
  while (frame.time < seconds) {
    frame = F.tsunamiStep(Math.max(1, Math.min(step, Math.ceil((seconds - frame.time) / frame.dt))));
    onProgress({ stage: 'local', fraction: Math.min(1, frame.time / seconds), seconds: frame.time });
  }
  const end = F.tsunamiStep(0, true);
  return {
    arrival: probes.map((_, k) => (end.probeArrival[k] >= 0 ? end.probeArrival[k] : null)), gaugePeak: probes.map(index => end.peak[index]), landDepth: end.summary.maxLandDepth,
    floodedHectares: end.summary.floodedHectares, maxSpeed: end.maxSpeed, volumeError: end.volumeError, simulated: end.time,
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
