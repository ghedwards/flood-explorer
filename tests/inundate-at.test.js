// The one-cell flood probe (FloodCore.inundateAt, used by the property check's "floods when the gauge reaches"
// search) must give the same answer as the full run at that cell.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');

test('inundateAt agrees with inundate at sampled cells, with controls and a levee', () => {
  assert.equal(F.engine, 'rust');
  const a = F.analyse(F.syntheticTerrain({ W: 200, H: 150 }));
  const levee = new Uint8Array(a.N);
  for (let c = a.defaultGauge, k = 0; c >= 0 && k < 30; c = a.rec[c], k++) levee[Math.min(a.N - 1, c + 2)] = 1;
  const down = []; for (let c = a.rec[a.defaultGauge], k = 0; c >= 0 && k < 40; c = a.rec[c], k++) if (k % 5 === 0) down.push({ cell: c, level: a.dem[c] + 1.5 });
  let wetSeen = 0, drySeen = 0;
  for (const extra of [{}, { controls: down }, { levee }, { controls: down, levee }]) {
    for (const rise of [0.4, 2, 5]) {
      const s = Object.assign({ gauge: a.defaultGauge, gaugeLevel: a.dem[a.defaultGauge] + rise, bayLevel: 1, upstreamGradient: 0.3 }, extra);
      const full = F.inundate(a, s, { slim: 1 });
      for (let c = 0; c < a.N; c += 37) {
        const p = F.inundateAt(a, s, c);
        assert.equal(p.wet, Boolean(full.wet[c]), `cell ${c}`);
        if (p.wet) { assert.equal(p.depth, full.depth[c], `depth at ${c}`); wetSeen++; } else drySeen++;
      }
    }
  }
  assert.ok(wetSeen > 200 && drySeen > 200, `${wetSeen} wet, ${drySeen} dry`);
  assert.deepEqual(F.inundateAt(a, { gauge: a.defaultGauge, gaugeLevel: 3, bayLevel: 1, upstreamGradient: 0.3 }, a.N + 10), { wet: false, depth: 0 });
});
