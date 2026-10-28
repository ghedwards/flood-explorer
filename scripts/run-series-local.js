// Run PTHA18 series files (from prepare-ptha-series.js) through a nested local model (the Gold Coast Seaway unless a place is given) and print the headline numbers, so several scenarios can be compared.
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
// `tide` is the sea level the model starts at, in the terrain's datum (metres; -1 to 2). `place` is one of the local scenes (gold-coast-seaway by default).
// "Land" is what is dry at `baseline` (default: the starting level), so that runs at
// different tide levels are measured over the same ground: land that a high tide has
// already covered is counted as flooded, with its depth is the tide's plus the wave's.
// With `keepPeak`, the result also carries `landPeak`: for each cell that is land at `baseline`, the most water the wave added there (m), and `W`, `H`, `cell`.
async function runSeries(series, seconds = 3600, { tide = 0, baseline = tide, keepPeak = false, place = 'gold-coast-seaway' } = {}) {
  const { forcingFromSeries } = await import('../viewer/tsunami-coupling.js');
  const { tsunamiGrid } = await import('../viewer/tsunami-grid.js');
  if (!/^[a-z-]+$/.test(place)) throw new Error('The place is a lower-case id such as gold-coast-seaway or currumbin.');
  const fine = JSON.parse(fs.readFileSync(path.join(__dirname, `../viewer/public/tsunami-data/${place}.json`)));
  const options = { preset: place, bathymetry: fine, amplitude: 0, absorbing: true, width: .45, coupled: true };
  const grid = tsunamiGrid({ ...options, tide });
  const dry = baseline === tide ? grid.depth : tsunamiGrid({ ...options, tide: baseline }).depth;
  const forcing = forcingFromSeries({ fine, fineGrid: grid }, series, { maxLocalSeconds: seconds });
  F.tsunamiStart({ ...grid, ...Object.fromEntries(Object.entries(forcing).filter(([key]) => key.startsWith('force'))) });
  let frame;
  while (!frame || frame.time < seconds) frame = F.tsunamiStep(200);
  let water = 0, land = 0, covered = 0, tideOnly = 0;
  const landPeak = keepPeak ? new Float32Array(grid.depth.length) : null;
  for (let i = 0; i < grid.depth.length; i++) {
    if (dry[i] !== 0) { water = Math.max(water, frame.peak[i]); continue; }
    if (landPeak) landPeak[i] = frame.peak[i];
    const depth = grid.depth[i] + frame.peak[i];
    land = Math.max(land, depth);
    if (depth > .01) covered++;
    if (grid.depth[i] > .01) tideOnly++;
  }
  const hectares = n => n * grid.cell ** 2 / 10000;
  // floodedHectares: land under more than 1 cm at any time, the tide's own cover included;
  // tideOnlyHectares: what the starting sea level covers before any wave; addedHectares: the
  // difference, land the wave newly covered. Without a tide, flooded and added are the same.
  return { offshorePeak: Math.max(...series.values.map(Math.abs)), maxWaterLevel: water, maxLandDepth: land,
    floodedHectares: hectares(covered), tideOnlyHectares: hectares(tideOnly), addedHectares: hectares(covered - tideOnly),
    ...(landPeak && { landPeak, W: grid.W, H: grid.H, cell: grid.cell }) };
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
