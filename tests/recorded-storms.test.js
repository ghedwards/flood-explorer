const test = require('node:test');
const assert = require('node:assert/strict');
const snapshot = require('./fixtures/rainfall/storms.json');
const load = () => import('../viewer/recorded-storms.js');
const event = snapshot.events[0], station = event.stations[0];

test('recorded storm picker filters by station distance, units and snapshot version', async () => {
  const { nearbyStorms } = await load();
  assert.equal(nearbyStorms(snapshot, { lat: -27.47, lon: 153.02 }).length, 1);
  assert.deepEqual(nearbyStorms(snapshot, { lat: -33.86, lon: 151.21 }), []);
  assert.deepEqual(nearbyStorms({ ...snapshot, schemaVersion: 0 }, { lat: -27.47, lon: 153.02 }), []);
  const invalid = structuredClone(snapshot); invalid.events[0].stations[0].unit = 'm';
  assert.deepEqual(nearbyStorms(invalid, { lat: -27.47, lon: 153.02 }), []);
});

test('replay keeps observed rainfall separate from effective runoff and anchors the selected window in UTC', async () => {
  const { recordedWindow, stormTime } = await load();
  const run = recordedWindow(event, station, 1, 5400, 50);
  assert.equal(run.start, '2022-02-23T15:00:00.000Z');
  assert.equal(run.end, '2022-02-23T16:30:00.000Z');
  assert.deepEqual(Array.from(run.series), [15, 0, 0]);
  assert.equal(run.rainfallMm, 30);
  assert.equal(run.effectiveMm, 15);
  assert.match(stormTime(run.start), /24 Feb 2022/);
  assert.match(stormTime(run.start), /AEST/);
});

test('missing rainfall cannot become zero rain or stretch the last observed hour', async () => {
  const { recordedWindow } = await load();
  assert.throws(() => recordedWindow(event, station, 2, 7200, 100), /missing rainfall/);
  assert.throws(() => recordedWindow(event, station, 7, 7200, 100), /beyond the record/);
  assert.throws(() => recordedWindow(event, station, 0, 25 * 3600, 100), /up to 24 hours/);
  assert.throws(() => recordedWindow(event, station, 0, 3600, -1), /runoff/);
  assert.throws(() => recordedWindow(event, station, 0, 3600, NaN), /runoff/);
  assert.equal(recordedWindow(event, station, 0, 1800, 0).effectiveMm, 0);
  assert.equal(recordedWindow(event, station, 0, 1800, 100).rainfallMm, 5);
});
