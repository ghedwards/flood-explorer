// Find PTHA18 scenarios of one source zone whose peak at a hazard point is close to
// a chosen level, to pick illustrative runs for that level.
//
//   NODE_USE_ENV_PROXY=1 node scripts/pick-ptha-scenarios.js --zone kermadectonga2 --gauge 1450.5 \
//       --return-period 2500 --mw 8.4,9.3 [--count 40] [--slip stochastic]
//
// The level is either --target-stage METRES or --return-period YEARS (the stage PTHA18
// expects to be exceeded once in that many years at the point, from its own curve).
// `count` scenarios are sampled evenly from the zone's possible scenarios in the
// magnitude range (about 5 s each), their frictionless peak at the point is computed,
// and they are listed closest to the level first. Sampling is not weighted by rate, so
// this finds scenarios of the right size, not the scenarios that dominate the hazard.
// A scenario of the right size is an illustration of that level, not an estimate of its
// probability or of the inundation it would cause. Data: PTHA18 (CC BY 4.0).
'use strict';
const lib = require('./ptha-lib.js');

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

async function main(options) {
  const { zone, gauge } = options, slipType = options.slip || 'stochastic';
  if (!zone || !gauge) throw new Error('Give --zone, --gauge and either --target-stage METRES or --return-period YEARS.');
  const point = lib.pointByGaugeID(await lib.hazardPoints(get), +gauge);
  let target = Number(options['target-stage']);
  if (options['return-period']) {
    const curve = await lib.exceedanceCurve(get, point.index, slipType);
    target = lib.stageAtRate(curve, 1 / Number(options['return-period']));
    if (target == null) throw new Error('PTHA18 gives no stage for that return period at this point.');
    console.log(`1 in ${options['return-period']} years at ${point.gaugeID}: ${target.toFixed(2)} m (all source zones).`);
  }
  if (!(target > 0)) throw new Error('Give --target-stage METRES or --return-period YEARS.');
  const [mwMin, mwMax] = options.mw ? String(options.mw).split(',').map(Number) : [0, 10];
  const rows = lib.sampleEvenly(await lib.findScenarios(get, zone, slipType, { mwMin, mwMax }), options.count ? +options.count : 40);
  console.log(`Sampling ${rows.length} possible scenarios of ${zone} (Mw ${mwMin}-${mwMax}); about 5 s each.`);
  const results = [];
  for (const row of rows) {
    const { stage } = await lib.scenarioStage(get, zone, slipType, row.row, point.index);
    results.push({ ...row, peak: stage.reduce((m, v) => Math.max(m, v), 0) });
  }
  console.log(' row     Mw  annual rate  peak at point (m)');
  for (const r of lib.rankByPeak(results, target).slice(0, 12)) console.log(`${String(r.row).padStart(6)}  ${r.mw.toFixed(2)}  ${r.rateAnnual.toExponential(2)}  ${r.peak.toFixed(3)}`);
}

if (require.main === module) {
  let options;
  try { options = args(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  main(options).catch(error => { console.error(error.message); process.exit(1); });
}
