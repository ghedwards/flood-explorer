// Which cells lie inside an area's outline (FloodCore.polygonMask) must match the per-cell point-in-polygon test the
// page used before (copied below as it was), including holes, tiny rings and no rings.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');

function pointInPolygon(lat, lon, rings) {
  if (!Array.isArray(rings) || !rings.length) return true;
  let inside = false;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    if (!Array.isArray(ring) || ring.length < 3) continue;
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][0], xi = ring[i][1];
      const yj = ring[j][0], xj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) c = !c;
    }
    if (r === 0) inside = c; else if (c) inside = false;
  }
  return inside;
}
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

test('the Rust polygon mask matches the per-cell test', () => {
  const geo = { west: 150, east: 150.2, south: -24.2, north: -24 }, W = 90, H = 70, r = rng(5);
  const star = (cx, cy, n, rad) => Array.from({ length: n }, (_, k) => { const t = (k / n) * 2 * Math.PI, rr = rad * (0.5 + 0.5 * r()); return [cy + rr * Math.sin(t) * 0.5, cx + rr * Math.cos(t)]; });
  const cases = [
    [],
    [star(150.1, -24.1, 11, 0.08)],
    [star(150.1, -24.1, 40, 0.09), star(150.1, -24.1, 7, 0.03)],
    [star(150.05, -24.05, 9, 0.04), [[-24.1, 150.1], [-24.1, 150.12]], star(150.15, -24.15, 5, 0.03)],
    [[[-24.1, 150.1], [-24.12, 150.12]]],
    [[[-24.0, 150.0], [-24.0, 150.2], [-24.2, 150.2], [-24.2, 150.0]]],
  ];
  for (const [k, rings] of cases.entries()) {
    const got = F.polygonMask(geo, W, H, rings);
    let inside = 0;
    for (let i = 0; i < W * H; i++) {
      const x = i % W, y = (i / W) | 0;
      const lat = geo.north - ((y + 0.5) / H) * (geo.north - geo.south), lon = geo.west + ((x + 0.5) / W) * (geo.east - geo.west);
      const want = pointInPolygon(lat, lon, rings) ? 1 : 0;
      assert.equal(got[i], want, `case ${k} cell ${i}`);
      inside += want;
    }
    if (k === 1 || k === 2) assert.ok(inside > 100 && inside < W * H - 100, `case ${k} has inside and outside cells`);
  }
});
