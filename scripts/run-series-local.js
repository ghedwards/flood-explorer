// Run PTHA18 series files (from prepare-ptha-series.js) through the nested Gold Coast
// Seaway model and print the headline numbers, so several scenarios can be compared.
//
//   node scripts/run-series-local.js [--seconds 3600] wave1.csv wave2.csv ...
//
// The local model starts at mean sea level (no tide), uses its bundled terrain and a
// fixed Manning roughness, and takes the series as its offshore boundary wave. The
// numbers are illustrations of how this model responds to a wave, not flood estimates:
// see docs/tsunami-prototype.md for what the model leaves out.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const F = require('../tests/model.js');

// Run one parsed series (see parseSeriesCsv) through the model; returns its headline numbers.
async function runSeries(series, seconds = 3600) {
  const { forcingFromSeries } = await import('../viewer/tsunami-coupling.js');
  const { tsunamiGrid } = await import('../viewer/tsunami-grid.js');
  const fine = JSON.parse(fs.readFileSync(path.join(__dirname, '../viewer/public/tsunami-data/gold-coast-seaway.json')));
  const grid = tsunamiGrid({ preset: 'gold-coast-seaway', bathymetry: fine, amplitude: 0, absorbing: true, width: .45, coupled: true });
  const forcing = forcingFromSeries({ fine, fineGrid: grid }, series, { maxLocalSeconds: seconds });
  F.tsunamiStart({ ...grid, ...Object.fromEntries(Object.entries(forcing).filter(([key]) => key.startsWith('force'))) });
  let frame;
  while (!frame || frame.time < seconds) frame = F.tsunamiStep(200);
  let water = 0, land = 0, flooded = 0;
  for (let i = 0; i < grid.depth.length; i++) {
    if (grid.depth[i] !== 0) { water = Math.max(water, frame.peak[i]); continue; }
    land = Math.max(land, frame.peak[i]);
    if (frame.peak[i] > .01) flooded++;
  }
  return { offshorePeak: Math.max(...series.values.map(Math.abs)), maxWaterLevel: water, maxLandDepth: land, floodedHectares: flooded * grid.cell ** 2 / 10000 };
}

async function main(argv) {
  let seconds = 3600;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seconds') seconds = Number(argv[++i]);
    else if (argv[i].startsWith('--')) throw new Error(`Unknown option ${argv[i]}`);
    else files.push(argv[i]);
  }
  if (!files.length || !(seconds > 0 && seconds <= 7200)) throw new Error('Give one or more series files and --seconds up to 7200.');
  const { parseSeriesCsv } = await import('../viewer/tsunami-coupling.js');
  console.log('series                                          offshore peak  max water level  max depth on land  flooded');
  for (const file of files) {
    const r = await runSeries(parseSeriesCsv(fs.readFileSync(file, 'utf8')), seconds);
    console.log(`${path.basename(file).slice(0, 46).padEnd(46)}  ${r.offshorePeak.toFixed(2).padStart(9)} m  ${r.maxWaterLevel.toFixed(2).padStart(12)} m  ${r.maxLandDepth.toFixed(2).padStart(14)} m  ${r.floodedHectares.toFixed(0).padStart(5)} ha`);
  }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exit(1); });
module.exports = { main, runSeries };
