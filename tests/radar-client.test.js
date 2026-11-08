const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');
const api = import('../viewer/radar-client.js');

const N = 100, ZONE = 56;
// a 100 km radar of 1 km cells, top-left at (450 000 E, 7 010 000 N), with a 40 mm/h rain cell at (e, n)
const blob = (e, n) => Array.from({ length: N * N }, (_, k) => {
  const ce = 450000 + ((k % N) + 0.5) * 1000, cn = 7010000 - (Math.floor(k / N) + 0.5) * 1000;
  return Math.round(400 * Math.exp(-((ce - e) ** 2 + (cn - n) ** 2) / (2 * 3000 * 3000)));
});
const body = (over = {}) => ({
  status: 'ok', source: 'Test radar', attribution: 'Test attribution', licence: 'Test licence', crs: 'EPSG:28356',
  grid: { w: N, h: N, x0: 450000, y0: 7010000, dx: 1000, dy: 1000 }, unit: 'tenths of mm/h; -1 means missing, not dry',
  times: Array.from({ length: 7 }, (_, k) => `2026-11-08T05:${String(k * 10).padStart(2, '0')}:00Z`), ageSeconds: 300, stepSeconds: 600, regular: true,
  frames: Array.from({ length: 7 }, (_, k) => blob(480000 + 1500 * k, 6960000)), ...over,
});
const geoAround = (e, n, half = 5000) => { const [s, w] = F.fromMga(e - half, n - half, ZONE), [no, ea] = F.fromMga(e + half, n + half, ZONE); return { west: w, east: ea, north: no, south: s }; };
const reply = (status, json) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => json });

test('MGA zones are read from EPSG codes and anything else is refused', async () => {
  const { mgaZone } = await api;
  assert.equal(mgaZone('EPSG:28356'), 56); assert.equal(mgaZone('EPSG:7856'), 56); assert.equal(mgaZone('epsg:28349'), 49); assert.equal(mgaZone('EPSG:7859'), 59);
  for (const bad of ['EPSG:4326', 'EPSG:3857', 'EPSG:28348', 'EPSG:28359', 'MGA56', '', null, undefined]) assert.equal(mgaZone(bad), null, String(bad));
});

test('the window around an area covers its corners and the margin', async () => {
  const { radarWindow } = await api;
  const geo = geoAround(500000, 6960000);
  const [e0, n0, e1, n1] = radarWindow(geo, ZONE, F.toMga, 60000);
  assert.ok(Math.abs(e0 - (495000 - 60000)) < 50 && Math.abs(e1 - (505000 + 60000)) < 50, `${e0} ${e1}`);
  assert.ok(Math.abs(n0 - (6955000 - 60000)) < 50 && Math.abs(n1 - (6965000 + 60000)) < 50, `${n0} ${n1}`);
});

test('a good answer is joined for the solver, and every kind of bad radar is an error with a code', async () => {
  const { readRadar, RadarError } = await api;
  const ok = readRadar(body(), ZONE);
  assert.equal(ok.radar.radarFrames.length, 7 * N * N); assert.equal(ok.radar.radarStepS, 600); assert.equal(ok.info.licence, 'Test licence'); assert.equal(ok.zone, 56);
  const code = (b) => { try { readRadar(b, ZONE); } catch (e) { assert.ok(e instanceof RadarError); return e.code; } return null; };
  assert.equal(code(body({ status: 'stale', ageSeconds: 4000 })), 'stale');
  assert.equal(code(body({ ageSeconds: 4000 })), 'stale', 'age is checked even if the status says ok');
  assert.equal(code(body({ regular: false, stepSeconds: null })), 'bad-data');
  assert.equal(code(body({ frames: [blob(0, 0)] })), 'bad-data');
  assert.equal(code(body({ frames: body().frames.map((f, k) => (k === 2 ? f.slice(1) : f)) })), 'bad-data');
  const gappy = body(); gappy.frames[3][17] = -1;
  assert.equal(code(gappy), 'gaps');
  const nan = body(); nan.frames[1][5] = null;
  assert.equal(code(nan), 'bad-data');
  assert.equal(code(body({ grid: { w: N, h: N, x0: 0, y0: 0, dx: 0, dy: 1 } })), 'bad-data');
  assert.equal(code(body({ status: 'weird' })), 'bad-data');
});

test('fetching asks for the radar\'s coordinate system first, then a window, and explains each failure', async () => {
  const { fetchRadar } = await api;
  const geo = geoAround(500000, 6960000);
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    if (url.includes('meta=1')) return { ok: true, status: 200, json: async () => ({ status: 'ok', crs: 'EPSG:28356' }) };
    return { ok: true, status: 200, json: async () => body() };
  };
  const got = await fetchRadar({ broker: 'https://b.example/', geo, toMga: F.toMga, fetchFn });
  assert.equal(got.zone, 56); assert.equal(urls.length, 2);
  assert.match(urls[0], /^https:\/\/b\.example\/v1\/radar\?meta=1$/);
  assert.match(urls[1], /^https:\/\/b\.example\/v1\/radar\?frames=7&bbox=-?\d+,-?\d+,-?\d+,-?\d+$/);
  const fail = async (opts) => { try { await fetchRadar({ broker: 'https://b.example', geo, toMga: F.toMga, ...opts }); } catch (e) { return e; } return null; };
  assert.equal((await fail({ broker: '' })).code, 'unconfigured');
  assert.equal((await fail({ fetchFn: reply(404, { status: 'unconfigured' }) })).code, 'unconfigured');
  assert.equal((await fail({ fetchFn: reply(503, { status: 'empty' }) })).code, 'unavailable');
  assert.match((await fail({ fetchFn: reply(503, { status: 'empty' }) })).message, /not treated as dry/);
  assert.equal((await fail({ fetchFn: reply(502, { error: 'x' }) })).code, 'unavailable');
  assert.equal((await fail({ fetchFn: async () => { throw new TypeError('offline'); } })).code, 'network');
  assert.equal((await fail({ fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', crs: 'EPSG:4326' }) }) })).code, 'unsupported-crs');
  const outside = async (url) => (url.includes('meta=1') ? { ok: true, status: 200, json: async () => ({ status: 'ok', crs: 'EPSG:28356' }) } : { ok: false, status: 404, json: async () => ({ status: 'outside' }) });
  assert.equal((await fail({ fetchFn: outside })).code, 'outside');
});

test('a live storm from radar frames runs through the solver and conserves water', async () => {
  const { readRadar } = await api;
  const { radar } = readRadar(body(), ZONE);
  const geo = geoAround(500000, 6960000);
  const W = 40, H = 40, n = W * H;
  const grid = { W, H, cell: 250, dem: new Float32Array(n), valid: new Uint8Array(n).fill(1) };
  const started = F.inertialStart(grid, { seconds: 600, rainMmH: 0, roughness: 0.035, initialDepth: 0, inflow: 0, inflowCell: -1, stages: new Float64Array(n).fill(NaN),
    ...radar, radarZone: ZONE, geoWest: geo.west, geoEast: geo.east, geoNorth: geo.north, geoSouth: geo.south, radarHorizonS: 3600, afterHours: 1, initialLoss: 5, contLoss: 1 });
  assert.equal(started.radarObservedSteps, 6); assert.equal(started.radarForecastSteps, 6); assert.equal(started.radarSeconds, 18 * 600, 'observed + forecast + an hour dry');
  assert.equal(started.radarMotionReliable, 1);
  assert.ok(Math.abs(started.radarMotionU - 2.5) < 0.25 && Math.abs(started.radarMotionV) < 0.25, `${started.radarMotionU}, ${started.radarMotionV}`);
  assert.ok(started.radarMinKnownShare > 0.9 && started.radarObservedRainMm > 0 && started.radarForecastRainMm > 0 && started.radarRunoffMm > 0 && started.radarRunoffMm < started.radarObservedRainMm + started.radarForecastRainMm);
  let r;
  do { r = F.inertialStep(); } while (!r.done);
  assert.equal(r.time, 18 * 600, 'the run is as long as the live storm, not the seconds that were passed');
  // the water put on the area is the runoff the build reported, over its cells
  assert.ok(Math.abs(r.sourceVolume - started.radarRunoffMm / 1000 * n * 250 * 250) < 1e-3 * r.sourceVolume, `${r.sourceVolume}`);
  assert.ok(Math.abs(r.balanceError) < 1e-6 * r.sourceVolume + 1e-6);
  // a gap in the data is an error from the model too, never dry
  const gappy = Float64Array.from(radar.radarFrames); gappy[N * N + 3] = -1;
  assert.throws(() => F.inertialStart(grid, { seconds: 600, rainMmH: 0, roughness: 0.035, initialDepth: 0, inflow: 0, inflowCell: -1, stages: new Float64Array(n).fill(NaN),
    ...radar, radarFrames: gappy, radarZone: ZONE, geoWest: geo.west, geoEast: geo.east, geoNorth: geo.north, geoSouth: geo.south, radarHorizonS: 3600 }), /no measurement/);
});

// The real broker binary serving a folder, read by the real client: the wire format both ways (skipped if the broker is not built).
test('the page client reads what the real broker serves, including a cropped window and an empty store', async (t) => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawn } = require('node:child_process');
  const bin = path.join(__dirname, '../rust/target/debug/flood-broker');
  if (!fs.existsSync(bin)) { t.skip('flood-broker is not built (cargo build -p flood-broker)'); return; }
  const { fetchRadar, RadarError } = await api;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flood-radar-contract-'));
  const port = 20000 + (process.pid % 20000);
  const child = spawn(bin, [], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', RADAR_DIR: dir, FLOOD_SETTINGS: path.join(dir, 'none.ini') }, stdio: 'ignore' });
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const broker = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${broker}/health`)).ok) break; } catch (e) { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); }
  const geo = geoAround(500000, 6960000);
  // nothing in the store yet: an error the client explains, not an empty radar
  await assert.rejects(fetchRadar({ broker, geo, toMga: F.toMga }), (e) => e instanceof RadarError && e.code === 'unavailable');
  // 7 frames ending a minute ago, as the broker's clock sees them
  const now = Date.now(), frames = [];
  for (let k = 0; k < 7; k++) {
    const t = new Date(now - 60000 - (6 - k) * 600000), name = `f${k}.f32`, vals = blob(480000 + 1500 * k, 6960000);
    const buf = Buffer.alloc(N * N * 4); vals.forEach((v, i) => buf.writeFloatLE(v / 10, i * 4));
    fs.writeFileSync(path.join(dir, name), buf);
    frames.push({ time: t.toISOString().replace(/\.\d+Z$/, 'Z'), file: name });
  }
  fs.writeFileSync(path.join(dir, 'radar.json'), JSON.stringify({ source: 'Contract radar', attribution: 'A', licence: 'L', crs: 'EPSG:28356', grid: { w: N, h: N, x0: 450000, y0: 7010000, dx: 1000, dy: 1000 }, frames }));
  const got = await fetchRadar({ broker, geo, toMga: F.toMga });
  assert.equal(got.zone, 56); assert.equal(got.info.licence, 'L'); assert.equal(got.info.frames, 7);
  // the window is the area plus 60 km each way: 130 km wide would exceed the 100 km radar, so it is clipped to it
  assert.equal(got.radar.radarW, N); assert.equal(got.radar.radarH, N);
  assert.equal(got.radar.radarX0, 450000); assert.equal(got.radar.radarY0, 7010000);
  assert.equal(got.radar.radarFrames[3 * N * N + 52 * N + 50], blob(480000 + 1500 * 3, 6960000)[52 * N + 50], 'values survive the round trip as tenths');
  // and the model can run what the broker served
  const n = 40 * 40;
  const started = F.inertialStart({ W: 40, H: 40, cell: 250, dem: new Float32Array(n), valid: new Uint8Array(n).fill(1) }, { seconds: 600, rainMmH: 0, roughness: 0.035, initialDepth: 0, inflow: 0, inflowCell: -1,
    stages: new Float64Array(n).fill(NaN), ...got.radar, radarZone: got.zone, geoWest: geo.west, geoEast: geo.east, geoNorth: geo.north, geoSouth: geo.south, radarHorizonS: 3600 });
  assert.equal(started.radarMotionReliable, 1); assert.ok(Math.abs(started.radarMotionU - 2.5) < 0.25);
  // a window beyond the radar is reported as outside
  const far = geoAround(900000, 6000000);
  await assert.rejects(fetchRadar({ broker, geo: far, toMga: F.toMga }), (e) => e.code === 'outside');
  // frames that go stale are refused: rewrite the manifest with old times
  const old = frames.map((f, k) => ({ ...f, time: new Date(now - 4 * 3600000 - (6 - k) * 600000).toISOString().replace(/\.\d+Z$/, 'Z') }));
  fs.writeFileSync(path.join(dir, 'radar.json'), JSON.stringify({ source: 'Contract radar', attribution: 'A', licence: 'L', crs: 'EPSG:28356', grid: { w: N, h: N, x0: 450000, y0: 7010000, dx: 1000, dy: 1000 }, frames: old }));
  await assert.rejects(fetchRadar({ broker, geo, toMga: F.toMga }), (e) => e.code === 'stale');
});
