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
