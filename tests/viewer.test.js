const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const F = require('./model.js');   // wasm engine, like the viewer

// Exercise the shipped viewer routines with small DOM/map/service fixtures.
// Keep their dependencies explicit without loading Leaflet or remote data.
const source = fs.readFileSync(require.resolve('../viewer/app.js'), 'utf8');
function viewer(names, globals) {
  const context = vm.createContext(globals);
  for (const name of names) {
    const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
    assert.ok(start >= 0, `${name} exists`);
    vm.runInContext(source.slice(start, source.indexOf('\n  }', start) + 4), context);
  }
  return context;
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const noop = () => {};
const geo = { west: 0, east: 1, south: 0, north: 1 };

test('web and desktop elevation retain proxy support, with hosted direct fallback', async () => {
  const direct = 'https://services.ga.gov.au/test?request=GetCoverage';
  const broker = 'http://127.0.0.1:8787';
  const proxy = `${broker}/v1/elev?url=${encodeURIComponent(direct)}`;
  for (const scenario of [
    { desktop: false, broker, responses: [200], urls: [proxy] },
    { desktop: true, broker, responses: [200], urls: [proxy] },
    { desktop: false, broker: '', responses: [200], urls: [direct] },
    { desktop: false, broker, responses: ['network', 200], urls: [proxy, direct] },
    { desktop: false, broker, responses: [413, 200], urls: [proxy, direct] },
    { desktop: false, broker, responses: [502, 'network', 200], urls: [proxy, direct, proxy] },
    { desktop: true, broker, responses: ['network', 200], urls: [proxy, proxy] },
  ]) {
    const urls = [];
    const ctx = viewer(['fetchRaster'], {
      isTauri: () => scenario.desktop, BROKER: scenario.broker,
      AbortSignal, RASTER_TIMEOUT_MS: 45000, setTimeout: resolve => resolve(),
      fetch: async url => {
        const result = scenario.responses[urls.length];
        urls.push(url);
        if (result === 'network') throw new TypeError('Failed to fetch');
        return new Response(new ArrayBuffer(4), { status: result, headers: { 'Content-Type': 'image/tiff' } });
      },
      F: { parseSimpleTiff: () => ({ W: 1, H: 1, data: new Float32Array([12]), nodata: -9999 }) },
    });
    const raster = await ctx.fetchRaster(null, null, 1, 1, direct);
    assert.deepEqual(urls, scenario.urls);
    assert.equal(raster.data[0], 12);
  }
});

test('timeline states retain dry gaps between two flood peaks', () => {
  const W = 60, H = 21, dem = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) dem[y * W + x] = 2 + 0.01 * (W - x) + Math.abs(y - 10) * 0.2;
  const a = F.analyse({ W, H, cell: 10, dem }, { streamAreaKm2: 0.001 });
  const s = { gauge: 10 * W + 50, gaugeLevel: 4, bayLevel: 0, upstreamGradient: 0 };
  const opts = { hydro: [[0, 2.2], [2, 4], [4, 2.2], [6, 4], [8, 2.2]], speedKmh: 100 };
  const tl = F.floodTimeline(a, s, opts), w = F.waveSetup(a, s, opts);
  let gaps = 0;
  for (let k = 0; k < tl.steps; k++) {
    const run = F.inundate(a, { ...s, wse: F.waveSurface(a, w, tl.t0 + k * tl.step), bayLevel: w.bayAt(tl.t0 + k * tl.step) });
    for (let c = 0; c < a.N; c++) {
      const wet = !!(run.wet[c] && !a.ocean[c]);
      const bit = 1 << (c & 31), word = k * tl.wordsPerStep + (c >>> 5);
      assert.equal(!!(tl.wetBits[word] & bit), wet);
      assert.equal(!!(tl.deepBits[word] & bit), wet && run.depth[c] >= 0.3);
      if (!wet && tl.firstWet[c] < k && k < tl.lastWet[c]) gaps++;
    }
  }
  assert.ok(gaps > 0, 'the two peaks have intervening dry cells');
});

test('roads reopen and buildings are dry between successive peaks', async () => {
  const { roadNet } = await import('../viewer/roadnet.js'), { timelineAccess } = await import('../viewer/access.js');
  const N = 100, steps = 7, wordsPerStep = Math.ceil(N / 32);
  const wetBits = new Uint32Array(steps * wordsPerStep), deepBits = new Uint32Array(steps * wordsPerStep);
  for (const k of [1, 5]) for (const bits of [wetBits, deepBits]) bits[k * wordsPerStep + (55 >>> 5)] |= 1 << (55 & 31);
  const ctx = viewer(['timelineAccess'], {
    state: { a: { W: 10, H: 10 }, geo: { west: 0, east: .01, south: 0, north: .01 } },
    roadNet, timelineAccessOn: timelineAccess, F,
  });
  const access = ctx.timelineAccess({ steps, t0: 0, step: 1, wordsPerStep, wetBits, deepBits }, {
    bx: [.0055, .0065], by: [.0045, .0045], roads: [{ name: 'River Road' }],
    net: { lat: [.0099, .0045], lon: [.0055, .0055], edges: [[0, 1, 0]] },
  });
  assert.deepEqual(Array.from(access.floodCount), [0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(Array.from(access.closedCount), [0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(Array.from(access.isoCount), [0, 1, 0, 0, 0, 1, 0]);
  assert.equal(access.longest, 1, 'dry gaps break a continuous isolation period');
  assert.deepEqual(plain(access.roads), [
    { name: 'River Road', closes: 1, reopens: 2 },
    { name: 'River Road', closes: 5, reopens: 6 },
  ]);
});

function modelFixture() {
  const area = { key: 'old', n: 1, name: 'Town', gauge: 5, streamAreaKm2: 2.5,
    areaMeta: { local: true, gaugeLatLon: [.9, .1], centerLatLon: [.5, .5], halfKm: 10, kind: 'river' } };
  const state = { areaKey: 'old', areaMeta: area.areaMeta, gauge: 5, streamAreaKm2: 2.5,
    controls: [{ cell: 10, level: 4, label: 'Bridge' }], grid: { W: 4, H: 4 }, geo,
    lmap: { setView: noop } };
  const ctl = { streamArea: { value: '20' }, gaugeLevel: { value: '5' } };
  const areaReg = new Map([['old', area]]);
  const context = {
    state, ctl, areaReg, CTL_KEYS: Object.keys(ctl), reports: [], pins: [], propertyChecks: [], studies: [], selectedNum: 1,
    MODEL_SIZES: [[10, 30], [20, 40]], status: {}, nat: { data: { gauges: [], storages: [] } },
    r5: (x) => Math.round(x * 1e5) / 1e5,
    streamFromSlider: (v) => .02 * Math.pow(10, v * .03),
    $: () => ({ hidden: true }),
    streamCellAt: (lat, lon) => Math.floor((1 - lat) * state.grid.H) * state.grid.W + Math.floor(lon * state.grid.W),
    areaByNumber: (n) => Array.from(areaReg.values()).find((a) => a.n === n), numberUsed: () => false,
    saveStudies: noop, setBusy: noop, syncOutputs: noop, runScenario: noop, ensureRiverGauges: async () => {},
    saveActive: noop, activateArea: noop, renderPlaces: noop, saveSessionSoon: noop, say: noop,
    modelHere: async (lat, lon, opts) => {
      context.lastModel = opts;
      state.grid = { W: 8, H: 8 }; state.gauge = 0; state.controls = [];
      state.streamAreaKm2 = opts.streamAreaKm2;
      state.areaKey = 'new';
      areaReg.set('new', { key: 'new', n: 1 });
      return true;
    },
  };
  return viewer(['cellToLatLon', 'modelPoints', 'restoreModelPoints', 'sessionState', 'restoreSession', 'extendModel'], context);
}

test('session records the current gauge for active and inactive models', () => {
  const ctx = modelFixture();
  let saved = plain(ctx.sessionState()).areas[0];
  assert.deepEqual(saved.gp, [.625, .375]);
  assert.deepEqual(saved.g, [.9, .1], 'original model anchor is retained separately');
  assert.equal(saved.sa, 2.5);
  ctx.state.gauge = 15;
  assert.deepEqual(plain(ctx.sessionState()).areas[0].gp, [.125, .875]);
  const a = ctx.areaReg.get('old');
  Object.assign(a, { grid: ctx.state.grid, geo, controls: ctx.state.controls, ctl: { streamArea: '20' } });
  ctx.state.areaKey = null;
  saved = plain(ctx.sessionState()).areas[0];
  assert.deepEqual(saved.gp, [.625, .375]);
  assert.equal(saved.sa, 2.5);
});

test('extending a model remaps its gauge and level points and keeps the live stream threshold', async () => {
  const ctx = modelFixture();
  assert.equal(await ctx.extendModel(), true);
  assert.equal(ctx.lastModel.streamAreaKm2, 2.5);
  assert.equal(ctx.state.gauge, 27);
  assert.deepEqual(plain(ctx.state.controls), [{ cell: 45, level: 4, label: 'Bridge' }]);
});

test('restoring current and older links analyses with the saved stream threshold', async () => {
  for (const current of [true, false]) {
    const ctx = modelFixture();
    ctx.areaReg.clear();
    const a = { n: 1, name: 'Town', g: [.9, .1], c: [.5, .5], h: 10,
      gp: [.625, .375], cp: [[.375, .625, 4, 'Bridge']], ctl: { streamArea: '20', gaugeLevel: '5' } };
    if (current) a.sa = 2.5;
    assert.equal(await ctx.restoreSession({ v: 1, areas: [a] }, 'test'), true, JSON.stringify(ctx.status));
    assert.equal(ctx.lastModel.streamAreaKm2, current ? 2.5 : ctx.streamFromSlider(20));
    assert.equal(ctx.state.gauge, 27);
    assert.deepEqual(plain(ctx.state.controls), [{ cell: 45, level: 4, label: 'Bridge' }]);
  }
});

test('detailed Brisbane sessions round-trip through the published terrain loader', async () => {
  const ctx = modelFixture();
  const area = ctx.areaReg.get('old');
  area.areaId = 'brisbane';
  area.n = 7;
  area.areaMeta = { id: 'brisbane', bounds_lonlat: [0, 0, 1, 1], brisbaneGauge: true };
  ctx.state.areaId = area.areaId;
  ctx.state.areaMeta = area.areaMeta;
  const saved = plain(ctx.sessionState());
  assert.equal(saved.areas.length, 1);
  assert.equal(saved.areas[0].id, 'brisbane');
  assert.equal(saved.active, 7);
  ctx.areaReg.clear();
  ctx.nextFrame = async () => {};
  ctx.renderEvents = noop;
  ctx.okBuf = (r) => r.arrayBuffer();
  ctx.showError = (s) => assert.fail(s);
  ctx.fetch = async (url) => ({
    json: async () => ({ id: 'brisbane', W: 4, H: 4, cell: 40, bounds_lonlat: [0, 0, 1, 1],
      files: { dem: 'dem.f32', d8: 'd8.u8' }, brisbaneGauge: true, streamAreaKm2: 4 }),
    arrayBuffer: async () => url.endsWith('.f32') ? new Float32Array(16).fill(2).buffer : new Uint8Array(16).buffer,
  });
  ctx.useGrid = async (grid, id, opts) => {
    assert.equal(opts.events, true, 'retain Brisbane event levels');
    assert.equal(grid.d8.length, 16, 'load the published flow directions');
    assert.equal(ctx.state.areaMeta.streamAreaKm2, 2.5, 'restore threshold before analysis');
    Object.assign(ctx.state, { grid, areaId: id, areaKey: id, geo, gauge: 0, controls: [], streamAreaKm2: ctx.state.areaMeta.streamAreaKm2 });
    ctx.areaReg.set(id, { key: id, n: ctx.state.areaMeta.keepN });
  };
  ctx.modelHere = () => assert.fail('detailed terrain must not be rebuilt from live DEM services');
  viewer(['loadArea'], ctx);
  ctx.ctl.gaugeLevel.value = '1';
  assert.equal(await ctx.restoreSession(saved, 'test'), true, JSON.stringify(ctx.status));
  assert.equal(ctx.areaReg.get('brisbane').n, 7);
  assert.equal(ctx.ctl.gaugeLevel.value, '5');
  assert.equal(ctx.state.gauge, 5);
  assert.deepEqual(plain(ctx.state.controls), [{ cell: 10, level: 4, label: 'Bridge' }]);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function timelineFixture(stage) {
  const pending = deferred(), entered = deferred();
  const area = { impact: null }, box = { innerHTML: '' };
  let calls = 0;
  const pause = () => { entered.resolve(); return pending.promise; };
  const ctx = viewer(['runTimeline'], {
    state: { areaKey: 'A', a: {}, gauge: 0 }, areaReg: new Map([['A', area]]), timelineSeq: 0,
    ensureHistory: stage === 'history' ? pause : async () => {},
    countImpact: stage === 'impact' ? pause : async () => {},
    timelineAsync: () => { calls++; return stage === 'worker' ? pause() : Promise.resolve({ gauge: [1, 2], steps: 2, step: 1 }); },
    $: () => box, renderTideRow: noop, scenario: () => ({ gaugeLevel: 5 }), timeOpts: () => ({ baseLevel: 0 }),
    F: { waveSetup: () => ({ routed: null }) }, timelineAccess: () => null,
    renderTimeline: noop, showTimeStep: noop, status: {}, escapeHtml: String,
  });
  return { ctx, area, box, pending, entered, calls: () => calls };
}

for (const stage of ['history', 'impact', 'worker']) {
  test(`timeline abandons a place switched while awaiting ${stage}`, async () => {
    const f = timelineFixture(stage), job = f.ctx.runTimeline();
    await f.entered.promise;
    f.ctx.state.areaKey = 'B';
    f.ctx.state.a = {};
    f.pending.resolve({ gauge: [1, 2] });
    assert.equal(await job, null);
    assert.equal(f.calls(), stage === 'worker' ? 1 : 0);
    assert.equal(f.area.timeline, undefined, 'discard stale results');
    assert.equal(f.ctx.status.timeline, undefined);
  });
}

test('a changed scenario discards a pending timeline and its errors', async () => {
  for (const fails of [false, true]) {
    const f = timelineFixture('worker'), job = f.ctx.runTimeline();
    await f.entered.promise;
    // runScenario invalidates pending work even if the place stays the same.
    viewer(['runScenario'], f.ctx);
    const a = f.ctx.state.a;
    f.ctx.state.a = null;
    f.ctx.runScenario();
    f.ctx.state.a = a;
    f.box.innerHTML = 'new scenario';
    if (fails) f.pending.reject(new Error('stale failure'));
    else f.pending.resolve({ gauge: [1, 2] });
    assert.equal(await job, null);
    assert.equal(f.box.innerHTML, 'new scenario');
    assert.equal(f.area.timeline, undefined);
  }
});

test('a timeline for an unchanged model completes', async () => {
  const f = timelineFixture('worker'), job = f.ctx.runTimeline();
  await f.entered.promise;
  f.pending.resolve({ gauge: [1, 2], steps: 2, step: 1 });
  assert.equal((await job).steps, 2);
  assert.equal(f.area.timeline.steps, 2);
});

test('population estimates use only the covered share of a census area', async () => {
  const { scenarioImpact } = await import('../viewer/impact.js'), { roadNet } = await import('../viewer/roadnet.js');
  const ctx = viewer(['cellOf', 'ringsKm2', 'computeImpact'], {
    scenarioImpact, F, roadNet,
    state: { areaKey: 'a', a: { W: 2, H: 2, N: 4, cell: 1000, ocean: new Uint8Array(4) }, geo,
      run: { wet: new Uint8Array(4).fill(1), depth: new Float32Array(4).fill(1) } },
    $: (id) => ({ value: id === 'floorHeight' ? '.3' : '0' }), damageShare: () => 0,
  });
  const data = { bx: [.25], by: [.75], isHome: [1], isWork: [0], roads: [], sites: [], net: { lat: [] },
    sa1: { pop: [1000], km2: [40], feats: [{}] }, sa1Grid: new Int32Array(4).fill(0), sa1Key: 'a2' };
  assert.equal(ctx.computeImpact(data).people, 100, '4 of 40 km² must not claim all 1,000 residents');
  data.sa1.km2[0] = 4;
  assert.equal(ctx.computeImpact(data).people, 1000, 'full coverage retains the original population');
  data.bx = []; data.by = []; data.isHome = []; data.isWork = []; data.sa1.km2[0] = 40;
  assert.equal(ctx.computeImpact(data).people, 100, 'the land-area fallback is also coverage adjusted');
});

test('impact counts: floor height optional and heavy sweep cached per run', async () => {
  const { scenarioImpact } = await import('../viewer/impact.js'), { roadNet } = await import('../viewer/roadnet.js');
  const ctx = viewer(['cellOf', 'ringsKm2', 'computeImpact'], {
    scenarioImpact, F, roadNet,
    state: { areaKey: 'a', a: { W: 2, H: 2, N: 4, cell: 1000, ocean: new Uint8Array(4) }, geo,
      run: { wet: new Uint8Array(4).fill(1), depth: new Float32Array(4).fill(1) } },
    $: (id) => (id === 'floorUnknown' ? { checked: true } : { value: id === 'floorHeight' ? '.3' : '0' }),
    damageShare: () => 0.4,
  });
  const data = { bx: [.25], by: [.75], isHome: [1], isWork: [0], roads: [], sites: [], net: { lat: [] },
    sa1: { pop: [1000], km2: [4], feats: [{}] }, sa1Grid: new Int32Array(4).fill(0), sa1Key: 'a2' };
  // no floor height known: water-above-floor and damage are skipped
  const unk = ctx.computeImpact(data, true);
  assert.equal(unk.overFloor, null, 'no floor height means no over-floor number');
  assert.equal(unk.damage, null);
  assert.equal(unk.floorH, null);
  assert.equal(unk.people, 1000);
  // a known floor re-enables them, reading the cached building depths
  ctx.$ = (id) => (id === 'floorUnknown' ? { checked: false } : { value: id === 'floorHeight' ? '.3' : '0' });
  const known = ctx.computeImpact(data, true);
  assert.equal(known.overFloor, 1, '1 m of water clears the 0.3 m floor');
  assert.equal(known.damage, 0, 'damageShare runs but the 0 value per building zeroes it');
  assert.equal(ctx.computeImpact(data, true).people, 1000, 'cache hit retains the sweep result');
  data.sa1.km2 = [40]; // at 4 of 40 km² coverage the fresh count would be 100
  assert.equal(ctx.computeImpact(data, true).people, 1000, 'the heavy sweep is reused until the run changes');
  ctx.state.run = { wet: new Uint8Array(4).fill(1), depth: new Float32Array(4).fill(1) };
  assert.equal(ctx.computeImpact(data, true).people, 100, 'a new run invalidates the cache');
});

test('canvas pixels accept worker bytes and ImageData without a typed-array constructor', () => {
  const ctx = viewer(['canvasPixels'], {});
  const canvas = { createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) };
  const storage = new Uint8Array([9, 9, 10, 20, 30, 255, 8]);
  const pixels = storage.subarray(2, 6);
  for (const input of [pixels, { data: pixels }, [10, 20, 30, 255]]) {
    const img = ctx.canvasPixels(canvas, input, 1, 1);
    assert.deepEqual(Array.from(img.data), [10, 20, 30, 255]);
    assert.notEqual(img.data.buffer, storage.buffer);
  }
  assert.throws(() => ctx.canvasPixels(canvas, new Uint8Array(3), 1, 1), /needs 4 RGBA/);
  assert.throws(() => ctx.canvasPixels(canvas, pixels, 0, 1), /positive integers/);
});

test('WASM water composition preserves fractional satellite frequency and returns a numeric count', () => {
  const result = F.composeWater({
    w: 2, h: 1, relief: 0, mode: 0, floodA: 255, streamA: 0,
    cellKm2: 1, streamThr: 1,
    valid: new Uint8Array([1, 1]), ocean: new Uint8Array(2), stream: new Uint8Array([1, 1]),
    acc: new Float32Array([10, 10]), sat: new Float32Array([0.01, 0.05]),
    baseWet: new Uint8Array(2), runWet: new Uint8Array(2), runDepth: new Float32Array(2),
  });
  assert.equal(result.count, 0);
  assert.deepEqual(Array.from(result.rgba), [0, 0, 0, 0, 38, 166, 154, 180]);
});

test('failed national datasets replace the warnings loading placeholder', async () => {
  const box = { innerHTML: 'Loading flood warnings…' };
  const problems = [];
  const ctx = viewer(['loadNationalData', 'renderWarnings'], {
    nat: {}, status: {}, DATA_SOURCE: 'build',
    fetch: async () => new Response('missing', { status: 404 }),
    decodeCompact: value => value,
    renderWatch() {}, renderFeedHealth() {}, runLiveUpdate: (_, draw) => draw(),
    logProblem: (...args) => problems.push(args),
    $: () => box,
  });
  await ctx.loadNationalData();
  assert.equal(ctx.status.national.loaded, true);
  assert.equal(ctx.status.national.gauges, 0);
  assert.match(box.innerHTML, /could not be loaded/);
  assert.equal(problems.length, 1);
});

test('optional HTML fallbacks do not discard national gauges or live warnings', async () => {
  const live = { level: {}, warnings: { ok: true, warnings: [] }, fetched: '2026-10-24T12:25:00Z' };
  const ctx = viewer(['loadNationalData'], {
    nat: {}, status: {}, DATA_SOURCE: 'runtime', BROKER: 'http://broker.test', AbortSignal,
    fetch: async url => {
      if (url.endsWith('/v1/now')) return Response.json(live);
      if (url.endsWith('gauges-core.min.json')) return Response.json({ features: [{ properties: { kind: 'forecast' } }] });
      if (url.endsWith('storages.geojson')) return Response.json({ features: [] });
      if (url.endsWith('readings.json')) return Response.json({ level: {} });
      if (url.endsWith('meta.json')) return Response.json({});
      return new Response('<html>app fallback</html>', { headers: { 'Content-Type': 'text/html' } });
    },
    decodeCompact: value => value,
    requestLiveReadings: async () => live, Response,
    savedReadings: async () => null,
    saveReadings() {}, setTimeout() {}, renderWarnings() {}, renderWatch() {}, renderFeedHealth() {}, runLiveUpdate: (_, draw) => draw(),
    logProblem() { assert.fail('optional files must not fail startup'); },
  });
  await ctx.loadNationalData();
  assert.equal(ctx.status.national.gauges, 1);
  assert.equal(ctx.nat.readingsSource, 'runtime');
  assert.equal(ctx.nat.warnings.ok, true);
});

test('a broken live layer cannot stop other layers updating', async () => {
  const fresh = { level: {}, fetched: '2026-10-25T10:00:00Z', warnings: { ok: true, warnings: [] } };
  const updated = [], problems = [];
  const ctx = viewer(['runLiveUpdate', 'refreshLiveReadings'], {
    DATA_SOURCE: 'runtime', document: { hidden: false }, nat: { readings: { level: {} }, readingsSource: 'runtime' },
    state: {}, status: {}, Response,
    requestLiveReadings: async () => fresh, saveReadings() {},
    renderWarnings() { throw new Error('bad warning geometry'); },
    renderWatch() { updated.push('watch'); }, renderInfo() {},
    drawRoadClosures() { updated.push('roads'); }, drawEmergencyWarnings() {}, drawRainObs() {},
    renderFeedHealth() {}, logProblem: (...args) => problems.push(args), errText: String,
  });
  assert.equal(await ctx.refreshLiveReadings(true), 'new');
  assert.deepEqual(updated, ['watch', 'roads']);
  assert.equal(problems.length, 1);
  assert.match(ctx.nat.layerIssues['Flood warnings'], /bad warning geometry/);
  assert.equal(ctx.nat.readings, fresh);
  assert.equal(ctx.status.liveRefresh.fetched, fresh.fetched);
});

test('an unchanged cached readings response clears the outage without redrawing layers', async () => {
  const fresh = { level: {}, fetched: '2026-10-25T10:00:00Z' };
  let rendered = 0;
  const ctx = viewer(['refreshLiveReadings'], {
    DATA_SOURCE: 'runtime', document: { hidden: false },
    nat: { readings: fresh, readingsSource: 'runtime', readingsFetched: fresh.fetched, readingsSaved: true },
    requestLiveReadings: async () => fresh,
    renderFeedHealth() { rendered++; },
    saveReadings() { assert.fail('unchanged readings need no new saved copy'); },
  });
  assert.equal(await ctx.refreshLiveReadings(), 'same');
  assert.equal(ctx.nat.readings, fresh);
  assert.equal(ctx.nat.readingsSaved, false);
  assert.equal(rendered, 1);
});

test('missing river subset falls back to the full gauge file without duplicating core gauges', async () => {
  const ctx = viewer(['ensureRiverGauges'], {
    riverP: null,
    nat: { data: { gauges: [{ properties: { kind: 'forecast' } }] }, layers: {} }, status: { national: {} },
    fetch: async url => url.endsWith('gauges-river.min.json')
      ? new Response('<html>app fallback</html>')
      : Response.json({ features: [{ properties: { kind: 'forecast' } }, { properties: { kind: 'river' } }] }),
    decodeCompact: value => value,
  });
  await ctx.ensureRiverGauges();
  assert.equal(ctx.status.national.gauges, 2);
});

test('warning gauge rings open the underlying gauge popup and stop map clicks', () => {
  const feature = { geometry: { coordinates: [153, -27] }, properties: { name: 'Test gauge' } };
  let handler, stopped, opened;
  const marker = { bindTooltip() {}, on(_event, callback) { handler = callback; } };
  const L = {
    circleMarker(_point, options) { assert.equal(options.interactive, true); return marker; },
    DomEvent: { stop(event) { stopped = event; } },
  };
  const ctx = viewer(['warningGaugeMarker'], { onDotClick: (...args) => { opened = args; } });
  assert.equal(ctx.warningGaugeMarker(L, {}, feature), marker);
  const event = { latlng: { lat: -27, lng: 153 } };
  handler(event);
  assert.equal(stopped, event);
  assert.equal(opened[0], feature);
  assert.equal(opened[1], event.latlng);
});

test('state dynamic-layer definitions stay JSON when used in image export URLs', () => {
  let options;
  const ctx = viewer(['makeStateOverlay'], {
    window: { L: { esri: { dynamicMapLayer(value) { options = value; return { on() {} }; } } } },
    status: { overlays: {} },
  });
  const definition = [{ id: 1, source: { type: 'mapLayer', mapLayerId: 1 }, minScale: 0, maxScale: 0 }];
  ctx.makeStateOverlay({ name: 'State layer', url: 'https://example.test/MapServer', layers: [1], dynamicLayers: definition });
  const query = new URLSearchParams({ dynamicLayers: options.dynamicLayers });
  assert.deepEqual(JSON.parse(query.get('dynamicLayers')), definition);
});

test('late live readings update warning and tide markers without resetting layer groups', () => {
  const makeGroup = () => ({ items: [], clearLayers() { this.items = []; }, addLayer(item) { this.items.push(item); } });
  const seaGroup = makeGroup(), warningGroup = makeGroup();
  const nat = { layers: { 'Storm tide gauges, live (Qld)': seaGroup, 'Gauges under a current flood warning (BoM)': warningGroup }, readings: {}, data: { gauges: [{ properties: { kind: 'forecast' } }] } };
  let hasWarning = false;
  const ctx = viewer(['updateLiveGaugeLayers'], {
    nat, status: {}, warningsFor: () => hasWarning ? [{}] : [],
    warningGaugeMarker: () => ({ warning: true }), seaPopupHtml() {},
  });
  const L = { layerGroup: makeGroup, circleMarker() { return { bindPopup() {} }; } };
  ctx.updateLiveGaugeLayers(L, {});
  assert.equal(warningGroup.items.length, 0);
  nat.readings.sea = { gauge: { lat: -27, lon: 153, surge: 0.4 } }; hasWarning = true;
  ctx.updateLiveGaugeLayers(L, {});
  assert.equal(nat.layers['Storm tide gauges, live (Qld)'], seaGroup);
  assert.equal(nat.layers['Gauges under a current flood warning (BoM)'], warningGroup);
  assert.equal(seaGroup.items.length, 1);
  assert.equal(warningGroup.items.length, 1);
});
