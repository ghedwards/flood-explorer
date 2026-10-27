// A rate-proportional sample of one PTHA18 source zone's scenarios, each run through the
// nested Gold Coast Seaway model, and what the sample implies for how often this zone's
// scenarios reach given offshore and flooded-area levels.
//
//   NODE_USE_ENV_PROXY=1 node scripts/ensemble-ptha.js --zone kermadectonga2 --gauge 1450.5 \
//       --mw 8.6,9.6 --count 24 [--seconds 3600] [--seed 1] [--jobs N] [--out report.json]
//
// Scenarios are drawn with probability proportional to their annual rate (systematic
// sampling), so common scenarios appear in proportion to how often they occur. For a level
// L the zone's rate of reaching it is estimated as the pool's total rate times the fraction
// of draws that reach L, with a 90% sampling interval. Scenarios whose peak at the hazard
// point is under --skip-below metres (default 0.1) are not run; they are counted as
// flooding nothing, which is a little under the 2 ha the model gives for a 9 cm wave.
// Each local run takes 15 to 40 seconds; --jobs N (default: one per core, up to 8) runs N at a time
// on worker threads, with up to three downloads in flight.
//
// What this is not: a hazard estimate for the site. It covers one source zone and one magnitude range, one tide level (mean sea level), one terrain and
// roughness, and the interval reflects the sample size only. See docs/tsunami-prototype.md.
'use strict';
const fs = require('node:fs');
const lib = require('./ptha-lib.js');
const { createPool, defaultJobs, mapLimit } = require('./run-pool.js');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument ${argv[i]}`);
    out[argv[i].slice(2)] = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i];
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
      if (attempt >= 4) throw new Error(`${error.message} (${url.slice(0, 100)}...). Behind a proxy, set NODE_USE_ENV_PROXY=1.`, { cause: error });
      await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
    }
  }
}

const years = rate => rate > 0 ? `1 in ${rate >= 1 ? (1 / rate).toFixed(1) : Math.round(1 / rate).toLocaleString('en-AU')} years` : 'none seen';

async function main(options) {
  const { zone, gauge } = options, slipType = options.slip || 'stochastic';
  if (!zone || !gauge) throw new Error('Give --zone and --gauge (and usually --mw MIN,MAX and --count N).');
  const count = options.count ? Number(options.count) : 24, seconds = options.seconds ? Number(options.seconds) : 3600;
  const skipBelow = options['skip-below'] ? Number(options['skip-below']) : 0.1;
  const [mwMin, mwMax] = options.mw ? String(options.mw).split(',').map(Number) : [8, 10];
  const point = lib.pointByGaugeID(await lib.hazardPoints(get), +gauge);
  const pool = await lib.findScenarios(get, zone, slipType, { mwMin, mwMax });
  const { draws, total } = lib.sampleByRate(pool, count, lib.seededRandom(options.seed ? Number(options.seed) : 1));
  console.log(`${zone}, Mw ${mwMin}-${mwMax}: ${pool.length} scenarios with a rate, total ${total.toExponential(2)} per year; ${count} draws gave ${draws.length} distinct scenarios.`);
  const workers = createPool(options.jobs ? Number(options.jobs) : defaultJobs());
  let results;
  try {
    results = await mapLimit(draws, 3, async draw => {
      const { event, time, stage } = await lib.scenarioStage(get, zone, slipType, draw.row, point.index);
      const peak = stage.reduce((m, v) => Math.max(m, v), 0);
      let flooded = 0, landDepth = 0, ran = false;
      if (peak >= skipBelow) {
        const values = lib.delayedLinearFriction(time, stage);
        const trimmed = lib.trimSeries(time, values, { hours: 3, align: 'peak' });
        const csv = lib.toCsv(trimmed, { zone, slipType, row: draw.row, mw: event.mw, rateAnnual: event.rateAnnual, gaugeID: point.gaugeID, lon: point.lon, lat: point.lat, depth: point.depth, friction: true, scale: 1 });
        const run = await workers.run(csv, seconds);
        flooded = run.floodedHectares; landDepth = run.maxLandDepth; ran = true;
      }
      console.log(`row ${String(draw.row).padStart(6)}  Mw ${draw.mw.toFixed(2)}  rate ${draw.rateAnnual.toExponential(2)}  x${draw.draws}  peak ${peak.toFixed(2)} m  ${ran ? `flooded ${flooded.toFixed(0)} ha, max depth ${landDepth.toFixed(2)} m` : 'not run'}`);
      return { row: draw.row, mw: draw.mw, rateAnnual: draw.rateAnnual, draws: draw.draws, peak, floodedHectares: flooded, maxLandDepth: landDepth, ran };
    });
  } finally { await workers.close(); }
  const level = (name, key, thresholds, unit) => {
    console.log(`\nRate at which this zone's scenarios reach each ${name} (90% sampling interval):`);
    const rows = lib.sampledExceedance(results.map(r => ({ draws: r.draws, value: r[key] })), total, count, thresholds);
    rows.forEach(r => console.log(`  >= ${String(r.threshold).padStart(5)} ${unit}  ${years(r.rate).padEnd(22)} (${years(r.high)} to ${years(r.low)}; ${r.hits}/${count} draws)`));
    return rows;
  };
  const report = {
    zone, slipType, gauge: point.gaugeID, mw: [mwMin, mwMax], count, seconds, skipBelow, poolRate: total, poolSize: pool.length, results,
    offshore: level('offshore peak at the hazard point', 'peak', [0.1, 0.25, 0.5, 0.76, 1.0], 'm'),
    flooded: level('flooded area', 'floodedHectares', [1, 10, 30, 60, 90], 'ha'),
  };
  if (options.out) { fs.writeFileSync(options.out, JSON.stringify(report, null, 1)); console.log(`\nWrote ${options.out}`); }
  return report;
}

if (require.main === module) {
  let options;
  try { options = args(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  main(options).catch(error => { console.error(error.message); process.exit(1); });
}
module.exports = { main };
