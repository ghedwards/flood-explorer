// Build the curated PTHA18 scenarios the main map can run live: for a hazard point, each chosen scenario's wave series (the same
// friction and trimming the ensemble uses) as a small CSV, and a manifest the page reads.
//
//   NODE_USE_ENV_PROXY=1 node scripts/prepare-tsunami-scenarios.js --gauge 1450.5 --places gold-coast-seaway,currumbin \
//       --pick kermadectonga2:38914:Moderate,newhebrides2:11816:Large [--out-dir dir]
//
// Each --pick is zone:row:label. The scenario's offshore peak, magnitude and annual rate (a scenario rate, not a hazard estimate) are
// recorded with it. Data: PTHA18, Geoscience Australia, CC BY 4.0.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./ptha-lib.js');

const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function parsePick(text) {
  const [zone, row, ...label] = String(text).split(':');
  if (!zone || !/^\d+$/.test(row || '') || !label.length) throw new Error(`Give each pick as zone:row:label, not "${text}".`);
  return { zone, row: Number(row), label: label.join(':') };
}

// Build the CSV and manifest entry for one pick.
async function buildScenario(get, point, pick, slipType = 'stochastic') {
  const found = (await lib.findScenarios(get, pick.zone, slipType, { mwMin: 0, mwMax: 10 })).find(r => r.row === pick.row);
  if (!found) throw new Error(`Scenario ${pick.zone} row ${pick.row} was not found.`);
  const { event, time, stage } = await lib.scenarioStage(get, pick.zone, slipType, found.row, point.index);
  const peak = stage.reduce((m, v) => Math.max(m, v), 0);
  const trimmed = lib.trimSeries(time, lib.delayedLinearFriction(time, stage), { hours: 3, align: 'peak' });
  const csv = lib.toCsv(trimmed, { zone: pick.zone, slipType, row: pick.row, mw: event.mw, rateAnnual: event.rateAnnual, gaugeID: point.gaugeID, lon: point.lon, lat: point.lat, depth: point.depth, friction: true, scale: 1 });
  const id = `${slug(pick.label)}-${pick.zone}-${pick.row}`;
  return { csv, entry: { id, label: pick.label, zone: pick.zone, row: pick.row, mw: +event.mw.toFixed(2), annualRate: event.rateAnnual, offshorePeakM: +peak.toFixed(3), file: `${id}.csv` } };
}

async function build(get, { gauge, places, picks }) {
  const point = lib.pointByGaugeID(await lib.hazardPoints(get), gauge);
  const scenarios = [];
  for (const pick of picks) scenarios.push(await buildScenario(get, point, pick));
  return {
    manifest: {
      title: 'PTHA18 scenarios the map can run', gaugeID: point.gaugeID, lon: point.lon, lat: point.lat, depthM: Math.round(point.depth), places,
      source: 'Geoscience Australia PTHA18, CC BY 4.0, (c) Commonwealth of Australia (Geoscience Australia), read from the NCI THREDDS server',
      notes: 'Wave heights above mean sea level at the hazard point, with PTHA18\'s delayed linear friction, trimmed to a window around the peak. annualRate is the rate of the earthquake scenario, not how often the wave happens. A 1 arc-minute linear model: not reliable nearshore.',
      scenarios: scenarios.map(s => s.entry),
    },
    files: scenarios.map(s => ({ name: s.entry.file, csv: s.csv })),
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2), opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const dir = opt('--out-dir') || path.join(__dirname, '../viewer/public/tsunami-data/scenarios');
  if (!opt('--gauge') || !opt('--places') || !opt('--pick')) { console.error('Usage: node scripts/prepare-tsunami-scenarios.js --gauge ID --places a,b --pick zone:row:label,... [--out-dir dir]'); process.exit(2); }
  const get = async url => {
    for (let attempt = 1; ; attempt++) {
      try { return await (await fetch(url, { signal: AbortSignal.timeout(180000) })).text(); } catch (error) {
        if (attempt >= 4) throw new Error(`${error.message}. Behind a proxy, set NODE_USE_ENV_PROXY=1.`, { cause: error });
        await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
      }
    }
  };
  build(get, { gauge: Number(opt('--gauge')), places: opt('--places').split(','), picks: opt('--pick').split(',').map(parsePick) }).then(({ manifest, files }) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(dir, f.name), f.csv);
    fs.writeFileSync(path.join(dir, `${slug(String(manifest.gaugeID))}.json`), JSON.stringify(manifest, null, 1) + '\n');
    // the index lists every manifest in the folder
    const manifests = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json').sort();
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ manifests }, null, 1) + '\n');
    console.log(`${files.length} scenarios for hazard point ${manifest.gaugeID} -> ${dir}`);
    for (const s of manifest.scenarios) console.log(`  ${s.label}: ${s.zone} row ${s.row}, Mw ${s.mw}, offshore peak ${s.offshorePeakM} m`);
  }).catch(error => { console.error(error.message); process.exit(1); });
}
module.exports = { parsePick, buildScenario, build, slug };
