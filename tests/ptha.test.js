const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../scripts/ptha-lib.js');
const F = require('./model.js');
const gridModule = import('../viewer/tsunami-grid.js');
const couplingModule = import('../viewer/tsunami-coupling.js');

// A small stand-in for the NCI THREDDS OPeNDAP server, answering the same
// .ascii requests in the same format, so the importer is tested offline.
function fakeServer({ zone = 'zz', stations, events, unitStage, rates }) {
  const requests = [];
  const fmt = v => typeof v === 'string' ? JSON.stringify(v) : String(v);
  const block = (name, values) => `${name}[${values.length}]\n${values.map(fmt).join(', ')}\n`;
  const wrap = body => `Dataset {\n} fake.nc;\n---------------------------------------------\n${body}`;
  const get = async url => {
    requests.push(url);
    const rel = url.slice(lib.DAP_BASE.length);
    const [file, query] = rel.split('.ascii?');
    if (file === 'EVENT_RATES/STATIONS_ONLY_lon_lat_elev_gaugeID.nc') {
      return wrap(['lon', 'lat', 'elev', 'gaugeID'].map(n => block(n, stations[n])).join('\n'));
    }
    if (file === 'EVENT_RATES/revised1_tsunami_stage_exceedance_rates_sum_over_all_source_zones.nc' && rates) {
      const parts = ['stage' + `[${rates.stage.length}]\n${rates.stage.join(', ')}\n`];
      for (const name of query.split(',').slice(1).map(q => q.replace(/\[.*$/, ''))) {
        const index = Number(new RegExp(`${name}\\[(\\d+):1:`).exec(query)[1]);
        parts.push(`${name}.${name}[1][${rates.stage.length}]\n[0], ${rates[name][index].join(', ')}\n`, `${name}.station[1]\n${index + 1}\n`);
      }
      return wrap(parts.join('\n'));
    }
    const zoneFile = /^SOURCE_ZONES\/(\w+)\/TSUNAMI_EVENTS\/(revised1_)?tsunami_stage_exceedance_rates_\1\.nc$/.exec(file);
    if (zoneFile && rates?.zones) {
      const curves = rates.zones[zoneFile[1]];
      if (!curves || (rates.plainOnly?.includes(zoneFile[1]) && zoneFile[2])) return 'Error {\n    code = 2;\n    message = "not found";\n};\n';
      const name = query.replace(/\[.*$/, ''), index = Number(/\[(\d+):1:/.exec(query)[1]);
      return wrap(`${name}.${name}[1][${curves[index].length}]\n[0], ${curves[index].join(', ')}\n`);
    }
    if (file.endsWith(`all_stochastic_slip_earthquake_events_${zone}.nc`) || file.endsWith(`all_uniform_slip_earthquake_events_${zone}.nc`)) {
      const m = /\[(\d+):1:(\d+)\]/.exec(query);
      if (!m) return wrap(['Mw', 'rate_annual'].map(n => block(n, events[n])).join('\n'));
      const row = Number(m[1]);
      if (row >= events.Mw.length) return 'Error {\n    code = 5;\n    message = "Index out of range";\n};\n';
      const names = query.split(',').map(q => q.replace(/\[.*$/, ''));
      return wrap(names.map(n => block(n, [events[n][row]])).join('\n'));
    }
    if (file.endsWith(`unit_source_statistics_${zone}.nc`)) {
      const count = Number(/\[0:1:(\d+)\]/.exec(query)[1]) + 1;
      return wrap(block('tide_gauge_file', Array.from({ length: count }, (_, k) => `/g/data/fj6/PTHA/AustPTHA_1/SOURCE_ZONES/${zone}/TSUNAMI_UNIT_SOURCES/unit_source_tsunami/RUN_${k + 1}/Gauges_data_ID${k + 1}.nc`)));
    }
    const unit = /RUN_(\d+)\/Gauges/.exec(file);
    if (unit) {
      const k = Number(unit[1]);
      if (query === 'time') return wrap(block('time', unitStage.time));
      const point = Number(/stage\[(\d+):1:\d+\]/.exec(query)[1]);
      const series = unitStage.series(k, point);
      return wrap(`stage[1][${series.length}]\n[0], ${series.join(', ')}\n`);
    }
    return 'Error {\n    code = 2;\n    message = "not found";\n};\n';
  };
  return { get, requests };
}

const time = Float32Array.from({ length: 101 }, (_, i) => i * 30);
const server = () => fakeServer({
  stations: { lon: [150, 154, 154.1], lat: [-30, -28, -28.1], elev: [-30, -667, -94], gaugeID: [1.1, 1450.5, 1431.1000001] },
  events: {
    Mw: [7.2, 9, 9.4], rate_annual: [1e-4, 0, 2e-6], target_lon: [1, 2, 3], target_lat: [1, 2, 3],
    event_index_string: ['1-', '1-2-', '1-2-3-'], event_slip_string: ['2_', '1_0.5_', '1_1_2_'], slip: [1, 1, 2],
  },
  // Unit source k at the chosen point: a pulse of height k arriving at step 10k.
  unitStage: { time: Array.from(time), series: (k, point) => Array.from(time, (_, i) => Math.max(0, k - Math.abs(i - 10 * k) / 5) * (point === 1 ? 1 : 0.5)) },
});

test('OPeNDAP ASCII responses parse, including strings with commas and errors', () => {
  const text = 'Dataset {\n} x.nc;\n---------------------------------------------\nMw[2]\n7.2, 9\n\nname[2]\n"a, b", "c"\n\nstage[1][3]\n[0], 0.0, 1.5, -2\n';
  assert.deepEqual(lib.parseDapAscii(text), { Mw: [7.2, 9], name: ['a, b', 'c'], stage: [[0, 1.5, -2]] });
  assert.throws(() => lib.parseDapAscii('Error {\n    code = 2;\n    message = "The variable `x\' was not found";\n};\n'), /refused the request: The variable/);
  assert.throws(() => lib.parseDapAscii('<html>nope</html>'), /no data section/);
  assert.deepEqual(lib.parseIndices('17-18-'), [17, 18]);
  assert.deepEqual(lib.parseSlips('0.8975_0.07469_'), [0.8975, 0.07469]);
  assert.equal(lib.relativePath('/g/data1a/fj6/PTHA/AustPTHA_1/SOURCE_ZONES/z/a.nc'), 'SOURCE_ZONES/z/a.nc');
  assert.throws(() => lib.relativePath('/somewhere/else.nc'), /Unrecognised/);
});

test('hazard points are found by ID or location, nearest and deep first', async () => {
  const { get } = server();
  const points = await lib.hazardPoints(get);
  assert.deepEqual(points.gaugeID, [1.1, 1450.5, 1431.1]);
  const near = lib.nearestPoints(points, 154, -28, { count: 2 });
  assert.deepEqual(near.map(p => p.gaugeID), [1450.5, 1431.1]);
  assert.deepEqual(lib.nearestPoints(points, 154.1, -28.1, { minDepth: 100 }).map(p => p.gaugeID), [1450.5], 'only the 667 m point is at least 100 m deep');
  assert.equal(lib.pointByGaugeID(points, 1431.1).index, 2);
  assert.equal(lib.pointByGaugeID(points, 1450.5).depth, 667);
  assert.throws(() => lib.pointByGaugeID(points, 999), /No hazard point/);
});

test('a scenario is the slip-weighted sum of its unit sources, and scenarios can be searched', async () => {
  const { get, requests } = server();
  const event = await lib.scenario(get, 'zz', 'stochastic', 3);
  assert.deepEqual([event.mw, event.indices, event.slips], [9.4, [1, 2, 3], [1, 1, 2]]);
  const { stage, time: t, event: used } = await lib.scenarioStage(get, 'zz', 'stochastic', 3, 1);
  assert.equal(used.row, 3);
  // Unit source k is a triangle of height k centred on step 10 k; the scenario
  // weights them by slips 1, 1 and 2 (they overlap, so compute the sum).
  const expected = i => [1, 2, 3].reduce((sum, k) => sum + [1, 1, 2][k - 1] * Math.max(0, k - Math.abs(i - 10 * k) / 5), 0);
  assert.ok(Array.from(stage).every((v, i) => Math.abs(v - expected(i)) < 1e-6), 'sum of weighted unit sources');
  assert.ok(Math.abs(stage[30] - 6) < 1e-6, 'unit source 3 (slip 2) peaks at 6 where the others are zero');
  assert.equal(t.length, 101);
  // Half height at the other point: only the requested station is fetched.
  const half = await lib.scenarioStage(get, 'zz', 'stochastic', 3, 0);
  assert.ok(Array.from(half.stage).every((v, i) => Math.abs(v - 0.5 * expected(i)) < 1e-6));
  assert.ok(requests.filter(u => u.includes('stage')).every(u => /stage\[\d+:1:\d+\]\[0:1:100\]/.test(u)));
  const uniform = await lib.scenario(get, 'zz', 'uniform', 3);
  assert.deepEqual(uniform.slips, [2, 2, 2]);
  assert.deepEqual((await lib.findScenarios(get, 'zz', 'stochastic', { mwMin: 8 })).map(r => r.row), [3]);
  assert.deepEqual((await lib.findScenarios(get, 'zz', 'stochastic', { onlyPossible: false })).map(r => r.row), [1, 2, 3]);
});

test('bad requests fail with clear messages', async () => {
  const { get } = server();
  await assert.rejects(() => lib.scenario(get, 'zz', 'stochastic', 99), /refused the request: Index out of range/);
  await assert.rejects(() => lib.scenario(get, 'Zz!', 'stochastic', 1), /source zone name/);
  await assert.rejects(() => lib.scenario(get, 'zz', 'bogus', 1), /Slip type/);
  await assert.rejects(() => lib.scenario(get, 'zz', 'stochastic', 0), /whole number/);
});

test('a long series is trimmed to the arrival, scaled and written with its provenance', () => {
  const t = Float64Array.from({ length: 200 }, (_, i) => i * 60);
  const stage = Float64Array.from(t, (_, i) => i < 50 ? 0 : .2 * Math.sin((i - 50) / 8) * Math.exp(-(i - 50) / 60));
  const series = lib.trimSeries(t, stage, { lead: 120, hours: 1 });
  assert.equal(series.times[0], 0);
  assert.ok(series.offset > 0 && series.offset < series.arrival && series.arrival - series.offset <= 120 + 60);
  assert.ok(series.times.at(-1) <= 3600 && series.times.every((v, i) => i === 0 || v > series.times[i - 1]));
  assert.equal(lib.trimSeries(t, stage, { align: false }).offset, 0);
  assert.equal(lib.trimSeries(t, stage, { align: 'none' }).times[0], 0);
  // A later, larger wave: the default window misses it, the peak window keeps it.
  const late = Float64Array.from(t, (_, i) => i < 50 ? 0 : i < 60 ? .05 : i === 170 ? .4 : 0);
  const early = lib.trimSeries(t, late, { hours: 1 });
  assert.equal(early.peak, .4);
  assert.ok(early.windowPeak < .4 && early.peakTime === 170 * 60);
  const centred = lib.trimSeries(t, late, { hours: 1, align: 'peak', beforePeak: 1800 });
  assert.equal(centred.windowPeak, .4);
  assert.equal(centred.offset, 170 * 60 - 1800);
  assert.throws(() => lib.trimSeries(t, stage, { align: 'middle' }), /Alignment must be/);
  assert.throws(() => lib.trimSeries(t, new Float64Array(200)), /no wave/);
  assert.ok(Math.abs(lib.greenScale(400, 25) - 2) < 1e-9, 'capped at 2');
  assert.ok(Math.abs(lib.greenScale(100, 50) - 2 ** .25) < 1e-9);
  assert.throws(() => lib.greenScale(0, 5), /positive/);
  const friction = lib.delayedLinearFriction(Float64Array.of(0, 43200, 43200 + 36000), Float64Array.of(1, 1, 1));
  assert.deepEqual([friction[0], friction[1]], [1, 1]);
  assert.ok(Math.abs(friction[2] - Math.exp(-1e-5 / 2 * 36000)) < 1e-12);
  const csv = lib.toCsv(series, { zone: 'zz', slipType: 'stochastic', row: 3, mw: 9.4, rateAnnual: 2e-6, gaugeID: 1450.5, lon: 154, lat: -28, depth: 667, friction: true, scale: 1.5, localDepth: 25 });
  assert.match(csv, /scenario row 3: Mw 9.4, annual rate 2.00e-6/);
  assert.match(csv, /delayed linear friction applied/);
  assert.match(csv, /Green's law, to 25 m/);
  assert.match(csv, /CC BY 4.0/);
  assert.match(csv, /window aligned to the arrival.*largest wave \(0\.\d+ m\).*this file's largest is/);
  assert.match(csv, /\nseconds,metres\n0,/);
});

test('the example PTHA18 series loads in the lab and drives the nested local model', async () => {
  const { parseSeriesCsv, forcingFromSeries } = await couplingModule;
  const { tsunamiGrid } = await gridModule;
  const text = fs.readFileSync(path.join(__dirname, '../docs/examples/ptha18-southamerica-142847-gauge1450.5.csv'), 'utf8');
  assert.match(text, /Geoscience Australia PTHA18, CC BY 4.0/);
  const series = parseSeriesCsv(text);
  assert.ok(series.times.length > 300 && series.times.length < 400 && series.times[0] >= 0 && series.times[0] < 60 && Math.max(...series.values.map(Math.abs)) > .05 && Math.max(...series.values.map(Math.abs)) < .2);
  const fine = JSON.parse(fs.readFileSync(path.join(__dirname, '../viewer/public/tsunami-data/gold-coast-seaway.json')));
  const grid = tsunamiGrid({ preset: 'gold-coast-seaway', bathymetry: fine, amplitude: 0, absorbing: true, width: .45, coupled: true });
  const forcing = forcingFromSeries({ fine, fineGrid: grid }, series, { maxLocalSeconds: 900 });
  assert.deepEqual(Object.keys(forcing.edges).sort(), ['east', 'north']);
  F.tsunamiStart({ ...grid, ...Object.fromEntries(Object.entries(forcing).filter(([k]) => k.startsWith('force'))) });
  let frame;
  while (!frame || frame.time < 900) frame = F.tsunamiStep(200);
  assert.ok(frame.water.every(h => Number.isFinite(h) && h >= 0));
  assert.ok(Math.max(...frame.peak) > .05, 'the PTHA18 wave entered the local model');
  assert.ok(Math.abs(frame.volumeError) < 1e-4 && frame.boundaryVolume !== 0);
});

// PTHA18's own hazard curve at a point, against which a scenario's peak is placed.
test('exceedance-rate curves are read, interpolated in log rate and put into words', async () => {
  const stage = Array.from({ length: 100 }, (_, i) => 0.02 * 1000 ** (i / 99));
  const curve = scale => stage.map(h => scale * 0.5 * Math.exp(-h / 0.5));
  const names = ['stochastic_slip_rate', 'stochastic_slip_rate_16pc', 'stochastic_slip_rate_median', 'stochastic_slip_rate_84pc'];
  const rates = { stage, ...Object.fromEntries(names.map((n, k) => [n, [curve(1), curve(1 + k)]])) };
  const { get, requests } = fakeServer({ rates, stations: {}, events: {}, unitStage: {} });
  const result = await lib.exceedanceCurve(get, 1);
  assert.equal(result.stage.length, 100);
  assert.deepEqual(Array.from(result.p16.slice(0, 2)), [curve(2)[0], curve(2)[1]]);
  assert.match(requests[0], /stochastic_slip_rate_84pc\[1:1:1\]\[0:1:99\]/);
  const tabulated = lib.exceedanceRate(result, stage[40]).rate;
  assert.ok(Math.abs(tabulated / curve(1)[40] - 1) < 1e-9);
  // Between two tabulated stages the log of the rate is interpolated.
  const mid = lib.exceedanceRate(result, (stage[40] + stage[41]) / 2).rate;
  assert.ok(Math.abs(mid - Math.sqrt(result.rate[40] * result.rate[41])) < 1e-9 * result.rate[40]);
  assert.equal(lib.exceedanceRate(result, 0.001).atLeast, true);
  assert.equal(lib.exceedanceRate(result, 25).beyond, true);
  assert.throws(() => lib.exceedanceRate(result, -1), /non-negative/);
  assert.throws(() => lib.exceedanceRate(result, 1, 'nope'), /Unknown/);
  assert.equal(lib.describeRate({ rate: 0.04 }), 'about 1 in 25 years');
  assert.equal(lib.describeRate({ rate: 0.4 }), 'about 1 in 2.5 years');
  assert.equal(lib.describeRate({ rate: 0.0004, atLeast: true }), 'at least as often as about 1 in 2500 years');
  assert.match(lib.describeRate({ rate: 0 }), /too rare/);
  assert.match(lib.describeRate({ rate: null, beyond: true }), /20 m/);
  await assert.rejects(lib.exceedanceCurve(get, -1), /whole number/);
  await assert.rejects(lib.exceedanceCurve(get, 0, 'wrong'), /Slip type/);
  // The server answering for a different station is caught.
  const shifted = async url => (await get(url)).replace(/station\[1\]\n\d+/g, 'station[1]\n99');
  await assert.rejects(lib.exceedanceCurve(shifted, 1), /different hazard point/);
});

test('the hazard sentence is written into the series file', () => {
  const series = { times: [0, 30], values: [0, 0.05], offset: 0, align: 'arrival', arrival: 0, peak: 0.05, peakTime: 30, windowPeak: 0.05 };
  const meta = { zone: 'zz', slipType: 'stochastic', row: 1, mw: 9, rateAnnual: 1e-5, gaugeID: 1.1, lon: 150, lat: -30, depth: 100 };
  assert.ok(!lib.toCsv(series, meta).includes('PTHA18 hazard at this point'));
  assert.match(lib.toCsv(series, { ...meta, hazard: 'peak 0.05 m is exceeded about 1 in 25 years' }), /# PTHA18 hazard at this point: peak 0\.05 m is exceeded about 1 in 25 years\n/);
});

test('source-zone contributions rank the zones, fall back to the plain file and report unreadable zones', async () => {
  const stage = Array.from({ length: 100 }, (_, i) => 0.02 * 1000 ** (i / 99));
  const curve = scale => stage.map(h => scale * Math.exp(-h / 0.5));
  const zones = { alpha: [curve(0.3), curve(0.3)], beta: [curve(0.1), curve(0.1)], gamma: [curve(0.6), curve(0.6)] };
  const total = [curve(1), curve(1)];
  const rates = { stage, stochastic_slip_rate: total, stochastic_slip_rate_16pc: total, stochastic_slip_rate_median: total, stochastic_slip_rate_84pc: total, zones, plainOnly: ['beta'] };
  const { get } = fakeServer({ rates, stations: {}, events: {}, unitStage: {} });
  const { rows, total: sum, failed } = await lib.zoneContributions(get, 1, 0.3, { zones: ['alpha', 'beta', 'gamma', 'missing'] });
  assert.deepEqual(rows.map(r => r.zone), ['gamma', 'alpha', 'beta']);
  assert.deepEqual(failed, ['missing']);
  assert.ok(Math.abs(rows[0].share - 0.6) < 1e-6 && Math.abs(rows.reduce((s, r) => s + r.share, 0) - 1) < 1e-9);
  assert.ok(Math.abs(sum - 1 * Math.exp(-0.6)) < 1e-6);
  assert.ok(lib.ZONES.includes('southamerica') && lib.ZONES.length === new Set(lib.ZONES).size);
  await assert.rejects(lib.zoneContributions(get, 1, 0.3, { zones: ['Bad Zone'] }).then(r => { if (r.failed.length) throw new Error('unreadable'); }), /unreadable/);
});

test('the stage for a given annual rate is the inverse of the exceedance rate', async () => {
  const stage = Array.from({ length: 100 }, (_, i) => 0.02 * 1000 ** (i / 99));
  const rate = stage.map(h => 0.5 * Math.exp(-h / 0.5));
  const curve = { stage, rate, p16: rate, median: rate, p84: rate };
  for (const target of [0.2, 0.01, 1e-4]) {
    const h = lib.stageAtRate(curve, target);
    assert.ok(Math.abs(lib.exceedanceRate(curve, h).rate / target - 1) < 1e-6, `rate ${target}`);
  }
  assert.equal(lib.stageAtRate(curve, 10), null);
  assert.equal(lib.stageAtRate(curve, 1e-300), null);
  assert.throws(() => lib.stageAtRate(curve, 0), /positive/);
  assert.throws(() => lib.stageAtRate(curve, 0.1, 'nope'), /Unknown/);
});

test('candidate scenarios are ranked by closeness of their peak to a level, as a ratio, and sampled evenly', () => {
  const candidates = [
    { row: 1, mw: 8, rateAnnual: 1e-4, peak: 0.5 }, { row: 2, mw: 9, rateAnnual: 1e-5, peak: 2.1 },
    { row: 3, mw: 9, rateAnnual: 1e-6, peak: 0.9 }, { row: 4, mw: 7, rateAnnual: 1e-3, peak: 0 }, { row: 5, mw: 9, rateAnnual: 5e-6, peak: 0.9 },
  ];
  const ranked = lib.rankByPeak(candidates, 1);
  assert.deepEqual(ranked.map(c => c.row), [5, 3, 1, 2]); // equal misses are ordered by rate; 0.5 m is nearer 1 m than 2.1 m is; the no-wave one is dropped
  assert.equal(lib.rankByPeak([{ row: 1, rateAnnual: 1, peak: 0.5 }, { row: 2, rateAnnual: 1, peak: 2 }], 1).length, 2);
  assert.ok(Math.abs(ranked[3].off - Math.log(2.1)) < 1e-12);
  assert.throws(() => lib.rankByPeak(candidates, 0), /positive/);
  const rows = Array.from({ length: 100 }, (_, i) => ({ row: i + 1 }));
  assert.deepEqual(lib.sampleEvenly(rows, 4).map(r => r.row), [1, 26, 51, 76]);
  assert.equal(lib.sampleEvenly(rows.slice(0, 3), 10).length, 3);
  assert.throws(() => lib.sampleEvenly(rows, 0), /whole number/);
});

test('the batch runner reports each series through the nested model and rejects bad arguments', async () => {
  const { main } = require('../scripts/run-series-local.js');
  const lines = [], log = console.log;
  console.log = line => lines.push(line);
  try { await main(['--seconds', '300', path.join(__dirname, '../docs/examples/ptha18-southamerica-142847-gauge1450.5.csv')]); } finally { console.log = log; }
  assert.equal(lines.length, 2);
  assert.match(lines[1], /ptha18-southamerica-142847.*0\.09 m\s+\d+\.\d\d m\s+\d+\.\d\d m\s+\d+ ha$/);
  await assert.rejects(main([]), /one or more series files/);
  await assert.rejects(main(['--seconds', '99999', 'x.csv']), /up to 7200/);
  await assert.rejects(main(['--tide', '1', 'x.csv']), /Unknown option/);
});

test('rate-proportional sampling draws in proportion to rate and estimates exceedance rates', () => {
  const rows = [{ row: 1, mw: 8, rateAnnual: 1 }, { row: 2, mw: 8, rateAnnual: 1 }, { row: 3, mw: 9, rateAnnual: 2 }];
  const { draws, total, count } = lib.sampleByRate(rows, 4, () => 0);
  assert.equal(total, 4);
  assert.equal(count, 4);
  assert.deepEqual(draws.map(d => [d.row, d.draws]), [[1, 1], [2, 1], [3, 2]]);
  // A heavy scenario is drawn several times; a huge sample follows the rates closely.
  const many = Array.from({ length: 50 }, (_, i) => ({ row: i + 1, mw: 8, rateAnnual: i === 0 ? 50 : 1 }));
  const sample = lib.sampleByRate(many, 99, () => .3);
  assert.equal(sample.draws.find(d => d.row === 1).draws, 50);
  assert.equal(sample.draws.reduce((n, d) => n + d.draws, 0), 99);
  assert.throws(() => lib.sampleByRate(rows, 0), /whole number/);
  assert.throws(() => lib.sampleByRate([{ row: 1, mw: 8, rateAnnual: 0 }], 3), /positive rate/);
  // The generator is seeded and in [0, 1).
  const [a, b] = [lib.seededRandom(7), lib.seededRandom(7)];
  const values = Array.from({ length: 5 }, a);
  assert.deepEqual(values, Array.from({ length: 5 }, b));
  assert.ok(values.every(v => v >= 0 && v < 1) && new Set(values).size === 5);
  // Exceedance: half the draws reach 2, so half the total rate does.
  const results = [{ draws: 2, value: 1 }, { draws: 2, value: 3 }];
  const [low, high, none] = lib.sampledExceedance(results, 0.01, 4, [0.5, 2, 10]);
  assert.equal(low.rate, 0.01);
  assert.equal(high.rate, 0.005);
  assert.equal(none.rate, 0);
  assert.ok(high.low < high.rate && high.rate < high.high && none.low === 0 && none.high > 0);
  assert.equal(low.hits, 4);
});
