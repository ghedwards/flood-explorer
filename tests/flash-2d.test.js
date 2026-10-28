const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../viewer/flash-2d.js');
const mm = (r) => r.series.reduce((x, rate) => x + rate * r.stepSeconds / 3600, 0);   // the runoff the series puts down

test('a one-hour storm loses the initial and continuing loss, as the screening model does, in 10-minute steps', async () => {
  const { effectiveRainSeries } = await load();
  const r = effectiveRainSeries({ rainMm: 100, hours: 1, initialLoss: 15, contLoss: 2.5 }, 2);
  assert.equal(r.stepSeconds, 600); assert.equal(r.series.length, 6 + 12); assert.equal(r.seconds, 18 * 600);
  assert.ok(Math.abs(r.effectiveMm - 82.5) < 1e-9 && Math.abs(mm(r) - 82.5) < 1e-9, 'the same 82.5 mm of runoff the screening model gives');
  assert.ok(Math.abs(r.series[0] - 7.5) < 1e-9, 'the first 10 minutes soak up the initial loss: 16.7 mm of rain, 15 absorbed, 0.4 soaked, 1.25 mm left, 7.5 mm/h');
  assert.ok(Math.abs(r.series[1] - 97.5) < 1e-9, 'then (16.7 - 0.4) mm a step, 97.5 mm/h');
  assert.deepEqual([...r.series.slice(6)], new Array(12).fill(0));
});

test('a long storm soaks in its first stretch, and the total is the screening excess', async () => {
  const { effectiveRainSeries } = await load();
  const r = effectiveRainSeries({ rainMm: 100, hours: 6, initialLoss: 15, contLoss: 2.5 }, 2);
  assert.equal(r.series.length, 36 + 12);
  assert.ok(r.series.slice(0, 5).every((x) => x < 6), 'the first hour is mostly soaked up');
  const screening = Math.max(0, 100 - 15 - 2.5 * 6);
  assert.ok(Math.abs(mm(r) - screening) < 1e-9, `${mm(r)} vs ${screening}`);
  assert.ok(r.series.slice(36).every((x) => x === 0));
});

test('a half-hour storm is three steps, not all its rain in the first hour; a storm that is all soaked in has no effective rain', async () => {
  const { effectiveRainSeries } = await load();
  const half = effectiveRainSeries({ rainMm: 40, hours: 0.5, initialLoss: 15, contLoss: 2.5 }, 1);
  assert.equal(half.series.length, 3 + 6); assert.ok(half.series.slice(3).every((x) => x === 0));
  assert.ok(Math.abs(mm(half) - (40 - 15 - 1.25)) < 1e-9);
  assert.ok(half.series[2] > half.series[0], 'the loss is taken from the early minutes, so the later minutes carry more runoff');
  const dry = effectiveRainSeries({ rainMm: 10, hours: 1, initialLoss: 15, contLoss: 2.5 }, 1);
  assert.equal(dry.effectiveMm, 0);
  const hourly = effectiveRainSeries({ rainMm: 100, hours: 1, initialLoss: 15, contLoss: 2.5 }, 1, 3600);
  assert.equal(hourly.series.length, 2); assert.ok(Math.abs(hourly.series[0] - 82.5) < 1e-9, 'a 60-minute step is the old hourly series');
});

test('rates are capped at the solver limit, and bad storms and steps are refused', async () => {
  const { effectiveRainSeries, peakRate, MAX_RATE } = await load();
  const r = effectiveRainSeries({ rainMm: 600, hours: 0.5, initialLoss: 0, contLoss: 0 }, 1);
  assert.equal(r.series[0], MAX_RATE, '600 mm in half an hour is 1,200 mm/h: capped'); assert.ok(r.capped); assert.equal(peakRate(r.series), MAX_RATE);
  assert.ok(!effectiveRainSeries({ rainMm: 400, hours: 0.5, initialLoss: 0, contLoss: 0 }, 1).capped, '400 mm in half an hour is 800 mm/h: under the limit');
  assert.ok(!effectiveRainSeries({ rainMm: 100, hours: 1, initialLoss: 0, contLoss: 0 }).capped);
  assert.throws(() => effectiveRainSeries({ rainMm: -1, hours: 1 }), /millimetres/);
  assert.throws(() => effectiveRainSeries({ rainMm: 50, hours: 30 }), /24 hours/);
  assert.throws(() => effectiveRainSeries({ rainMm: 50, hours: 1 }, 9), /6 hours/);
  assert.throws(() => effectiveRainSeries({ rainMm: 50, hours: 1 }, 2, 10), /1 to 60 minutes/);
});
