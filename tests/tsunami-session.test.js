const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('./model.js');

const data = path.join(__dirname, '../viewer/public/tsunami-data');
const read = file => fs.readFileSync(path.join(data, file), 'utf8');
const load = () => import('../viewer/tsunami-session.js');

// serve tsunami-data/ files through fetch the way the site does
async function withFetch(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async url => {
    const file = decodeURIComponent(new URL(url).pathname.replace(/^\/(site\/)?tsunami-data\//, ''));
    const full = path.join(data, file);
    if (!full.startsWith(data) || !fs.existsSync(full)) return { ok: false, status: 404 };
    const text = fs.readFileSync(full, 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
  };
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('scenarios load for each place their manifest lists, and tide levels come from the planes', async () => {
  const s = await load();
  const scenarios = await withFetch(() => s.loadScenarios('http://localhost/site/'));
  assert.deepEqual([...new Set(scenarios.map(x => x.place))].sort(), ['brisbane-mouth', 'currumbin', 'gold-coast-seaway', 'pine-estuary']);
  assert.equal(scenarios.filter(x => x.place === 'currumbin').length, 4);
  assert.ok(scenarios.every(x => x.offshorePeakM > 0 && x.mw >= 8.4 && x.gaugeID === (['pine-estuary', 'brisbane-mouth'].includes(x.place) ? 1570.2 : 1450.5)));
  assert.equal(new Set(scenarios.map(x => `${x.gaugeID}:${x.file}`)).size, 8, 'each hazard point has its own four files');
  const levels = s.tideLevels(JSON.parse(read('gold-coast-seaway-tidal-planes.json')));
  assert.deepEqual(levels.map(l => l.state), s.TIDE_STATES);
  assert.equal(levels.find(l => l.state === 'MSL').aboveMsl, 0);
  assert.equal(levels.find(l => l.state === 'HAT').aboveMsl, 1.15);
  assert.throws(() => s.tideLevels({ planes: { HAT: 2 } }), /incomplete/);
  const bar = s.tideLevels(JSON.parse(read('brisbane-bar-tidal-planes.json')));
  assert.ok(bar.find(l => l.state === 'LAT').aboveMsl < -1 && s.modelTide(bar.find(l => l.state === 'LAT').aboveMsl) === -1, 'a state below the model\'s limit runs at -1 m');
  assert.equal(s.modelTide(0.65), 0.65);
  assert.equal(s.TIDE_STATION['pine-estuary'], 'brisbane-bar');
  assert.equal(s.TIDE_STATION.currumbin, 'gold-coast-seaway');
});

test('a run is prepared on the place grid with a dry-land mask, and bad settings are refused', async () => {
  const s = await load();
  const bathymetry = JSON.parse(read('gold-coast-seaway.json'));
  const series = await withFetch(async () => { const [first] = await s.loadScenarios('http://localhost/site/'); return s.loadSeries('http://localhost/site/', first); });
  const msl = s.prepareRun({ place: 'gold-coast-seaway', bathymetry, series });
  const hat = s.prepareRun({ place: 'gold-coast-seaway', bathymetry, series, tide: 1.15 });
  assert.equal(msl.grid.W, 160); assert.equal(msl.land.length, 160 * 96);
  assert.deepEqual([...msl.land], [...hat.land], 'the land mask is the ground dry at mean sea level whatever the tide');
  const covered = (p) => p.land.reduce((n, l, i) => n + (l && p.grid.depth[i] > 0 ? 1 : 0), 0);
  assert.equal(covered(msl), 0); assert.ok(covered(hat) > 0, 'a high tide covers some land');
  assert.throws(() => s.prepareRun({ place: 'gold-coast-seaway', bathymetry, series, seconds: 60 }), /5 minutes/);
  assert.throws(() => s.prepareRun({ place: 'gold-coast-seaway', bathymetry, series, tide: 3 }), /-1 and 2/);
});

test('the live run reproduces the offline model: same flooded area and depth for the Moderate scenario', async () => {
  const s = await load();
  const bathymetry = JSON.parse(read('gold-coast-seaway.json'));
  const scenarios = await withFetch(() => s.loadScenarios('http://localhost/site/'));
  const moderate = scenarios.find(x => x.place === 'gold-coast-seaway' && /^Moderate/.test(x.label));
  const series = await withFetch(() => s.loadSeries('http://localhost/site/', moderate));
  const prepared = s.prepareRun({ place: 'gold-coast-seaway', bathymetry, series, seconds: 3600, frames: 60 });
  const { frames, interval, extremes } = s.runHere(F, prepared);
  assert.ok(frames.length >= 60 && Math.abs(interval - 60) < 1e-9);
  assert.ok(frames.every((f, i) => i === 0 || f.time > frames[i - 1].time));
  const result = frames.at(-1).summary;
  const { runSeries } = require('../scripts/run-series-local.js');
  const { parseSeriesCsv } = await import('../viewer/tsunami-coupling.js');
  const offline = await runSeries(parseSeriesCsv(read(`scenarios/${moderate.file}`)), 3600);
  assert.ok(Math.abs(result.floodedHectares - offline.floodedHectares) < 0.05, `${result.floodedHectares} vs ${offline.floodedHectares}`);
  assert.ok(Math.abs(result.maxLandDepth - offline.maxLandDepth) < 0.01, `${result.maxLandDepth} vs ${offline.maxLandDepth}`);
  assert.ok(result.floodedHectares > 20 && result.floodedHectares < 50, 'about 34 ha, as the ensemble found');
  assert.ok(frames[0].summary.floodedHectares === 0, 'nothing is flooded at the start');
  // the extremes the solver kept every step: deepest water on land, arrival counted from the wave reaching the edge, the worst hazard class
  const n = prepared.grid.W * prepared.grid.H;
  assert.ok(extremes.peakValue.length === n && extremes.arrival.length === n && extremes.peakClass.length === n && extremes.peakSpeed.length === n && extremes.peakTime.length === n);
  let deepest = 0, arrived = 0, worst = 0;
  for (let i = 0; i < n; i++) if (prepared.land[i]) { deepest = Math.max(deepest, extremes.peakValue[i]); if (extremes.arrival[i] >= 0) arrived++; worst = Math.max(worst, extremes.peakClass[i]); }
  assert.ok(Math.abs(deepest - result.maxLandDepth) < 1e-4, `${deepest} vs ${result.maxLandDepth}`);
  assert.ok(arrived > 0 && worst >= 1 && worst <= 6, `${arrived} cells flooded, worst class ${worst}`);
});


test('a Moreton Bay place runs live on its own grid and matches the offline model', async () => {
  const s = await load();
  const bathymetry = JSON.parse(read('pine-estuary.json'));
  const scenarios = await withFetch(() => s.loadScenarios('http://localhost/site/'));
  const large = scenarios.find(x => x.place === 'pine-estuary' && /^Large/.test(x.label));
  const series = await withFetch(() => s.loadSeries('http://localhost/site/', large));
  const low = s.prepareRun({ place: 'pine-estuary', bathymetry, series, tide: s.modelTide(-1.154), seconds: 600, frames: 10 });
  assert.equal(low.grid.cell, 25); assert.equal(low.tide, -1, 'a tide state below the limit runs at -1 m');
  const prepared = s.prepareRun({ place: 'pine-estuary', bathymetry, series, seconds: 3600, frames: 60 });
  const { frames } = s.runHere(F, prepared);
  const result = frames.at(-1).summary;
  const { runSeries } = require('../scripts/run-series-local.js');
  const { parseSeriesCsv } = await import('../viewer/tsunami-coupling.js');
  const offline = await runSeries(parseSeriesCsv(read(`scenarios/${large.file}`)), 3600, { place: 'pine-estuary' });
  assert.ok(Math.abs(result.floodedHectares - offline.floodedHectares) < 0.05 && Math.abs(result.maxLandDepth - offline.maxLandDepth) < 0.01, `${result.floodedHectares} ha ${result.maxLandDepth} m vs ${offline.floodedHectares} ha ${offline.maxLandDepth} m`);
  assert.ok(result.floodedHectares > 5 && result.floodedHectares < 30, 'about 15 ha, as the ensemble found');
});
