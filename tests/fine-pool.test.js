// The 5 m picture split into bands of rows and joined (viewer/fine-pool.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');
const { scene } = require('./fine-scene.js');

(async () => {
  const { fineWindow, cropGrid } = await import('../viewer/fine-raster.js'), { fineRaster } = require('./fine-raster-reference.js');
  const { planBands, bandParams, stitch, createFinePool } = await import('../viewer/fine-pool.js');
  const fine = { fineWindow, cropGrid };
  const same = (a, b) => Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));

  // stand-in workers: draw the band they are sent (like fine-worker.js) after a tick
  const fakeWorker = (draw = fineRaster, log = []) => () => {
    const w = {
      terminated: false,
      postMessage({ id, p }) {
        log.push(p);
        setTimeout(() => {
          try { const { rgba, have } = draw(p); w.onmessage({ data: { id, rgba, have } }); } catch (e) { w.onmessage({ data: { id, error: String(e.message) } }); }
        }, 1);
      },
      terminate() { w.terminated = true; },
    };
    return w;
  };

  test('bands cover the picture once, none thinner than the minimum, at most one per worker', () => {
    for (const [H, workers, minRows] of [[70, 3, 20], [1800, 3, 200], [1799, 4, 200], [150, 3, 200], [10, 0, 1], [1000, 7, 100], [1, 5, 1]]) {
      const bands = planBands(H, workers, minRows);
      assert.ok(bands.length >= 1 && bands.length <= Math.max(1, workers), `${H}/${workers}: ${bands.length}`);
      assert.equal(bands[0][0], 0);
      assert.equal(bands.at(-1)[1], H);
      bands.forEach(([from, to], i) => { assert.ok(to > from); if (i) assert.equal(from, bands[i - 1][1]); });
      if (bands.length > 1) assert.ok(bands.every(([from, to]) => to - from >= minRows), `${H}/${workers}`);
    }
    assert.deepEqual(planBands(150, 3, 200), [[0, 150]]);
    assert.deepEqual(planBands(1800, 3, 200), [[0, 600], [600, 1200], [1200, 1800]]);
  });

  test('a band carries only its own LiDAR rows, and the whole picture is passed as is', () => {
    const p = scene(5, fine, { hazard: true, baseline: true, level: true, window: true });
    assert.equal(bandParams(p, 0, p.H), p);
    const b = bandParams(p, 10, 40);
    assert.equal(b.rowFrom, 10);
    assert.equal(b.rowTo, 40);
    assert.equal(b.lidar.length, p.W * 30);
    assert.equal(b.lidar.buffer.byteLength, p.W * 30 * 4, 'a copy of the band, not a view of the whole');
    assert.deepEqual(Array.from(b.lidar.slice(0, 3)), Array.from(p.lidar.slice(10 * p.W, 10 * p.W + 3)).map((v) => v), 'the band starts at its first row');
    assert.equal(b.dem, p.dem);
  });

  test('bands drawn apart and joined are the same picture, in JavaScript and in Rust', () => {
    let seed = 40, checked = 0;
    for (const draw of [fineRaster, F.fineRaster]) for (const hazard of [false, true]) for (const baseline of [false, true]) for (const level of [false, true]) {
      const p = scene(seed++, fine, { hazard, baseline, level, window: hazard !== level });
      const whole = draw(p);
      for (const cuts of [[0, 70], [0, 1, 70], [0, 23, 24, 51, 70], [0, 35, 70]]) {
        const parts = cuts.slice(1).map((to, i) => draw(bandParams(p, cuts[i], to)));
        const joined = stitch(parts, p.W, p.H);
        assert.equal(joined.have, whole.have, `have, cuts ${cuts}`);
        assert.ok(same(joined.rgba, whole.rgba), `pixels, cuts ${cuts}`);
        checked++;
      }
    }
    assert.equal(checked, 64);
  });

  test('stitching rejects bands that do not fit', () => {
    const band = (rows) => ({ rgba: new Uint8ClampedArray(rows * 5 * 4), have: 1 });
    assert.equal(stitch([band(2), band(3)], 5, 5).have, 2);
    assert.throws(() => stitch([band(2), band(2)], 5, 5), /do not cover/);
    assert.throws(() => stitch([band(4), band(4)], 5, 5), /taller/);
  });

  test('the pool gives the same picture as one worker, uses a worker per band, and reuses them', async () => {
    const p = scene(77, fine, { hazard: true, baseline: true, level: true, window: true });
    const sent = [];
    const pool = createFinePool({ makeWorker: fakeWorker(fineRaster, sent), size: 3, minRows: 20, minPixels: 0, fallback: fineRaster });
    const a = await pool.compute(p);
    assert.equal(a.worker, true);
    assert.equal(pool.workers, 3);
    assert.deepEqual(sent.map((q) => [q.rowFrom, q.rowTo]), [[0, 23], [23, 46], [46, 70]]);
    const whole = fineRaster(p);
    assert.equal(a.have, whole.have);
    assert.ok(same(a.rgba, whole.rgba));
    await pool.compute(p);
    assert.equal(pool.workers, 3, 'workers are reused');
    // the Rust drawing in the workers joins to the same picture too
    const rust = createFinePool({ makeWorker: fakeWorker(F.fineRaster), size: 2, minRows: 20, minPixels: 0, fallback: fineRaster });
    assert.ok(same((await rust.compute(p)).rgba, whole.rgba));
    pool.close(); rust.close();
  });

  test('a picture too small to split goes to one worker unchanged', async () => {
    const p = scene(78, fine, { hazard: false, baseline: false, level: false, window: false });
    const sent = [];
    // 90 x 70 rows would split with minRows 20, but it is far under the default pixel count
    const pool = createFinePool({ makeWorker: fakeWorker(fineRaster, sent), size: 3, minRows: 20, fallback: fineRaster });
    const r = await pool.compute(p);
    assert.equal(sent.length, 1);
    assert.equal(sent[0], p, 'the very same parameters');
    assert.ok(same(r.rgba, fineRaster(p).rgba));
    pool.close();
  });

  test('a failing worker sends the picture to the fallback, once, and the pool stops using workers', async () => {
    const p = scene(79, fine, { hazard: false, baseline: true, level: false, window: true });
    const problems = [], fell = [];
    const fallback = (q) => { fell.push(q); return fineRaster(q); };
    let n = 0;
    // the second band's worker reports an error
    const flaky = createFinePool({ makeWorker: fakeWorker((q) => { if (++n === 2) throw new Error('boom'); return fineRaster(q); }), size: 2, minRows: 20, minPixels: 0, fallback, onProblem: (m) => problems.push(m) });
    const r = await flaky.compute(p);
    assert.equal(fell.length, 1);
    assert.equal(fell[0], p, 'the fallback draws the whole picture');
    assert.ok(same(r.rgba, fineRaster(p).rgba));
    // a worker that dies (onerror) takes the pool down and later pictures go straight to the fallback
    const dying = createFinePool({ makeWorker: () => ({ postMessage() { setTimeout(() => this.onerror({ message: 'crashed' }), 1); }, terminate() {} }), size: 2, minRows: 20, minPixels: 0, fallback, onProblem: (m) => problems.push(m) });
    await dying.compute(p);
    assert.equal(fell.length, 2);
    assert.match(problems.join(), /crashed/);
    await dying.compute(p);
    assert.equal(fell.length, 3);
    assert.equal(dying.workers, 0);
    // no Worker support at all
    const none = createFinePool({ makeWorker: undefined, size: 0, fallback });
    await none.compute(p);
    assert.equal(fell.length, 4);
    // a constructor that throws
    const broken = createFinePool({ makeWorker: () => { throw new Error('no workers here'); }, size: 2, fallback });
    await broken.compute(p);
    assert.equal(fell.length, 5);
  });

  test('bands are checked against the lidar rows they hold', () => {
    const p = scene(80, fine, { hazard: false, baseline: false, level: false, window: false });
    assert.throws(() => fineRaster({ ...p, rowFrom: 10, rowTo: 40 }), /inconsistent rows/);
    assert.throws(() => F.fineRaster({ ...p, rowFrom: 10, rowTo: 40 }), /inconsistent sizes/);
    assert.throws(() => fineRaster({ ...p, rowFrom: 40, rowTo: 10, lidar: new Float32Array(0) }), /inconsistent rows/);
    assert.throws(() => fineRaster({ ...p, rowFrom: 0, rowTo: p.H + 1, lidar: new Float32Array(p.W * (p.H + 1)) }), /inconsistent rows/);
  });
})();
