const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tide = require('../scripts/tide-lib.js');

const planes = JSON.parse(fs.readFileSync(path.join(__dirname, '../viewer/public/tsunami-data/gold-coast-seaway-tidal-planes.json'), 'utf8'));

test('tide states are the plane heights relative to MSL, lowest first', () => {
  const levels = tide.levelsAboveMsl(planes);
  assert.deepEqual(levels.map(l => l.name), ['LAT', 'MLWS', 'MLWN', 'MSL', 'MHWN', 'MHWS', 'HAT']);
  assert.ok(levels.every((l, i) => i === 0 || l.aboveMsl > levels[i - 1].aboveMsl));
  assert.equal(levels.find(l => l.name === 'MSL').aboveMsl, 0);
  assert.equal(levels.find(l => l.name === 'HAT').aboveMsl, 1.15);
  assert.equal(levels.find(l => l.name === 'LAT').aboveMsl, -0.88);
});

test('a state level adds the MSL offset in the terrain datum and rejects bad input', () => {
  assert.equal(tide.stateLevel(planes, 'MHWS'), 0.65);
  assert.equal(tide.stateLevel(planes, 'MHWS', 0.1), 0.75);
  assert.equal(tide.stateLevel(planes, 'MSL', -0.2), -0.2);
  assert.throws(() => tide.stateLevel(planes, 'HIGH'), /Unknown tide state/);
  assert.throws(() => tide.stateLevel(planes, 'MSL', NaN), /number of metres/);
  assert.throws(() => tide.levelsAboveMsl({ planes: { ...planes.planes, MHWN: 0.3 } }), /must rise from MSL to MHWN/);
  assert.throws(() => tide.levelsAboveMsl({ planes: { HAT: 2 } }), /need numbers/);
  assert.throws(() => tide.levelsAboveMsl(null), /need numbers/);
});

test('spring and neap ranges give M2 and S2 amplitudes, and the file says it is unverified', () => {
  const { springRange, neapRange, m2, s2 } = tide.springNeap(planes);
  assert.ok(Math.abs(springRange - 1.31) < 1e-9 && Math.abs(neapRange - 0.73) < 1e-9);
  assert.ok(Math.abs(2 * (m2 + s2) - springRange) < 1e-2 && Math.abs(2 * (m2 - s2) - neapRange) < 1e-2);
  assert.ok(m2 > s2 && s2 > 0);
  // The numbers have not been checked against the published table; keep saying so until they are.
  assert.equal(planes.verified, false);
  assert.match(planes.note, /could not be downloaded/);
  // All states fit the local grid's allowed starting sea level (-1 to 2 m).
  for (const { name } of tide.levelsAboveMsl(planes).map(l => ({ name: l.name }))) {
    const level = tide.stateLevel(planes, name);
    assert.ok(level >= -1 && level <= 2, `${name} ${level}`);
  }
});

test('a run at a higher starting sea level counts the tide\'s own cover separately from what the wave adds', async () => {
  const { runSeries } = require('../scripts/run-series-local.js');
  const { parseSeriesCsv } = await import('../viewer/tsunami-coupling.js');
  const series = parseSeriesCsv(fs.readFileSync(path.join(__dirname, '../docs/examples/ptha18-southamerica-142847-gauge1450.5.csv'), 'utf8'));
  const base = await runSeries(series, 300);
  const high = await runSeries(series, 300, { tide: tide.stateLevel(planes, 'MHWN'), baseline: 0 });
  // At the baseline level nothing is covered before the wave, so added equals total.
  assert.equal(base.tideOnlyHectares, 0);
  assert.equal(base.addedHectares, base.floodedHectares);
  // At a higher level the tide alone covers land, the total includes it, and the wave adds the rest.
  assert.ok(high.tideOnlyHectares > 10, `tide alone ${high.tideOnlyHectares}`);
  assert.ok(high.floodedHectares >= high.tideOnlyHectares);
  assert.ok(Math.abs(high.addedHectares - (high.floodedHectares - high.tideOnlyHectares)) < 1e-9);
  assert.ok(high.maxLandDepth > base.maxLandDepth);
  assert.equal(high.offshorePeak, base.offshorePeak);
});

test('harmonic analysis recovers a known tide and reproduces it', () => {
  const t = [], y = [], truth = h => 0.9 + 0.6 * Math.cos((28.9841042 * h + 30) * Math.PI / 180) + 0.2 * Math.cos((30 * h + 200) * Math.PI / 180) + 0.15 * Math.cos((15.0410686 * h + 75) * Math.PI / 180);
  for (let i = 0; i < 24 * 400; i++) { t.push(i); y.push(truth(i)); }
  const fit = tide.fitHarmonics(t, y), amp = k => fit.parts.find(p => p.name === k);
  assert.ok(Math.abs(fit.z0 - 0.9) < 1e-6);
  assert.ok(Math.abs(amp('M2').amp - 0.6) < 1e-6 && Math.abs(amp('S2').amp - 0.2) < 1e-6 && Math.abs(amp('K1').amp - 0.15) < 1e-6);
  const back = tide.synthesise(fit, t);
  assert.ok(back.every((v, i) => Math.abs(v - y[i]) < 1e-6), 'the fitted tide reproduces the series, so the phases are right');
  const p = tide.planesFromFit(fit, 1);
  assert.ok(Math.abs(p.MHWS - 1.7) < 1e-6 && Math.abs(p.MLWS - 0.1) < 1e-6 && p.HAT <= 0.9 + 0.95 + 1e-6 && p.HAT > 1.6);
});

test('a gauge CSV parses, and tide-state weights add to one and follow the levels', () => {
  const g = tide.parseGauge('_id,Date,Time,Ind,Reading\n1,01/01/2025, 00:00 ,9,0.500\n2,1/01/2025,00:10,9,\n3,1/01/2025,00:20,9,1.250\n');
  assert.deepEqual(g.y, [0.5, 1.25]);
  assert.ok(Math.abs(g.t[1] - g.t[0] - 20 / 60) < 1e-6);
  const w = tide.stateWeights([0, 0, 0.88, 0.88, 2.03], planes.planes);
  assert.equal(Object.values(w).reduce((a, b) => a + b, 0).toFixed(3), '1.000');
  assert.equal(w.LAT, 0.4); assert.equal(w.MSL, 0.4); assert.equal(w.HAT, 0.2);
});

test('the gauge analysis recovers a synthetic station, with no trend removed from under six years', () => {
  const os = require('node:os');
  const { analyse } = require('../scripts/tide-analysis.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-'));
  try {
    const rows = year => {
      const out = ['_id,Date,Time,Ind,Reading'];
      for (let i = 0, t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); i++, t += 600000) {
        const d = new Date(t), h = (t - Date.UTC(2020, 0, 1)) / 3600000, pad = n => String(n).padStart(2, '0');
        const level = 1 + 0.7 * Math.cos(28.9841042 * h * Math.PI / 180) + 0.2 * Math.cos((30 * h + 40) * Math.PI / 180) + 0.15 * Math.cos((15.0410686 * h + 10) * Math.PI / 180);
        out.push(`${i + 1},${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${year},${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())},9,${level.toFixed(3)}`);
      }
      return out.join('\n');
    };
    fs.writeFileSync(path.join(dir, 'obs_2024.csv'), rows(2024)); fs.writeFileSync(path.join(dir, 'pred_2024.csv'), rows(2024));
    const r = analyse(dir, { published: null, source: 'synthetic' });
    assert.equal(r.source, 'synthetic');
    assert.ok(Math.abs(r.planesFromPredictions.MSL - 1) < 0.01 && Math.abs(r.planesFromPredictions.MHWS - 1.9) < 0.01 && Math.abs(r.planesFromPredictions.MLWS - 0.1) < 0.01, JSON.stringify(r.planesFromPredictions));
    assert.equal(r.meanSeaLevelTrendMPerYear, 0);
    assert.ok(r.harmonicFitVsPrediction.rmsM < 0.01 && r.observedMinusPredicted.sdM < 0.001);
    assert.equal(r.publishedPlanes, undefined);
    assert.ok(Math.abs(Object.values(r.stateWeights).reduce((a, b) => a + b, 0) - 1) < 0.001);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
