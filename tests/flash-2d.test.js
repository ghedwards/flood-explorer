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
