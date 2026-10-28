// Build viewer/public/tsunami-data/ptha18-hazard.json: PTHA18's offshore tsunami hazard at a thinned set of
// hazard points around Australia, for the map's "Tsunami hazard (offshore)" layer.
//
//   NODE_USE_ENV_PROXY=1 node scripts/prepare-tsunami-hazard.js [--out file.json]
//
// For each point the file holds the wave height (maximum stage above mean sea level, no tide) that PTHA18 gives
// at several return periods, from the logic-tree mean hazard curve, plus its 16th and 84th percentile for the
// rarest two. PTHA18 is Geoscience Australia's 2018 Australian Probabilistic Tsunami Hazard Assessment (CC BY 4.0),
// read from the NCI THREDDS server. Its hazard points are on a 1 arc-minute linear model, so they are offshore
// (the nominal depth is 100 m) and are not a land-inundation estimate.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./ptha-lib.js');
const { mapLimit } = require('./run-pool.js');

const RETURN_PERIODS = [100, 250, 500, 1000, 2500];
const BAND_RETURN_PERIODS = [500, 2500];        // which of those also carry the 16th and 84th percentile stages
const TOP = 20;                                 // PTHA18 tabulates stages up to 20 m

// Hazard points in Australian waters: the mainland, Tasmania, the Great Barrier Reef, the Coral Sea islands and Lord Howe.
// Indonesia, Timor, Papua New Guinea and New Zealand lie close to this box, so their coasts are cut out. The external
// territories (Christmas, Cocos, Norfolk, Heard and Macquarie Islands) are left out.
function australian(lon, lat) {
  if (lon < 108 || lon > 160 || lat < -44.5 || lat > -9.5) return false;
  if (lon < 130 && lat > -11.6) return false;                    // Timor, Roti and the Indonesian islands
  if (lon > 144.5 && lon < 156 && lat > -12.2) return false;      // Papua New Guinea and the Louisiade Archipelago
  return true;
}

// Pick one point per `cell` degrees (the one nearest `target` m deep) from those `minDepth` to `maxDepth` m deep.
function selectPoints(points, { minDepth = 50, maxDepth = 150, target = 100, cell = 0.1 } = {}) {
  const best = new Map();
  for (let i = 0; i < points.lon.length; i++) {
    const depth = -points.elev[i];
    if (depth < minDepth || depth > maxDepth || !australian(points.lon[i], points.lat[i])) continue;
    const key = `${Math.floor(points.lon[i] / cell)},${Math.floor(points.lat[i] / cell)}`;
    const off = Math.abs(depth - target);
    if (!best.has(key) || off < best.get(key).off || (off === best.get(key).off && i < best.get(key).index)) best.set(key, { index: i, off });
  }
  return [...best.values()].map(b => b.index).sort((a, b) => a - b);
}

// Of the selected points, those that are also the pick of a coarser cell: the map shows only these when zoomed out.
function coarseSet(points, indices, cell = 0.5) {
  const best = new Map();
  for (const i of indices) {
    const key = `${Math.floor(points.lon[i] / cell)},${Math.floor(points.lat[i] / cell)}`, off = Math.abs(-points.elev[i] - 100);
    if (!best.has(key) || off < best.get(key).off) best.set(key, { i, off });
  }
  return new Set([...best.values()].map(b => b.i));
}

// Runs of nearby indices to fetch with one request each, so the stations in a run share a request.
function chunks(indices, { gap = 150, max = 400 } = {}) {
  const runs = [];
  for (const index of indices) {
    const run = runs[runs.length - 1];
    if (run && index - run.end <= gap && index - run.start < max) { run.end = index; run.indices.push(index); } else runs.push({ start: index, end: index, indices: [index] });
  }
  return runs;
}

// The stage at the return period: 0 where even the smallest tabulated stage is rarer than that, TOP where the largest one
// still is not.
function stageFor(stage, rates, period) {
  const rate = 1 / period;
  if (!(rates[0] >= rate)) return 0;
  if (rates[rates.length - 1] >= rate) return TOP;
  const s = lib.stageAtRate({ stage, rate: rates }, rate);
  return s == null ? 0 : s;
}

const round = (x, digits = 2) => +x.toFixed(digits);

// One point's row: lon, lat, depth (m), gaugeID, the mean stage at each return period, then the 16th and 84th percentile
// stages at the BAND_RETURN_PERIODS.
function packRow(points, index, stage, mean, p16, p84, coarse = false) {
  return [round(points.lon[index], 3), round(points.lat[index], 3), Math.round(-points.elev[index]), points.gaugeID[index], coarse ? 1 : 0,
    ...RETURN_PERIODS.map(p => round(stageFor(stage, mean, p))),
    ...BAND_RETURN_PERIODS.flatMap(p => [round(stageFor(stage, p16, p)), round(stageFor(stage, p84, p))])];
}

async function fetchChunk(get, points, run, coarse) {
  const names = ['stochastic_slip_rate', 'stochastic_slip_rate_16pc', 'stochastic_slip_rate_84pc'];
  const slice = `[${run.start}:1:${run.end}][0:1:99]`;
  const url = `https://thredds.nci.org.au/thredds/dodsC/fj6/PTHA/AustPTHA_1/EVENT_RATES/revised1_tsunami_stage_exceedance_rates_sum_over_all_source_zones.nc.ascii?stage[0:1:99],${names.map(n => n + slice).join(',')}`;
  const data = lib.parseDapAscii(await get(url));
  const [mean, p16, p84] = names.map(n => data[`${n}.${n}`]);
  if (!data.stage || data.stage.length !== 100 || [mean, p16, p84].some(m => !m || m.length !== run.end - run.start + 1)) throw new Error(`Unexpected rates for stations ${run.start} to ${run.end}.`);
  const stations = data[`${names[0]}.station`];
  if (stations && stations[0] !== run.start + 1) throw new Error('The rate curves belong to different hazard points.');
  return run.indices.map(i => packRow(points, i, data.stage, mean[i - run.start], p16[i - run.start], p84[i - run.start], coarse.has(i)));
}

async function build(get, options = {}) {
  const points = await lib.hazardPoints(get);
  const indices = selectPoints(points, options), coarse = coarseSet(points, indices);
  const rows = (await mapLimit(chunks(indices), 3, run => fetchChunk(get, points, run, coarse))).flat();
  return {
    title: 'PTHA18 offshore tsunami hazard around Australia',
    source: 'Geoscience Australia, 2018 Australian Probabilistic Tsunami Hazard Assessment (PTHA18), https://doi.org/10.11636/Record.2018.041, read from the NCI THREDDS server (https://thredds.nci.org.au/thredds/catalog/fj6/PTHA/catalog.html). Logic-tree mean hazard curve summed over all source zones, stochastic-slip scenarios.',
    licence: 'CC BY 4.0, (c) Commonwealth of Australia (Geoscience Australia)',
    notes: 'Maximum stage above mean sea level, without tide, at PTHA18 hazard points on a 1 arc-minute linear model (nominal depth 100 m; depth_m is the point\'s own depth). Offshore values, not a land-inundation estimate. 0 means smaller than 0.02 m; 20 means at least 20 m. coarse is 1 for the points the map shows when zoomed out.',
    generated: new Date().toISOString().slice(0, 10),
    returnPeriodsYears: RETURN_PERIODS,
    bandReturnPeriodsYears: BAND_RETURN_PERIODS,
    columns: ['lon', 'lat', 'depth_m', 'gaugeID', 'coarse', ...RETURN_PERIODS.map(p => `stage_${p}`), ...BAND_RETURN_PERIODS.flatMap(p => [`stage_${p}_p16`, `stage_${p}_p84`])],
    points: rows,
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2), at = argv.indexOf('--out');
  const out = at >= 0 ? argv[at + 1] : path.join(__dirname, '../viewer/public/tsunami-data/ptha18-hazard.json');
  const get = async url => {
    for (let attempt = 1; ; attempt++) {
      try { return await (await fetch(url, { signal: AbortSignal.timeout(180000) })).text(); } catch (error) {
        if (attempt >= 4) throw new Error(`${error.message} (${url.slice(0, 100)}...). Behind a proxy, set NODE_USE_ENV_PROXY=1.`, { cause: error });
        await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
      }
    }
  };
  build(get).then(file => {
    fs.writeFileSync(out, JSON.stringify(file).replace(/\],\[/g, '],\n[') + '\n');
    console.log(`${file.points.length} points -> ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
  }).catch(error => { console.error(error.message); process.exit(1); });
}
module.exports = { australian, selectPoints, coarseSet, chunks, stageFor, packRow, build, RETURN_PERIODS };
