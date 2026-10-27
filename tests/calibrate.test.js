// The recorded-flood level fit scores runs against an analysis held by the module. In the worker the analysis is a
// handle-only stub (FloodCore.byHandle), not the object analyse() returned, so the fit must work with one.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');

test('calibrateLevels works against a handle-only analysis and reproduces the recorded flood', async () => {
  const a = F.analyse(F.syntheticTerrain({ W: 140, H: 100 }));
  const stub = F.byHandle(F.handleOf(a));
  const bed = a.dem[a.defaultGauge], truth = bed + 3.2;
  const scenario = (lv) => ({ gauge: a.defaultGauge, gaugeLevel: lv, bayLevel: 1, upstreamGradient: 0.3 });
  const recorded = F.inundate(a, scenario(truth), { slim: 1 });
  const near = new Uint8Array(a.N).fill(1), m = { near, flood: Uint8Array.from(recorded.wet) };
  const best = await F.calibrateLevels(stub, scenario(bed + 1), m, bed, (s0, lv) => F.inundate(stub, { ...s0, gaugeLevel: lv }, { slim: 1 }));
  // several levels can flood the same cells, so judge the fit by how well it reproduces the record
  assert.ok(best.s.csi > 0.99, `csi ${best.s.csi} at ${best.lv} (recorded ${truth})`);
});
