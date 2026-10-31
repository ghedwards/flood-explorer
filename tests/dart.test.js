const test = require('node:test');
const assert = require('node:assert/strict');
const dart = require('../scripts/dart-lib.js');
const validate = require('../scripts/validate-ptha-dart.js');
const ptha = require('../scripts/ptha-lib.js');

const origin = Date.UTC(2011, 2, 11, 5, 46, 23);

test('NCEI DART files parse to seconds after the earthquake, skipping junk and fill values', () => {
  const text = [
    '# header line',
    '     70.239155 2011  3 11  5 44 23 3283.64686 3283.73019   -0.08333  0.000',
    '     70.240544 2011  3 11  5 46 23 3283.64786 3283.73085   -0.08300  0.000',
    '     70.241238 2011  3 11  5 47 23 3283.66000 3283.73100   -0.07100  0.000',
    '     70.241932 2011  3 11  5 48 23 9999999.0 3283.73100   9999.0  0.000',
    'not a data row',
  ].join('\n');
  const r = dart.parseNgdcDart(text, origin);
  assert.deepEqual(r.t, [-120, 0, 60]);
  assert.deepEqual(r.residual, [-0.08333, -0.083, -0.071]);
  assert.equal(r.raw.length, 3);
  assert.throws(() => dart.parseNgdcDart('nothing here', origin), /No readable/);
  assert.throws(() => dart.parseNgdcDart('1 2011 3 11 5 47 23 1 1 0.1 0\n1 2011 3 11 5 46 23 1 1 0.1 0', origin), /do not increase/);
});

test('station data files are found on an event page', () => {
  const html = '<a href="/hazard/data/DART/20110311_honshu/dart21401_20110301to20110320_meter.txt">d</a> <a href="/hazard/data/DART/20110311_honshu/21401_20101116to20120624_tides.txt">t</a> <a href="/hazard/data/DART/20110311_honshu/dart55012_20110301to20110320_meter.txt">d</a>';
  assert.deepEqual(dart.stationFiles(html), {
    21401: 'https://www.ngdc.noaa.gov/hazard/data/DART/20110311_honshu/dart21401_20110301to20110320_meter.txt',
    55012: 'https://www.ngdc.noaa.gov/hazard/data/DART/20110311_honshu/dart55012_20110301to20110320_meter.txt',
  });
});

test('resampling interpolates, leaves gaps blank and does not extrapolate', () => {
  const out = dart.resample([0, 60, 120, 1000, 1060], [0, 6, 12, 100, 106], Float64Array.of(-10, 30, 90, 500, 1030, 2000), 600);
  assert.ok(Number.isNaN(out[0]) && Number.isNaN(out[5]));
  assert.equal(out[1], 3); assert.equal(out[2], 9);
  assert.ok(Number.isNaN(out[3]), 'a gap longer than maxGap stays blank');
  assert.equal(out[4], 103);
});

test('the high-pass filter removes slow drift but keeps a tsunami-like pulse', () => {
  const step = 60, n = 24 * 60;
  const drift = i => .08 * Math.sin(2 * Math.PI * i * step / (12.4 * 3600)) - .05;
  const pulse = i => { const z = ((i - 700) * step) / 1200; return Math.exp(-z * z) * .3; };
  const v = Float64Array.from({ length: n }, (_, i) => drift(i) + pulse(i));
  const out = dart.highpass(v, step);
  const quiet = Math.max(...Array.from(out.slice(900, 1300), Math.abs));
  assert.ok(quiet < .02, `drift left ${quiet}`);
  // The pulse itself nudges the running median, so an isolated broad peak is lowered by roughly a tenth (documented in the report).
  assert.ok(out[700] > .24 && out[700] < .30, `pulse height ${out[700]}`);
  assert.ok(Number.isNaN(dart.highpass(Float64Array.of(NaN, 1, 2, 3, 4, 5), step)[0]));
});

test('despiking replaces isolated bad readings and leaves a tsunami pulse and quiet noise alone', () => {
  const n = 600, noise = i => .002 * Math.sin(i * 12.9898) ;
  const pulse = i => { const z = (i - 300) / 20; return .3 * Math.exp(-z * z); };
  const clean = Float64Array.from({ length: n }, (_, i) => noise(i) + pulse(i));
  const dirty = Float64Array.from(clean);
  dirty[100] += 0.9; dirty[101] -= 0.7; dirty[450] = 12; dirty[200] = NaN;
  const { values, replaced } = dart.despike(dirty);
  assert.equal(replaced, 3);
  for (const i of [100, 101, 450]) assert.ok(Math.abs(values[i] - clean[i]) < .01, `sample ${i}: ${values[i]} against ${clean[i]}`);
  assert.ok(Number.isNaN(values[200]), 'a missing sample stays missing');
  assert.deepEqual([...values.slice(280, 320)], [...dirty.slice(280, 320)], 'the pulse crest is untouched');
  assert.equal(dart.despike(clean).replaced, 0, 'a clean record loses nothing');
  const step = Float64Array.from({ length: 60 }, (_, i) => (i < 30 ? 0 : .2) + noise(i));
  assert.equal(dart.despike(step).replaced, 0, 'a sharp step, as a tsunami front can be, is not a spike');
  assert.equal(dart.despike(Float64Array.of(1, 2, 3)).replaced, 0, 'too few samples to judge');
});

test('distances and the earliest possible tsunami arrival mask the earthquake\'s own shaking', () => {
  assert.ok(Math.abs(dart.distanceKm(0, 0, 0, 1) - 111.19) < .05);
  assert.ok(Math.abs(dart.distanceKm(142.369, 38.322, 148.698, 38.718) - 552) < 15);
  const time = Float64Array.from({ length: 100 }, (_, i) => i * 60);
  // 282 km: 0.9 * 282000 / sqrt(9.81 * 6000) = about 1046 s.
  const masked = dart.maskBeforeTsunami(new Float64Array(100).fill(1), time, 282);
  assert.ok(Number.isNaN(masked[17]) && masked[18] === 1);
  assert.equal(dart.maskBeforeTsunami(new Float64Array(100).fill(1), time, 0).filter(Number.isNaN).length, 0);
});

test('onsets, first exceedances and the best-lag correlation have the stated signs', () => {
  const pulse = (centre, n = 200) => Float64Array.from({ length: n }, (_, i) => Math.exp(-(((i - centre) / 6) ** 2)));
  const observed = pulse(100);
  assert.ok(dart.firstExceed(observed, 0, 200, .5) > 90 && dart.firstExceed(observed, 0, 200, .5) < 100);
  assert.equal(dart.firstExceed(observed, 0, 50, .5), -1);
  assert.ok(dart.onset(observed, 0, 200, { fraction: .5, floor: .01 }) > 90);
  // A model that is 7 samples early must be delayed (positive lag) to match.
  const early = pulse(93);
  const r = dart.bestLagCorrelation(early, observed, 40, 160, 20);
  assert.equal(r.lag, 7);
  assert.ok(r.correlation > .999);
  const late = dart.bestLagCorrelation(pulse(110), observed, 40, 160, 20);
  assert.equal(late.lag, -10);
  assert.throws(() => dart.bestLagCorrelation(early, observed, 0, 5, 3), /Too little/);
  assert.equal(dart.bestLagCorrelation(new Float64Array(200), observed, 40, 160, 3).correlation, 0);
});

// Synthetic ensemble: unit source k is a pulse of height k centred at step 100 + 20 k.
function ensemble() {
  const n = 600, step = 30;
  const time = Float64Array.from({ length: n }, (_, i) => i * step);
  const series = [1, 2, 3, 4].map(k => Float32Array.from(time, (_, i) => k * .05 * Math.exp(-(((i - (100 + 20 * k)) / 8) ** 2)) * Math.sin((i - 100 - 20 * k) / 3)));
  const scenarios = [
    { row: 1, indices: [1], slips: [1] }, { row: 2, indices: [2], slips: [1] }, { row: 3, indices: [3], slips: [1] },
    { row: 4, indices: [4], slips: [1] }, { row: 5, indices: [1, 2], slips: [1, 1] }, { row: 6, indices: [3, 4], slips: [1, 1] },
    { row: 7, indices: [2, 3], slips: [2, 1] }, { row: 8, indices: [1, 4], slips: [1, 2] }, { row: 9, indices: [4], slips: [2] }, { row: 10, indices: [2, 4], slips: [1, 1] },
  ];
  return { time, step, series, scenarios, n };
}

test('a station is placed against the scenario spread, with a window that does not depend on the observation', () => {
  const { time, step, series, scenarios, n } = ensemble();
  const truth = scenarios[5]; // scenario 6
  const model = ptha.sumScenario(series, truth.indices, truth.slips);
  const delay = 10; // observation 10 samples later than the model
  const obs = Float64Array.from({ length: n }, (_, i) => i >= delay ? model[i - delay] + .0005 * Math.sin(i * 7) : 0);
  const a = validate.analyseStation({ time, series, scenarios, obs, windowHours: 2, leadSeconds: 600, maxLagSeconds: 900 });
  assert.equal(a.scenarios, 10);
  assert.ok(a.observedPeak > 0 && a.observedPercentile >= 0 && a.observedPercentile <= 100);
  assert.ok(a.modelPeak.p10 <= a.modelPeak.p50 && a.modelPeak.p50 <= a.modelPeak.p90);
  assert.equal(a.bestMatch.row, 6);
  assert.ok(a.bestMatch.correlation > .98);
  assert.equal(a.bestMatch.lagMinutes, delay * step / 60, 'positive lag: the model must be delayed');
  assert.ok(a.window.toHours - a.window.fromHours <= 2.001);
  // Friction can only lower the modelled peaks, so the observation sits at or above its frictionless percentile.
  assert.ok(a.withFriction.p50 <= a.modelPeak.p50 + 1e-12 && a.withFriction.observedPercentile >= a.observedPercentile - 1e-9);
  assert.ok(a.onsetDifferenceMinutes && a.onsetDifferenceMinutes.scenarios > 0);
  // Changing the observation moves the percentile but not the window.
  const larger = validate.analyseStation({ time, series, scenarios, obs: obs.map(v => v * 3), windowHours: 2, leadSeconds: 600, maxLagSeconds: 900 });
  assert.deepEqual(larger.window, a.window);
  assert.ok(larger.observedPercentile >= a.observedPercentile);
  const withEnvelope = validate.analyseStation({ time, series, scenarios, obs, windowHours: 2, leadSeconds: 600, wantEnvelope: true });
  const e = withEnvelope.envelope;
  assert.ok(e.time.length > 100 && [e.obs, e.p10, e.p50, e.p90].every(v => v.length === e.time.length));
  assert.ok(e.p10.every((v, i) => v <= e.p50[i] + 1e-12 && e.p50[i] <= e.p90[i] + 1e-12));
  assert.throws(() => validate.analyseStation({ time, series, scenarios, obs: new Float64Array(n) }), /empty/);
  assert.throws(() => validate.analyseStation({ time, series: series.map(s => new Float32Array(s.length)), scenarios, obs }), /No scenario produces/);
});

test('the summary, report and figure are built from the station results', () => {
  const { time, series, scenarios } = ensemble();
  const model = ptha.sumScenario(series, [3, 4], [1, 1]);
  const obs = Float64Array.from(model);
  const rows = ['21418', '55012'].map((id, k) => ({ id, group: k ? 'towards eastern Australia' : 'near field, off Japan', depth: 5000, ...validate.analyseStation({ time, series, scenarios, obs, wantEnvelope: true }) }));
  const summary = validate.summarise(rows);
  assert.equal(summary.stations, 2);
  assert.ok(Number.isFinite(summary.medianObservedPercentileWithFriction) && Number.isFinite(summary.medianModelToObservedPeakWithFriction));
  assert.ok(summary.insideP10P90 >= 0 && summary.insideP10P90 <= 2);
  assert.deepEqual(Object.keys(summary.onsetMedianByGroup).sort(), ['near field, off Japan', 'towards eastern Australia']);
  const report = validate.renderReport({ rows, summary, meta: { event: 'Test event', date: '2026-01-01', originText: 'now', highpassHours: 4, scenarios: 10, slipType: 'stochastic', zone: 'z', mw: [9, 9.2], radiusDegrees: 2.5, caveats: ['one caveat'], figure: 'f.svg', page: 'https://example.org', figureNote: 'note' } });
  assert.match(report, /# PTHA18 against observed DART records: Test event/);
  assert.match(report, /\| 21418 \| near field, off Japan \| 5000 \|/);
  assert.match(report, /delayed linear friction applied to the scenarios/);
  assert.match(report, /\*\*\d+ of 2\*\* buoys/);
  assert.match(report, /one caveat/);
  assert.doesNotMatch(report, /Despiking/, 'off by default, so the published method is unchanged');
  assert.match(validate.renderReport({ rows, summary, meta: { ...JSON.parse(JSON.stringify({ event: 'E', date: 'd', originText: 'o', highpassHours: 4, scenarios: 1, slipType: 's', zone: 'z', mw: [9, 9.2], radiusDegrees: 2, caveats: [], figure: 'f.svg', page: 'p', figureNote: 'n' })), despiked: 7 } }), /Despiking:\*\* before filtering, 7 isolated readings/);
  assert.match(report, /CC BY 4.0/);
  const svg = validate.renderFigure(rows, ['21418', '55012', 'missing']);
  assert.match(svg, /^<svg /);
  assert.equal((svg.match(/DART \d{5}/g) || []).length, 2);
  assert.ok(!/NaN|undefined/.test(svg), 'no invalid coordinates');
  assert.equal(validate.quantile([5, 1, 3], .5), 3);
});

test('the shipped Tohoku report has the numbers its summary states', () => {
  const fs = require('node:fs'), path = require('node:path');
  const json = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/validation/tohoku-2011-dart.json'), 'utf8'));
  const md = fs.readFileSync(path.join(__dirname, '../docs/validation/tohoku-2011-dart.md'), 'utf8');
  assert.equal(json.stations.length, 16);
  assert.ok(json.scenarios > 100);
  const inside = json.stations.filter(r => r.observedPeak >= r.modelPeak.p10 && r.observedPeak <= r.modelPeak.p90).length;
  assert.equal(inside, json.summary.insideP10P90);
  assert.match(md, new RegExp(`\\*\\*${inside} of 16\\*\\*`));
  for (const r of json.stations) assert.match(md, new RegExp(`\\| ${r.id} \\|`));
  assert.ok(fs.existsSync(path.join(__dirname, '../docs/validation/tohoku-2011-dart.svg')));
});
