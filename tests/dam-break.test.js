const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');

// The planning, the solver and the mapping onto the area model are tested in Rust (rust/flood-core/src/dam.rs). This is the bridge: the same dam through
// FloodCore.damStart / damStep / damFinish, and the page's helpers around it.
const load = () => import('../viewer/dam-break.js');
const run = () => import('../viewer/dam-run.js');

// A synthetic valley, 100 x 60 cells of 30 m: a flat reservoir (x 5 to 34, 20 cells wide) at 100 m, a wall across it (x 35 to 38, 103 m), a floodplain below.
function valley(W = 100) {
  const H = 60, dem = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const across = Math.abs(y - 29.5);
    dem[y * W + x] = x <= 38 ? (x < 35 ? (x >= 5 && across < 10 ? 100 : 100 + Math.max(1, across - 9)) : (across < 12 ? 103 : 105 + (across - 12) * 0.5)) : 94 - 0.1 * (x - 38) + 0.05 * across;
  }
  const at = (x, y) => y * W + x;
  const route = []; for (let x = 20; x <= 39; x++) route.push(at(x, 30));
  const downstream = []; for (let x = 40; x < W - 1; x++) downstream.push(at(x, 30));
  return {
    at, area: { W, H, cell: 30, dem, valid: new Uint8Array(W * H).fill(1), ocean: new Uint8Array(W * H) },
    params: { gauge: at(20, 30), crest: at(38, 30), below: at(39, 30), lake: 100, route: Float64Array.from(route), downstream: Float64Array.from(downstream), volume: 2e6, mode: 0, timeScale: 0.1 },
  };
}

test('a dam failure runs through the WebAssembly bridge and lands on the area model', async () => {
  const m = await load(), r = await run(), v = valley();
  const planned = [], progress = [];
  const out = r.runDamBreak(F, v.area, v.params, { onPlan: (p) => planned.push(p), onProgress: (p) => progress.push(p) });
  const plan = out.plan;
  assert.equal(planned.length, 1);
  assert.ok(plan.W >= 64 && plan.W <= 256 && plan.factor === 1 && Math.abs(plan.volume - 2e6) / 2e6 < 0.02 && plan.reservoirCells === 600);
  assert.ok(plan.seconds >= 3600 && plan.seconds <= 21600 && plan.seconds % 600 === 0 && out.seconds >= plan.seconds);
  assert.ok(Math.abs(out.volumeError) < 1e-3 * plan.volume, `water conserved: ${out.volumeError}`);
  assert.ok(out.peakDischarge > 0.25 * plan.froehlichPeak && out.peakDischarge < 4 * plan.froehlichPeak && out.peakDischargeAt > plan.breachStart, `${out.peakDischarge} against ${plan.froehlichPeak}`);
  assert.ok(progress.every((p) => p.fraction >= 0 && p.fraction <= 1));
  const flood = m.floodRun(out.result);
  assert.equal(flood.depth.length, v.area.W * v.area.H);
  assert.equal(flood.depth[v.params.gauge], 0, 'the reservoir itself is not counted as flooded');
  const below = v.at(50, 30);
  assert.ok(flood.depth[below] > 0.3 && flood.wet[below] === 1 && flood.peakHazard.cls[below] >= 1 && flood.arrival[below] > 0 && Number.isFinite(flood.level[below]));
  assert.ok(flood.peakHazard.km2.reduce((s, k) => s + k, 0) > 0.05 && flood.covered > 1000 && flood.dam === true);
  assert.ok(flood.wse instanceof Float64Array && flood.wse.length === flood.depth.length);
  assert.match(m.damText(plan), /million m³ held at .* m deep behind a .* m wall; breach .* m wide, opening over .* min/);
  assert.deepEqual(Object.keys(m.BREACH_MODES), ['overtopping', 'piping']);
});

test('the bridge refuses a dam it cannot plan and a run that was not started', async () => {
  const r = await run(), v = valley();
  assert.throws(() => F.damStart(v.area, { ...v.params, volume: -1 }), /invalid dam description/);
  assert.throws(() => F.damStart({ ...v.area, dem: v.area.dem.slice(1) }, v.params), /do not match/);
  assert.throws(() => F.damStart({ ...v.area, valid: new Uint8Array(v.area.W * v.area.H) }, v.params), /too small/);
  assert.throws(() => r.runDamBreak(F, v.area, v.params, { shouldStop: () => true }), /cancelled/);
  assert.throws(() => F.damStep(500), /invalid dam-break step count/);
});
