const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');
const fs = require('node:fs');
const path = require('node:path');
const gridModule = import('../viewer/tsunami-grid.js');

test('synthetic tsunami scenarios contain ocean and a signed source, with fixed dry land', async () => {
  const { tsunamiGrid } = await gridModule;
  for (const preset of ['flat', 'shelf', 'island']) {
    const grid = tsunamiGrid({ preset });
    assert.ok(grid.depth.some(d => d > 0));
    assert.equal(grid.depth.some(d => d === 0), preset !== 'flat');
    assert.ok(grid.eta.some(e => e > .9));
    assert.ok(grid.eta.some(e => e < -.9));
    assert.ok(grid.eta.every((e, i) => grid.depth[i] > 0 || e === 0));
  }
  assert.throws(() => tsunamiGrid({ source: [150, 48] }), /ocean/);
  assert.throws(() => tsunamiGrid({ source: [NaN, 48] }), /Invalid/);
  assert.throws(() => tsunamiGrid({ deep: -1 }), /Invalid/);
});

test('the WASM bridge propagates finite waves and conserves closed-basin displacement', async () => {
  const { tsunamiGrid } = await gridModule;
  for (const method of ['staggered', 'finite-volume']) for (const preset of ['flat', 'shelf', 'island']) {
    const grid = tsunamiGrid({ preset, absorbing: false, method });
    const initial = grid.eta.reduce((sum, e) => sum + e, 0) * grid.cell ** 2;
    const { dt } = F.tsunamiStart(grid);
    assert.ok(dt > 0 && dt < 10);
    let frame;
    for (let i = 0; i < 5; i++) frame = F.tsunamiStep(200);
    assert.ok(frame.eta.every(Number.isFinite));
    assert.ok(frame.peak.every((e, i) => e + 1e-6 >= Math.abs(frame.eta[i])));
    assert.ok(frame.eta.every((e, i) => grid.depth[i] > 0 || e === 0));
    assert.ok(Math.abs(frame.volume - initial) < .001, `${preset}: ${frame.volume - initial}`);
    assert.ok(Math.abs(frame.time - dt * 1000) < 1e-6);
  }
  assert.throws(() => F.tsunamiStep(201), /step count/);
});

test('zero displacement stays at rest through the WASM solver', async () => {
  const { tsunamiGrid } = await gridModule;
  F.tsunamiStart(tsunamiGrid({ amplitude: 0 }));
  const result = F.tsunamiStep(200);
  assert.ok(result.eta.every(e => e === 0));
  assert.equal(result.volume, 0);
});

test('prefetched Australian coastal terrain runs with both methods', async () => {
  const { tsunamiGrid } = await gridModule;
  for (const id of (await import('../viewer/tsunami-locations.js')).regionalIds) {
    const bathymetry = JSON.parse(fs.readFileSync(path.join(__dirname, '../viewer/public/tsunami-data', `${id}.json`)));
    assert.match(bathymetry.source, /Geoscience Australia/);
    assert.match(bathymetry.sourceUrl, /^https:\/\/services\.ga\.gov\.au\//);
    assert.ok(bathymetry.elevation.some(z => z > 0));
    assert.ok(bathymetry.elevation.some(z => z < -1000));
    const sourceIndex = bathymetry.elevation.findIndex((z, i) => z < -500 && i % 160 > 90 && Math.floor(i / 160) === 48);
    assert.ok(sourceIndex > 0);
    for (const method of ['staggered', 'finite-volume']) {
      const grid = tsunamiGrid({ preset: id, bathymetry, source: [sourceIndex % 160, 48], method });
      assert.ok(grid.depth.every((d, i) => bathymetry.elevation[i] < 0 ? d >= 10 : d === 0));
      F.tsunamiStart(grid);
      const result = F.tsunamiStep(100);
      assert.ok(result.eta.every(Number.isFinite));
      assert.ok(result.eta.every((e, i) => grid.depth[i] > 0 || e === 0));
    }
    assert.throws(() => tsunamiGrid({ preset: id, bathymetry: { ...bathymetry, elevation: [] } }), /Invalid/);
  }
});

test('nonlinear estuary wets dry land, moves water along the river, and preserves a disconnected lake', async () => {
  const { tsunamiGrid } = await gridModule;
  const grid = tsunamiGrid({ preset: 'estuary', width: .3, absorbing: false });
  assert.equal(grid.method, 2);
  const river = 55 * grid.W + 115, lake = 22 * grid.W + 128;
  assert.ok(grid.depth[river] > 0);
  assert.equal(grid.bed[lake] + grid.depth[lake], 1);
  F.tsunamiStart(grid);
  let result;
  for (let n = 0; n < 6; n++) result = F.tsunamiStep(200);
  assert.ok(result.water.every(h => Number.isFinite(h) && h >= 0));
  assert.ok(result.water.some((h, i) => grid.depth[i] === 0 && h > .01));
  assert.ok(result.speed.some(v => v > .1));
  assert.ok(Math.abs(result.eta[river]) > .0001, `river ${result.eta[river]}`);
  assert.equal(result.eta[lake], 0);
  assert.ok(Math.abs(result.volumeError) < 1e-5);
  assert.throws(() => tsunamiGrid({ preset: 'estuary', width: .3, source: [120, 48] }), /water/);
  assert.throws(() => tsunamiGrid({ preset: 'estuary', width: .3, roughness: NaN }), /Invalid/);
  const lakeWave = tsunamiGrid({ preset: 'estuary', width: .15, source: [128, 22], absorbing: false });
  assert.ok(lakeWave.eta.some(e => e > .1));
  assert.equal(lakeWave.eta[48 * grid.W + 38], 0);
  F.tsunamiStart(lakeWave);
  const lakeResult = F.tsunamiStep(200);
  assert.ok(lakeResult.speed.some(v => v > .01));
  assert.equal(lakeResult.eta[48 * grid.W + 38], 0);
  assert.ok(Math.abs(lakeResult.volumeError) < 1e-5);
});

test('all local terrain experiments start in sea-connected water and run nonlinear flow', async () => {
  const { tsunamiGrid, connectedWaterDepth } = await gridModule;
  for (const id of (await import('../viewer/tsunami-locations.js')).estuaryIds) {
    const bathymetry = JSON.parse(fs.readFileSync(path.join(__dirname, '../viewer/public/tsunami-data', `${id}.json`)));
    assert.equal(bathymetry.license, id === 'gold-coast-seaway' ? 'CC BY 4.0' : 'CC BY-SA');
    assert.match(bathymetry.verticalDatum, id === 'gold-coast-seaway' ? /AVWS/ : /Not specified/);
    if (bathymetry.terrainSource) {
      assert.equal(bathymetry.terrainSource.length, 160*96);
      assert.equal(bathymetry.sourceCounts.reduce((n, s) => n+s.cells, 0) + bathymetry.missing, 160*96);
      assert.ok(bathymetry.terrainSource.every((v, i) => bathymetry.valid[i] ? v >= 0 && v <= 7 : v === 255));
    }
    const initial = connectedWaterDepth(bathymetry.elevation, 160, 96, 0, bathymetry.seaEdges, bathymetry.valid);
    let sourceIndex = -1, distance = Infinity;
    initial.forEach((depth, i) => {
      const d = Math.hypot(i % 160 - bathymetry.sourceTarget[0], Math.floor(i / 160) - bathymetry.sourceTarget[1]);
      if (depth > 3.1 && d < distance) { sourceIndex = i; distance = d; }
    });
    assert.ok(sourceIndex >= 0);
    const grid = tsunamiGrid({ preset: id, bathymetry, source: [sourceIndex % 160, Math.floor(sourceIndex / 160)], width: .45, amplitude: 2.5, absorbing: false });
    assert.ok(grid.bed.some(z => z > 1));
    assert.ok(grid.bed.some(z => z < -2));
    F.tsunamiStart(grid);
    let result;
    for (let n = 0; n < 3; n++) result = F.tsunamiStep(200);
    assert.ok(result.water.every(h => Number.isFinite(h) && h >= 0));
    assert.ok(result.speed.some(v => v > 0));
    if (grid.valid) assert.ok(result.water.every((h, i) => grid.valid[i] || h === 0));
    if (id === 'pine-estuary') assert.ok(result.water.some((h, i) => grid.depth[i] === 0 && h > .01));
    assert.ok(Math.abs(result.volumeError) < 1e-5);
    assert.throws(() => tsunamiGrid({ preset: id, bathymetry: { ...bathymetry, elevation: [] }, width: .3 }), /Invalid/);
  }
});

test('dispersive WASM waves conserve volume and differ from shallow-water propagation', async () => {
  const { tsunamiGrid } = await gridModule;
  const grid = tsunamiGrid({ preset: 'flat', method: 'dispersive', deep: 5000, width: 5, absorbing: false });
  const initial = grid.eta.reduce((a, b) => a + b, 0) * grid.cell ** 2;
  F.tsunamiStart(grid);
  const dispersive = F.tsunamiStep(160);
  assert.ok(dispersive.eta.every(Number.isFinite));
  assert.ok(Math.abs(dispersive.volume - initial) < .001);
  F.tsunamiStart({ ...grid, method: 0 });
  const shallow = F.tsunamiStep(160);
  const difference = dispersive.eta.reduce((s, v, i) => s + Math.abs(v - shallow.eta[i]), 0) / grid.eta.length;
  assert.ok(difference > .001, `waveform difference ${difference}`);
  assert.throws(() => tsunamiGrid({ method: 'dispersive', preset: 'estuary' }), /local scenes/);
  assert.throws(() => tsunamiGrid({ method: 'dispersive', preset: 'currumbin', bathymetry: readData('currumbin') }), /local scenes/);
});

const dataDir = path.join(__dirname, '../viewer/public/tsunami-data');
const readData = id => JSON.parse(fs.readFileSync(path.join(dataDir, `${id}.json`)));

test('regional runs record their wave at requested points', async () => {
  const { tsunamiGrid } = await gridModule;
  const grid = tsunamiGrid({ preset: 'flat', amplitude: 1, width: 5, source: [40, 48], absorbing: false });
  const rec = F.tsunamiParent(grid, [60, 48.5, 100, 48.5], 600);
  assert.equal(rec.points, 2);
  assert.equal(rec.values.length, rec.times.length * 2);
  assert.ok(rec.times[0] === 0 && rec.times.every((t, i) => i === 0 || t > rec.times[i - 1]));
  assert.ok(rec.time >= 600);
  // The positive lobe reaches the nearer point first.
  const peakAt = p => rec.times[rec.values.filter((_, i) => i % 2 === p).reduce((best, v, k, a) => v > a[best] ? k : best, 0)];
  assert.ok(peakAt(0) < peakAt(1));
  assert.throws(() => F.tsunamiParent(grid, [500, 48], 600), /outside/);
  assert.throws(() => F.tsunamiParent(grid, [60, 48, 70], 600), /pairs/);
  assert.throws(() => F.tsunamiParent(grid, [60, 48], 1e9), /length/);
});

test('boundary forcing is validated at the WASM boundary', async () => {
  const { tsunamiGrid, connectedWaterDepth } = await gridModule;
  const bathymetry = readData('currumbin');
  const grid = tsunamiGrid({ preset: 'currumbin', bathymetry, amplitude: 0, absorbing: false, width: .45, coupled: true });
  assert.equal(grid.coupled, true);
  assert.ok(grid.eta.every(e => e === 0));
  assert.ok(connectedWaterDepth(grid.bed, 160, 96, 0, bathymetry.seaEdges, grid.valid).some(d => d > 2));
  const times = [0, 100];
  assert.throws(() => F.tsunamiStart({ ...grid, forceTimes: times, forceEast: [0, 0, 0] }), /does not match/);
  assert.throws(() => F.tsunamiStart({ ...grid, forceTimes: times, forceEast: [0, NaN] }), /invalid boundary forcing/);
  assert.throws(() => F.tsunamiStart({ ...grid, forceTimes: [5, 1], forceEast: [0, 0] }), /invalid boundary forcing/);
  assert.throws(() => F.tsunamiStart({ ...grid, forceTimes: times, forceWest: [0, 0] }), /no initially wet/);
  assert.equal(F.tsunamiStart({ ...grid, forceTimes: times, forceEast: [0, 0] }).forcingEnd, 100);
  assert.throws(() => tsunamiGrid({ preset: 'shelf', coupled: true }), /local terrain/);
});

// The coupling a one-way run is started with: where the local scene sits in the regional grid, the offshore source, and how long to run (the rest is Rust)
async function regionalCoupling(id, parentId, source, { amplitude = 2.5, localSeconds = 600, seconds, tide = 0, width = 10, cacheKey } = {}) {
  const { tsunamiGrid } = await gridModule;
  const C = await import('../viewer/tsunami-coupling.js');
  const fine = readData(id), parentData = readData(parentId);
  const cell = C.toParentCell(parentData, ...source).map(Math.floor);
  const parentGrid = tsunamiGrid({ preset: parentId, bathymetry: parentData, source: cell, amplitude, width });
  const fineGrid = tsunamiGrid({ preset: id, bathymetry: fine, amplitude, absorbing: true, width: .45, coupled: true });
  return { fine, fineGrid, coupling: { parentGrid, bounds: parentData.bounds, extent: fine.extent, zone: 56, source: cell, seaEdges: fine.seaEdges, localSeconds, tide, ...(seconds && { seconds }), ...(cacheKey && { cacheKey }) } };
}

test('an offshore wave in the regional model drives the nested local model and conserves water', async () => {
  const R = await import('../viewer/tsunami-runner.js');
  for (const [id, parentId, source] of [['currumbin', 'gold-coast', [154.3, -28.0]], ['pine-estuary', 'moreton', [154.3, -27.3]]]) {
    const { fine, fineGrid, coupling: input } = await regionalCoupling(id, parentId, source);
    assert.equal(fineGrid.absorbing, false, 'the sponge would damp the forced signal');
    const { coupling } = R.startRun(F, { grid: fineGrid, coupling: input });
    const order = ['north', 'east', 'south', 'west'];
    assert.deepEqual(Object.keys(coupling.edges), fine.seaEdges.filter(e => order.includes(e)).sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    assert.equal(coupling.source, 'regional');
    assert.ok(coupling.peak > .02 && coupling.arrival > 600 && coupling.offset >= 0 && coupling.offset <= coupling.arrival && coupling.regionalPeak >= coupling.peak / 2, JSON.stringify(coupling));
    assert.ok(coupling.regionalSeconds >= 10800 && coupling.regionalSeconds <= 21600);
    assert.ok(Object.values(coupling.edges).every(e => e.points > 0 && e.peak > 0));
    let result;
    while (!result || result.time < 600) result = F.tsunamiStep(200);
    assert.ok(result.water.every(h => Number.isFinite(h) && h >= 0));
    assert.ok(Math.max(...result.peak) > .005, 'forced wave entered the local model');
    assert.ok(result.boundaryVolume !== 0);
    assert.ok(Math.abs(result.volumeError) < 1e-4, `${id}: ${result.volumeError}`);
    // Control: the same terrain without forcing stays exactly at rest.
    F.tsunamiStart(fineGrid);
    const rest = F.tsunamiStep(200);
    assert.equal(Math.max(...rest.peak), 0);
    assert.ok(rest.speed.every(v => v < 1e-9));
  }
});

test('coupling refuses scenes outside the regional model and runs that never deliver a wave', async () => {
  const R = await import('../viewer/tsunami-runner.js');
  const { tsunamiGrid } = await gridModule;
  // Currumbin lies outside the Moreton Bay regional grid
  const outside = await regionalCoupling('currumbin', 'moreton', [154.3, -27.3]);
  assert.throws(() => R.startRun(F, { grid: outside.fineGrid, coupling: outside.coupling }), /outside the regional/);
  // a source too far for a 30-minute regional run to reach the scene
  const short = await regionalCoupling('currumbin', 'gold-coast', [154.3, -28.0], { seconds: 600 });
  assert.throws(() => R.startRun(F, { grid: short.fineGrid, coupling: short.coupling }), /never reaches/);
  const dry = await regionalCoupling('currumbin', 'gold-coast', [154.3, -28.0]);
  assert.throws(() => R.startRun(F, { grid: dry.fineGrid, coupling: { ...dry.coupling, seaEdges: [] } }), /no open sea edges/);
  void tsunamiGrid;
});

test('two-way nesting runs in the Rust solver: the local model is driven, conserves water, and the regional cells it covers follow it', async () => {
  const R = await import('../viewer/tsunami-runner.js');
  const setup = async (id, parentId, source) => {
    const { fineGrid, coupling } = await regionalCoupling(id, parentId, source, { localSeconds: 900 });
    return (strength) => {
      const run = R.startRun(F, { grid: fineGrid, coupling: { ...coupling, twoWay: { strength } } });
      let frame;
      while (!frame || frame.time < 900) frame = F.tsunamiStep(200);
      return { coupling: run.coupling, frame, parentCells: coupling.parentGrid.W * coupling.parentGrid.H };
    };
  };
  // the 8 km Gold Coast Seaway scene covers a couple of 1.5 km regional cells
  const seaway = await setup('gold-coast-seaway', 'gold-coast', [154.3, -28.0]);
  const one = seaway(0), two = seaway(0.25);
  assert.equal(two.coupling.source, 'regional-two-way');
  assert.ok(two.coupling.handovers >= 1 && two.coupling.offset > 600, `the local clock starts when the wave arrives: ${two.coupling.offset}`);
  for (const r of [one, two]) {
    assert.ok(r.frame.water.every(h => Number.isFinite(h) && h >= 0));
    assert.ok(Math.max(...r.frame.peak) > .005, 'the regional wave entered the local model');
    assert.ok(Math.abs(r.frame.volumeError) < 1e-4, `water conserved: ${r.frame.volumeError}`);
    assert.equal(r.frame.parentEta.length, r.parentCells);
  }
  assert.equal(one.frame.feedbackVolume, 0, 'with no strength nothing is fed back');
  assert.ok(two.frame.feedbackVolume !== 0, 'with strength the regional model takes water from the local one');
  let diff = 0, top = 0;
  for (let i = 0; i < one.parentCells; i++) { diff = Math.max(diff, Math.abs(one.frame.parentEta[i] - two.frame.parentEta[i])); top = Math.max(top, Math.abs(one.frame.parentEta[i])); }
  assert.ok(diff > 0 && diff < top, `the regional wave is changed near the local grid, not overwhelmed: ${diff} of ${top}`);
  assert.ok(Math.max(...two.frame.peak) < 5 * Math.max(...one.frame.peak) && Math.max(...two.frame.peak) > 0.2 * Math.max(...one.frame.peak), 'the local wave stays the same size');
  // the 4 km Currumbin scene is under three regional cells wide: none is covered enough to follow it, so two-way is exactly one-way and says so
  const currumbin = await setup('currumbin', 'gold-coast', [154.3, -28.0]);
  const c1 = currumbin(0), c2 = currumbin(0.25);
  assert.equal(c2.coupling.handovers, 0);
  assert.equal(c2.frame.feedbackVolume, 0);
  assert.ok(c1.frame.eta.every((v, i) => v === c2.frame.eta[i]) && c1.frame.parentEta.every((v, i) => v === c2.frame.parentEta[i]));
});

test('wave series files parse strictly and drive the local model with an optional rising tide', async () => {
  const { tsunamiGrid } = await gridModule;
  const C = await import('../viewer/tsunami-coupling.js');
  const R = await import('../viewer/tsunami-runner.js');
  const parsed = C.parseSeriesCsv('# DART-style export\nseconds,metres\n0,0\n60;0.5\n120\t1.0\n180 0.5\n240,0\n');
  assert.deepEqual([...parsed.times], [0, 60, 120, 180, 240]);
  assert.deepEqual([...parsed.values], [0, .5, 1, .5, 0]);
  for (const bad of ['0,0', '0,0\n0,1', '0,0\n5,abc', '0,0\n5,99', '0,0\n10,1\n5,1']) assert.throws(() => C.parseSeriesCsv(bad), /series|Times|not "seconds|Wave heights/);
  const fine = readData('currumbin');
  const fineGrid = tsunamiGrid({ preset: 'currumbin', bathymetry: fine, amplitude: 0, width: .45, coupled: true });
  const drive = (series, extra = {}) => R.startRun(F, { grid: fineGrid, coupling: { series, seaEdges: fine.seaEdges, localSeconds: 600, tide: 0, ...extra } });
  assert.throws(() => drive({ times: Float64Array.of(0, 60), values: Float64Array.of(0, 0) }), /no wave/);
  assert.throws(() => R.startRun(F, { grid: fineGrid, coupling: { series: parsed, seaEdges: ['west'], localSeconds: 600 } }), /no sea edge/);
  const times = Float64Array.from({ length: 31 }, (_, i) => i * 20);
  const values = Float64Array.from(times, t => .3 * Math.exp(-(((t - 200) / 80) ** 2)));
  const { coupling } = drive({ times, values });
  assert.deepEqual(Object.keys(coupling.edges), ['north', 'east']);
  assert.ok(Math.abs(coupling.arrival - 80) <= 40 && Math.abs(coupling.peak - .3) < 1e-9 && coupling.source === 'series' && coupling.offset === 0);
  let waveOnly;
  while (!waveOnly || waveOnly.time < 600) waveOnly = F.tsunamiStep(200);
  assert.ok(Math.max(...waveOnly.peak) > .1 && Math.abs(waveOnly.volumeError) < 1e-4);
  // A rising tide adds water at the edges on top of the wave, all of it accounted for.
  drive({ times, values }, { tide: 1.0 });
  let withTide;
  while (!withTide || withTide.time < 600) withTide = F.tsunamiStep(200);
  assert.ok(withTide.volume > waveOnly.volume && withTide.boundaryVolume > waveOnly.boundaryVolume);
  assert.ok(Math.abs(withTide.volumeError) < 1e-4);
  assert.throws(() => F.tsunamiStart({ ...fineGrid, levelTimes: [0, 1], level: [0, NaN] }), /invalid sea level/);
});

test('variable-depth dispersion runs on shelf and real coastal grids, conserves displacement volume and differs from shallow water', async () => {
  const { tsunamiGrid } = await gridModule;
  for (const [preset, bathymetry, source] of [['shelf', null, [38, 48]], ['moreton', readData('moreton'), (() => { const d = readData('moreton'); const i = d.elevation.findIndex((z, k) => z < -1500 && k % 160 > 100 && Math.floor(k / 160) === 48); return [i % 160, 48]; })()]]) {
    const grid = tsunamiGrid({ preset, bathymetry, source, method: 'dispersive', width: 5, absorbing: false });
    assert.equal(grid.method, 3);
    const initial = grid.eta.reduce((a, b) => a + b, 0) * grid.cell ** 2;
    F.tsunamiStart(grid);
    let dispersive;
    for (let i = 0; i < 4; i++) dispersive = F.tsunamiStep(16);
    assert.ok(dispersive.eta.every(Number.isFinite));
    assert.ok(dispersive.eta.every((e, i) => grid.depth[i] > 0 || e === 0));
    assert.ok(Math.abs(dispersive.volume - initial) < 1e-3 * Math.max(1, Math.abs(initial)) + .01, `${preset}: ${dispersive.volume} vs ${initial}`);
    F.tsunamiStart({ ...grid, method: 0 });
    let shallow;
    for (let i = 0; i < 4; i++) shallow = F.tsunamiStep(16);
    assert.ok(dispersive.eta.some((e, i) => Math.abs(e - shallow.eta[i]) > 1e-4), `${preset} should differ from shallow water`);
  }
});

test('an ensemble plan brackets each input on its own and in combination, without duplicates', async () => {
  const { ensemblePlan, summarise } = await import('../viewer/tsunami-runner.js');
  const base = { amplitude: 2.5, tide: 0, roughness: .025 };
  const plan = ensemblePlan(base, { amplitudePercent: 50, tideMetres: .5, roughnessPercent: 40, terrainMetres: .5 });
  assert.equal(plan.length, 11);
  assert.deepEqual(plan[0].factors, { amplitude: 2.5, tide: 0, roughness: .025, terrain: 0 });
  assert.equal(new Set(plan.map(m => JSON.stringify(m.factors))).size, plan.length);
  // Every single-input run changes exactly one input.
  for (const m of plan.filter(m => ['amplitude', 'tide', 'roughness', 'terrain'].includes(m.group)))
    assert.equal(Object.keys(m.factors).filter(k => m.factors[k] !== plan[0].factors[k]).length, 1, m.label);
  const severe = plan.find(m => m.id === 'severe').factors, mild = plan.find(m => m.id === 'mild').factors;
  assert.ok(severe.amplitude > mild.amplitude && severe.tide > mild.tide && severe.roughness < mild.roughness && severe.terrain < mild.terrain);
  // Clamping merges runs that would repeat: amplitude cannot exceed 3 m, tide stays within -1..2 m.
  const clamped = ensemblePlan({ amplitude: 3, tide: 2, roughness: 0 }, {}, { terrain: false });
  assert.equal(new Set(clamped.map(m => JSON.stringify(m.factors))).size, clamped.length);
  assert.ok(clamped.every(m => m.factors.amplitude <= 3 && m.factors.tide <= 2 && m.factors.terrain === 0));
  assert.ok(clamped.length < 11);
  assert.ok(ensemblePlan(base, {}, { amplitude: false }).every(m => m.factors.amplitude === 2.5));
  const ranges = summarise([{ arrival: [10, null], gaugePeak: [1, 2], landDepth: 0, floodedHectares: 3, maxSpeed: 1 }, { arrival: [20, null], gaugePeak: [3, 1], landDepth: 2, floodedHectares: 1, maxSpeed: 4 }]);
  assert.deepEqual(ranges.arrival, [{ min: 10, max: 20, missing: 0 }, { min: null, max: null, missing: 2 }]);
  assert.deepEqual([ranges.landDepth.min, ranges.landDepth.max, ranges.floodedHectares.min, ranges.maxSpeed.max], [0, 2, 1, 4]);
});

test('two-way nesting through a 250 m intermediate grid runs, conserves water and hands the coast back to many more regional cells than the local scene alone', async () => {
  const R = await import('../viewer/tsunami-runner.js');
  const { fineGrid, coupling } = await regionalCoupling('gold-coast-seaway', 'gold-coast', [154.3, -28.0], { localSeconds: 900 });
  const run = (twoWay) => {
    const started = R.startRun(F, { grid: fineGrid, coupling: { ...coupling, twoWay } });
    let frame;
    while (!frame || frame.time < 900) frame = F.tsunamiStep(200);
    return { coupling: started.coupling, frame, parentCells: coupling.parentGrid.W * coupling.parentGrid.H };
  };
  const direct = run({ strength: 0.25 }), mid = run({ strength: 0.25, intermediate: { cell: 250, margin: 6000 } }), passive = run({ strength: 0, intermediate: { cell: 250, margin: 6000 } });
  assert.equal(mid.coupling.source, 'regional-two-way');
  assert.ok(mid.coupling.intermediate && mid.coupling.intermediate.cell === 250 && mid.coupling.intermediate.w > 40, JSON.stringify(mid.coupling.intermediate));
  assert.ok(mid.coupling.handovers >= 1 && mid.coupling.offset > 600, `the local clock starts when the wave arrives: ${mid.coupling.offset}`);
  for (const r of [mid, passive]) {
    assert.ok(r.frame.water.every(h => Number.isFinite(h) && h >= 0));
    assert.ok(Math.max(...r.frame.peak) > .005, 'the regional wave entered the local model');
    assert.ok(Math.abs(r.frame.volumeError) < 1e-4, `water conserved: ${r.frame.volumeError}`);
    assert.equal(r.frame.parentEta.length, r.parentCells);
  }
  assert.equal(passive.frame.feedbackVolume, 0, 'with no strength nothing is fed back');
  assert.ok(mid.frame.feedbackVolume !== 0, 'with strength the coarser models take water from the finer ones');
  assert.ok(mid.coupling.intermediate.handovers > 3 * direct.coupling.handovers, `regional cells that follow the intermediate grid (${mid.coupling.intermediate.handovers}) against those that follow the local scene directly (${direct.coupling.handovers})`);
  assert.ok(Math.max(...mid.frame.peak) < 5 * Math.max(...passive.frame.peak) && Math.max(...mid.frame.peak) > 0.2 * Math.max(...passive.frame.peak), 'the local wave stays the same size');
  assert.throws(() => R.startRun(F, { grid: fineGrid, coupling: { ...coupling, twoWay: { strength: 0.25, intermediate: { cell: 5, margin: 6000 } } } }), /invalid intermediate/);
});

test('ensemble runs measure arrival, gauge peaks and flooding, and stronger sources give larger responses', async () => {
  const { tsunamiGrid } = await gridModule;
  const { runMember, ensemblePlan } = await import('../viewer/tsunami-runner.js');
  const fine = readData('currumbin');
  const localSeconds = 300, seen = [];
  const member = async factors => {
    const grid = tsunamiGrid({ preset: 'currumbin', bathymetry: fine, amplitude: factors.amplitude, tide: factors.tide, roughness: factors.roughness, absorbing: true, width: .45, coupled: true });
    const { coupling } = await regionalCoupling('currumbin', 'gold-coast', [154.3, -28.0], { amplitude: factors.amplitude, localSeconds, cacheKey: `currumbin|${factors.amplitude}` });
    return { grid, coupling, seen };
  };
  const plan = ensemblePlan({ amplitude: 2.5, tide: 0, roughness: .025 }, {}, { terrain: false });
  const probes = [[130, 48], [100, 48], [60, 48]].map(([x, y]) => y * 160 + x);
  const run = async id => runMember(F, await member(plan.find(m => m.id === id).factors), { seconds: localSeconds, probes });
  const base = await run('base'), strong = await run('amplitude-high'), again = await run('tide-high');
  assert.ok(base.arrival.some(t => t != null && t >= 0 && t <= localSeconds));
  assert.ok(base.gaugePeak.every(Number.isFinite) && base.maxSpeed > 0);
  assert.ok(strong.gaugePeak[0] > base.gaugePeak[0], `${strong.gaugePeak[0]} vs ${base.gaugePeak[0]}`);
  assert.ok(strong.maxSpeed >= base.maxSpeed && strong.landDepth >= base.landDepth && strong.floodedHectares >= base.floodedHectares);
  assert.ok([base, strong, again].every(r => Math.abs(r.volumeError) < 1e-3 && r.simulated >= localSeconds));
  // The regional run is shared by members that differ only in local settings: the tide member reuses the base member's.
  const { startRun } = await import('../viewer/tsunami-runner.js');
  const again2 = await member(plan.find(m => m.id === 'tide-high').factors);
  assert.equal(startRun(F, again2).coupling.regionalCached, true);
  const other = await member(plan.find(m => m.id === 'amplitude-low').factors);
  assert.equal(startRun(F, other).coupling.regionalCached, false, 'a different source strength is a different regional run');
});

test('the second-order scheme is selectable, stays positive and conservative, and is less diffusive on real terrain', async () => {
  const { tsunamiGrid } = await gridModule;
  assert.throws(() => tsunamiGrid({ preset: 'estuary', scheme: 'third' }), /numerical scheme/);
  assert.equal(tsunamiGrid({ preset: 'estuary', width: .3 }).order, 1);
  assert.equal(tsunamiGrid({ preset: 'estuary', width: .3, scheme: 'second' }).order, 2);
  const fine = readData('currumbin');
  const results = {};
  for (const scheme of ['first', 'second']) {
    const grid = tsunamiGrid({ preset: 'currumbin', bathymetry: fine, source: [135, 30], width: .45, amplitude: 2.5, absorbing: false, scheme });
    F.tsunamiStart(grid);
    let frame;
    while (!frame || frame.time < 300) frame = F.tsunamiStep(200);
    assert.ok(frame.water.every(h => Number.isFinite(h) && h >= 0));
    assert.ok(frame.water.every((h, i) => grid.valid?.[i] !== 0 || h === 0));
    assert.ok(Math.abs(frame.volumeError) < 1e-5, `${scheme}: ${frame.volumeError}`);
    results[scheme] = frame;
  }
  const speed = f => Math.max(...f.speed);
  assert.ok(speed(results.second) > speed(results.first), 'less numerical damping should keep currents stronger');
  // Rest states stay exact under both schemes through the WASM bridge.
  for (const scheme of ['first', 'second']) {
    const grid = tsunamiGrid({ preset: 'currumbin', bathymetry: fine, amplitude: 0, absorbing: false, width: .45, coupled: true, scheme });
    F.tsunamiStart(grid);
    const rest = F.tsunamiStep(200);
    assert.ok(Math.max(...rest.peak) < 1e-9, scheme);
    assert.ok(rest.speed.every(v => v < 1e-9), scheme);
  }
});

// The arithmetic is tested in Rust (rust/flood-core/src/lab.rs, ensemble.rs, series.rs); this is the bridge the lab page and the ensemble use.
test('the lab page numbers come through the WebAssembly bridge', async () => {
  const water = F.waterPoint(Float64Array.from([5, 5, 5, 5, -50, 5, 5, 5, 5]), 3, [2, 2], 10);
  assert.deepEqual(water, [1, 1]);
  assert.equal(F.waterPoint([5, 5], 2, [0, 0], 10), null);
  const stats = F.frameStats(Float32Array.from([0, 0, 4]), Float32Array.from([.5, .001, 2]), Float32Array.from([.1, 3, 0]), Float32Array.from([1, 8, 2]));
  assert.equal(stats.flooded, 1);
  assert.ok(Math.abs(stats.maxLandDepth - .5) < 1e-6 && Math.abs(stats.maxSpeed - 3) < 1e-6 && stats.maxPeak === 8);
  const { terrainFor } = await import('../viewer/tsunami-terrain.js');
  const t = terrainFor({ depth: Float32Array.from([100, 0, 0]), valid: Uint8Array.from([1, 1, 0]), bed: Float64Array.from([-100, 20, 7]) }, null, F);
  assert.deepEqual([t.low, t.high], [-100, 20]);
  assert.deepEqual([...t.colours.slice(0, 3)], [17, 54, 94]);
  assert.deepEqual([...t.colours.slice(6, 9)], [110, 119, 107]);
  assert.deepEqual(F.spans([1, NaN, 3, 4], 2), [{ min: 1, max: 3, missing: 0 }, { min: 4, max: 4, missing: 1 }]);
  assert.deepEqual(F.parseSeries('0,0\n10,1'), { times: Float64Array.from([0, 10]), values: Float64Array.from([0, 1]) });
});
