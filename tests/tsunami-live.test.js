const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../viewer/tsunami-live.js');
const place = { extent: [537500, 6905500, 545500, 6910300], W: 4, H: 2 };

test('depth classes follow the legend edges and the canvas keeps the ground shape', async () => {
  const m = await load();
  assert.deepEqual([0.1, 0.5, 0.99, 1, 3.9, 4, 10].map(m.depthClass), [0, 1, 1, 2, 3, 4, 4]);
  const { width, height } = m.canvasSize(place);
  assert.equal(width, 16);
  assert.ok(height >= 8 && height <= 10, `an 8 by 4.8 km place at 16 px across is about 9 px tall, got ${height}`);
  assert.equal(m.legendParts().length, 8);
});

test('each pixel maps to the cell under it, north at the top, and -1 outside', async () => {
  const m = await load();
  const { width, height } = m.canvasSize(place), map = m.pixelMap(place, width, height);
  assert.equal(map.length, width * height);
  assert.equal(map[0], 0, 'the north-west pixel is cell 0');
  assert.equal(map[width - 1], 3, 'the north-east pixel is the last cell of the first row');
  assert.equal(map[(height - 1) * width], 4, 'the south-west pixel is the first cell of the second row');
  assert.equal(map[map.length - 1], 7);
  assert.ok(map.every(c => c >= -1 && c < 8));
});

test('land is coloured by water depth and the sea by the wave, with nothing drawn below the thresholds', async () => {
  const m = await load();
  const map = Int32Array.from([0, 1, 2, 3, -1, 4]), land = Uint8Array.from([1, 1, 0, 0, 1, 1]);
  const frame = { water: Float64Array.from([0.3, 0.01, 5, 5, 5, 3]), eta: Float64Array.from([0, 0, 0.5, -0.5, 0.9, 0.02]) };
  const px = m.framePixels(map, land, frame), at = p => [...px.slice(p * 4, p * 4 + 4)];
  assert.deepEqual(at(0), [0x3f, 0x9a, 0xe0, 225], 'land under 0.3 m of water is the lightest blue');
  assert.deepEqual(at(1), [0, 0, 0, 0], 'a centimetre of water is not drawn');
  assert.deepEqual(at(2), [...m.CREST, 220], 'a 0.5 m crest at sea is the strongest orange');
  assert.deepEqual(at(3), [...m.DRAWDOWN, 220], 'a 0.5 m drawdown is blue');
  assert.deepEqual(at(4), [0, 0, 0, 0], 'a pixel outside the place is clear');
  assert.deepEqual(at(5), [0x0c, 0x34, 0x70, 225], 'pixel 5 reads cell 4, land under 5 m of water: the darkest class');
  const out = new Uint8ClampedArray(map.length * 4).fill(9);
  assert.equal(m.framePixels(map, land, frame, out), out); assert.equal(out[4 * 4], 0, 'a reused buffer is cleared first');
});

test('the layer shows a place, paints frames on it and clears', async () => {
  const m = await load();
  const calls = [];
  const L = { layerGroup: () => { const layers = new Set(); return { addLayer: l => layers.add(l), removeLayer: l => layers.delete(l), layers }; } };
  const overlay = { setPixels: (rgba, w, h) => calls.push([rgba.length, w, h]) };
  const layer = m.makeLiveLayer(L, { canvasOverlay: (bounds, options) => { calls.push(['overlay', bounds[0].length, options.className]); return overlay; } });
  const bounds = layer.show({ ...place, W: 160, H: 96 });
  assert.equal(bounds.length, 2); assert.equal(layer.place().W, 160);
  const { width, height } = m.canvasSize({ ...place, W: 160, H: 96 });
  layer.paint({ water: new Float64Array(160 * 96), eta: new Float64Array(160 * 96) }, new Uint8Array(160 * 96));
  assert.deepEqual(calls.at(-1), [width * height * 4, width, height]);
  assert.equal(calls[0][2], 'flood-layer tsunami-live');
  layer.clear(); assert.equal(layer.place(), null);
  layer.paint({ water: [], eta: [] }, []);   // nothing to paint on after a clear
  assert.equal(calls.filter(c => c[0] === 'overlay').length, 1);
});
