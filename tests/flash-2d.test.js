const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');

// The loss arithmetic is tested in Rust (rust/flood-core/src/flash.rs). This is the bridge: the same storm through FloodCore.effectiveRainSeries.
test('a storm becomes an effective-rain series through the WebAssembly bridge, and refusals come back as errors', () => {
  const r = F.effectiveRainSeries({ rainMm: 100, hours: 1, initialLoss: 15, contLoss: 2.5 }, 2);
  assert.equal(r.stepSeconds, 600); assert.equal(r.series.length, 18); assert.equal(r.seconds, 18 * 600);
  assert.ok(Math.abs(r.effectiveMm - 82.5) < 1e-9 && r.capped === false && r.rainMm === 100 && r.stormHours === 1);
  assert.ok(Math.abs(r.series[0] - 7.5) < 1e-9 && Math.abs(r.series[1] - 97.5) < 1e-9 && r.series.slice(6).every((x) => x === 0));
  assert.ok(F.effectiveRainSeries({ rainMm: 600, hours: 0.5, initialLoss: 0, contLoss: 0 }, 1).capped);
  assert.equal(F.effectiveRainSeries({ rainMm: 100, hours: 1, initialLoss: 15, contLoss: 2.5 }, 1, 3600).series.length, 2);
  assert.equal(F.effectiveRainSeries({ rainMm: 100, hours: 1 }).series.length, 18, 'losses and the run after the rain default');
  assert.throws(() => F.effectiveRainSeries({ rainMm: -1, hours: 1 }), /millimetres/);
  assert.throws(() => F.effectiveRainSeries({ rainMm: 50, hours: 1 }, 9), /6 hours/);
});

// A drifting storm cell, built in Rust inside inertialStart (rust/flood-core/src/rainfield.rs). A cell far wider than the area is the even storm.
test('a drifting storm cell puts down less rain than the even storm, and a very wide one is the even storm', () => {
  const W = 24, H = 16, cell = 100, n = W * H;
  const grid = { W, H, cell, dem: new Float32Array(n), valid: new Uint8Array(n).fill(1) };
  const storm = { rainMm: 60, hours: 1, initialLoss: 10, contLoss: 2 };
  const even = F.effectiveRainSeries(storm, 1);
  const run = (extra) => {
    const started = F.inertialStart(grid, { seconds: even.seconds, rainMmH: 0, roughness: 0.035, initialDepth: 0, inflow: 0, inflowCell: -1,
      stages: new Float64Array(n).fill(NaN), ...extra });
    let r;
    do { r = F.inertialStep(); } while (!r.done);
    return { started, r };
  };
  const reference = run({ rainSeries: even.series, seriesStepS: even.stepSeconds });
  assert.ok(Number.isNaN(reference.started.driftMeanRainMm), 'an even run reports no drift numbers');
  const drift = { stormRainMm: 60, stormHours: 1, afterHours: 1, stepSeconds: 600, initialLoss: 10, contLoss: 2, driftHeadingDeg: 90, driftSpeedKmh: 0 };
  const wide = run({ ...drift, driftSigmaM: 1e7 });
  assert.ok(Math.abs(wide.r.sourceVolume - reference.r.sourceVolume) / reference.r.sourceVolume < 1e-4, `${wide.r.sourceVolume} vs ${reference.r.sourceVolume}`);
  assert.ok(Math.abs(wide.started.driftMeanRainMm - 60) < 1e-3 && Math.abs(wide.started.driftMeanRunoffMm - even.effectiveMm) < 1e-3);
  const cellStorm = run({ ...drift, driftSigmaM: 400 });
  assert.ok(cellStorm.started.driftMeanRainMm < 30 && cellStorm.started.driftMeanRainMm > 0, `${cellStorm.started.driftMeanRainMm}`);
  assert.ok(cellStorm.r.sourceVolume < reference.r.sourceVolume / 2);
  // the water added is the runoff the run reported, over the area
  assert.ok(Math.abs(cellStorm.r.sourceVolume - cellStorm.started.driftMeanRunoffMm / 1000 * n * cell * cell) < 1e-3 * cellStorm.r.sourceVolume + 1e-6);
  assert.ok(Math.abs(cellStorm.r.balanceError) < 1e-6);
  // the rain lands under the cell: its middle holds more water at the peak than a corner does
  assert.ok(cellStorm.r.peak[(H / 2) * W + W / 2] > cellStorm.r.peak[0]);
  assert.throws(() => run({ ...drift, driftSigmaM: 0 }), /storm needs a positive/);
});
