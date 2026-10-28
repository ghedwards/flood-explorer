// Build viewer/public/tsunami-data/extents/<place>.json (and index.json): for each cell of a local tsunami grid, how often the sampled
// PTHA18 scenarios put at least a given depth of water on it, from the per-zone files that scripts/ensemble-ptha.js writes with
// --tide-weighted --cells-out.
//
//   node scripts/prepare-tsunami-extents.js --place gold-coast-seaway zone1-cells.json zone2-cells.json ... [--out-dir dir]
//
// Each zone file holds the zone's total annual rate and, per cell and depth, the share of its sampled scenarios (weighted over the tide
// states) that reach the depth. A zone's rate for a cell is the total rate times that share; the zones are independent samples, so the site
// rate is their sum. That is a lower bound: zones and magnitudes that were not sampled add nothing. Rates are stored as one byte per cell,
// log10(rate) = code / 40 - 6 (see viewer/tsunami-extents.js).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function combineZones(zones) {
  if (!zones.length) throw new Error('Give at least one zone file.');
  const { W, H, cell, depths } = zones[0];
  for (const z of zones) {
    if (z.W !== W || z.H !== H || z.cell !== cell || z.depths.join() !== depths.join()) throw new Error(`Zone ${z.zone} was run on a different grid or with different depths.`);
    if (z.fraction.length !== depths.length || z.fraction.some(f => f.length !== W * H)) throw new Error(`Zone ${z.zone} has the wrong number of cells.`);
  }
  return { W, H, cell, depths, rate: depths.map((_, k) => Float64Array.from({ length: W * H }, (__, i) => zones.reduce((sum, z) => sum + z.poolRate * z.fraction[k][i], 0))) };
}

async function build(place, zones) {
  const { encodeRate } = await import('../viewer/tsunami-extents.js');
  const { estuaryLocations } = await import('../viewer/tsunami-locations.js');
  const location = estuaryLocations.find(l => l.id === place);
  if (!location) throw new Error(`Unknown place ${place}.`);
  const terrain = JSON.parse(fs.readFileSync(path.join(__dirname, `../viewer/public/tsunami-data/${place}.json`), 'utf8'));
  const c = combineZones(zones);
  if (c.W !== terrain.W || c.H !== terrain.H || c.cell !== terrain.cell) throw new Error('The zone files are not on this place\'s grid.');
  return {
    id: place, name: location.name.replace(/ · terrain test$/, ''), zone: 56, extent: terrain.extent, W: c.W, H: c.H, cell: c.cell, projection: terrain.projection,
    depths: c.depths, codes: c.rate.map(r => Buffer.from(Uint8Array.from(r, encodeRate)).toString('base64')),
    zones: zones.map(z => ({ zone: z.zone, mw: z.mw, draws: z.count, annualRate: z.poolRate, seed: z.seed })), gauge: zones[0].gauge,
    maxRatePerYear: c.depths.map((_, k) => Math.max(...c.rate[k])),
    method: 'A rate-proportional sample of each source zone\'s PTHA18 scenarios, each run through the nested local model at seven tide states (LAT to HAT) weighted by how often the Seaway gauge sits nearest each (scripts/tide-analysis.js). For each cell: the zones\' total rates times the share of draws that add at least the depth.',
    limits: 'A lower bound: other source zones, magnitudes below those sampled and sea-level rise are not included; the terrain is the bundled grid at mean sea level with no defences or drainage; each run is one hour with the tide held at its state; the model is not validated against a recorded event. Sampling error is large for rare outcomes. Not a hazard assessment.',
    attribution: `PTHA18 (c) Commonwealth of Australia (Geoscience Australia), CC BY 4.0. Terrain: ${terrain.attribution || terrain.source}`, license: /SA/i.test(terrain.license || '') ? `${terrain.license} (derived from share-alike terrain)` : 'CC BY 4.0', terrainLicense: terrain.license, prepared: new Date().toISOString().slice(0, 10),
  };
}

function writeIndex(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json').sort();
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ places: files }, null, 1) + '\n');
}

if (require.main === module) {
  const argv = process.argv.slice(2), files = [];
  let place = null, dir = path.join(__dirname, '../viewer/public/tsunami-data/extents');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--place') place = argv[++i];
    else if (argv[i] === '--out-dir') dir = argv[++i];
    else if (argv[i].startsWith('--')) { console.error(`Unknown option ${argv[i]}`); process.exit(2); } else files.push(argv[i]);
  }
  if (!place || !files.length) { console.error('Usage: node scripts/prepare-tsunami-extents.js --place ID zone-cells.json ... [--out-dir dir]'); process.exit(2); }
  build(place, files.map(f => JSON.parse(fs.readFileSync(f, 'utf8')))).then(file => {
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${place}.json`);
    fs.writeFileSync(out, JSON.stringify(file) + '\n');
    writeIndex(dir);
    console.log(`${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB); peak rate per cell: ${file.maxRatePerYear.map((r, k) => `>=${file.depths[k]} m: 1 in ${Math.round(1 / r)} years`).join(', ')}`);
  }).catch(error => { console.error(error.message); process.exit(1); });
}
module.exports = { combineZones, build };
