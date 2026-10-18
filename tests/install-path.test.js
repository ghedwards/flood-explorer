// Exercises the real install() path (fetch + WebAssembly) that tests/model.js
// skips by calling create() directly — regression for the missing
// handleOf/byHandle on the installed FloodCore.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const bytes = fs.readFileSync(path.join(__dirname, '../viewer/flood.wasm'));
  globalThis.self = globalThis;
  globalThis.fetch = async () => new Response(bytes, { headers: { 'content-type': 'application/wasm' } });

  await import('../viewer/flood-core.js');
  await import('../viewer/flood-wasm.js');

  const core = globalThis.FloodCore;
  const { install } = globalThis.FloodWasm;
  await install(core, 'flood.wasm');

  const assert = (ok, msg) => { if (!ok) { console.error('FAIL:', msg); process.exit(1); } console.log('ok:', msg); };
  assert(core.engine === 'rust', 'engine is rust after install');
  assert(typeof core.handleOf === 'function', 'installed FloodCore exposes handleOf');
  assert(typeof core.byHandle === 'function', 'installed FloodCore exposes byHandle');
  assert(typeof core.inundate === 'function' && typeof core.floodTimeline === 'function', 'rust functions installed');

  // round-trip: analyse through the installed core, then handleOf/byHandle
  const W = 24, H = 18, N = W * H;
  const dem = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) dem[y * W + x] = 10 + Math.sin(x / 6) + y * 0.05;
  const a = core.analyse({ W, H, cell: 30, dem, valid: null }, {});
  const h = core.handleOf(a);
  assert(Number.isFinite(h), 'handleOf returns a handle for a fresh analysis');
  const stub = core.byHandle(h);
  const run = core.inundate(stub, { gaugeLevel: dem[a.defaultGauge] + 4, extra: 0, rainMm: 0 });
  assert(run && run.wet && run.wet.length === N, 'inundate works through a byHandle stub');
  console.log('install path OK');
})().catch((err) => {
  console.error('FAIL:', err && err.stack || err);
  process.exit(1);
});
