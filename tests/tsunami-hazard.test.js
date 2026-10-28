const test = require('node:test');
const assert = require('node:assert/strict');
const prep = require('../scripts/prepare-tsunami-hazard.js');

const load = () => import('../viewer/tsunami-hazard.js');

test('only Australian waters are kept, and the neighbouring coasts are cut out', () => {
  for (const [lon, lat] of [[153.7, -28], [151.5, -33.8], [115.3, -32], [130, -12], [148.2, -43], [146.3, -16.7], [159.1, -31.5], [143.5, -11.1]]) assert.ok(prep.australian(lon, lat), `${lon},${lat}`);
  for (const [lon, lat] of [[125, -10.5], [115, -8.9], [147, -9.8], [152.5, -11.2], [172, -41], [-10, 40]]) assert.ok(!prep.australian(lon, lat), `${lon},${lat}`);
});

test('one point is chosen per cell, the one nearest 100 m deep, from the depth band', () => {
  const points = { lon: [150.01, 150.02, 150.03, 150.5, 150.51], lat: [-30.01, -30.02, -30.03, -30.5, -30.51], elev: [-60, -105, -140, -30, -100], gaugeID: [1, 2, 3, 4, 5] };
  assert.deepEqual(prep.selectPoints(points), [1, 4]);
});

test('nearby indices share a request and far ones start a new one', () => {
  const runs = prep.chunks([10, 12, 100, 300, 301, 900]);
  assert.deepEqual(runs.map(r => [r.start, r.end, r.indices.length]), [[10, 100, 3], [300, 301, 2], [900, 900, 1]]);
  assert.equal(prep.chunks(Array.from({ length: 1000 }, (_, i) => i), { max: 400 }).length, 3);
});

test('the stage at a return period interpolates the curve and caps at both ends', () => {
  const stage = [0.02, 0.1, 1, 20], rates = [0.2, 0.05, 0.001, 0];
  assert.equal(prep.stageFor(stage, rates, 100), 0.1 + (0.9) * (Math.log(0.05) - Math.log(0.01)) / (Math.log(0.05) - Math.log(0.001)));
  assert.equal(prep.stageFor(stage, [0.001, 0.0005, 0.0001, 0], 100), 0, 'rarer than the smallest stage');
  assert.equal(prep.stageFor(stage, [0.5, 0.4, 0.3, 0.2], 100), 20, 'still more frequent at the largest stage');
});

test('the hazard file parses and its classes, colours and texts follow the stage', async () => {
  const h = await load();
  const file = { returnPeriodsYears: [100, 500], bandReturnPeriodsYears: [500], columns: ['lon', 'lat', 'depth_m', 'gaugeID', 'stage_100', 'stage_500', 'stage_500_p16', 'stage_500_p84'], points: [[153.667, -28, 69, 1449.5, 0.71, 1.32, 0.68, 1.57], [100, -20, 90, 7.1, 0, 20, 0, 20]] };
  const [a, b] = h.parseHazard(file);
  assert.deepEqual([a.id, a.depth, a.stage[500], a.band[500]], [1449.5, 69, 1.32, [0.68, 1.57]]);
  assert.equal(h.stageText(0), 'under 0.02 m'); assert.equal(h.stageText(b.stage[500]), '20 m or more'); assert.equal(h.stageText(0.5), '0.50 m');
  assert.deepEqual([0.1, 0.25, 0.9, 1, 3, 4, 9].map(h.classOf), [0, 1, 2, 3, 4, 5, 5]);
  assert.equal(h.colourFor(0.1), h.COLOURS[0]); assert.equal(h.colourFor(10), h.COLOURS[5]);
  assert.throws(() => h.parseHazard({ ...file, columns: ['lon'] }), /no lat column/);
  const html = h.popupHtml(a, [100, 500]);
  assert.match(html, /1449\.5/); assert.match(html, /1 in 500 years/); assert.match(html, /0\.68 m to 1\.57 m/); assert.match(html, /not a flooding estimate/);
  assert.equal(h.legendParts(500).length, 7); assert.match(h.legendParts(500)[0], /1 in 500 years \(0\.2% a year\)/);
});

test('the coarse set is the point nearest 100 m deep in each larger cell', () => {
  const points = { lon: [150.1, 150.2, 150.3, 151.2], lat: [-30.1, -30.2, -30.3, -30.1], elev: [-60, -98, -140, -100], gaugeID: [1, 2, 3, 4] };
  assert.deepEqual([...prep.coarseSet(points, [0, 1, 2, 3])].sort(), [1, 3]);
});

test('zoomed out the map draws the coarse set only; zoomed in it draws all', async () => {
  const h = await load();
  assert.ok(!h.showAll(5) && !h.showAll(6) && h.showAll(7) && h.showAll(12));
  const [coarse, fine] = h.parseHazard({ returnPeriodsYears: [100], bandReturnPeriodsYears: [], columns: ['lon', 'lat', 'depth_m', 'gaugeID', 'coarse', 'stage_100'], points: [[1, 2, 100, 1, 1, 0.3], [1, 2, 100, 2, 0, 0.3]] });
  assert.equal(coarse.coarse, true); assert.equal(fine.coarse, false);
});
