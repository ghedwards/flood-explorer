const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');

// The grid adaptation is tested in Rust (rust/flood-core/src/inertial_grid.rs). This is the bridge: the same cases through FloodCore.inertialPrepare / Cell / Expand.
test('2D coarsening preserves walls and bounds, and reports the actual resolution', () => {
  const a = { W: 7, H: 6, cell: 10, dem: new Float32Array(42).fill(2), valid: new Uint8Array(42).fill(1) };
  a.valid[0] = 0;
  const g = F.inertialPrepare(a, 4);
  assert.equal(g.factor, 2); assert.equal(g.cell, 20); assert.equal(g.W, 3); assert.equal(g.H, 3);
  assert.equal(g.valid[0], 0); assert.equal(g.valid[1], 1);
  assert.equal(F.inertialCell(g, a, 6), -1); assert.equal(F.inertialCell(g, a, -1), -1); assert.equal(F.inertialCell(g, a, 2), 1);
  const r = F.inertialExpand(a, g, { depth: new Float64Array(9).fill(0.2) });
  assert.equal(r.wet[0], 0); assert.equal(r.wet[1], 0); assert.equal(r.wet[6], 0);
  assert.equal(r.wet[2], 1); assert.ok(Math.abs(r.depth[2] - .2) < 1e-7);
  assert.ok(r.wse instanceof Float64Array && r.onPath.length === 42 && r.vx.length === 42);
  assert.throws(() => F.inertialPrepare({ ...a, W: 1, H: 42, dem: new Float32Array(42), valid: new Uint8Array(42) }, 1), /too narrow/);
  assert.throws(() => F.inertialExpand(a, g, { depth: new Float64Array(5) }), /does not match/);
});

test('a storm run expands its peak depth, worst hazard classes and arrival times onto the fine grid', () => {
  const a = { W: 4, H: 2, cell: 30, dem: new Float32Array(8).fill(2), valid: new Uint8Array(8).fill(1), ocean: new Uint8Array(8) };
  a.ocean[7] = 1;
  const g = F.inertialPrepare(a, 2);   // 2 x 1 coarse cells of 60 m
  const result = { depth: Float64Array.from([0, 0]), peak: Float64Array.from([0.8, 0.05]), peakClass: Float64Array.from([4, 1]), peakSpeed: Float64Array.from([1.5, 0.1]), arrival: Float64Array.from([300, -1]) };
  const run = F.inertialExpand(a, g, result, { peak: true });
  assert.ok(Math.abs(run.depth[0] - 0.8) < 1e-7, 'the map shows the peak, not the final depth');
  assert.equal(run.wet[0], 1); assert.equal(run.wet[3], 1);
  assert.equal(run.peakHazard.cls[0], 4); assert.equal(run.peakHazard.cls[3], 1); assert.ok(Math.abs(run.peakHazard.vel[0] - 1.5) < 1e-6);
  assert.ok(Number.isNaN(run.arrival[3]) && Math.abs(run.arrival[0] - 300) < 1e-6, 'a cell never flooded has no arrival time');
  const k = run.peakHazard.km2; assert.ok(Math.abs(k[3] - 4 * 0.0009) < 1e-12, `${k}`); assert.ok(Math.abs(k[0] - 3 * 0.0009) < 1e-12, `${k}`);
  const plain = F.inertialExpand(a, g, { depth: Float64Array.from([0.1, 0.1]), peak: Float64Array.from([0.8, 0.05]) });
  assert.equal(plain.peakHazard, undefined); assert.equal(plain.arrival, undefined); assert.ok(Math.abs(plain.depth[0] - 0.1) < 1e-7, 'without the peak option the final depth is shown');
});
