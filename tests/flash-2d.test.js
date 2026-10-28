const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../viewer/flash-2d.js');
const sum = a => a.reduce((x, y) => x + y, 0);

test('a one-hour storm loses the initial and continuing loss, as the screening model does', async () => {
  const { effectiveRainSeries } = await load();
  const r = effectiveRainSeries({ rainMm: 100, hours: 1, initialLoss: 15, contLoss: 2.5 }, 2);
  assert.equal(r.series.length, 3); assert.equal(r.seconds, 3 * 3600); assert.equal(r.stormHours, 1);
  assert.ok(Math.abs(r.series[0] - 82.5) < 1e-9 && r.series[1] === 0 && r.series[2] === 0);
  assert.ok(Math.abs(r.effectiveMm - 82.5) < 1e-9);
});

test('a long storm soaks in its first hours, and the total stays within a millimetre of the screening excess', async () => {
  const { effectiveRainSeries } = await load();
  const r = effectiveRainSeries({ rainMm: 100, hours: 6, initialLoss: 15, contLoss: 2.5 }, 2);
  assert.equal(r.series[0], 0, 'the first hour is soaked up (16.7 mm against 15 + 1.7 left to infiltrate)');
  assert.ok(r.series[1] > 14 && r.series[1] < 14.3);
  const screening = Math.max(0, 100 - 15 - 2.5 * 6);
  assert.ok(Math.abs(sum(r.series) - screening) < 1, `${sum(r.series)} vs ${screening}`);
  assert.deepEqual([...r.series.slice(6)], [0, 0]);
});

test('a half-hour storm puts all its rain in the first hour; a storm that is all soaked in has no effective rain', async () => {
  const { effectiveRainSeries } = await load();
  const half = effectiveRainSeries({ rainMm: 40, hours: 0.5, initialLoss: 15, contLoss: 2.5 }, 1);
  assert.equal(half.stormHours, 1); assert.ok(Math.abs(half.series[0] - (40 - 15 - 1.25)) < 1e-9);
  const dry = effectiveRainSeries({ rainMm: 10, hours: 1, initialLoss: 15, contLoss: 2.5 }, 1);
  assert.equal(dry.effectiveMm, 0);
});

test('rates are capped at the solver limit, and bad storms are refused', async () => {
  const { effectiveRainSeries, peakRate, MAX_RATE } = await load();
  const r = effectiveRainSeries({ rainMm: 1500, hours: 0.5, initialLoss: 0, contLoss: 0 }, 1);
  assert.equal(r.series[0], MAX_RATE); assert.ok(r.capped); assert.equal(peakRate(r.series), MAX_RATE);
  assert.ok(!effectiveRainSeries({ rainMm: 100, hours: 1, initialLoss: 0, contLoss: 0 }).capped);
  assert.throws(() => effectiveRainSeries({ rainMm: -1, hours: 1 }), /millimetres/);
  assert.throws(() => effectiveRainSeries({ rainMm: 50, hours: 30 }), /24 hours/);
  assert.throws(() => effectiveRainSeries({ rainMm: 50, hours: 1 }, 9), /6 hours/);
});
