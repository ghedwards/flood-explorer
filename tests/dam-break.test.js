const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');

const load = () => import('../viewer/dam-break.js');

// A synthetic valley, 100 x 60 cells of 30 m: a flat reservoir (x 5 to 34, 20 cells wide) at 100 m, a wall across it (x 35 to 38, 103 m), and a floodplain below that
// falls 0.1 m a cell with gentle banks.
function valley(W = 100) {
  const H = 60, dem = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const across = Math.abs(y - 29.5);
    let z;
    if (x <= 38) z = x < 35 ? (x >= 5 && across < 10 ? 100 : 100 + Math.max(1, across - 9)) : (across < 12 ? 103 : 105 + (across - 12) * 0.5);
    else z = 94 - 0.1 * (x - 38) + 0.05 * across;
    dem[y * W + x] = z;
  }
  const a = { W, H, cell: 30, dem, valid: new Uint8Array(W * H).fill(1), ocean: new Uint8Array(W * H) };
  const at = (x, y) => y * W + x, gauge = at(20, 30);
  const route = []; for (let x = 20; x <= 39; x++) route.push(at(x, 30));
  const downstream = []; for (let x = 40; x < W - 1; x++) downstream.push(at(x, 30));
  return { a, gauge, route, downstream, dam: { crest: at(38, 30), below: at(39, 30), lake: 100 }, at };
}

test('Froehlich equations give a wider, faster breach for overtopping than piping, and grow with the volume', async () => {
  const m = await load();
  const over = m.froehlich({ volume: 1e7, depth: 15, mode: 'overtopping' }), pipe = m.froehlich({ volume: 1e7, depth: 15, mode: 'piping' });
  assert.ok(Math.abs(over.width / pipe.width - 1.4) < 1e-9);
  assert.ok(over.width > 30 && over.width < 400, `${over.width}`);
  assert.ok(Math.abs(over.seconds / 3600 - 1.14) < 0.1, `a 10 million m3 dam 15 m deep fails in about an hour: ${over.seconds / 3600} h`);
  assert.ok(m.froehlich({ volume: 1e8, depth: 15 }).peak > over.peak && m.froehlich({ volume: 1e7, depth: 25 }).peak > over.peak);
});

test('the plan gives the reservoir a bed that holds the volume, opens a breach through the wall and fits the solver window', async () => {
  const m = await load(), v = valley();
  const plan = m.planDamBreak(v.a, { gauge: v.gauge, dam: v.dam, route: v.route, downstream: v.downstream, volume: 2e6 });
  assert.ok(plan.W <= m.MAX_SIDE && plan.H <= m.MAX_SIDE && plan.W >= 64 && plan.factor === 1);
  assert.ok(Math.abs(plan.volume - 2e6) / 2e6 < 0.02, `the reservoir holds the volume: ${plan.volume}`);
  assert.ok(plan.depth > 3 && plan.depth < plan.wallHeight && Math.abs(plan.wallHeight - 6.1) < 0.2);
  assert.ok(plan.breachCells.length >= 3 && plan.breachCells.every((c, k) => plan.valid[c] && !plan.lake[c] && plan.breachTo[k] <= plan.bed[c]));
  assert.ok(plan.breachTo.every((z) => z >= 100 - plan.depth - 1e-9 || z >= 90), 'never lowered below the reservoir bed or the ground below');
  assert.equal(plan.reservoirCells, 30 * 20);
  // too big a volume is capped by the wall: the plan holds what the wall can
  const big = m.planDamBreak(v.a, { gauge: v.gauge, dam: v.dam, route: v.route, downstream: v.downstream, volume: 5e7 });
  assert.ok(big.volume < 5e7 && Math.abs(big.depth - big.wallHeight) < 1e-9);
  assert.throws(() => m.planDamBreak({ ...v.a, valid: new Uint8Array(v.a.W * v.a.H) }, { gauge: v.gauge, dam: v.dam, route: v.route, volume: 1e6 }));
});

test('the solver carries the reservoir through the breach: water is conserved, the flood runs downstream and arrives later further away, and the peak discharge is the right size', async () => {
  const m = await load(), v = valley();
  for (const mode of ['overtopping', 'piping']) {
    const plan = m.planDamBreak(v.a, { gauge: v.gauge, dam: v.dam, route: v.route, downstream: v.downstream, volume: 2e6, mode, seconds: 2400, timeScale: 0.1 });
    F.tsunamiStart(m.solverGrid(plan));
    let frame = F.tsunamiStep(0), peakQ = 0;
    const column = plan.breachCells.map((c) => c % plan.W).sort((p, q) => p - q)[0], cells = plan.breachCells.filter((c) => c % plan.W === column);
    while (frame.time < plan.seconds) {
      frame = F.tsunamiStep(25);
      let q = 0; for (const c of cells) q += frame.water[c] * frame.speed[c] * plan.cell;
      peakQ = Math.max(peakQ, q);
    }
    assert.ok(Math.abs(frame.volumeError) < 1e-3 * plan.volume, `${mode}: water conserved, error ${frame.volumeError}`);
    frame = F.tsunamiStep(1, true);
    const x = (col) => (plan.breachCells[0] % plan.W) + col, row = Math.floor(plan.breachCells[0] / plan.W);
    const at = (col) => row * plan.W + x(col);
    assert.ok(frame.peakDepth[at(10)] > 0.3 && frame.peakClass[at(10)] >= 1, `${mode}: the flood reaches 10 cells down: ${frame.peakDepth[at(10)]}`);
    const a1 = frame.arrival[at(5)], a2 = frame.arrival[at(15)], a3 = frame.arrival[at(30)];
    assert.ok(a1 > plan.breachStart && a2 > a1 && a3 > a2, `${mode}: arrivals ${a1} ${a2} ${a3}`);
    const froehlich = plan.froehlich.peak; if (process.env.DAM_DEBUG) console.log(mode, 'solver peak', peakQ.toFixed(0), 'Froehlich', froehlich.toFixed(0), 'time to fail', Math.round(plan.breachSeconds));
    assert.ok(peakQ > 0.25 * froehlich && peakQ < 4 * froehlich, `${mode}: solver peak ${peakQ.toFixed(0)} m3/s against Froehlich ${froehlich.toFixed(0)}`);
    // the run on the area model: the reservoir stays dry in the impact tools, the floodplain is wet with hazard and arrival, and the counts add up
    const run = m.runOnArea(v.a, plan, frame);
    assert.ok(run.dam && run.covered > 1000);
    assert.equal(run.depth[v.gauge], 0, 'the reservoir itself is not counted as flooded');
    const below = v.at(50, 30);
    assert.ok(run.depth[below] > 0.3 && run.wet[below] === 1 && run.peakHazard.cls[below] >= 1 && run.arrival[below] > 0);
    assert.ok(run.peakHazard.km2.reduce((s, k) => s + k, 0) > 0.05);
    assert.ok(run.arrival[v.at(60, 30)] > run.arrival[v.at(45, 30)], 'arrival is measured from the start of the breach and grows downstream');
  }
});

test('runDamBreak runs a plan to its length, reports progress and the discharge, and can be stopped', async () => {
  const m = await load(), run = await import('../viewer/dam-run.js'), v = valley();
  const plan = m.planDamBreak(v.a, { gauge: v.gauge, dam: v.dam, route: v.route, downstream: v.downstream, volume: 2e6, seconds: 1200, timeScale: 0.1 });
  assert.equal(run.runSeconds({ breachStart: 60, breachSeconds: 100 }), 4200);
  assert.equal(run.runSeconds({ breachStart: 60, breachSeconds: 6150 }), 10200);
  assert.equal(run.runSeconds({ breachStart: 60, breachSeconds: 90000 }), 21600);
  const progress = [];
  const result = run.runDamBreak(F, plan, { seconds: 1200, onProgress: (p) => progress.push(p) });
  assert.ok(result.seconds >= 1200 && Math.abs(result.volumeError) < 1e-3 * plan.volume);
  assert.ok(result.peakDischarge > 20 && result.peakDischargeAt > plan.breachStart, `${result.peakDischarge} at ${result.peakDischargeAt}`);
  assert.ok(result.extremes.peakDepth.length === plan.W * plan.H && result.extremes.peakClass.length === plan.W * plan.H);
  assert.ok(progress.length === 0 || progress.at(-1).fraction <= 1);
  assert.throws(() => run.runDamBreak(F, plan, { seconds: 1200, shouldStop: () => true }), /cancelled/);
});

test('on a coarser window the thin wall still holds the reservoir until the breach opens', async () => {
  const m = await load(), run = await import('../viewer/dam-run.js'), v = valley(330);
  const plan = m.planDamBreak(v.a, { gauge: v.gauge, dam: v.dam, route: v.route, downstream: v.downstream, volume: 2e6, timeScale: 50 });
  assert.ok(plan.factor >= 2, `the window is coarser than the terrain: factor ${plan.factor}`);
  assert.ok(plan.W <= m.MAX_SIDE && plan.H <= m.MAX_SIDE);
  F.tsunamiStart(m.solverGrid(plan));
  const held = (f) => { let t = 0; plan.lake.forEach((l, i) => { if (l) t += f.water[i]; }); return t * plan.cell * plan.cell; };
  let frame = F.tsunamiStep(0); const start = held(frame);
  while (frame.time < 55) frame = F.tsunamiStep(25);
  assert.ok(Math.abs(held(frame) - start) < 0.002 * start, `nothing leaves before the breach starts: ${start} to ${held(frame)}`);
  assert.ok(run.runSeconds(plan) <= 21600);
});
