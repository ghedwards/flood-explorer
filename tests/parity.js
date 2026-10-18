// Prints the same checksums as rust/flood-core/examples/parity.rs from the
// wasm engine; with a file argument, compares against a reference run.
//   cargo run --release -p flood-core --example parity > rust.txt
//   node tests/parity.js rust.txt
const F = require('./model.js');
const lines = [];
const out = (k, v) => lines.push(k + ' ' + v.map((x) => (Number.isFinite(x) ? x.toExponential() : 'NaN')).join(' '));
const runSum = (r) => {
  let wet = 0, d = 0, ws = 0, lv = 0;
  for (let c = 0; c < r.wet.length; c++) {
    if (r.wet[c]) { wet++; d += r.depth[c]; }
    if (Number.isFinite(r.wse[c])) ws += r.wse[c];
    if (Number.isFinite(r.level[c])) lv += r.level[c];
  }
  return [wet, d, ws, lv];
};
const fsum = (v) => { let s = 0; for (const x of v) if (Number.isFinite(x)) s += x; return s; };
const sum = (v) => { let s = 0; for (const x of v) s += x; return s; };
const valley = () => {
  const W = 60, H = 21, dem = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) dem[y * W + x] = 2 + 0.01 * (W - x) + Math.abs(y - 10) * 0.2;
  return { W, H, cell: 10, dem };
};

const grid = F.syntheticTerrain();
const a = F.analyse(grid);
const g = a.defaultGauge;
let rh = 0;
for (let c = 0; c < a.N; c++) rh += (a.rec[c] + 1) * ((c % 97) + 1);
out('analysis', [a.mainOutlet, a.defaultGauge, a.nOrder, fsum(a.chain), sum(a.acc), sum(a.stream), rh, fsum(a.filled)]);
const sc = (level, bay) => ({ gauge: g, gaugeLevel: level, bayLevel: bay, upstreamGradient: 0.3 });
const base = F.inundate(a, sc(0.5, 0));
for (const l of [2.3, 3.85, 4.46, 5.45, 8.35]) {
  const r = F.inundate(a, sc(l, 1));
  out('inundate' + l, runSum(r));
  const s = F.stats(a, r, base);
  out('stats' + l, [s.wetLandKm2, s.floodedKm2, s.deepKm2, s.maxDepth, s.rawMaxDepth, s.meanDepth]);
}
const path = [];
for (let c = g; c >= 0; c = a.rec[c]) path.push(c);
const mid = path[Math.floor(path.length / 2)];
out('controls', runSum(F.inundate(a, Object.assign(sc(4, 1), { controls: [{ cell: mid, level: 3.5 }] }))));
out('gates', runSum(F.inundate(a, Object.assign(sc(4, 1), { gates: [path[Math.floor(path.length / 3)]] }))));
const codes = F.encodeWhiteboxD8(a);
const b = F.analyse(Object.assign({}, grid, { d8: codes }));
out('pointers', [sum(codes), sum(b.rec)]);
for (const [name, st] of [
  ['flash40', { rainMm: 40, hours: 1 }],
  ['flash200', { rainMm: 200, hours: 3 }],
  ['flashpipe', { rainMm: 60, hours: 1, initialLoss: 3, contLoss: 0.5, pipeMmH: 40, urban: new Uint8Array(a.N).fill(1) }],
]) {
  const r = F.flashFlood(a, st), m = r.summary;
  out(name, runSum(r).concat([m.excessMm, m.runoffCoeff, m.creekKm2, m.overlandKm2, m.pondKm2, m.maxCreekRise, m.pipedMm, m.urbanKm2]));
}
const big = F.inundate(a, sc(a.dem[g] + 4, 1)), small = F.inundate(a, sc(a.dem[g] + 2, 1));
const hz = F.hazard(a, big);
out('hazard', Array.from(hz.km2).concat([sum(hz.vel)]));
const cm = F.compareRuns(a, big, small);
out('compare', [cm.km2.both, cm.km2.onlyNow, cm.km2.onlyPinned, cm.deeperKm2, cm.shallowerKm2, sum(cm.dDepth)]);
out('uplift', [F.stormUplift(1, 1), F.stormUplift(6, 2), F.stormUplift(24, 1.5)]);
const dg = a.dem[g];
const wsum = (w, t) => fsum(F.waveSurface(a, w, t));
const o = { baseLevel: dg + 0.3, riseHours: 12, fallHours: 24, speedKmh: 2, route: true };
const s4 = sc(dg + 4, 0.5);
let w = F.waveSetup(a, s4, o);
const R = w.routed, pk = R.peakAt(R.flows.length - 1);
out('routed', [R.flows.length, pk.frac, pk.hours, sum(R.flows[R.flows.length - 1].Q), R.T0, R.dt, R.nT, R.tributaries, R.extraHours, wsum(w, w.tPeak), wsum(w, w.tPeak + 7.3)]);
w = F.waveSetup(a, s4, Object.assign({}, o, { rating: { b: 2.4, depth: 1.5 } }));
out('rated', [wsum(w, w.tPeak), wsum(w, w.tPeak - 6), w.routed.exponent]);
const s3 = sc(dg + 3, 1.2);
let tl = F.floodTimeline(a, s3, { baseLevel: dg + 0.3, riseHours: 12, fallHours: 24, speedKmh: 3, tide: { amp: 0.8 } });
const bits = (arr) => { let n = 0; for (let x of arr) { x >>>= 0; while (x) { n += x & 1; x >>>= 1; } } return n; };
out('tidetimeline', [tl.t0, tl.step, tl.steps, sum(tl.firstWet), sum(tl.lastDeep), bits(tl.wetBits), bits(tl.deepBits)].concat(Array.from(tl.wetCount)));
let u = g;
for (let k = 0; k < 400; k++) {
  let best = -1;
  for (let c = 0; c < a.N; c++) if (a.rec[c] === u && a.stream[c] && (best < 0 || a.acc[c] > a.acc[best])) best = c;
  if (best < 0 || a.chain[best] - a.chain[g] > 15000) break;
  u = best;
}
const hydro = [[0, 1], [10, 5], [20, 2], [40, 1]], up = [[0, 2], [4, 8], [14, 3], [40, 2]];
w = F.waveSetup(a, s4, { hydro, speedKmh: 3, others: [{ cell: u, hydro: up }] });
out('upper', [wsum(w, 4), wsum(w, 10), wsum(w, 17.5), w.up.gauges]);
let dn = g;
while (a.rec[dn] >= 0 && a.chain[g] - a.chain[dn] < 6000) dn = a.rec[dn];
w = F.waveSetup(a, s4, { hydro, speedKmh: 3, route: true, others: [{ cell: dn, hydro: up }] });
out('lower', [wsum(w, 4), wsum(w, 10), wsum(w, 17.5), w.up.below]);
const sea = [[0, 0.1], [6, 1.4], [12, -0.6], [18, 1.6], [30, 0]];
const os = { hydro: [[0, 1], [10, 5], [30, 1]], speedKmh: 3, sea, flatten: 2 };
const s02 = sc(dg + 3, 0.2);
w = F.waveSetup(a, s02, os);
out('sea', [w.bayAt(9), w.at[6](12), w.at[3](7.5), wsum(w, 11)]);
tl = F.floodTimeline(a, s02, os);
out('seatimeline', [tl.t0, tl.step, tl.steps, sum(tl.firstDeep)].concat(Array.from(tl.wetCount)));
w = F.waveSetup(a, sc(dg + 3, 0.5), { baseLevel: dg + 0.3, riseHours: 12, fallHours: 24, speedKmh: 3, release: { startHours: 20, hours: 30, frac: 0.3 } });
out('release', [w.gaugeAt(10), w.gaugeAt(30), w.gaugeAt(60), w.release.peakWith, w.release.rise, w.tStart, w.tEnd]);
const vg = valley(), W = vg.W;
const lc = F.lineCells([[0, 13], [59, 13]], W, vg.H);
const mask = new Uint8Array(W * vg.H);
lc.forEach((c) => { mask[c] = 1; });
for (const [name, lv] of [
  ['leveehigh', { cells: lc, height: 3 }],
  ['leveefailed', { cells: lc, height: 3, failed: true }],
  ['leveebreach', { cells: lc, height: 3, breaches: [13 * W + 30] }],
  ['leveelow', { cells: lc, height: 0.3 }],
  ['leveeterrain', { cells: lc, height: null }],
]) {
  const gg = F.burnDefences(vg, { levees: [lv] });
  const av = F.analyse(gg, { streamAreaKm2: 0.001 });
  const gauge = 10 * W + 55;
  const r = F.inundate(av, { gauge, gaugeLevel: vg.dem[gauge] + 1.5, bayLevel: 0, upstreamGradient: 0, levee: mask });
  out(name, runSum(r).concat([sum(gg.dem)]));
}
const av = F.analyse(vg, { streamAreaKm2: 0.001 });
const gauge = 10 * W + 50;
tl = F.floodTimeline(av, { gauge, gaugeLevel: vg.dem[gauge] + 1.5, bayLevel: 0, upstreamGradient: 0 }, { baseLevel: vg.dem[gauge] + 0.1, riseHours: 6, fallHours: 12, speedKmh: 0.1 });
out('valleytimeline', [tl.t0, tl.step, tl.steps, sum(tl.firstWet), sum(tl.gauge)].concat(Array.from(tl.wetCount)));
const ag = F.parseAsciiGrid('ncols 3\nnrows 2\nxllcorner 0\nyllcorner 0\ncellsize 25\nNODATA_value -9999\n1 2 3\n4 -9999 6\n');
out('ascii', [ag.W, ag.H, ag.cell, fsum(ag.dem)]);
const ds = F.downsample(grid, 100);
out('downsample', [ds.W, ds.H, ds.cell, sum(ds.dem)]);

if (process.argv[2]) {
  const other = new Map(require('fs').readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => { const p = l.split(' '); return [p[0], p.slice(1)]; }));
  let bad = 0;
  for (const l of lines) {
    const p = l.split(' '), k = p[0], js = p.slice(1).map(Number), rs = (other.get(k) || []).map(Number);
    let worst = 0;
    if (rs.length !== js.length) worst = Infinity;
    else for (let i = 0; i < js.length; i++) {
      if (Number.isNaN(js[i]) && Number.isNaN(rs[i])) continue;
      worst = Math.max(worst, Math.abs(js[i] - rs[i]) / Math.max(1, Math.abs(js[i])));
    }
    const ok = worst < 1e-6;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'DIFF'} ${k}${ok ? '' : `  worst ${worst}\n  js ${js.slice(0, 12).join(' ')}\n  rs ${rs.slice(0, 12).join(' ')}`}`);
  }
  console.log(bad ? `${bad} differ` : 'all match');
  process.exit(bad ? 1 : 0);
} else console.log(lines.join('\n'));
