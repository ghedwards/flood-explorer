// Combine the per-zone reports of scripts/ensemble-ptha.js into one site-level estimate.
//
//   node scripts/combine-ensembles.js zone1.json zone2.json ... [--out combined.json]
//
// Each zone's sample is independent, so the rate at which any of them reaches a level is
// the sum of the zones' rates. The combined interval adds the zones' half-widths in
// quadrature (the sampling errors are independent), which is an approximation and is
// only as good as each zone's own interval. Zones that were left out contribute nothing,
// so the result is a lower bound on the site's rate: it covers only the zones and
// magnitude ranges that were sampled, at the sea level they were run at.
'use strict';
const fs = require('node:fs');

// Sum the zones' estimates at each threshold of one measure ('offshore' or 'flooded').
function combine(reports, key) {
  if (!reports.length) throw new Error('Give at least one zone report.');
  const first = reports[0][key];
  if (!Array.isArray(first)) throw new Error(`The reports have no ${key} estimates.`);
  const thresholds = first.map(r => r.threshold);
  for (const report of reports) {
    const there = report[key]?.map(r => r.threshold);
    if (!there || there.length !== thresholds.length || there.some((t, i) => t !== thresholds[i])) throw new Error(`Zone ${report.zone} was run with different ${key} thresholds.`);
  }
  const gauges = new Set(reports.map(r => r.gauge));
  if (gauges.size > 1) throw new Error('The reports are for different hazard points.');
  return thresholds.map((threshold, i) => {
    const rows = reports.map(r => r[key][i]);
    const rate = rows.reduce((s, r) => s + r.rate, 0);
    const down = Math.sqrt(rows.reduce((s, r) => s + (r.rate - r.low) ** 2, 0));
    const up = Math.sqrt(rows.reduce((s, r) => s + (r.high - r.rate) ** 2, 0));
    return { threshold, rate, low: Math.max(0, rate - down), high: rate + up, byZone: Object.fromEntries(reports.map((r, k) => [r.zone, rows[k].rate])) };
  });
}

const years = rate => rate > 0 ? `1 in ${rate >= 1 ? (1 / rate).toFixed(1) : Math.round(1 / rate).toLocaleString('en-AU')} years` : 'none seen';

function main(argv) {
  const files = [];
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i].startsWith('--')) throw new Error(`Unknown option ${argv[i]}`);
    else files.push(argv[i]);
  }
  const reports = files.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
  const combined = { gauge: reports[0]?.gauge, zones: reports.map(r => ({ zone: r.zone, mw: r.mw, poolRate: r.poolRate, count: r.count })), offshore: combine(reports, 'offshore'), flooded: combine(reports, 'flooded') };
  // the tide-weighted area the wave adds, only when every zone was run with --tide-weighted
  if (reports.every(r => r.tideWeightedAdded)) combined.tideWeightedAdded = combine(reports, 'tideWeightedAdded');
  for (const [name, key, unit] of [['offshore peak at the hazard point', 'offshore', 'm'], ['flooded area', 'flooded', 'ha'], ['area the wave adds to the tide, weighted by how often each tide state occurs', 'tideWeightedAdded', 'ha']]) {
    if (!combined[key]) continue;
    console.log(`Rate at which the sampled zones together reach each ${name} (interval: zones' half-widths in quadrature):`);
    for (const r of combined[key]) console.log(`  >= ${String(r.threshold).padStart(5)} ${unit}  ${years(r.rate).padEnd(22)} (${years(r.high)} to ${years(r.low)})`);
  }
  if (out) { fs.writeFileSync(out, JSON.stringify(combined, null, 1)); console.log(`Wrote ${out}`); }
  return combined;
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(1); }
}
module.exports = { combine, main };
