// Make a tsunami-lab incoming-wave file (seconds, metres) from a PTHA18 scenario.
//
//   NODE_USE_ENV_PROXY=1 node scripts/prepare-ptha-series.js --near 153.9,-27.95
//       list the hazard points nearest a place (use ones in deep water)
//   node scripts/prepare-ptha-series.js --zone southamerica --find --mw 9.0,9.3
//       list scenarios of a source zone by magnitude (rows are 1-based)
//   node scripts/prepare-ptha-series.js --zone southamerica --event 1234 --gauge 1431.1 --out wave.csv
//       build the series; load it in the lab as Incoming wave > Uploaded series
//
// Options: --slip stochastic|variable_uniform|uniform (default stochastic),
// --hours N (default 6), --align arrival|peak|none (default arrival: start just
// before the first wave; peak: start 30 min before the largest wave, which often
// arrives hours later; none: keep time since the earthquake),
// --friction (delayed linear friction), --local-depth M (Green's-law scaling
// from the hazard point's depth to M metres), --out FILE.
// Behind a proxy set NODE_USE_ENV_PROXY=1. The data are GA's PTHA18 (CC BY 4.0).
'use strict';
const fs = require('node:fs');
const lib = require('./ptha-lib.js');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument ${argv[i]}`);
    const key = argv[i].slice(2);
    out[key] = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i];
  }
  return out;
}

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      const text = await response.text();
      if (!response.ok && !/^\s*Error\s*{/.test(text)) throw new Error(`HTTP ${response.status}`);
      return text;
    } catch (error) {
      if (attempt >= 3) throw new Error(`${error.message} (${url.slice(0, 120)}...). Behind a proxy, set NODE_USE_ENV_PROXY=1.`, { cause: error });
      await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
    }
  }
}

const pair = (text, name) => {
  const values = String(text).split(',').map(Number);
  if (values.length !== 2 || values.some(v => !Number.isFinite(v))) throw new Error(`--${name} takes two numbers separated by a comma.`);
  return values;
};

async function main(options) {
  if (options.near) {
    const [lon, lat] = pair(options.near, 'near');
    const rows = lib.nearestPoints(await lib.hazardPoints(get), lon, lat, { count: 12, minDepth: +options['min-depth'] || 0 });
    console.log('gaugeID    lon       lat      depth(m)  km away');
    for (const r of rows) console.log(`${String(r.gaugeID).padEnd(9)} ${r.lon.toFixed(3).padStart(8)} ${r.lat.toFixed(3).padStart(8)} ${r.depth.toFixed(0).padStart(8)} ${r.km.toFixed(1).padStart(8)}`);
    return;
  }
  const zone = options.zone, slipType = options.slip || 'stochastic';
  if (!zone) throw new Error('Give --zone (a PTHA18 source zone such as southamerica), or --near lon,lat.');
  if (options.find) {
    const [mwMin, mwMax] = options.mw ? pair(options.mw, 'mw') : [0, 10];
    const rows = await lib.findScenarios(get, zone, slipType, { mwMin, mwMax });
    console.log(`${rows.length} possible ${slipType}-slip scenarios in ${zone} with Mw ${mwMin}-${mwMax} (row, Mw, annual rate); showing the first 40 by row`);
    for (const r of rows.slice(0, 40)) console.log(`${String(r.row).padStart(7)}  Mw ${r.mw.toFixed(2)}  rate ${r.rateAnnual.toExponential(2)}`);
    return;
  }
  const row = Number(options.event);
  if (!Number.isInteger(row) || row < 1 || !options.gauge) throw new Error('Give --event ROW (from --find) and --gauge ID (from --near).');
  const point = lib.pointByGaugeID(await lib.hazardPoints(get), +options.gauge);
  if (point.depth < 50) console.error(`Warning: hazard point ${point.gaugeID} is only ${point.depth.toFixed(0)} m deep; PTHA18's linear 1 arc-minute model is unreliable in shallow water. Prefer a deeper point.`);
  const { event, time, stage } = await lib.scenarioStage(get, zone, slipType, row, point.index);
  let values = options.friction ? lib.delayedLinearFriction(time, stage) : stage;
  const localDepth = options['local-depth'] ? +options['local-depth'] : null;
  const scale = localDepth ? lib.greenScale(point.depth, localDepth) : 1;
  if (scale !== 1) values = Float64Array.from(values, v => v * scale);
  const series = lib.trimSeries(time, values, { hours: options.hours ? +options.hours : 6, align: options.align || 'arrival' });
  const csv = lib.toCsv(series, { zone, slipType, row, mw: event.mw, rateAnnual: event.rateAnnual, gaugeID: point.gaugeID, lon: point.lon, lat: point.lat, depth: point.depth, friction: !!options.friction, scale, localDepth });
  const out = options.out || `ptha18-${zone}-${slipType}-${row}-gauge${point.gaugeID}.csv`;
  fs.writeFileSync(out, csv);
  console.log(`Wrote ${out}: Mw ${event.mw}, ${event.indices.length} unit sources at hazard point ${point.gaugeID} (${point.depth.toFixed(0)} m deep); ${series.times.length} rows from ${(series.offset / 60).toFixed(1)} min after the earthquake, largest ${series.windowPeak.toFixed(3)} m.`);
  if (series.windowPeak < 0.99 * series.peak) console.error(`Note: the largest wave of the whole series (${series.peak.toFixed(3)} m, ${(series.peakTime / 60).toFixed(0)} min after the earthquake) is not in this window. Use --align peak to include it.`);
}

if (require.main === module) {
  let options;
  try { options = args(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  main(options).catch(error => { console.error(error.message); process.exit(1); });
}
