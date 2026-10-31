// Test PTHA18's modelled waves against observed DART records for the 2011 Tohoku
// tsunami. Blind: nothing is fitted. All PTHA18 scenarios of the right magnitude
// and location are taken, and for each DART buoy the observed record is placed
// against the spread of those scenarios (peak amplitude, arrival time, and the
// best waveform match any scenario achieves).
//
//   NODE_USE_ENV_PROXY=1 node scripts/validate-ptha-dart.js [--cache DIR] [--out DIR]
//
// Needs the network (NOAA NCEI for the DART records, NCI THREDDS for PTHA18) and
// downloads a few hundred MB once into the cache (default work/validation-cache).
// Writes docs/validation/tohoku-2011-dart.{md,json,svg}. This checks the PTHA18
// series that the lab's importer (scripts/prepare-ptha-series.js) reads; it does
// not test the lab's own propagation or inundation solvers.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ptha = require('./ptha-lib.js');
const dart = require('./dart-lib.js');

const EVENT = {
  name: '2011 Tohoku, Japan',
  magnitude: 9.1,
  origin: Date.UTC(2011, 2, 11, 5, 46, 23), source: [142.369, 38.322],
  page: 'https://www.ngdc.noaa.gov/hazard/dart/2011honshu_dart.html',
  zone: 'kurilsjapan', slipType: 'stochastic',
  // Scenarios of this magnitude whose peak slip lies near the epicentre.
  mw: [9.0, 9.2], epicentre: [142.4, 38.3], radiusDegrees: 2.5,
  windowHours: 8, leadSeconds: 3600, maxLagSeconds: 1800,
  stations: [
    ['21401', 'near field, off Japan'], ['21413', 'near field, off Japan'], ['21418', 'near field, off Japan'], ['21419', 'near field, off Japan'],
    ['52402', 'north-west Pacific'], ['52403', 'north-west Pacific'],
    ['52406', 'towards eastern Australia'], ['55012', 'towards eastern Australia'], ['51425', 'south-west Pacific'], ['51426', 'south-west Pacific'], ['54401', 'south-west Pacific'],
    ['51407', 'central Pacific (Hawaii)'],
    ['46409', 'north-east Pacific'], ['43413', 'east Pacific'], ['32411', 'east Pacific'], ['32413', 'east Pacific'],
  ],
  figure: ['21418', '52402', '52406', '55012', '54401', '32413'],
};

const quantile = (values, q) => {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN;
};

// One buoy against the ensemble. `series` are the unit-source series at the buoy's
// hazard point, `scenarios` the candidate scenarios, `obs` the observed residual on
// the model's time grid (NaN where missing, drift removed).
function analyseStation({ time, series, scenarios, obs, windowHours = 8, leadSeconds = 3600, maxLagSeconds = 1800, wantEnvelope = false }) {
  const n = time.length, step = (time[n - 1] - time[0]) / (n - 1);
  const stage = scenarios.map(c => ptha.sumScenario(series, c.indices, c.slips));
  // The window follows the models' median arrival, not the observation, so it cannot flatter the comparison.
  const arrivals = stage.map(s => dart.onset(s, 0, n, { fraction: .1, floor: .005 })).filter(i => i >= 0);
  if (!arrivals.length) throw new Error('No scenario produces a wave at this point.');
  const from = Math.max(0, Math.round(quantile(arrivals, .5) - leadSeconds / step));
  const to = Math.min(n, from + Math.round(windowHours * 3600 / step));
  const peakOf = v => { let p = 0; for (let i = from; i < to; i++) if (Number.isFinite(v[i]) && Math.abs(v[i]) > p) p = Math.abs(v[i]); return p; };
  const observedPeak = peakOf(obs);
  if (!(observedPeak > 0)) throw new Error('The observed record is empty in this window.');
  // Timing at one common level, so large and small scenarios are timed alike.
  const level = Math.max(.01, .15 * observedPeak);
  const observedOnset = dart.firstExceed(obs, from, to, level);
  const peaks = stage.map(peakOf);
  // The same scenarios with PTHA18's delayed linear friction (12 h delay), which its guide recommends for late waves.
  const frictionPeaks = stage.map(s => peakOf(ptha.delayedLinearFriction(time, s)));
  const onsetDifferences = stage.map(s => dart.firstExceed(s, from, to, level)).map(i => i < 0 || observedOnset < 0 ? NaN : (i - observedOnset) * step / 60).filter(Number.isFinite);
  const maxLag = Math.round(maxLagSeconds / step);
  let best = { correlation: -Infinity, lag: 0, row: null, peakRatio: NaN };
  stage.forEach((s, k) => {
    const r = dart.bestLagCorrelation(s, obs, from, to, maxLag);
    if (r.correlation > best.correlation) best = { ...r, row: scenarios[k].row, peakRatio: peaks[k] / observedPeak };
  });
  const result = {
    window: { fromHours: from * step / 3600, toHours: to * step / 3600 },
    observedPeak,
    modelPeak: { p10: quantile(peaks, .1), p50: quantile(peaks, .5), p90: quantile(peaks, .9) },
    observedPercentile: 100 * peaks.filter(p => p < observedPeak).length / peaks.length,
    withFriction: { p50: quantile(frictionPeaks, .5), observedPercentile: 100 * frictionPeaks.filter(p => p < observedPeak).length / frictionPeaks.length },
    observedOnsetHours: observedOnset < 0 ? null : observedOnset * step / 3600,
    onsetDifferenceMinutes: onsetDifferences.length ? { p10: quantile(onsetDifferences, .1), p50: quantile(onsetDifferences, .5), p90: quantile(onsetDifferences, .9), scenarios: onsetDifferences.length } : null,
    bestMatch: { row: best.row, correlation: best.correlation, lagMinutes: best.lag * step / 60, peakRatio: best.peakRatio },
    scenarios: scenarios.length,
  };
  if (wantEnvelope) {
    const col = new Float64Array(stage.length);
    const env = { time: [], obs: [], p10: [], p50: [], p90: [] };
    for (let i = from; i < to; i++) {
      stage.forEach((s, k) => { col[k] = s[i]; });
      env.time.push(time[i] / 3600); env.obs.push(Number.isFinite(obs[i]) ? obs[i] : null);
      env.p10.push(quantile(col, .1)); env.p50.push(quantile(col, .5)); env.p90.push(quantile(col, .9));
    }
    result.envelope = env;
  }
  return result;
}

const fmt = (v, d = 2) => v == null || !Number.isFinite(v) ? '–' : v.toFixed(d);

function summarise(rows) {
  const inside = rows.filter(r => r.observedPeak >= r.modelPeak.p10 && r.observedPeak <= r.modelPeak.p90).length;
  const median = values => quantile(values, .5);
  const groups = {};
  for (const r of rows) (groups[r.group] ||= []).push(r);
  return {
    stations: rows.length, insideP10P90: inside,
    medianObservedPercentile: median(rows.map(r => r.observedPercentile)),
    medianObservedPercentileWithFriction: median(rows.map(r => r.withFriction.observedPercentile)),
    medianModelToObservedPeakWithFriction: median(rows.map(r => r.withFriction.p50 / r.observedPeak)),
    medianModelToObservedPeak: median(rows.map(r => r.modelPeak.p50 / r.observedPeak)),
    onsetMedianByGroup: Object.fromEntries(Object.entries(groups).map(([g, v]) => [g, median(v.filter(r => r.onsetDifferenceMinutes).map(r => r.onsetDifferenceMinutes.p50))])),
    medianBestCorrelation: median(rows.map(r => r.bestMatch.correlation)),
  };
}

function renderReport({ rows, summary, meta }) {
  const lines = [];
  lines.push(`# PTHA18 against observed DART records: ${meta.event}`, '');
  lines.push(`Generated ${meta.date} by \`scripts/validate-ptha-dart.js\`. This asks how well Geoscience Australia's PTHA18 scenario waves, the series the tsunami lab's importer reads, reproduce what deep-ocean buoys recorded. It does **not** test the lab's own propagation or inundation solvers.`, '');
  lines.push('## Method', '');
  lines.push(`- **Observations:** NOAA NCEI DART residuals (de-tided, metres of water column) at ${rows.length} buoys, converted to seconds after the earthquake (${meta.originText}) and high-pass filtered with a ${meta.highpassHours} h running median to remove drift. Before the earliest time a tsunami could arrive (0.9 × distance ÷ 243 m/s, the speed in 6000 m of water) the record is blanked, because bottom-pressure sensors also record the earthquake's own shaking and acoustic waves.`);
  if (meta.despiked != null) lines.push(`- **Despiking:** before filtering, ${meta.despiked} isolated readings in the observed records (more than 6 robust standard deviations from the median of the seven samples around them, at least 5 mm) were replaced by that median.`);
  lines.push(`- **Model:** the ${meta.scenarios} PTHA18 ${meta.slipType}-slip scenarios of the ${meta.zone} source zone with Mw ${meta.mw[0]}–${meta.mw[1]} whose peak slip is within ${meta.radiusDegrees}° of the epicentre. Each scenario's wave at a buoy is the slip-weighted sum of PTHA18's unit-source waves at the hazard point that sits at the buoy (gauge ID = buoy ID + .4; 3–34 km from the buoy, depth differences up to a few hundred metres).`);
  lines.push('- **Blind:** no scenario is fitted to the data. Each buoy\'s record is placed against the spread (10th, 50th and 90th percentiles) of all those scenarios. The comparison window starts one hour before the models\' median arrival and lasts 8 hours, so it does not depend on the observation.');
  lines.push(`- **Timing:** the time each series first exceeds one common level (the larger of 1 cm and 15% of the observed peak), as model minus observation, over the scenarios.`);
  lines.push('- **Best match:** the highest correlation any single scenario reaches with the record within ±30 minutes of shift (positive lag: the model had to be delayed to match). This one is chosen after seeing the record at that buoy, so it shows what the scenario family can reproduce, not a prediction.', '');
  lines.push('## Results', '');
  lines.push('| Buoy | Region | Depth (m) | Window (h) | Observed peak (m) | Scenarios p10 / p50 / p90 (m) | Observed percentile (with friction) | Onset: model − observed (min), p10 / p50 / p90 | Best match r (lag min) |');
  lines.push('| --- | --- | ---: | --- | ---: | --- | --- | --- | --- |');
  for (const r of rows) {
    const o = r.onsetDifferenceMinutes;
    lines.push(`| ${r.id} | ${r.group} | ${fmt(r.depth, 0)} | ${fmt(r.window.fromHours, 1)}–${fmt(r.window.toHours, 1)} | ${fmt(r.observedPeak, 3)} | ${fmt(r.modelPeak.p10, 3)} / ${fmt(r.modelPeak.p50, 3)} / ${fmt(r.modelPeak.p90, 3)} | ${fmt(r.observedPercentile, 0)} (${fmt(r.withFriction.observedPercentile, 0)}) | ${o ? `${fmt(o.p10, 0)} / ${fmt(o.p50, 0)} / ${fmt(o.p90, 0)}` : '–'} | ${fmt(r.bestMatch.correlation)} (${fmt(r.bestMatch.lagMinutes, 0)}) |`);
  }
  lines.push('');
  lines.push('## Summary', '');
  lines.push(`- The observed peak lies inside the scenarios' 10th–90th percentile range at **${summary.insideP10P90} of ${summary.stations}** buoys. The median observed percentile is ${fmt(summary.medianObservedPercentile, 0)}%, and the scenarios' median peak is ${fmt(summary.medianModelToObservedPeak)} times the observed peak (a median over buoys). With PTHA18's delayed linear friction applied to the scenarios, the median observed percentile is ${fmt(summary.medianObservedPercentileWithFriction, 0)}% and the scenarios' median peak is ${fmt(summary.medianModelToObservedPeakWithFriction)} times the observed peak.`);
  lines.push(`- Median onset difference by region (model minus observation, minutes): ${Object.entries(summary.onsetMedianByGroup).map(([g, v]) => `${g} ${fmt(v, 0)}`).join('; ')}.`);
  lines.push(`- The best single scenario reaches a median correlation of ${fmt(summary.medianBestCorrelation)} with the records (in-sample).`, '');
  lines.push('## What this does and does not show', '');
  for (const text of meta.caveats) lines.push(`- ${text}`);
  lines.push('', `![Observed record against the scenario spread at six buoys](${meta.figure})`, '');
  lines.push('Shaded band: scenarios\' 10th–90th percentile; line: median; dark line: observed. ' + meta.figureNote, '');
  lines.push('## Data', '', `- DART: NOAA National Centers for Environmental Information, ${meta.page}.`, '- PTHA18: Geoscience Australia, CC BY 4.0, (c) Commonwealth of Australia (Geoscience Australia), read from NCI THREDDS; report http://dx.doi.org/10.11636/Record.2018.041.', '');
  return lines.join('\n');
}

// A compact multi-panel SVG: observed record over the scenario band at each buoy.
function renderFigure(rows, ids) {
  const panels = ids.map(id => rows.find(r => r.id === id)).filter(r => r && r.envelope);
  const [W, H, left, right, top, gap] = [920, 150, 64, 14, 22, 28];
  const total = panels.length * (H + gap) + 10;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${total}" width="${W}" role="img" aria-label="Observed DART records against the PTHA18 scenario spread">`,
    '<style>text{font:12px system-ui,sans-serif;fill:#1d2a33}.a{stroke:#9fb2bd;stroke-width:1}.b{fill:#e07a3a;fill-opacity:.25}.m{fill:none;stroke:#c0541a;stroke-width:1.4}.o{fill:none;stroke:#143346;stroke-width:1.6}</style>',
    `<rect width="${W}" height="${total}" fill="#fff"/>`];
  panels.forEach((r, k) => {
    // About 300 points per line is plenty for a 900-pixel figure.
    const stride = Math.max(1, Math.round(r.envelope.time.length / 300));
    const pick = v => v.filter((_, i) => i % stride === 0);
    const e = Object.fromEntries(Object.entries(r.envelope).map(([key, v]) => [key, pick(v)])), y0 = k * (H + gap) + top;
    const extent = Math.max(.01, ...e.p90.map(Math.abs), ...e.p10.map(Math.abs), ...e.obs.filter(v => v != null).map(Math.abs)) * 1.1;
    const x = t => left + (t - e.time[0]) / (e.time.at(-1) - e.time[0]) * (W - left - right);
    const y = v => y0 + H / 2 - v / extent * (H / 2 - 4);
    const line = (v, cls) => `<polyline class="${cls}" points="${e.time.map((t, i) => v[i] == null ? null : `${x(t).toFixed(1)},${y(v[i]).toFixed(1)}`).filter(Boolean).join(' ')}"/>`;
    out.push(`<text x="${left}" y="${y0 - 8}"><tspan font-weight="700">DART ${r.id}</tspan> · ${r.group} · ${fmt(r.depth, 0)} m deep</text>`);
    out.push(`<line class="a" x1="${left}" x2="${W - right}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/><line class="a" x1="${left}" x2="${left}" y1="${y0}" y2="${y0 + H}"/>`);
    const upper = e.time.map((t, i) => `${x(t).toFixed(1)},${y(e.p90[i]).toFixed(1)}`), lower = e.time.map((t, i) => `${x(t).toFixed(1)},${y(e.p10[i]).toFixed(1)}`).reverse();
    out.push(`<polygon class="b" points="${upper.concat(lower).join(' ')}"/>`, line(e.p50, 'm'), line(e.obs, 'o'));
    out.push(`<text x="${left - 6}" y="${y(extent).toFixed(1)}" text-anchor="end" dy="10">${fmt(extent, 2)} m</text><text x="${left - 6}" y="${y(-extent).toFixed(1)}" text-anchor="end" dy="-2">−${fmt(extent, 2)}</text>`);
    out.push(`<text x="${W - right}" y="${y0 + H + 14}" text-anchor="end">${fmt(e.time[0], 1)} to ${fmt(e.time.at(-1), 1)} hours after the earthquake</text>`);
  });
  out.push('</svg>');
  return out.join('\n');
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i];
  }
  return out;
}

function makeGet(cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });
  return async function get(url) {
    const file = path.join(cacheDir, 'http-' + require('node:crypto').createHash('sha1').update(url).digest('hex') + '.txt');
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
        const text = await response.text();
        if (!response.ok && !/^\s*Error\s*{/.test(text)) throw new Error(`HTTP ${response.status}`);
        if (response.ok) fs.writeFileSync(file, text);
        return text;
      } catch (error) {
        if (attempt >= 4) throw new Error(`${error.message} (${url.slice(0, 120)}...). Behind a proxy set NODE_USE_ENV_PROXY=1.`, { cause: error });
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }
    }
  };
}

// Unit-source series at a point, cached as one binary file per station.
async function cachedUnitSeries(get, cacheDir, zone, id, pointIndex) {
  const file = path.join(cacheDir, `unit-${zone}-${id}.bin`);
  if (fs.existsSync(file)) {
    const buffer = fs.readFileSync(file);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const [units, steps] = [view.getUint32(0, true), view.getUint32(4, true)];
    const time = new Float64Array(steps);
    for (let i = 0; i < steps; i++) time[i] = view.getFloat64(8 + 8 * i, true);
    const base = 8 + 8 * steps;
    return { time, series: Array.from({ length: units }, (_, k) => new Float32Array(buffer.buffer.slice(buffer.byteOffset + base + 4 * steps * k, buffer.byteOffset + base + 4 * steps * (k + 1)))) };
  }
  let shown = 0;
  const { time, series } = await ptha.unitSeriesAt(get, zone, pointIndex, { onProgress: (done, total) => { if (done - shown >= 80 || done === total) { shown = done; process.stderr.write(`  ${id}: ${done}/${total} unit sources\n`); } } });
  const header = Buffer.alloc(8 + 8 * time.length);
  header.writeUInt32LE(series.length, 0); header.writeUInt32LE(time.length, 4);
  time.forEach((v, i) => header.writeDoubleLE(v, 8 + 8 * i));
  fs.writeFileSync(file, Buffer.concat([header, ...series.map(s => Buffer.from(s.buffer, s.byteOffset, s.byteLength))]));
  return { time, series };
}

async function candidateScenarios(get) {
  const found = await ptha.findScenarios(get, EVENT.zone, EVENT.slipType, { mwMin: EVENT.mw[0], mwMax: EVENT.mw[1], onlyPossible: false });
  const [first, last] = [found[0].row, found.at(-1).row];
  const near = [];
  for (let a = first; a <= last; a += 2000) {
    for (const t of await ptha.scenarioTargets(get, EVENT.zone, EVENT.slipType, a, Math.min(last, a + 1999))) {
      if (t.mw >= EVENT.mw[0] && t.mw <= EVENT.mw[1] && Math.hypot(t.lon - EVENT.epicentre[0], t.lat - EVENT.epicentre[1]) <= EVENT.radiusDegrees) near.push(t.row);
    }
  }
  const wanted = new Set(near), scenarios = [];
  for (let a = Math.min(...near); a <= Math.max(...near); a += 2000) {
    for (const c of await ptha.scenarioRange(get, EVENT.zone, EVENT.slipType, a, Math.min(Math.max(...near), a + 1999))) if (wanted.has(c.row)) scenarios.push(c);
  }
  return scenarios;
}

// Timing statement from the numbers: which regions' observed arrivals are later than the models'.
function delayText(summary) {
  const later = Object.entries(summary.onsetMedianByGroup).filter(([, v]) => Number.isFinite(v) && v <= -10);
  const earlier = Object.entries(summary.onsetMedianByGroup).filter(([, v]) => Number.isFinite(v) && v >= 10);
  const parts = [];
  if (later.length) parts.push(`Observed arrivals are later than the models' by at least 10 minutes (median) in: ${later.map(([g, v]) => `${g} (${fmt(-v, 0)} min)`).join('; ')}.`);
  if (earlier.length) parts.push(`Observed arrivals are earlier than the models' by at least 10 minutes (median) in: ${earlier.map(([g, v]) => `${g} (${fmt(v, 0)} min)`).join('; ')}.`);
  return parts.length ? parts.join(' ') : 'Median arrival differences are within 10 minutes in every region.';
}

const CAVEATS = (summary) => [
  'It is a **blind check of one event**, the 2011 Tohoku earthquake, at 16 deep-ocean buoys. It says nothing about other source zones, and the buoys sit in deep water, where PTHA18\'s linear 1 arc-minute model is at its best. It says nothing about nearshore waves or inundation.',
  `The scenarios are those PTHA18 holds for Mw ${EVENT.mw[0]}–${EVENT.mw[1]} near the epicentre, a family chosen with knowledge of the event; the stochastic slip patterns are random draws, so individual waveforms are not expected to match. The meaningful tests are whether the observation falls inside the spread and whether arrival times agree.`,
  `PTHA18's frictionless linear model is documented to overstate late waves, and it ignores dispersion and elastic loading, which the literature finds delay real tsunami arrivals over long paths. ${summary.medianObservedPercentile < 50 ? `Here the observed peaks tend to sit below the scenarios' median (median observed percentile ${fmt(summary.medianObservedPercentile, 0)}%). ` : ''}${delayText(summary)}`,
  'PTHA18\'s delayed linear friction starts 12 hours after the earthquake, so it changes only the buoys whose windows extend past that (mainly the east Pacific), and only modestly; within the first 12 hours the frictionless and friction columns agree.',
  'Onset times depend on the slip pattern as well as on travel speed: a scenario with more slip near the trench sends a larger, earlier leading wave. They are therefore only a rough test of travel time, and the p10–p90 spread shows how much of the difference could be the source rather than the propagation.',
  'Small signals (a few centimetres at the far-field buoys) approach the noise and the residual tide error of the observed record, so percentiles and onset times there are the least certain numbers in the table.',
  'The high-pass filter removes slow drift and any tsunami signal slower than a few hours. It also lowers an isolated broad peak by roughly a tenth to an eighth (a synthetic 40-minute pulse loses 13%), because the pulse nudges the running median; the observed peaks are the filtered ones, so the observed percentiles here are, if anything, slightly low.',
];

async function main() {
  const options = args(process.argv.slice(2));
  const cacheDir = options.cache || path.join(__dirname, '../work/validation-cache');
  const outDir = options.out || path.join(__dirname, '../docs/validation');
  const get = makeGet(cacheDir);
  const files = dart.stationFiles(await get(EVENT.page));
  const points = await ptha.hazardPoints(get);
  const scenarios = await candidateScenarios(get);
  process.stderr.write(`${scenarios.length} PTHA18 scenarios, Mw ${EVENT.mw.join('-')}, within ${EVENT.radiusDegrees} degrees of the epicentre\n`);
  const rows = [];
  let despiked = 0;
  for (const [id, group] of EVENT.stations) {
    if (!files[id]) throw new Error(`No NCEI data file for DART ${id}.`);
    const point = ptha.pointByGaugeID(points, +`${id}.4`);
    const units = await cachedUnitSeries(get, cacheDir, EVENT.zone, id, point.index);
    const step = (units.time.at(-1) - units.time[0]) / (units.time.length - 1);
    const record = dart.parseNgdcDart(await get(files[id]), EVENT.origin);
    // Blank the earthquake's own shaking and acoustic signal, which precedes any tsunami.
    // `--despike` first replaces isolated bad readings with the running median (off by default, so the published report stays reproducible)
    let residual = record.residual;
    if (options.despike) { const cleaned = dart.despike(residual); residual = cleaned.values; despiked += cleaned.replaced; }
    const obs = dart.maskBeforeTsunami(dart.highpass(dart.resample(record.t, residual, units.time, 1200), step), units.time, dart.distanceKm(EVENT.source[0], EVENT.source[1], point.lon, point.lat));
    rows.push({ id, group, depth: point.depth, ...analyseStation({ time: units.time, series: units.series, scenarios, obs, windowHours: EVENT.windowHours, leadSeconds: EVENT.leadSeconds, maxLagSeconds: EVENT.maxLagSeconds, wantEnvelope: EVENT.figure.includes(id) }) });
    process.stderr.write(`DART ${id}: observed ${rows.at(-1).observedPeak.toFixed(3)} m, scenarios p50 ${rows.at(-1).modelPeak.p50.toFixed(3)} m\n`);
  }
  const summary = summarise(rows);
  const figure = 'tohoku-2011-dart.svg';
  const meta = { event: `${EVENT.name} (Mw ${EVENT.magnitude})`, date: new Date().toISOString().slice(0, 10), originText: '2011-03-11 05:46:23 UTC', highpassHours: 4, ...(options.despike && { despiked }), scenarios: scenarios.length, slipType: EVENT.slipType, zone: EVENT.zone, mw: EVENT.mw, radiusDegrees: EVENT.radiusDegrees, caveats: CAVEATS(summary), figure, page: EVENT.page,
    figureNote: 'Time runs along each panel from one hour before the models\' median arrival; vertical scales differ between panels.' };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'tohoku-2011-dart.md'), renderReport({ rows, summary, meta }));
  fs.writeFileSync(path.join(outDir, figure), renderFigure(rows, EVENT.figure));
  fs.writeFileSync(path.join(outDir, 'tohoku-2011-dart.json'), JSON.stringify({ event: EVENT.name, generated: meta.date, scenarios: scenarios.length, summary, stations: rows.map(({ envelope, ...r }) => r) }, null, 1));
  console.log(`Wrote ${outDir}/tohoku-2011-dart.{md,svg,json}: observed peak inside the scenario p10-p90 range at ${summary.insideP10P90} of ${summary.stations} buoys.`);
}

module.exports = { EVENT, analyseStation, summarise, renderReport, renderFigure, quantile };

if (require.main === module) main().catch(error => { console.error(error.message); process.exit(1); });
