require('./model.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPool, mapLimit, defaultJobs } = require('../scripts/run-pool.js');
const { runSeries } = require('../scripts/run-series-local.js');

const csv = fs.readFileSync(path.join(__dirname, '../docs/examples/ptha18-southamerica-142847-gauge1450.5.csv'), 'utf8');

test('worker threads give the same results as running in the main thread, whatever the pool size', async () => {
  const { parseSeriesCsv } = await import('../viewer/tsunami-coupling.js');
  const expected = [await runSeries(parseSeriesCsv(csv), 300), await runSeries(parseSeriesCsv(csv), 300, { tide: 0.36, baseline: 0 })];
  for (const size of [1, 2]) {
    const pool = createPool(size);
    try {
      const [plain, tidal, again] = await Promise.all([pool.run(csv, 300), pool.run(csv, 300, { tide: 0.36, baseline: 0 }), pool.run(csv, 300)]);
      assert.deepEqual(plain, expected[0]);
      assert.deepEqual(tidal, expected[1]);
      assert.deepEqual(again, expected[0]);
    } finally { await pool.close(); }
  }
});

test('a bad series rejects its own run only, and a closed pool refuses work', async () => {
  const pool = createPool(2);
  const bad = pool.run('seconds,metres\nnot,numbers\n', 300);
  const good = pool.run(csv, 120);
  await assert.rejects(bad);
  assert.ok((await good).offshorePeak > 0.05);
  await pool.close();
  await assert.rejects(pool.run(csv, 120), /closed/);
  assert.throws(() => createPool(0), /whole number/);
  assert.throws(() => createPool(99), /whole number/);
  assert.ok(defaultJobs() >= 1 && defaultJobs() <= 8);
});

test('mapLimit keeps input order and never exceeds its limit', async () => {
  let running = 0, peak = 0;
  const out = await mapLimit([30, 5, 20, 1, 10, 2], 3, async (ms, i) => {
    running++; peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, ms));
    running--;
    return i * 10;
  });
  assert.deepEqual(out, [0, 10, 20, 30, 40, 50]);
  assert.equal(peak, 3);
  assert.deepEqual(await mapLimit([], 2, async () => 1), []);
  await assert.rejects(mapLimit([1], 0, async () => 1), /whole number/);
  await assert.rejects(mapLimit([1, 2], 2, async x => { if (x === 2) throw new Error('boom'); return x; }), /boom/);
});
