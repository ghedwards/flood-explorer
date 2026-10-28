const test = require('node:test');
const assert = require('node:assert/strict');
const prep = require('../scripts/prepare-tsunami-extents.js');

const load = () => import('../viewer/tsunami-extents.js');

test('MGA coordinates match the published GDA reference point and round-trip', async () => {
  const m = await load();
  const lat = -(37 + 57 / 60 + 3.7203 / 3600), lon = 144 + 25 / 60 + 29.5244 / 3600;     // Flinders Peak, zone 55 (GA's GDA technical manual)
  const [e, n] = m.toMga(lat, lon, 55);
  assert.ok(Math.abs(e - 273741.297) < 0.005 && Math.abs(n - 5796489.777) < 0.005, `${e} ${n}`);
  const [la, lo] = m.fromMga(e, n, 55);
  assert.ok(Math.abs(la - lat) < 1e-9 && Math.abs(lo - lon) < 1e-9);
  assert.deepEqual(m.toMga(0, 153, 56).map(Math.round), [500000, 10000000]);
  const [[s, w], [nn, ee]] = m.placeBounds({ extent: [537500, 6905500, 545500, 6910300], W: 160, H: 96 });
  assert.ok(s > -28 && nn < -27.9 && w > 153.37 && ee < 153.48, 'the Seaway extent is at Southport');
});

test('rates round-trip through one byte within 6%, and classes follow the rate', async () => {
  const m = await load();
  for (const rate of [1e-5, 3e-4, 0.002, 0.01, 0.05, 0.9]) assert.ok(Math.abs(m.decodeRate(m.encodeRate(rate)) / rate - 1) < 0.06, String(rate));
  assert.equal(m.encodeRate(0), 0); assert.equal(m.decodeRate(0), 0);
  assert.deepEqual([0, 1e-5, 1 / 5000, 1 / 2000, 1 / 800, 1 / 300, 1 / 150, 1 / 50].map(m.classOfRate), [-1, -1, 0, 1, 2, 3, 4, 5]);
  assert.match(m.yearsText(0.002), /1 in 500 years/); assert.match(m.yearsText(0), /not reached/);
  assert.equal(m.legendParts(0.3).length, 7);
});

test('pixels are painted from the cell under them, north at the top, and left clear outside or where nothing arrives', async () => {
  const m = await load();
  const place = { extent: [537500, 6905500, 545500, 6910300], W: 4, H: 2 };
  const codes = new Uint8Array(8);
  codes[0] = m.encodeRate(1 / 150);         // north-west cell
  const px = m.extentPixels(place, codes, 40, 20);
  const at = (x, y) => px.slice((y * 40 + x) * 4, (y * 40 + x) * 4 + 4);
  const [[s, w], [n, e]] = m.placeBounds(place);
  assert.equal(at(1, 1)[3], 215, 'the north-west corner is drawn');
  assert.equal(at(38, 18)[3], 0, 'the south-east corner has nothing');
  assert.deepEqual([...at(1, 1).slice(0, 3)], [0xa9, 0x2d, 0x7d], 'a rate of 1 in 150 years is the 1 in 100 to 1 in 250 class');
  assert.ok(m.rateAt(place, codes, n - 0.001, w + 0.001) > 0 && m.rateAt(place, codes, s + 0.001, e - 0.001) === 0 && m.rateAt(place, codes, 0, 0) === null);
});

test('zone files combine by their rates and must share a grid', () => {
  const zone = (name, rate, a, b) => ({ zone: name, W: 2, H: 1, cell: 50, depths: [0.1, 1], poolRate: rate, fraction: [[a, b], [0, a]] });
  const c = prep.combineZones([zone('a', 0.01, 0.5, 0), zone('b', 0.02, 0.25, 0.5)]);
  assert.ok(Math.abs(c.rate[0][0] - (0.005 + 0.005)) < 1e-12 && Math.abs(c.rate[0][1] - 0.01) < 1e-12 && Math.abs(c.rate[1][1] - (0.005 + 0.005)) < 1e-12);
  assert.throws(() => prep.combineZones([zone('a', 1, 0, 0), { ...zone('b', 1, 0, 0), W: 3 }]), /different grid/);
  assert.throws(() => prep.combineZones([]), /at least one/);
});

test('a place file is built from zone files on its grid', async () => {
  const f = Array.from({ length: 160 * 96 }, (_, i) => i === 5 ? 0.4 : 0);
  const file = await prep.build('gold-coast-seaway', [{ zone: 'z', gauge: 1450.5, mw: [8.4, 9.6], count: 60, seed: 1, poolRate: 0.01, W: 160, H: 96, cell: 50, depths: [0.1, 0.3, 1], fraction: [f, f, f] }]);
  const m = await load();
  const codes = m.decodeBytes(file.codes[1]);
  assert.equal(codes.length, 160 * 96);
  assert.ok(Math.abs(m.decodeRate(codes[5]) / 0.004 - 1) < 0.06 && codes[6] === 0);
  assert.deepEqual([file.id, file.zone, file.extent.length, file.depths], ['gold-coast-seaway', 56, 4, [0.1, 0.3, 1]]);
  assert.match(file.limits, /lower bound/);
  await assert.rejects(prep.build('nowhere', []), /at least one|Unknown place/);
  await assert.rejects(prep.build('gold-coast-seaway', [{ zone: 'z', W: 4, H: 2, cell: 50, depths: [0.1], poolRate: 1, fraction: [new Array(8).fill(0)] }]), /not on this place's grid/);
});
