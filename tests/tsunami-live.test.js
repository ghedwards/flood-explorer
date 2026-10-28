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

test('a run is summed up per cell: peak depth, arrival after the wave reaches the edge, and when the deepest water came', async () => {
  const m = await load();
  // cells: 0 dry land the wave floods, 1 land with 0.5 m of tide cover that the wave never adds to, 2 sea, 3 land the wave never reaches
  const grid = { depth: Float64Array.from([0, 0.5, 0, 0]) }, land = Uint8Array.from([1, 1, 0, 1]);
  const frame = (time, water, peak) => ({ time, water: Float64Array.from(water), eta: new Float64Array(4), peak: Float64Array.from(peak) });
  const frames = [frame(0, [0, 0.5, 0, 0], [0, 0, 0, 0]), frame(30, [0, 0.5, 0.2, 0], [0, 0, 0.2, 0]), frame(60, [0.3, 0.5, 0.6, 0], [0.3, 0, 0.6, 0]), frame(90, [0.1, 0.5, 0.1, 0], [0.3, 0, 0.6, 0])];
  const derived = m.deriveRun({ grid, land }, frames, { waveAt: 30, summarise: (p, f) => f.time });
  assert.equal(derived.arrival[0], 30, 'the wave adds 0.1 m or more at 60 s, 30 s after it reached the edge');
  assert.ok(Number.isNaN(derived.arrival[1]), 'the tide cover is not an arrival');
  assert.ok(Number.isNaN(derived.arrival[3]));
  assert.equal(derived.peakAt[0], 60);
  assert.ok(Math.abs(derived.peak[0] - 0.3) < 1e-6 && Math.abs(derived.peak[1] - 0.5) < 1e-6, 'land peaks include the tide cover');
  assert.ok(Math.abs(derived.peak[2] - 0.6) < 1e-6, 'the sea peak is the highest wave');
  assert.deepEqual(derived.summaries, [0, 30, 60, 90]);
});

test('the maximum and arrival views colour land by depth and by arrival band, and the tap finds its cell', async () => {
  const m = await load();
  const map = Int32Array.from([0, 1, 2, 3]), land = Uint8Array.from([1, 1, 0, 1]);
  const max = m.maxPixels(map, land, Float32Array.from([0.3, 5, 0.4, 0]));
  assert.deepEqual([...max.slice(0, 4)], [63, 154, 224, 225], 'shallow land is the first depth colour');
  assert.deepEqual([...max.slice(4, 8)].slice(0, 3), [12, 52, 112], 'deep land is the last');
  assert.equal(max[11] > 0 && max[11] < 225, true, 'the sea is a translucent crest');
  assert.equal(max[15], 0, 'dry land is clear');
  const arr = m.arrivalPixels(map, land, Float32Array.from([240, 1500, NaN, NaN]));
  assert.deepEqual([...arr.slice(0, 3)], [128, 0, 38], 'within five minutes is the darkest');
  assert.deepEqual([...arr.slice(4, 7)], [252, 78, 42], '25 minutes falls in the 20 to 40 minute band');
  assert.equal(arr[11], 0, 'the sea has no arrival colour');
  assert.deepEqual([0, 300, 301, 3600, 3601].map(m.arrivalClass), [0, 0, 1, 4, 5]);
  assert.equal(m.viewLegend('arrival').length, 7);
  assert.match(m.viewLegend('max')[0], /Deepest/);
  // the place is 8 km by 4.8 km, 4 by 2 cells; its centre is the corner shared by the four middle cells, so just north-west of it is cell 1
  const { fromMga } = await import('../viewer/tsunami-extents.js');
  const [lat, lon] = fromMga(537500 + 1000, 6905500 + 4800 - 1200);
  assert.equal(m.cellIndex(place, lat, lon), 0);
  const [lat2, lon2] = fromMga(537500 + 7000, 6905500 + 1200);
  assert.equal(m.cellIndex(place, lat2, lon2), 7);
  assert.equal(m.cellIndex(place, -10, 150), -1);
});
