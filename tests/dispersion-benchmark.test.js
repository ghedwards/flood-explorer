// Compares the lab's linear solvers on a uniform-depth closed basin with the exact
// linear solution, a cosine-mode sum with omega^2 = g k tanh(k H). A closed box
// with a uniform bed has exactly these modes, so no fitting is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./model.js');
const gridModule = import('../viewer/tsunami-grid.js');

const G = 9.81;
const TIME = Number(process.env.BENCH_TIME || 50);

// Separable DCT-II analysis and the matching synthesis at time `t`.
function exactField(eta, W, H, cell, depth, t) {
  const cx = Array.from({ length: W }, (_, m) => Float64Array.from({ length: W }, (_, i) => Math.cos(Math.PI * m * (i + .5) / W)));
  const cy = Array.from({ length: H }, (_, n) => Float64Array.from({ length: H }, (_, j) => Math.cos(Math.PI * n * (j + .5) / H)));
  const rows = new Float64Array(H * W); // transform in x for each row
  for (let j = 0; j < H; j++) for (let m = 0; m < W; m++) {
    let s = 0;
    for (let i = 0; i < W; i++) s += eta[j * W + i] * cx[m][i];
    rows[j * W + m] = s * (m ? 2 : 1) / W;
  }
  const modes = new Float64Array(H * W);
  for (let n = 0; n < H; n++) for (let m = 0; m < W; m++) {
    let s = 0;
    for (let j = 0; j < H; j++) s += rows[j * W + m] * cy[n][j];
    modes[n * W + m] = s * (n ? 2 : 1) / H;
  }
  const evolved = new Float64Array(H * W);
  for (let n = 0; n < H; n++) for (let m = 0; m < W; m++) {
    const k = Math.hypot(Math.PI * m / (W * cell), Math.PI * n / (H * cell));
    evolved[n * W + m] = modes[n * W + m] * Math.cos(Math.sqrt(G * k * Math.tanh(k * depth)) * t);
  }
  const cols = new Float64Array(H * W);
  for (let j = 0; j < H; j++) for (let m = 0; m < W; m++) {
    let s = 0;
    for (let n = 0; n < H; n++) s += evolved[n * W + m] * cy[n][j];
    cols[j * W + m] = s;
  }
  const out = new Float64Array(H * W);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let s = 0;
    for (let m = 0; m < W; m++) s += cols[j * W + m] * cx[m][i];
    out[j * W + i] = s;
  }
  return out;
}

const rms = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - (b ? b[i] : 0)) ** 2, 0) / a.length);

test('the dispersive solver tracks exact linear dispersion better than shallow water, and the gap grows with kH', async () => {
  const { tsunamiGrid } = await gridModule;
  const report = [];
  for (const [depth, width, limit] of [[5000, 5, .3], [2000, 5, .06], [1000, 10, .01]]) {
    const grid = tsunamiGrid({ preset: 'flat', method: 'dispersive', deep: depth, width, absorbing: false });
    const { W, H, cell } = grid;
    // Time long enough for the short waves to lag, short enough to stay clear of the walls.
    F.tsunamiStart(grid);
    let frame = F.tsunamiStep(1);
    const batches = Math.ceil(TIME / (frame.dt || 1) / 40);
    for (let n = 0; n < batches; n++) frame = F.tsunamiStep(40);
    const dispersive = Float64Array.from(frame.eta), time = frame.time;
    F.tsunamiStart({ ...grid, method: 0 });
    let shallow;
    for (let n = 0; n < batches + 1; n++) shallow = F.tsunamiStep(n ? 40 : 1);
    assert.ok(Math.abs(shallow.time - time) / time < .05, 'comparable simulated times');
    const exact = exactField(grid.eta, W, H, cell, depth, time);
    const errorDispersive = rms(dispersive, exact) / rms(exact);
    const errorShallow = rms(Float64Array.from(shallow.eta), exact) / rms(exact);
    report.push({ depth, width, kH: depth / (width * 1000), time: Math.round(time), errorDispersive, errorShallow });
    assert.ok(errorDispersive < errorShallow, `depth ${depth} width ${width}: dispersive ${errorDispersive.toFixed(3)} vs shallow ${errorShallow.toFixed(3)}`);
    assert.ok(errorDispersive < limit, `kH ${(depth / width / 1000).toFixed(1)}: dispersive error ${errorDispersive.toFixed(3)} above ${limit}`);
    assert.ok(errorShallow > 3 * errorDispersive, 'shallow water should be several times worse');
  }
  if (process.env.BENCH_REPORT) console.log(JSON.stringify(report));
});

// A band-limited packet crosses a long ramp in a closed basin (a one-dimensional
// problem on the 2-D grid). Energy flux per frequency is conserved in slowly varying
// depth, so the energy passing a deep gauge relative to a shallow one is the
// spectrum-weighted ratio of group speeds, cg(H1)/cg(H2), for each model's own
// dispersion relation. The packet is centred on the left wall (a mirrored image
// makes it purely right-going), so one pass gives a clean comparison.
function packetRamp(method, upstream, downstream, wavelengthCells = 50) {
  const W = 160, H = 96, cell = 1000, ramp = 60, start = 62;
  const depth = new Float64Array(W * H), eta = new Float64Array(W * H);
  const k = 2 * Math.PI / wavelengthCells;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = i + .5;
    depth[j * W + i] = i <= start ? upstream : i >= start + ramp ? downstream : upstream + (downstream - upstream) * (i - start) / ramp;
    eta[j * W + i] = Math.exp(-.5 * (x / 10) ** 2) * Math.cos(k * x);
  }
  F.tsunamiStart({ W, H, cell, depth, eta, absorbing: false, method });
  const near = [], far = [], times = [];
  let frame = F.tsunamiStep(1);
  while (frame.time < 1000) {
    frame = F.tsunamiStep(2);
    times.push(frame.time); near.push(frame.eta[48 * W + 62]); far.push(frame.eta[48 * W + 125]);
  }
  const power = series => (omega) => {
    let a = 0, b = 0;
    for (let n = 0; n < series.length; n++) { a += series[n] * Math.cos(omega * times[n]); b += series[n] * Math.sin(omega * times[n]); }
    return a * a + b * b;
  };
  const sum = v => v.reduce((s, x) => s + x * x, 0);
  return { measured: sum(far) / sum(near), spectrum: power(near) };
}

const groupSpeed = (relation, depth, omega) => {
  let low = 1e-8, high = 1e-2;
  for (let i = 0; i < 100; i++) { const mid = (low + high) / 2; if (relation(mid, depth) < omega) low = mid; else high = mid; }
  const dk = low * 1e-5;
  return (relation(low + dk, depth) - relation(low - dk, depth)) / (2 * dk);
};
const shallowRelation = (k, h) => Math.sqrt(G * h) * k;
const weakRelation = (k, h) => Math.sqrt(G * h * k * k / (1 + k * k * h * h / 3));

function predicted({ spectrum }, relation, upstream, downstream) {
  let num = 0, den = 0;
  for (let period = 30; period <= 600; period += 3) {
    const omega = 2 * Math.PI / period, p = spectrum(omega);
    num += p * groupSpeed(relation, upstream, omega) / groupSpeed(relation, downstream, omega);
    den += p;
  }
  return num / den;
}

test('shoaling and deepening of a wave packet follow group-speed energy conservation', () => {
  const rows = [];
  for (const [upstream, downstream] of [[4000, 2500], [2500, 4000]]) {
    const dispersive = packetRamp(3, upstream, downstream), shallow = packetRamp(0, upstream, downstream);
    const weak = predicted(dispersive, weakRelation, upstream, downstream);
    const long = predicted(shallow, shallowRelation, upstream, downstream);
    rows.push({ upstream, downstream, shallowMeasured: shallow.measured, shallowPredicted: long, dispersiveMeasured: dispersive.measured, dispersivePredicted: weak });
    // The shallow-water solver is the control: it must reproduce its own prediction.
    assert.ok(Math.abs(shallow.measured / long - 1) < .03, `shallow water ${shallow.measured.toFixed(3)} vs ${long.toFixed(3)}`);
    // The dispersive solver follows the dispersive prediction to within 15%
    // and is closer to it than to the shallow-water one.
    assert.ok(Math.abs(dispersive.measured / weak - 1) < .15, `dispersive ${dispersive.measured.toFixed(3)} vs ${weak.toFixed(3)}`);
    assert.ok(Math.abs(dispersive.measured - weak) < Math.abs(dispersive.measured - long));
  }
  if (process.env.BENCH_REPORT) console.log(JSON.stringify(rows));
});
