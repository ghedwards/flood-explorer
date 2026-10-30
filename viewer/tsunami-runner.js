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
 * and a `cacheKey` so runs that differ only in local settings share one regional run), a supplied `series`, or two-way nesting (`twoWay: { strength, intermediate: { cell, margin } }`, the second to go through an intermediate grid of `cell` metres reaching `margin` metres beyond the local scene), with an optional
 * rising `tide` over `localSeconds`. `seaEdges` are the local scene's open-sea edge names. `data.land` (1 where the ground is dry at mean sea level) lets the solver report what a
 * run has flooded and its extremes (see tsunamiStep). Returns what the page shows about the coupling, or null, and how many steps to take at once. */
export function startRun(F, data, report = () => {}) {
  const c = data.coupling, withLand = (g) => ({ ...g, ...(data.land && { land: data.land }), ...(data.probes && { probes: Float64Array.from(data.probes), probeThreshold: data.probeThreshold }) });
  if (!c) { F.tsunamiStart(withLand(data.grid)); return { coupling: null, batch: data.grid.method === 3 ? 16 : 200 }; }
  const sea = Float64Array.from((c.seaEdges || []).map(name => EDGE_CODES[name]));
  const parent = c.parentGrid && { nestW: c.parentGrid.W, nestH: c.parentGrid.H, nestCell: c.parentGrid.cell, nestDepth: c.parentGrid.depth, nestEta: c.parentGrid.eta, nestAbsorbing: c.parentGrid.absorbing ? 1 : 0, nestMethod: c.parentGrid.method, nestBounds: Float64Array.from(c.bounds), nestExtent: Float64Array.from(c.extent), nestZone: c.zone ?? 56 };
  let mode;
  if (c.series) mode = { couple: 2, seriesTimes: c.series.times, seriesValues: c.series.values };
  else if (c.twoWay) mode = { nest: c.twoWay.intermediate ? 2 : 1, ...parent, nestStrength: c.twoWay.strength ?? 0.25, ...(c.twoWay.intermediate && { midCell: c.twoWay.intermediate.cell, midMargin: c.twoWay.intermediate.margin }) };
  else mode = { couple: 1, ...parent, coupleSource: Float64Array.from(c.source), ...(c.seconds && { coupleSeconds: c.seconds }), ...(c.cacheKey && { cacheKey: new TextEncoder().encode(c.cacheKey) }) };
  if (!c.series) report({ stage: 'regional' });
  const started = F.tsunamiStart(withLand({ ...data.grid, ...mode, nestEdges: sea, coupleLocalSeconds: c.localSeconds, tideRange: c.tide || 0 }));
  const tide = c.tide || 0;
  if (c.twoWay && !c.series) {
    const n = started.nest;
    return { coupling: { source: 'regional-two-way', arrival: n.offset, offset: n.offset, peak: null, edges: {}, regionalPeak: null, handovers: n.handovers, snapped: n.snapped, strength: c.twoWay.strength ?? 0.25, tide, ...(n.intermediate && { intermediate: n.intermediate }) }, batch: 200 };
  }
  const k = started.coupled, edges = Object.fromEntries(k.edgeCodes.map((code, i) => [EDGE_NAMES[code], { points: k.edgePoints[i], peak: k.edgePeak[i], snapped: k.edgeSnapped[i] }]));
  const coupling = c.series
    ? { source: 'series', arrival: k.arrival, offset: 0, peak: k.peak, edges, rows: k.rows, tide }
    : { source: 'regional', arrival: k.arrival, offset: k.offset, peak: k.peak, edges, regionalSeconds: k.regionalSeconds, regionalPeak: k.regionalPeak, regionalCached: k.regionalCached, tide };
  return { coupling, batch: data.grid.method === 3 ? 16 : 200 };
}

// The runs of an ensemble. `base` holds the current settings; `spread` how far each is pushed. Terrain is a uniform vertical shift of the bed in metres (negative lowers the
// ground, which floods more). Which runs there are and their factors are worked out in Rust (rust/flood-core/src/ensemble.rs); the words are here.
export function ensemblePlan(base, spread = {}, options = {}, F = globalThis.FloodCore) {
  const text = {
    amplitude: v => `Source strength ${v.toFixed(2)} m`,
    tide: v => `Initial sea level ${v.toFixed(2)} m`,
    roughness: v => `Manning n ${v.toFixed(3)}`,
    terrain: v => `Terrain ${v > 0 ? '+' : ''}${v.toFixed(2)} m`,
  };
  return F.ensemblePlan(base, spread, options).map(({ kind, input, factors }) => {
    if (kind === 'base') return { id: 'base', label: 'Baseline', group: 'base', factors };
    if (kind === 'severe') return { id: 'severe', label: 'All towards more flooding', group: 'combined', factors };
    if (kind === 'mild') return { id: 'mild', label: 'All towards less flooding', group: 'combined', factors };
    return { id: `${input}-${kind}`, label: text[input](factors[input]), group: input, factors };
  });
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

// Minimum and maximum of each measure over all members (null arrivals are counted separately: that gauge was not reached in that run). The arithmetic is Rust's (`spans`).
export function summarise(results, F = globalThis.FloodCore) {
  const gauges = results[0]?.arrival.length ?? 0;
  const column = (pick) => F.spans(results.map(pick), 1)[0];
  const perGauge = (field) => (gauges ? F.spans(results.flatMap(r => Array.from({ length: gauges }, (_, k) => r[field][k] ?? NaN)), gauges) : []);
  return {
    arrival: perGauge('arrival'),
    gaugePeak: perGauge('gaugePeak'),
    landDepth: column(r => r.landDepth),
    floodedHectares: column(r => r.floodedHectares),
    maxSpeed: column(r => r.maxSpeed),
  };
}
